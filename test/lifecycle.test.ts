import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  LifecycleError,
  RootTreeLifecycleCoordinator,
  deriveRootTreeId,
  type TerminalEvidence,
} from "../pi-extension/subagents/lifecycle.ts";

const EVIDENCE: TerminalEvidence = {
  exitCode: 0,
  sentinel: "SUBAGENT_DONE",
  transcriptRef: "transcript-child-a",
  sessionRef: "session-child-a",
  cancelled: false,
  observedAt: "2026-09-11T12:00:00.000Z",
};

function withCoordinator(
  options: { capacity?: number; rootId?: string; transitionAttempts?: number } = {},
  run: (coordinator: RootTreeLifecycleCoordinator, artifactDir: string) => void,
): void {
  const artifactDir = mkdtempSync(join(tmpdir(), "subagent-lifecycle-test-"));
  try {
    run(
      new RootTreeLifecycleCoordinator({
        rootArtifactDir: artifactDir,
        rootId: options.rootId ?? "root-session",
        maxActiveSubagents: options.capacity ?? 2,
        maxTransitionAttempts: options.transitionAttempts ?? 2,
      }),
      artifactDir,
    );
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

function expectCode(run: () => void, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof LifecycleError && error.code === code);
}

describe("root-tree lifecycle coordinator", () => {
  it("derives a stable inherited root and rejects unsafe identifiers", () => {
    assert.equal(deriveRootTreeId({ sessionId: "child-session", inheritedRootId: "root-session" }), "root-session");
    assert.equal(deriveRootTreeId({ sessionId: "root-session" }), "root-session");
    expectCode(
      () => deriveRootTreeId({ sessionId: "child", inheritedRootId: "../outside" }),
      "invalid-identifier",
    );
  });

  it("atomically admits exactly one contender for the final slot", () => {
    withCoordinator({ capacity: 1 }, (first, artifactDir) => {
      const second = new RootTreeLifecycleCoordinator({
        rootArtifactDir: artifactDir,
        rootId: "root-session",
        maxActiveSubagents: 1,
      });
      const admitted = first.acquire({ childId: "child-one", ownerId: "worker-one" });
      assert.equal(admitted.admitted, true);
      expectCode(
        () => second.acquire({ childId: "child-two", ownerId: "worker-two" }),
        "capacity-exhausted",
      );
      assert.deepEqual(Object.keys(first.inspect().children), ["child-one"]);
    });
  });

  it("shares a propagated root while isolating unrelated roots", () => {
    const parentRoot = deriveRootTreeId({ sessionId: "parent" });
    const nestedRoot = deriveRootTreeId({ sessionId: "nested", inheritedRootId: parentRoot });
    assert.equal(nestedRoot, parentRoot);

    withCoordinator({ rootId: parentRoot, capacity: 1 }, (parent, artifactDir) => {
      const resumed = new RootTreeLifecycleCoordinator({
        rootArtifactDir: artifactDir,
        rootId: nestedRoot,
        maxActiveSubagents: 1,
      });
      parent.acquire({ childId: "parent-child", ownerId: "parent-owner" });
      expectCode(
        () => resumed.acquire({ childId: "resumed-child", ownerId: "resume-owner" }),
        "capacity-exhausted",
      );
      const mismatchedBoundary = new RootTreeLifecycleCoordinator({
        rootArtifactDir: artifactDir,
        rootId: "wrong-root",
        maxActiveSubagents: 1,
      });
      expectCode(() => mismatchedBoundary.inspect(), "root-mismatch");

      const otherArtifactDir = mkdtempSync(join(tmpdir(), "subagent-lifecycle-other-root-"));
      try {
        const unrelated = new RootTreeLifecycleCoordinator({
          rootArtifactDir: otherArtifactDir,
          rootId: "other-root",
          maxActiveSubagents: 1,
        });
        assert.equal(unrelated.acquire({ childId: "other-child", ownerId: "other-owner" }).admitted, true);
      } finally {
        rmSync(otherArtifactDir, { recursive: true, force: true });
      }
    });
  });

  it("does not create a record for rejected admission", () => {
    withCoordinator({ capacity: 0 }, (coordinator, artifactDir) => {
      expectCode(() => coordinator.acquire({ childId: "child", ownerId: "owner" }), "capacity-exhausted");
      assert.equal(existsSync(join(artifactDir, "subagent-lifecycle.json")), false);
    });
  });

  it("counts every active phase, then makes matching release idempotent", () => {
    withCoordinator({ capacity: 1 }, (coordinator) => {
      const lease = coordinator.acquire({ childId: "child", ownerId: "owner" }).lease;
      assert.equal(coordinator.inspect().activeCount, 1);
      for (const phase of ["running", "waiting", "interactive"] as const) {
        coordinator.updatePhase({ childId: "child", ownerId: "owner", leaseToken: lease.token, phase });
        assert.equal(coordinator.inspect().activeCount, 1);
      }
      coordinator.persistTerminalEvidence({ childId: "child", ownerId: "owner", leaseToken: lease.token, evidence: EVIDENCE });
      assert.equal(coordinator.releaseLease({ childId: "child", ownerId: "owner", leaseToken: lease.token }).released, true);
      assert.equal(coordinator.releaseLease({ childId: "child", ownerId: "owner", leaseToken: lease.token }).released, false);
      assert.equal(coordinator.inspect().activeCount, 0);
    });
  });

  it("requires the lease owner and token for mutation", () => {
    withCoordinator({}, (coordinator) => {
      const lease = coordinator.acquire({ childId: "child", ownerId: "owner" }).lease;
      expectCode(
        () => coordinator.updatePhase({ childId: "child", ownerId: "intruder", leaseToken: lease.token, phase: "running" }),
        "ownership-mismatch",
      );
      expectCode(
        () => coordinator.releaseLease({ childId: "child", ownerId: "owner", leaseToken: "wrong-token" }),
        "lease-mismatch",
      );
    });
  });

  it("rejects replayed child ids and malformed evidence without allocating another record", () => {
    withCoordinator({}, (coordinator) => {
      const lease = coordinator.acquire({ childId: "child", ownerId: "owner" }).lease;
      assert.equal(coordinator.acquire({ childId: "child", ownerId: "owner" }).admitted, false);
      expectCode(() => coordinator.acquire({ childId: "child", ownerId: "other-owner" }), "duplicate-child");
      expectCode(() => coordinator.acquire({ childId: "../child", ownerId: "owner" }), "invalid-identifier");
      expectCode(
        () => coordinator.persistTerminalEvidence({
          childId: "child",
          ownerId: "owner",
          leaseToken: lease.token,
          evidence: { ...EVIDENCE, prompt: "must not persist" } as TerminalEvidence,
        }),
        "invalid-evidence",
      );
      assert.equal(Object.keys(coordinator.inspect().children).length, 1);
    });
  });

  it("persists terminal evidence once and keeps it immutable across duplicate callbacks", () => {
    withCoordinator({}, (coordinator) => {
      const lease = coordinator.acquire({ childId: "child", ownerId: "owner" }).lease;
      assert.equal(
        coordinator.persistTerminalEvidence({ childId: "child", ownerId: "owner", leaseToken: lease.token, evidence: EVIDENCE }).persisted,
        true,
      );
      assert.equal(
        coordinator.persistTerminalEvidence({ childId: "child", ownerId: "owner", leaseToken: lease.token, evidence: EVIDENCE }).persisted,
        false,
      );
      expectCode(
        () => coordinator.persistTerminalEvidence({
          childId: "child",
          ownerId: "owner",
          leaseToken: lease.token,
          evidence: { ...EVIDENCE, exitCode: 1 },
        }),
        "terminal-evidence-immutable",
      );
      assert.deepEqual(coordinator.inspect().children.child.terminalEvidence, EVIDENCE);
    });
  });

  it("persists cancellation evidence before releasing its admission lease", () => {
    withCoordinator({ capacity: 1 }, (coordinator) => {
      const lease = coordinator.acquire({ childId: "child", ownerId: "owner" }).lease;
      const cancelled = { ...EVIDENCE, exitCode: null, cancelled: true };
      assert.equal(
        coordinator.persistTerminalEvidence({ childId: "child", ownerId: "owner", leaseToken: lease.token, evidence: cancelled }).record.phase,
        "cancelled",
      );
      assert.deepEqual(coordinator.inspect().children.child.terminalEvidence, cancelled);
      assert.equal(coordinator.releaseLease({ childId: "child", ownerId: "owner", leaseToken: lease.token }).released, true);
      assert.equal(coordinator.inspect().activeCount, 0);
    });
  });

  it("requires immutable terminal evidence before settlement, then fences and bounds claims", () => {
    withCoordinator({ transitionAttempts: 2 }, (coordinator) => {
      const lease = coordinator.acquire({ childId: "child", ownerId: "owner" }).lease;
      expectCode(
        () => coordinator.claimTransition({ childId: "child", ownerId: "owner", leaseToken: lease.token, transition: "delivery" }),
        "terminal-evidence-required",
      );
      expectCode(
        () => coordinator.releaseLease({ childId: "child", ownerId: "owner", leaseToken: lease.token }),
        "terminal-evidence-required",
      );
      coordinator.persistTerminalEvidence({ childId: "child", ownerId: "owner", leaseToken: lease.token, evidence: EVIDENCE });
      assert.equal(coordinator.claimTransition({ childId: "child", ownerId: "owner", leaseToken: lease.token, transition: "delivery" }).claimed, true);
      coordinator.completeTransition({
        childId: "child",
        ownerId: "owner",
        leaseToken: lease.token,
        transition: "delivery",
        error: "parent unavailable",
      });
      assert.equal(coordinator.inspect().children.child.lastTransitionError, "delivery: parent unavailable");
      assert.equal(coordinator.claimTransition({ childId: "child", ownerId: "owner", leaseToken: lease.token, transition: "delivery" }).claimed, true);
      expectCode(
        () => coordinator.claimTransition({ childId: "child", ownerId: "owner", leaseToken: lease.token, transition: "delivery" }),
        "retry-exhausted",
      );
      expectCode(
        () => coordinator.completeTransition({ childId: "child", ownerId: "intruder", leaseToken: lease.token, transition: "delivery" }),
        "ownership-mismatch",
      );
      assert.equal(coordinator.completeTransition({ childId: "child", ownerId: "owner", leaseToken: lease.token, transition: "delivery" }).completed, true);
      assert.equal(coordinator.completeTransition({ childId: "child", ownerId: "owner", leaseToken: lease.token, transition: "delivery" }).completed, false);
    });
  });

  it("rejects state that is syntactically valid but violates lifecycle invariants", () => {
    withCoordinator({}, (coordinator, artifactDir) => {
      coordinator.acquire({ childId: "child", ownerId: "owner" });
      const state = JSON.parse(readFileSync(join(artifactDir, "subagent-lifecycle.json"), "utf8"));
      state.children.child.phase = "terminal";
      writeFileSync(join(artifactDir, "subagent-lifecycle.json"), JSON.stringify(state), "utf8");
      expectCode(() => coordinator.inspect(), "malformed-state");
    });
  });

  it("rejects transition errors that cannot fit in the persisted state", () => {
    withCoordinator({}, (coordinator) => {
      const lease = coordinator.acquire({ childId: "child", ownerId: "owner" }).lease;
      coordinator.persistTerminalEvidence({ childId: "child", ownerId: "owner", leaseToken: lease.token, evidence: EVIDENCE });
      coordinator.claimTransition({ childId: "child", ownerId: "owner", leaseToken: lease.token, transition: "extraction" });
      expectCode(
        () => coordinator.completeTransition({ childId: "child", ownerId: "owner", leaseToken: lease.token, transition: "extraction", error: "x".repeat(512) }),
        "invalid-configuration",
      );
      assert.equal(coordinator.inspect().children.child.transitions.extraction.status, "claimed");
    });
  });

  it("refuses corrupt state and contended or stale locks without speculative recovery", () => {
    withCoordinator({}, (coordinator, artifactDir) => {
      writeFileSync(join(artifactDir, "subagent-lifecycle.json"), "{truncated", "utf8");
      expectCode(() => coordinator.inspect(), "malformed-state");
    });

    withCoordinator({}, (coordinator, artifactDir) => {
      mkdirSync(join(artifactDir, "subagent-lifecycle.lock"));
      expectCode(() => coordinator.acquire({ childId: "child", ownerId: "owner" }), "lock-contended");
    });
  });
});
