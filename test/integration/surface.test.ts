/**
 * Integration tests for the Herdr surface layer.
 *
 * These tests exercise real Herdr operations: creating panes, sending commands,
 * reading screen output, and closing panes. No LLM calls - fast and free.
 *
 * Run inside Herdr:
 *   herdr
 *   npm run test:integration
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  getFocusedSurface,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
if (backends.length === 0) {
  console.log("⚠️  Herdr is not available - skipping Herdr surface integration tests");
  console.log("   Run inside Herdr to enable these tests.");
}

for (const backend of backends) {
  describe(`Herdr surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    afterEach(() => {
      for (const surface of env.surfaces) {
        try {
          closeSurface(surface);
        } catch {}
      }
      env.surfaces = [];
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("keeps focus on the parent while Herdr creates non-focused panes", async () => {
      const initialFocus = getFocusedSurface();
      assert.ok(initialFocus, "The test runner should have a focused Herdr pane");
      createTrackedSurfaceSplit(env, "focus-anchor", "right");
      await sleep(1000);
      assert.equal(getFocusedSurface(), initialFocus);

      const childA = createTrackedSurface(env, "focus-child-a");
      await sleep(1000);
      assert.equal(getFocusedSurface(), initialFocus);

      const childB = createTrackedSurface(env, "focus-child-b");
      await sleep(1000);
      assert.equal(getFocusedSurface(), initialFocus);

      const markerA = uniqueId().slice(0, 4);
      const markerB = uniqueId().slice(0, 4);
      sendCommand(childA, `echo "FOCUS_A_${markerA}"`);
      sendCommand(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
      ]);
      assert.equal(getFocusedSurface(), initialFocus);
    });

    it("balances right-hand panes into equal columns", () => {
      const parent = getFocusedSurface();
      assert.ok(parent, "The test runner should have a focused Herdr pane");
      const surfaces = [
        createTrackedSurface(env, "balance-1"),
        createTrackedSurface(env, "balance-2"),
        createTrackedSurface(env, "balance-3"),
      ];

      const response = JSON.parse(
        execFileSync("herdr", ["pane", "layout", "--pane", parent], { encoding: "utf8" }),
      );
      const layout = response.result.layout;
      const widths = [parent, ...surfaces].map(
        (pane) => layout.panes.find((entry: any) => entry.pane_id === pane)?.rect.width,
      );

      assert.ok(widths.every((width) => typeof width === "number"));
      assert.ok(
        widths.every((width) => width === widths[0]),
        `Expected equal pane widths, got ${widths.join(", ")}`,
      );
    });

    it("stacks agents vertically after three horizontal agent columns", () => {
      const parent = getFocusedSurface();
      assert.ok(parent, "The test runner should have a focused Herdr pane");
      const surfaces = Array.from({ length: 4 }, (_, index) =>
        createTrackedSurface(env, `placement-${index + 1}`),
      );

      const response = JSON.parse(
        execFileSync("herdr", ["pane", "layout", "--pane", parent], { encoding: "utf8" }),
      );
      const panes = response.result.layout.panes;
      const rects = surfaces.map((pane) => {
        const rect = panes.find((entry: any) => entry.pane_id === pane)?.rect;
        assert.ok(rect, `Expected layout rect for ${pane}`);
        return rect;
      });

      assert.equal(new Set(rects.slice(0, 3).map((rect) => rect.x)).size, 3);
      assert.equal(rects[3].x, rects[0].x);
      assert.notEqual(rects[3].y, rects[0].y);
    });

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell special characters in echo output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(1000);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`SPEC_${marker}`),
        `Expected special-char output. Got:\n${screen}`,
      );
      // $ should be literal inside single quotes
      assert.ok(
        screen.includes("$HOME"),
        `Expected literal $HOME in output. Got:\n${screen}`,
      );
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(1000);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      const command = `echo "LONG_${marker}_${longValue}_END"`;

      sendLongCommand(surface, command);
      await sleep(2000);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.includes(`LONG_${marker}`),
        `Expected long command output. Got:\n${screen.slice(0, 300)}...`,
      );
      assert.ok(
        screen.includes("_END"),
        `Expected full output (not truncated). Got:\n${screen.slice(-300)}`,
      );
    });

    it("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await sleep(1500);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(
        screen.includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      await sleep(1500);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);
      await sleep(1500);

      const screen1 = readScreen(s1, 50);
      const screen2 = readScreen(s2, 50);

      assert.ok(screen1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(screen2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    it("writes output to a file and verifies via surface", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(1000);

      const marker = uniqueId();
      const filePath = `/tmp/pi-herdr-test-${marker}.txt`;

      sendCommand(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`);

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 10_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      // Clean up
      try {
        unlinkSync(filePath);
      } catch {}
    });
  });
}
