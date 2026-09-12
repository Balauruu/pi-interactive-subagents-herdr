import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  admitLifecycleRun,
  persistLifecycleTerminal,
  settleLifecycleRun,
} from "../pi-extension/subagents/lifecycle-runtime.ts";
import { LifecycleError, RootTreeLifecycleCoordinator } from "../pi-extension/subagents/lifecycle.ts";
import {
  acknowledgeOwnedEvent,
  isOwnedEventAcknowledged,
  ownedInteractionEventIds,
  ownedQuestionEventId,
  ownedTerminalResultEventId,
  readNameRegistry,
  recoverLegacyOwnedNameInRegistry,
  registerName,
  resolveOwnedNameInRegistry,
  type OwnedNameRegistryEntry,
} from "../pi-extension/subagents/session.ts";

const evidence = {
  exitCode: 0,
  sentinel: "DONE",
  transcriptRef: "transcript-child",
  sessionRef: "session-child",
  cancelled: false,
  observedAt: "2026-09-11T12:00:00.000Z",
};

function withDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "owned-transition-test-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function ownedEntry(artifactDir: string): OwnedNameRegistryEntry {
  return {
    sessionFile: join(artifactDir, "child.jsonl"),
    sessionId: "child-session",
    ownership: {
      rootId: "root",
      parentId: "parent",
      parentArtifactDir: artifactDir,
      childId: "child",
      ownerId: "owner",
      eventIds: ownedInteractionEventIds({ rootId: "root", parentId: "parent", childId: "child", sessionId: "child-session" }),
    },
  };
}

