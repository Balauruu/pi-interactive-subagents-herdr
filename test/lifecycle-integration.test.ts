import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  admitLifecycleRun,
  lifecycleEnvParts,
  markLifecycleRunning,
  persistLifecycleTerminal,
  settleLifecycleRun,
} from "../pi-extension/subagents/lifecycle-runtime.ts";
import { LifecycleError } from "../pi-extension/subagents/lifecycle.ts";

const evidence = {
  exitCode: 0,
  sentinel: "__SUBAGENT_DONE_0__",
  transcriptRef: "transcript-a",
  sessionRef: "session-a",
  cancelled: false,
  observedAt: "2026-09-11T12:00:00.000Z",
};

function withRoot(run: (artifactDir: string) => Promise<void> | void): Promise<void> {
  const artifactDir = mkdtempSync(join(tmpdir(), "subagent-runtime-test-"));
  return Promise.resolve(run(artifactDir)).finally(() => rmSync(artifactDir, { recursive: true, force: true }));
}

describe("lifecycle runtime integration", () => {
  it("admits fresh, nested, and resumed callers under the same root before allocation", async () => {
    await withRoot((artifactDir) => {
      const first = admitLifecycleRun({ sessionId: "root", artifactDir, childId: "fresh", ownerId: "fresh-owner", maxActiveSubagents: 1 });
      markLifecycleRunning(first);
      assert.deepEqual(lifecycleEnvParts(first, (value) => `'${value}'`), ["PI_SUBAGENT_ROOT_ID='root'", `PI_SUBAGENT_ROOT_ARTIFACT_DIR='${artifactDir}'`]);
      const priorRoot = process.env.PI_SUBAGENT_ROOT_ID;
      const priorArtifact = process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR;
      process.env.PI_SUBAGENT_ROOT_ID = first.rootId;
      process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR = first.rootArtifactDir;
      try {
        const nested = () => admitLifecycleRun({ sessionId: "nested", artifactDir, childId: "nested", ownerId: "nested-owner", maxActiveSubagents: 1 });
        assert.throws(nested, (error: unknown) => error instanceof LifecycleError && error.code === "capacity-exhausted");
      } finally {
        if (priorRoot === undefined) delete process.env.PI_SUBAGENT_ROOT_ID; else process.env.PI_SUBAGENT_ROOT_ID = priorRoot;
        if (priorArtifact === undefined) delete process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR; else process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR = priorArtifact;
      }
      persistLifecycleTerminal(first, evidence);
      return settleLifecycleRun(first, {});
    });
  });

  it("persists evidence then isolates delivery, cleanup, and layout failures from release", async () => {
    await withRoot(async (artifactDir) => {
      const run = admitLifecycleRun({ sessionId: "root", artifactDir, childId: "child", ownerId: "owner", maxActiveSubagents: 1 });
      persistLifecycleTerminal(run, evidence);
      const calls: string[] = [];
      await settleLifecycleRun(run, {
        extraction: () => { calls.push("extract"); throw new Error("parse failure"); },
        delivery: () => { calls.push("deliver"); throw new Error("parent unavailable"); },
        cleanup: () => { calls.push("cleanup"); throw new Error("close failure"); },
        layout: () => { calls.push("layout"); throw new Error("layout failure"); },
      });
      const record = run.coordinator.inspect().children.child!;
      assert.deepEqual(record.terminalEvidence, evidence);
      assert.equal(record.lease.state, "released");
      assert.deepEqual(calls, ["extract", "deliver", "cleanup", "layout"]);
      assert.equal(record.transitions.delivery.status, "ambiguous");
      assert.equal(record.transitions.release.status, "complete");
      assert.equal(record.transitions.cleanup.status, "pending");
    });
  });

  it("does not rerun claimed-complete terminal actions after a duplicate callback", async () => {
    await withRoot(async (artifactDir) => {
      const run = admitLifecycleRun({ sessionId: "root", artifactDir, childId: "child", ownerId: "owner", maxActiveSubagents: 1 });
      persistLifecycleTerminal(run, evidence);
      let delivered = 0;
      await settleLifecycleRun(run, { delivery: () => { delivered++; } });
      await settleLifecycleRun(run, { delivery: () => { delivered++; } });
      assert.equal(delivered, 1);
      assert.equal(run.coordinator.inspect().activeCount, 0);
    });
  });
});
