import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  LifecycleError,
  RootTreeLifecycleCoordinator,
  type ExhaustedFailureDiagnostic,
} from "../pi-extension/subagents/lifecycle.ts";
import {
  admitLifecycleRun,
  persistLifecycleTerminal,
  settleLifecycleRun,
} from "../pi-extension/subagents/lifecycle-runtime.ts";

const evidence = {
  exitCode: 1,
  sentinel: "SUBAGENT_DONE_1",
  transcriptRef: "transcript-a",
  sessionRef: "session-a",
  cancelled: false,
  observedAt: "2026-09-11T12:00:00.000Z",
};

function withRoot(run: (artifactDir: string) => Promise<void> | void): Promise<void> {
  const artifactDir = mkdtempSync(join(tmpdir(), "failure-visibility-"));
  return Promise.resolve(run(artifactDir)).finally(() => rmSync(artifactDir, { recursive: true, force: true }));
}

function createCoordinator(artifactDir: string): RootTreeLifecycleCoordinator {
  return new RootTreeLifecycleCoordinator({
    rootArtifactDir: artifactDir,
    rootId: "root",
    maxActiveSubagents: 2,
    maxTransitionAttempts: 2,
  });
}

function exhaustTransition(
  coordinator: RootTreeLifecycleCoordinator,
  transition: "cleanup" | "layout",
  ownerId = "owner",
): void {
  const lease = coordinator.acquire({ childId: "child", ownerId }).lease;
  coordinator.persistTerminalEvidence({ childId: "child", ownerId, leaseToken: lease.token, evidence });
  coordinator.claimTransition({ childId: "child", ownerId, leaseToken: lease.token, transition });
  coordinator.completeTransition({ childId: "child", ownerId, leaseToken: lease.token, transition, error: "/private/task/prompt.txt provider failed with sk-secret" });
  coordinator.claimTransition({ childId: "child", ownerId, leaseToken: lease.token, transition });
  coordinator.completeTransition({ childId: "child", ownerId, leaseToken: lease.token, transition, error: "/private/task/prompt.txt provider failed with sk-secret" });
}

