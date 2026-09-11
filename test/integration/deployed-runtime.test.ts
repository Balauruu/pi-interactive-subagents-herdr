import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadExtensionConfig } from "../../pi-extension/subagents/status.ts";
import { formatLiveTestPreflightFailure, preflightLiveTest } from "../live-test-guard.ts";
import {
  PI_TIMEOUT,
  cleanupPaneLayoutWorkspace,
  cleanupTestEnv,
  createPaneLayoutWorkspace,
  createTestEnv,
  getAvailableBackends,
  getFocusedSurface,
  paneExists,
  readPaneLayout,
  readScreen,
  startDeployedPi,
  uniqueId,
  verifyDeployedRuntimeIdentity,
  waitForFile,
  waitForPiExit,
  waitForSessionContent,
  waitForScreen,
} from "./harness.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ACTIVE_AGENT_DIR = resolve(PROJECT_ROOT, "../../../..");
const ROLLBACK = join(ACTIVE_AGENT_DIR, "settings.json.m001-s06.rollback.json");
const MIN_AREA_RATIO = 0.60;
const liveTestPreflight = preflightLiveTest(process.env);
const backends = getAvailableBackends(liveTestPreflight);

function assertBalanced(rootPaneId: string, expectedPaneIds?: readonly string[]): void {
  const layout = readPaneLayout(rootPaneId);
  if (expectedPaneIds) assert.deepEqual(new Set(layout.panes.map((pane) => pane.paneId)), new Set(expectedPaneIds));
  const areas = layout.panes.map((pane) => pane.rect.width * pane.rect.height);
  const smallest = Math.min(...areas);
  const largest = Math.max(...areas);
  assert.ok(smallest / largest >= MIN_AREA_RATIO, `layout area ratio ${smallest / largest} is below ${MIN_AREA_RATIO}`);
}

function boundedDiagnostics(rootPaneId: string, parentPaneId: string, phase: string): string {
  let layout = "unavailable";
  let screen = "unavailable";
  try {
    layout = JSON.stringify(readPaneLayout(rootPaneId).panes.map((pane) => ({
      paneId: pane.paneId,
      area: pane.rect.width * pane.rect.height,
    })));
  } catch {}
  try {
    screen = readScreen(parentPaneId, 120).slice(-1200);
  } catch {}
  return `phase=${phase}; layout=${layout}; parent-screen=${screen}`;
}

