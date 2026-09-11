import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  abandonLifecycleRun,
  admitLifecycleRun,
  persistLifecycleTerminal,
  settleLifecycleRun,
  type LifecycleRun,
} from "../pi-extension/subagents/lifecycle-runtime.ts";
import { RootTreeLifecycleCoordinator } from "../pi-extension/subagents/lifecycle.ts";

const EVIDENCE = {
  exitCode: 17,
  sentinel: "SUBAGENT_DONE_17",
  transcriptRef: "transcript-child",
  sessionRef: "session-child",
  cancelled: false,
  observedAt: "2026-09-11T12:00:00.000Z",
};

type ReleaseParams = { childId: string; ownerId: string; leaseToken: string };

async function withRoot(run: (artifactDir: string) => Promise<void> | void): Promise<void> {
  const artifactDir = mkdtempSync(join(tmpdir(), "subagent-settlement-faults-"));
  try {
    await run(artifactDir);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

function admit(artifactDir: string, childId = "child"): LifecycleRun {
  return admitLifecycleRun({
    sessionId: "root",
    artifactDir,
    childId,
    ownerId: `${childId}-owner`,
    maxActiveSubagents: 2,
  });
}

function evidenceBytes(run: LifecycleRun): string {
  return JSON.stringify(run.coordinator.inspect().children[run.childId]!.terminalEvidence);
}

describe("fault-isolated lifecycle settlement", () => {
  it("preserves byte-stable evidence while every secondary action fails and release recovers independently", async () => {
    await withRoot(async (artifactDir) => {
      const run = admit(artifactDir);
      persistLifecycleTerminal(run, EVIDENCE);
      const persistedEvidence = evidenceBytes(run);
      const order: string[] = [];
      const originalRelease = run.coordinator.releaseLease.bind(run.coordinator);
      const coordinator = run.coordinator as unknown as {
        releaseLease: (params: ReleaseParams) => unknown;
      };
      let releaseAttempts = 0;
      coordinator.releaseLease = (params) => {
        order.push("release");
        if (++releaseAttempts === 1) throw new Error("filesystem token=secret-value");
        return originalRelease(params);
      };
      const actions = {
        extraction: () => { order.push("extraction"); throw new Error("transcript body must not persist"); },
        delivery: () => { order.push("delivery"); throw new Error("prompt=private parent rejected"); },
        cleanup: () => { order.push("cleanup:owned-pane"); throw new Error("close failed"); },
        layout: () => { order.push("layout"); throw new Error("layout failed"); },
      };

      await settleLifecycleRun(run, actions);
      let record = run.coordinator.inspect().children.child!;
      assert.equal(record.lease.state, "active");
      assert.equal(record.transitions.release.status, "pending");
      assert.equal(record.transitions.release.attempts, 1);
      assert.equal(record.transitions.delivery.lastError, "external lifecycle action failed");
      assert.equal(evidenceBytes(run), persistedEvidence);

      await settleLifecycleRun(run, actions);
      record = run.coordinator.inspect().children.child!;
      assert.equal(record.lease.state, "released");
      assert.equal(record.transitions.release.status, "complete");
      assert.equal(record.transitions.delivery.status, "ambiguous");
      assert.equal(record.transitions.delivery.attempts, 1);
      assert.equal(record.transitions.delivery.lastError, "external lifecycle action failed");
      assert.equal(order.filter((entry) => entry === "delivery").length, 1);
      assert.deepEqual(order, [
        "extraction", "delivery", "release", "cleanup:owned-pane", "layout",
        "extraction", "release", "cleanup:owned-pane", "layout",
      ]);
      assert.equal(evidenceBytes(run), persistedEvidence);

      await settleLifecycleRun(run, actions);
      assert.equal(order.filter((entry) => entry === "delivery").length, 1);
      assert.equal(run.coordinator.inspect().activeCount, 0);
    });
  });

  it("survives restart after terminal persistence, including an interrupted temporary write", async () => {
    await withRoot(async (artifactDir) => {
      const initial = admit(artifactDir);
      persistLifecycleTerminal(initial, EVIDENCE);
      const persistedEvidence = evidenceBytes(initial);
      writeFileSync(join(artifactDir, "subagent-lifecycle.json.tmp-interrupted"), "{truncated", "utf8");

      const restarted: LifecycleRun = {
        ...initial,
        coordinator: new RootTreeLifecycleCoordinator({ rootArtifactDir: artifactDir, rootId: initial.rootId, maxActiveSubagents: 2 }),
      };
      let cleanupCalls = 0;
      await settleLifecycleRun(restarted, { cleanup: () => { cleanupCalls++; } });
      const record = restarted.coordinator.inspect().children.child!;
      assert.equal(JSON.stringify(record.terminalEvidence), persistedEvidence);
      assert.equal(record.lease.state, "released");
      assert.equal(cleanupCalls, 1);
      assert.equal(record.transitions.cleanup.status, "complete");
    });
  });

  it("records cancellation and declines recovery when a restarted owner cannot prove ownership", async () => {
    await withRoot(async (artifactDir) => {
      const cancelled = admit(artifactDir, "cancelled");
      await abandonLifecycleRun(cancelled, new Error("startup cancelled"));
      const cancelledRecord = cancelled.coordinator.inspect().children.cancelled!;
      assert.equal(cancelledRecord.phase, "cancelled");
      assert.equal(cancelledRecord.lease.state, "released");
      assert.equal(cancelledRecord.terminalEvidence?.cancelled, true);

      const owned = admit(artifactDir, "owned");
      persistLifecycleTerminal(owned, EVIDENCE);
      const snapshot = readFileSync(join(artifactDir, "subagent-lifecycle.json"), "utf8");
      const unknownOwner: LifecycleRun = {
        ...owned,
        ownerId: "unproven-owner",
        coordinator: new RootTreeLifecycleCoordinator({ rootArtifactDir: artifactDir, rootId: owned.rootId, maxActiveSubagents: 2 }),
      };
      let unrelatedPaneTargets = 0;
      await settleLifecycleRun(unknownOwner, { cleanup: () => { unrelatedPaneTargets++; } });
      assert.equal(unrelatedPaneTargets, 0);
      assert.equal(readFileSync(join(artifactDir, "subagent-lifecycle.json"), "utf8"), snapshot);
      assert.equal(owned.coordinator.inspect().children.owned!.lease.state, "active");
    });
  });

  it("keeps bounded transition attempts at the configured cap across a modest sequence", async () => {
    await withRoot(async (artifactDir) => {
      let deliveries = 0;
      for (let index = 0; index < 12; index++) {
        const run = admit(artifactDir, `child-${index}`);
        persistLifecycleTerminal(run, { ...EVIDENCE, sessionRef: `session-${index}` });
        await settleLifecycleRun(run, { delivery: () => { deliveries++; } });
        const record = run.coordinator.inspect().children[`child-${index}`]!;
        assert.equal(record.lease.state, "released");
        assert.equal(record.transitions.delivery.attempts, 1);
      }
      const final = new RootTreeLifecycleCoordinator({ rootArtifactDir: artifactDir, rootId: "root", maxActiveSubagents: 2 }).inspect();
      assert.equal(final.activeCount, 0);
      assert.equal(deliveries, 12);
    });
  });
});