describe("exhausted failure visibility", () => {
  it("claims a bounded, owner-bound redacted diagnostic exactly once", async () => {
    await withRoot((artifactDir) => {
      const coordinator = createCoordinator(artifactDir);
      exhaustTransition(coordinator, "cleanup");

      const reloaded = createCoordinator(artifactDir);
      assert.deepEqual(reloaded.claimExhaustedFailureDiagnostics({ ownerId: "foreign" }), []);
      const diagnostics = reloaded.claimExhaustedFailureDiagnostics({ ownerId: "owner" });
      assert.equal(diagnostics.length, 1);
      assert.deepEqual(Object.keys(diagnostics[0]).sort(), ["attempts", "category", "childId", "message", "occurredAt", "state", "transition"]);
      assert.deepEqual(diagnostics[0], {
        childId: "child",
        transition: "cleanup",
        state: "exhausted",
        category: "provider",
        attempts: 2,
        occurredAt: diagnostics[0].occurredAt,
        message: "Failure details redacted.",
      });
      assert.doesNotMatch(JSON.stringify(diagnostics), /private|prompt|sk-secret/);
      assert.deepEqual(createCoordinator(artifactDir).claimExhaustedFailureDiagnostics({ ownerId: "owner" }), []);
      assert.equal(coordinator.inspect().children.child.transitions.cleanup.failureNotice.status, "claimed");
    });
  });

  it("bounds independent diagnostics and keeps terminal evidence immutable", async () => {
    await withRoot((artifactDir) => {
      const coordinator = createCoordinator(artifactDir);
      exhaustTransition(coordinator, "cleanup");
      exhaustTransition(coordinator, "layout");
      const lease = coordinator.acquire({ childId: "terminal", ownerId: "owner" }).lease;
      coordinator.persistTerminalEvidence({ childId: "terminal", ownerId: "owner", leaseToken: lease.token, evidence });
      const duplicate = coordinator.persistTerminalEvidence({ childId: "terminal", ownerId: "owner", leaseToken: lease.token, evidence });
      assert.equal(duplicate.persisted, false);
      assert.throws(
        () => coordinator.persistTerminalEvidence({
          childId: "terminal",
          ownerId: "owner",
          leaseToken: lease.token,
          evidence: { ...evidence, exitCode: 9 },
        }),
        (error: unknown) => error instanceof LifecycleError && error.code === "terminal-evidence-immutable",
      );
      assert.equal(coordinator.claimExhaustedFailureDiagnostics({ ownerId: "owner", limit: 1 }).length, 1);
      assert.equal(coordinator.claimExhaustedFailureDiagnostics({ ownerId: "owner" }).length, 1);
      assert.throws(
        () => coordinator.claimExhaustedFailureDiagnostics({ ownerId: "owner", limit: 13 }),
        (error: unknown) => error instanceof LifecycleError && error.code === "invalid-configuration",
      );
    });
  });

  it("migrates v2 errors into safe diagnostics and rejects malformed notice state", async () => {
    await withRoot((artifactDir) => {
      const coordinator = createCoordinator(artifactDir);
      const lease = coordinator.acquire({ childId: "child", ownerId: "owner" }).lease;
      coordinator.persistTerminalEvidence({ childId: "child", ownerId: "owner", leaseToken: lease.token, evidence });
      coordinator.claimTransition({ childId: "child", ownerId: "owner", leaseToken: lease.token, transition: "cleanup" });
      coordinator.completeTransition({ childId: "child", ownerId: "owner", leaseToken: lease.token, transition: "cleanup", error: "/absolute/legacy-output" });
      const statePath = join(artifactDir, "subagent-lifecycle.json");
      const v3 = JSON.parse(readFileSync(statePath, "utf8"));
      v3.version = 2;
      for (const transition of Object.values(v3.children.child.transitions) as Array<Record<string, unknown>>) {
        delete transition.failureDiagnostic;
        delete transition.failureNotice;
      }
      writeFileSync(statePath, JSON.stringify(v3));

      const migrated = createCoordinator(artifactDir).inspect();
      assert.equal(migrated.version, 3);
      assert.equal(migrated.children.child.transitions.cleanup.failureDiagnostic?.message, "Failure details redacted.");
      assert.equal(migrated.children.child.transitions.cleanup.failureNotice.ownerId, "owner");
      assert.doesNotMatch(JSON.stringify(migrated.children.child.transitions.cleanup.failureDiagnostic), /absolute|legacy-output/);

      writeFileSync(statePath, JSON.stringify(migrated));
      const malformed = JSON.parse(readFileSync(statePath, "utf8"));
      malformed.version = 3;
      malformed.children.child.transitions.cleanup.failureNotice = { status: "claimed", ownerId: "../foreign", claimedAt: null };
      writeFileSync(statePath, JSON.stringify(malformed));
      assert.throws(() => createCoordinator(artifactDir).inspect(), (error: unknown) => error instanceof LifecycleError && error.code === "malformed-state");
    });
  });

  it("does not let throwing notice delivery retain a lease or replay a notice", async () => {
    await withRoot(async (artifactDir) => {
      const run = admitLifecycleRun({ sessionId: "root", artifactDir, childId: "child", ownerId: "owner", maxActiveSubagents: 1 });
      persistLifecycleTerminal(run, evidence);
      let calls = 0;
      const throwingNotice = (_diagnostics: ExhaustedFailureDiagnostic[]) => {
        calls++;
        throw new Error("parent unavailable");
      };
      await settleLifecycleRun(run, { cleanup: () => { throw new Error("cleanup failure"); }, failureNotice: throwingNotice });
      await settleLifecycleRun(run, { cleanup: () => { throw new Error("cleanup failure"); }, failureNotice: throwingNotice });
      await settleLifecycleRun(run, { failureNotice: throwingNotice });

      assert.equal(calls, 1);
      const snapshot = run.coordinator.inspect();
      assert.equal(snapshot.children.child.lease?.state, "released");
      assert.equal(snapshot.children.child.transitions.cleanup.failureNotice.status, "ambiguous");
      assert.equal(snapshot.children.child.terminalEvidence?.exitCode, 1);
    });
  });
});
