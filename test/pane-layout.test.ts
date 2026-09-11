import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPaneOwnership,
  parseHerdrPaneLayout,
  planOwnedClose,
  planOwnedSplit,
  planPaneReconciliation,
  registerOwnedSplit,
  unregisterOwnedPane,
  type PaneOwnership,
} from "../pi-extension/subagents/pane-layout.ts";

function layout(panes: Array<{ pane_id: string; rect: { x: number; y: number; width: number; height: number } }>) {
  return {
    result: {
      layout: {
        area: { x: 0, y: 0, width: 160, height: 90 },
        panes,
      },
    },
  };
}

function equalLayout(ids: string[]) {
  return layout(ids.map((pane_id, index) => ({
    pane_id,
    rect: { x: index * 20, y: 0, width: 20, height: 20 },
  })));
}

function ownershipFor(ids: string[]): PaneOwnership {
  let ownership = createPaneOwnership(ids[0]!);
  for (const paneId of ids.slice(1)) {
    const registration = registerOwnedSplit(ownership, paneId);
    assert.equal(registration.state, "registered");
    ownership = registration.ownership;
  }
  return ownership;
}

describe("pane layout planner", () => {
  it("parses the Herdr response envelope and complete finite pane rectangles", () => {
    const parsed = parseHerdrPaneLayout(equalLayout(["root", "child"]));
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.layout.panes[1]!.paneId, "child");
      assert.deepEqual(parsed.layout.panes[1]!.rect, { x: 20, y: 0, width: 20, height: 20 });
    }
  });

  for (let count = 1; count <= 8; count++) {
    it(`uses proven ownership and remains already balanced at ${count} pane${count === 1 ? "" : "s"}`, () => {
      const ids = Array.from({ length: count }, (_, index) => index === 0 ? "root" : `owned-${index}`);
      const ownership = ownershipFor(ids);
      const plan = planPaneReconciliation(ownership, equalLayout(ids));

      assert.equal(plan.state, "completed");
      assert.equal(plan.reason, "already-balanced");
      assert.equal(plan.rootPaneId, "root");
      assert.equal(plan.ownedPaneCount, count - 1);
      assert.equal(plan.operationCount, 0);
      assert.deepEqual(plan.operations, []);
    });
  }

  it("chooses the largest owned leaf, its longest axis, and a stable pane-id tie", () => {
    const ownership = ownershipFor(["root", "alpha", "beta"]);
    const snapshot = layout([
      { pane_id: "root", rect: { x: 0, y: 0, width: 20, height: 80 } },
      { pane_id: "beta", rect: { x: 20, y: 0, width: 60, height: 30 } },
      { pane_id: "alpha", rect: { x: 80, y: 0, width: 60, height: 30 } },
    ]);

    assert.deepEqual(planOwnedSplit(ownership, snapshot).operations, [
      { kind: "split", paneId: "alpha", direction: "right" },
    ]);
    assert.deepEqual(planOwnedSplit(createPaneOwnership("root"), layout([
      { pane_id: "root", rect: { x: 0, y: 0, width: 12, height: 50 } },
    ])).operations, [
      { kind: "split", paneId: "root", direction: "down" },
    ]);
  });

  it("returns the same single-snapshot plan on repeated reconciliation", () => {
    const ownership = ownershipFor(["root", "owned-a", "owned-b"]);
    const snapshot = layout([
      { pane_id: "root", rect: { x: 0, y: 0, width: 100, height: 60 } },
      { pane_id: "owned-a", rect: { x: 100, y: 0, width: 20, height: 20 } },
      { pane_id: "owned-b", rect: { x: 120, y: 0, width: 10, height: 20 } },
    ]);

    const first = planPaneReconciliation(ownership, snapshot);
    const second = planPaneReconciliation(ownership, snapshot);
    assert.deepEqual(second, first);
    assert.ok(first.operations.every((operation) => ownership.ownedPaneIds.has(operation.paneId) || operation.paneId === "root"));
  });

  it("supports non-LIFO cleanup, duplicate close, and never closes an unproven pane", () => {
    let ownership = ownershipFor(["root", "one", "two", "three"]);
    const before = equalLayout(["root", "one", "two", "three"]);
    assert.deepEqual(planOwnedClose(ownership, before, "two").operations, [{ kind: "close", paneId: "two" }]);
    ownership = unregisterOwnedPane(ownership, "two");

    const after = equalLayout(["root", "one", "three"]);
    const duplicate = planOwnedClose(ownership, after, "two");
    assert.equal(duplicate.state, "skipped");
    assert.equal(duplicate.reason, "unknown-pane");
    const stale = planOwnedClose(ownershipFor(["root", "one", "two"]), after, "two");
    assert.equal(stale.state, "completed");
    assert.equal(stale.reason, "already-closed");
    const foreign = planOwnedClose(ownership, after, "foreign-pane");
    assert.equal(foreign.reason, "unknown-pane");
    assert.equal(foreign.operationCount, 0);
    const root = planOwnedClose(ownership, after, "root");
    assert.equal(root.reason, "root-pane-protected");
    assert.equal(root.operationCount, 0);
    const closeBeforeLayout = planOwnedClose(ownership, {}, "one");
    assert.equal(closeBeforeLayout.reason, "malformed-layout");
    assert.equal(closeBeforeLayout.operationCount, 0);
  });

  it("fences a foreign branch before split or rebalance and does not target it", () => {
    const ownership = ownershipFor(["root", "owned"]);
    const snapshot = equalLayout(["root", "owned", "foreign"]);
    for (const plan of [planOwnedSplit(ownership, snapshot), planPaneReconciliation(ownership, snapshot)]) {
      assert.equal(plan.state, "skipped");
      assert.equal(plan.reason, "mixed-ownership");
      assert.equal(plan.operationCount, 0);
    }
  });

  it("rejects malformed, empty, duplicate, forged, non-finite, and negative input without operations", () => {
    const ownership = ownershipFor(["root", "owned"]);
    const malformed = [
      {},
      { result: { layout: { area: { x: 0, y: 0, width: 1, height: 1 }, panes: [] } } },
      layout([
        { pane_id: "root", rect: { x: 0, y: 0, width: 1, height: 1 } },
        { pane_id: "root", rect: { x: 1, y: 0, width: 1, height: 1 } },
      ]),
      layout([
        { pane_id: "root", rect: { x: 0, y: 0, width: Number.NaN, height: 1 } },
        { pane_id: "owned", rect: { x: 1, y: 0, width: 1, height: 1 } },
      ]),
      layout([
        { pane_id: "root", rect: { x: 0, y: 0, width: -1, height: 1 } },
        { pane_id: "owned", rect: { x: 1, y: 0, width: 1, height: 1 } },
      ]),
    ];
    for (const snapshot of malformed) {
      const plan = planPaneReconciliation(ownership, snapshot);
      assert.equal(plan.operationCount, 0);
      assert.ok(["malformed-layout", "empty-layout", "duplicate-pane-id"].includes(plan.reason));
    }
    assert.equal(registerOwnedSplit(ownership, "owned").reason, "duplicate-owned-pane");
    assert.equal(registerOwnedSplit(ownership, " forged").reason, "invalid-pane-id");
  });

  it("reports stale ownership rather than resizing a changed layout", () => {
    const ownership = ownershipFor(["root", "gone"]);
    const plan = planPaneReconciliation(ownership, equalLayout(["root"]));
    assert.equal(plan.state, "skipped");
    assert.equal(plan.reason, "stale-owned-pane");
    assert.equal(plan.operationCount, 0);
  });

  it("returns cancellation before parsing or producing commands", () => {
    const controller = new AbortController();
    controller.abort();
    const plan = planPaneReconciliation(createPaneOwnership("root"), { raw: "not examined" }, { signal: controller.signal });
    assert.equal(plan.state, "cancelled");
    assert.equal(plan.reason, "aborted");
    assert.equal(plan.operationCount, 0);
  });

  it("fails safely when the fixed command budget would be exhausted", () => {
    const ownership = ownershipFor(["root", "one", "two", "three"]);
    const snapshot = layout([
      { pane_id: "root", rect: { x: 0, y: 0, width: 100, height: 100 } },
      { pane_id: "one", rect: { x: 100, y: 0, width: 8, height: 8 } },
      { pane_id: "two", rect: { x: 108, y: 0, width: 7, height: 7 } },
      { pane_id: "three", rect: { x: 115, y: 0, width: 6, height: 6 } },
    ]);
    const plan = planPaneReconciliation(ownership, snapshot, { maxOperations: 1 });
    assert.equal(plan.state, "failed");
    assert.equal(plan.reason, "command-budget-exhausted");
    assert.equal(plan.operationCount, 0);
    assert.deepEqual(plan.operations, []);
  });
});
