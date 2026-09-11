import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PaneLayoutCoordinator,
  type HerdrExecutor,
} from "../pi-extension/subagents/herdr.ts";

const ROOT = "workspace:p1";

type Call = { args: string[]; timeoutMs: number; aborted: boolean };

class FakeHerdr implements HerdrExecutor {
  readonly active = new Set<string>([ROOT]);
  readonly calls: Call[] = [];
  nextPane = 2;
  foreign = false;
  malformed = false;
  skew = false;
  failNextResize = false;
  failNextSplit = false;
  failNextClose = false;

  async run(args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string }> {
    this.calls.push({ args: [...args], timeoutMs: options.timeoutMs, aborted: options.signal?.aborted === true });
    if (options.signal?.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    if (args[0] !== "pane") throw new Error("unexpected Herdr command");
    if (args[1] === "layout") {
      if (this.malformed) return { stdout: JSON.stringify({ result: { layout: { nope: true } } }) };
      return { stdout: JSON.stringify(this.layout()) };
    }
    if (args[1] === "split") {
      if (this.failNextSplit) {
        this.failNextSplit = false;
        throw Object.assign(new Error("split exited"), { code: "EPIPE" });
      }
      const paneId = `workspace:p${this.nextPane++}`;
      this.active.add(paneId);
      return { stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }) };
    }
    if (args[1] === "close") {
      if (this.failNextClose) {
        this.failNextClose = false;
        throw Object.assign(new Error("close exited"), { code: "EPIPE" });
      }
      this.active.delete(args[2]!);
      return { stdout: JSON.stringify({ result: {} }) };
    }
    if (args[1] === "resize") {
      if (this.failNextResize) {
        this.failNextResize = false;
        throw Object.assign(new Error("temporary resize failure"), { code: "EPIPE" });
      }
      return { stdout: JSON.stringify({ result: {} }) };
    }
    throw new Error(`unexpected Herdr subcommand ${args[1]}`);
  }

  private layout() {
    const panes = [...this.active].map((pane_id, index) => ({
      pane_id,
      rect: {
        x: index * 20,
        y: 0,
        width: this.skew && index === 0 ? 80 : 20,
        height: 40,
      },
    }));
    if (this.foreign) panes.push({ pane_id: "foreign:p99", rect: { x: 140, y: 0, width: 20, height: 40 } });
    return { result: { layout: { area: { x: 0, y: 0, width: 160, height: 90 }, panes } } };
  }
}

function callsFor(fake: FakeHerdr, command: string) {
  return fake.calls.filter(({ args }) => args[1] === command);
}

