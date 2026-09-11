/**
 * Real, provider-free coverage for owner-scoped Herdr layout reconciliation.
 *
 * This suite intentionally runs only inside a live Herdr pane. It creates its
 * own no-focus workspace and always removes that workspace in finally cleanup.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PaneLayoutCoordinator,
  createHerdrExecutor,
  type HerdrExecutor,
  type PaneLayoutOutcome,
} from "../../pi-extension/subagents/herdr.ts";
import {
  cleanupPaneLayoutWorkspace,
  createPaneLayoutWorkspace,
  getFocusedSurface,
  isPaneLayoutIntegrationAvailable,
  readPaneLayout,
  uniqueId,
} from "./harness.ts";

const MIN_AREA_RATIO = 0.60;

function assertOwnedLayout(rootPaneId: string, ownedPaneIds: ReadonlySet<string>): void {
  const expected = new Set([rootPaneId, ...ownedPaneIds]);
  const layout = readPaneLayout(rootPaneId);
  assert.deepEqual(
    new Set(layout.panes.map((pane) => pane.paneId)),
    expected,
    "the temporary workspace contains only the trusted root and coordinator-owned panes",
  );

  const areas = layout.panes.map((pane) => pane.rect.width * pane.rect.height);
  const smallest = Math.min(...areas);
  const largest = Math.max(...areas);
  assert.ok(
    smallest / largest >= MIN_AREA_RATIO,
    `expected a reasonably symmetric layout (area ratio >= ${MIN_AREA_RATIO}), got ${smallest / largest}`,
  );
}

function assertOutcome(outcome: PaneLayoutOutcome, rootPaneId: string, ownedPaneCount: number): void {
  assert.equal(outcome.rootPaneId, rootPaneId);
  assert.equal(outcome.ownerPaneCount, ownedPaneCount);
  assert.ok(outcome.operationCount >= 0 && outcome.operationCount <= 8);
  assert.ok(["completed", "skipped", "cancelled", "failed"].includes(outcome.state));
  assert.equal(typeof outcome.reason, "string");
}

if (!isPaneLayoutIntegrationAvailable()) {
  test("pane layout integration requires PI_LIVE_TESTS=1 inside Herdr", { skip: "live Herdr caller context is unavailable" }, () => {});
} else {
  test("keeps real Herdr layout balanced and owner-scoped through spawn and cleanup", { timeout: 60_000 }, async () => {
    const callerPaneId = getFocusedSurface();
    assert.ok(callerPaneId, "the test process must have a caller pane");

    const workspace = createPaneLayoutWorkspace(`pi-layout-${uniqueId()}`);
    const commands: string[][] = [];
    const baseExecutor = createHerdrExecutor();
    const executor: HerdrExecutor = {
      async run(args, options) {
        commands.push([...args]);
        return baseExecutor.run(args, options);
      },
    };
    const coordinator = new PaneLayoutCoordinator({
      rootPaneId: workspace.rootPaneId,
      executor,
      commandTimeoutMs: 3_000,
      maxOperations: 8,
    });

    try {
      assertOwnedLayout(workspace.rootPaneId, coordinator.ownedPaneIds);

      const firstPaneId = await coordinator.allocate();
      assertOwnedLayout(workspace.rootPaneId, coordinator.ownedPaneIds);

      const secondPaneId = await coordinator.allocate();
      assertOwnedLayout(workspace.rootPaneId, coordinator.ownedPaneIds);
      assert.ok(
        commands.some((args) => args[0] === "pane" && args[1] === "resize"),
        "the real three-pane sequence performs a bounded Herdr resize",
      );

      const settled = await coordinator.reconcile();
      assertOutcome(settled, workspace.rootPaneId, 2);
      assert.notEqual(settled.state, "failed");
      assert.notEqual(settled.state, "cancelled");

      const firstClose = await coordinator.close(firstPaneId);
      assert.deepEqual(
        { state: firstClose.state, reason: firstClose.reason, ownerPaneCount: firstClose.ownerPaneCount },
        { state: "completed", reason: "planned", ownerPaneCount: 1 },
      );
      assertOwnedLayout(workspace.rootPaneId, coordinator.ownedPaneIds);

      const secondClose = await coordinator.close(secondPaneId);
      assert.deepEqual(
        { state: secondClose.state, reason: secondClose.reason, ownerPaneCount: secondClose.ownerPaneCount },
        { state: "completed", reason: "planned", ownerPaneCount: 0 },
      );
      assertOwnedLayout(workspace.rootPaneId, coordinator.ownedPaneIds);

      const repeatedClose = await coordinator.close(secondPaneId);
      assert.deepEqual(
        { state: repeatedClose.state, reason: repeatedClose.reason, operationCount: repeatedClose.operationCount },
        { state: "skipped", reason: "unknown-pane", operationCount: 0 },
      );
      assert.equal(getFocusedSurface(), callerPaneId, "no-focus workspace operations leave the caller pane unchanged");
    } finally {
      cleanupPaneLayoutWorkspace(workspace);
    }
  });
}