describe("owned parent interaction transitions", () => {
  it("binds exact child names to one parent/root/owner and rejects foreign or malformed entries", async () => {
    await withDir((artifactDir) => {
      const entry = ownedEntry(artifactDir);
      registerName(artifactDir, "reviewer", entry);
      assert.deepEqual(resolveOwnedNameInRegistry({ artifactDir, name: "reviewer", rootId: "root", parentId: "parent", ownerId: "owner" }), entry);
      assert.equal(resolveOwnedNameInRegistry({ artifactDir, name: "reviewer", rootId: "other-root", parentId: "parent", ownerId: "owner" }), null);
      assert.equal(resolveOwnedNameInRegistry({ artifactDir, name: "REVIEWER", rootId: "root", parentId: "parent", ownerId: "owner" }), null);

      const registryPath = join(artifactDir, "subagent-registry.json");
      writeFileSync(registryPath, JSON.stringify({ reviewer: { ...entry, ownership: { ...entry.ownership, childId: "../foreign" } } }));
      assert.deepEqual(readNameRegistry(artifactDir), {});
      assert.equal(resolveOwnedNameInRegistry({ artifactDir, name: "reviewer", rootId: "root", parentId: "parent", ownerId: "owner" }), null);
    });
  });

  it("uses content-free stable question/result identities and acknowledgement no-ops", () => {
    const identity = { rootId: "root", parentId: "parent", childId: "child", sessionId: "child-session" };
    const question = ownedQuestionEventId(identity);
    const result = ownedTerminalResultEventId(identity);
    assert.equal(question, ownedQuestionEventId(identity));
    assert.notEqual(question, result);
    assert.match(question, /^question-[a-f0-9]{64}$/);
    const acknowledgement = acknowledgeOwnedEvent(question, "2026-09-11T12:00:00.000Z");
    assert.deepEqual(acknowledgement, { eventId: question, acknowledgedAt: "2026-09-11T12:00:00.000Z" });
    assert.equal(isOwnedEventAcknowledged(acknowledgement, question), true);
    assert.equal(isOwnedEventAcknowledged(acknowledgement, result), false);
    assert.throws(() => ownedQuestionEventId({ ...identity, childId: "../child" }), (error: unknown) => error instanceof LifecycleError && error.code === "invalid-identifier");
  });

  it("requires terminal evidence before notification and settles notification independently", async () => {
    await withDir(async (artifactDir) => {
      const run = admitLifecycleRun({ sessionId: "root", artifactDir, childId: "child", ownerId: "owner", maxActiveSubagents: 1 });
      assert.throws(() => run.coordinator.claimTransition({ childId: "child", ownerId: "owner", leaseToken: run.lease.token, transition: "notification" }), (error: unknown) => error instanceof LifecycleError && error.code === "terminal-evidence-required");
      persistLifecycleTerminal(run, evidence);
      const calls: string[] = [];
      await settleLifecycleRun(run, {
        delivery: () => calls.push("delivery"),
        notification: () => { calls.push("notification"); throw new Error("notification transport rejected"); },
        cleanup: () => calls.push("cleanup"),
        layout: () => calls.push("layout"),
      });
      const record = run.coordinator.inspect().children.child!;
      assert.deepEqual(calls, ["delivery", "cleanup", "layout", "notification"]);
      assert.equal(record.terminalEvidence?.sessionRef, "session-child");
      assert.equal(record.lease.state, "released");
      assert.equal(record.transitions.notification.status, "ambiguous");
      assert.equal(record.transitions.notification.attempts, 1);
      assert.equal(record.transitions.delivery.status, "complete");
      assert.equal(record.transitions.cleanup.status, "complete");
      assert.equal(record.transitions.layout.status, "complete");
    });
  });

  it("does not repeat externally visible notification after an ambiguous failure or claimed restart", async () => {
    await withDir(async (artifactDir) => {
      const run = admitLifecycleRun({ sessionId: "root", artifactDir, childId: "child", ownerId: "owner", maxActiveSubagents: 1 });
      persistLifecycleTerminal(run, evidence);
      let sends = 0;
      await settleLifecycleRun(run, { notification: () => { sends++; throw new Error("may have reached parent"); } });
      await settleLifecycleRun(run, { notification: () => { sends++; } });
      assert.equal(sends, 1);
      assert.equal(run.coordinator.inspect().children.child.transitions.notification.status, "ambiguous");

      const restart = admitLifecycleRun({ sessionId: "root", artifactDir, childId: "restart", ownerId: "owner", maxActiveSubagents: 1 });
      persistLifecycleTerminal(restart, evidence);
      assert.equal(restart.coordinator.claimTransition({ childId: "restart", ownerId: "owner", leaseToken: restart.lease.token, transition: "notification" }).claimed, true);
      const afterRestart = new RootTreeLifecycleCoordinator({ rootArtifactDir: artifactDir, rootId: "root", maxActiveSubagents: 1 });
      let restartSends = 0;
      await settleLifecycleRun({ ...restart, coordinator: afterRestart }, { notification: () => { restartSends++; } });
      assert.equal(restartSends, 0);
      assert.equal(afterRestart.inspect().children.restart.transitions.notification.status, "claimed");
    });
  });

  it("upgrades legacy records only with an exact parent-session proof", async () => {
    await withDir((artifactDir) => {
      const parentSessionFile = join(artifactDir, "parent.jsonl");
      const childSessionFile = join(artifactDir, "legacy-child.jsonl");
      writeFileSync(parentSessionFile, JSON.stringify({ type: "session", id: "parent-session" }) + "\n");
      writeFileSync(childSessionFile, JSON.stringify({ type: "session", id: "legacy-session", parentSession: parentSessionFile }) + "\n");
      registerName(artifactDir, "legacy", { sessionFile: childSessionFile, sessionId: "legacy-session" });
      const params = { artifactDir, name: "legacy", rootId: "root", parentId: "parent", ownerId: "owner", childId: "child", parentSessionFile };
      assert.equal(recoverLegacyOwnedNameInRegistry(params)?.ownership.parentId, "parent");
      assert.equal(recoverLegacyOwnedNameInRegistry({ ...params, parentSessionFile: join(artifactDir, "other-parent.jsonl") }), null);
    });
  });

  it("bounds notification retries without affecting other settled transitions", async () => {
    await withDir(async (artifactDir) => {
      const run = admitLifecycleRun({ sessionId: "root", artifactDir, childId: "child", ownerId: "owner", maxActiveSubagents: 1 });
      persistLifecycleTerminal(run, evidence);
      const transition = "notification" as const;
      assert.equal(run.coordinator.claimTransition({ childId: "child", ownerId: "owner", leaseToken: run.lease.token, transition }).claimed, true);
      run.coordinator.completeTransition({ childId: "child", ownerId: "owner", leaseToken: run.lease.token, transition, error: "local preparation failed" });
      assert.equal(run.coordinator.claimTransition({ childId: "child", ownerId: "owner", leaseToken: run.lease.token, transition }).claimed, true);
      run.coordinator.completeTransition({ childId: "child", ownerId: "owner", leaseToken: run.lease.token, transition, error: "local preparation failed" });
      assert.throws(() => run.coordinator.claimTransition({ childId: "child", ownerId: "owner", leaseToken: run.lease.token, transition }), (error: unknown) => error instanceof LifecycleError && error.code === "retry-exhausted");
      assert.equal(run.coordinator.releaseLease({ childId: "child", ownerId: "owner", leaseToken: run.lease.token }).released, true);
    });
  });
});