describe("async owner-safe Herdr pane coordinator", () => {
  it("uses explicit argv and a fixed timeout while growing from one through eight owned panes", async () => {
    const fake = new FakeHerdr();
    const coordinator = new PaneLayoutCoordinator({ rootPaneId: ROOT, executor: fake, commandTimeoutMs: 321 });

    for (let expected = 2; expected <= 8; expected++) {
      await coordinator.allocate();
      assert.equal(coordinator.ownedPaneIds.size + 1, expected);
    }

    const splitCalls = callsFor(fake, "split");
    assert.equal(splitCalls.length, 7);
    assert.deepEqual(fake.calls[0]!.args, ["pane", "layout", "--pane", ROOT]);
    assert.deepEqual(splitCalls[0]!.args, ["pane", "split", ROOT, "--direction", "down", "--no-focus"]);
    assert.ok(fake.calls.every((call) => call.timeoutMs === 321));
    assert.ok(fake.calls.every((call) => call.args.every((argument) => !argument.includes(";"))));
  });

  it("returns each concurrently allocated pane to its own launch", async () => {
    const fake = new FakeHerdr();
    const coordinator = new PaneLayoutCoordinator({ rootPaneId: ROOT, executor: fake });
    const [firstPane, secondPane] = await Promise.all([coordinator.allocate(), coordinator.allocate()]);

    assert.notEqual(firstPane, secondPane);
    assert.ok(coordinator.ownedPaneIds.has(firstPane));
    assert.ok(coordinator.ownedPaneIds.has(secondPane));
  });

  it("coalesces concurrent reconciliation and treats malformed, abort, timeout, and transient failures as bounded outcomes", async () => {
    const fake = new FakeHerdr();
    const coordinator = new PaneLayoutCoordinator({ rootPaneId: ROOT, executor: fake });
    await coordinator.allocate();

    const first = coordinator.reconcile();
    const second = coordinator.reconcile();
    assert.equal(first, second);
    await first;

    fake.malformed = true;
    const malformed = await coordinator.reconcile();
    assert.equal(malformed.state, "failed");
    assert.equal(malformed.reason, "malformed-layout");
    fake.malformed = false;

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await coordinator.reconcile(aborted.signal);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.reason, "aborted");

    const timeoutExecutor: HerdrExecutor = {
      async run() {
        throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
      },
    };
    const timedOut = await new PaneLayoutCoordinator({ rootPaneId: ROOT, executor: timeoutExecutor }).reconcile();
    assert.deepEqual({ state: timedOut.state, reason: timedOut.reason }, { state: "failed", reason: "command-timeout" });

    fake.skew = true;
    fake.failNextResize = true;
    const failed = await coordinator.reconcile();
    assert.equal(failed.reason, "command-failed");
    const recovered = await coordinator.reconcile();
    assert.equal(recovered.state, "completed");
    assert.equal(recovered.reason, "planned");
  });

  it("allocates from its root without rebalancing a mixed ancestor branch", async () => {
    const fake = new FakeHerdr();
    fake.foreign = true;
    const coordinator = new PaneLayoutCoordinator({ rootPaneId: ROOT, executor: fake });

    const paneId = await coordinator.allocate();

    assert.equal(paneId, "workspace:p2");
    assert.deepEqual([...coordinator.ownedPaneIds], ["workspace:p2"]);
    assert.deepEqual(fake.calls.map(({ args }) => args[1]), ["layout", "split", "layout"]);
    assert.deepEqual(callsFor(fake, "split")[0]?.args.slice(2), [ROOT, "--direction", "down", "--no-focus"]);
    assert.equal(callsFor(fake, "resize").length, 0);
  });

  it("never mutates a foreign or stale pane and makes repeated cleanup idempotent", async () => {
    const foreign = new FakeHerdr();
    foreign.foreign = true;
    const isolated = new PaneLayoutCoordinator({ rootPaneId: ROOT, executor: foreign });
    const mixed = await isolated.reconcile();
    assert.deepEqual({ state: mixed.state, reason: mixed.reason }, { state: "skipped", reason: "mixed-ownership" });
    assert.deepEqual(foreign.calls.map(({ args }) => args[1]), ["layout"]);

    const fake = new FakeHerdr();
    const coordinator = new PaneLayoutCoordinator({ rootPaneId: ROOT, executor: fake });
    const panes = [await coordinator.allocate(), await coordinator.allocate(), await coordinator.allocate()];
    const failedClosePane = panes[1]!;
    fake.failNextClose = true;
    assert.equal((await coordinator.close(failedClosePane)).reason, "command-failed");
    assert.equal((await coordinator.close(failedClosePane)).state, "completed");
    assert.equal((await coordinator.close(panes[2]!)).state, "completed");
    assert.equal((await coordinator.close(panes[0]!)).state, "completed");
    const closeCount = callsFor(fake, "close").length;
    const duplicateClose = await coordinator.close(panes[0]!);
    assert.equal(duplicateClose.reason, "unknown-pane");
    assert.equal(callsFor(fake, "close").length, closeCount);

    const staleFake = new FakeHerdr();
    const staleCoordinator = new PaneLayoutCoordinator({ rootPaneId: ROOT, executor: staleFake });
    staleFake.failNextSplit = true;
    await assert.rejects(staleCoordinator.allocate(), /split failed: command-failed/);
    assert.equal(staleCoordinator.ownedPaneIds.size, 0);
    const stalePane = await staleCoordinator.allocate();
    staleFake.active.delete(stalePane);
    const stale = await staleCoordinator.reconcile();
    assert.deepEqual({ state: stale.state, reason: stale.reason }, { state: "skipped", reason: "stale-owned-pane" });
    assert.equal(callsFor(staleFake, "resize").length, 0);
  });
});