if (liveTestPreflight.status === "disabled") {
  test("deployed runtime integration requires PI_LIVE_TESTS=1", { skip: "PI_LIVE_TESTS is not enabled" }, () => {});
} else if (liveTestPreflight.status === "rejected") {
  test("deployed runtime integration preflight fails closed", () => assert.fail(formatLiveTestPreflightFailure(liveTestPreflight)));
} else if (backends.length === 0) {
  test("deployed runtime integration requires available Herdr infrastructure", () =>
    assert.fail("Live test guard rejected: Herdr infrastructure is unavailable."),
  );
} else {
  test("normal package auto-discovery enforces admission and cleans owned Herdr panes", { timeout: PI_TIMEOUT * 4 }, async () => {
    let phase = "identity";
    let env: ReturnType<typeof createTestEnv> | undefined;
    let workspace: ReturnType<typeof createPaneLayoutWorkspace> | undefined;
    let sentinelWorkspace: ReturnType<typeof createPaneLayoutWorkspace> | undefined;
    let parentPaneId = "not-created";
    try {
      // This is intentionally before any temporary workspace, pane, or Pi process.
      verifyDeployedRuntimeIdentity({ agentDir: ACTIVE_AGENT_DIR, repo: PROJECT_ROOT, rollback: ROLLBACK });
      const config = loadExtensionConfig(join(PROJECT_ROOT, "config.json"));
      assert.ok(config.maxActiveSubagents >= 1 && config.maxActiveSubagents <= 4, "bounded smoke refuses an unsafe configured cap");
      const cap = config.maxActiveSubagents;
      const callerPaneId = getFocusedSurface();
      assert.ok(callerPaneId, "the live test runner requires a focused Herdr caller pane");

      phase = "workspace";
      env = createTestEnv();
      workspace = createPaneLayoutWorkspace(`deployed-runtime-${uniqueId()}`);
      sentinelWorkspace = createPaneLayoutWorkspace(`deployed-sentinel-${uniqueId()}`);
      const sentinelPaneId = sentinelWorkspace.rootPaneId;
      parentPaneId = workspace.rootPaneId;
      assertBalanced(parentPaneId, [parentPaneId]);
      assertBalanced(sentinelPaneId, [sentinelPaneId]);
      assert.equal(getFocusedSurface(), callerPaneId, "no-focus setup must preserve the caller focus");

      const id = uniqueId();
      const startFiles = Array.from({ length: cap }, (_, index) => join(env!.dir, `started-${index}.txt`));
      const doneFiles = Array.from({ length: cap }, (_, index) => join(env!.dir, `done-${index}.txt`));
      const replacementFile = join(env.dir, "replacement.txt");
      const extraFile = join(env.dir, "denied-extra.txt");
      const childCalls = startFiles.map((startFile, index) => [
        `Call ${index + 1}: name "Deploy-${id}-${index}", agent "test-echo",`,
        `task "Run exactly: echo START_${id}_${index} > '${startFile}'; sleep 12; echo DONE_${id}_${index} > '${doneFiles[index]}'".`,
      ].join(" "));
      const task = [
        `Use the auto-discovered subagent tool only. Make exactly ${cap} calls immediately before waiting for results:`,
        ...childCalls,
        `Then make one additional call named "Denied-${id}" with agent "test-echo" and task "echo DENIED_${id} > '${extraFile}'" while the first ${cap} are active.`,
        `The additional call must be rejected by the configured active-subagent limit. Do not retry it.`,
        `After all successful child results arrive, make one replacement call named "Replacement-${id}" with agent "test-echo" and task "echo REPLACEMENT_${id} > '${replacementFile}'".`,
        `After its result arrives, print exactly DEPLOYED_PARENT_COMPLETE_${id} and RESULT_DELIVERED_${id}.`,
      ].join("\n");

      phase = "parent-launch";
      startDeployedPi(parentPaneId, {
        agentDir: ACTIVE_AGENT_DIR,
        sessionDir: env.sessionDir,
        testDir: env.dir,
        task,
      });

      phase = "admission";
      await Promise.all(startFiles.map((file, index) => waitForFile(file, PI_TIMEOUT, new RegExp(`START_${id}_${index}`))));
      await waitForSessionContent(env.sessionDir, /root-tree admission capacity is exhausted/, PI_TIMEOUT);
      assert.equal(existsSync(extraFile), false, "cap+1 must be rejected before a child process can write its marker");
      assertBalanced(parentPaneId);
      assert.equal(readPaneLayout(parentPaneId).panes.length, cap + 1, "cap+1 must not allocate another child pane");

      phase = "delivery-and-release";
      await Promise.all(doneFiles.map((file, index) => waitForFile(file, PI_TIMEOUT, new RegExp(`DONE_${id}_${index}`))));
      await waitForFile(replacementFile, PI_TIMEOUT, new RegExp(`REPLACEMENT_${id}`));
      const screen = await waitForScreen(parentPaneId, new RegExp(`DEPLOYED_PARENT_COMPLETE_${id}[\\s\\S]*RESULT_DELIVERED_${id}`), PI_TIMEOUT, 180);
      assert.match(screen, new RegExp(`RESULT_DELIVERED_${id}`), "parent must receive terminal child results");
      assert.equal(await waitForPiExit(parentPaneId, PI_TIMEOUT), 0, "isolated parent Pi must exit cleanly");

      phase = "owner-cleanup";
      assertBalanced(parentPaneId, [parentPaneId]);
      assertBalanced(sentinelPaneId, [sentinelPaneId]);
      assert.equal(paneExists(sentinelPaneId, sentinelPaneId), true, "unrelated sentinel pane must survive child cleanup");
      assert.equal(paneExists(parentPaneId, parentPaneId), true, "parent pane must survive child cleanup");
      assert.equal(getFocusedSurface(), callerPaneId, "child spawn and cleanup must preserve caller focus");
    } catch (error) {
      const detail = workspace ? boundedDiagnostics(workspace.rootPaneId, parentPaneId, phase) : `phase=${phase}; workspace=not-created`;
      throw new Error(`Deployed runtime proof failed: ${detail}`, { cause: error });
    } finally {
      if (workspace) cleanupPaneLayoutWorkspace(workspace);
      if (sentinelWorkspace) cleanupPaneLayoutWorkspace(sentinelWorkspace);
      if (env) await cleanupTestEnv(env);
    }
  });
}
