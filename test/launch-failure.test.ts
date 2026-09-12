import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { RootTreeLifecycleCoordinator } from "../pi-extension/subagents/lifecycle.ts";
import {
  admitLifecycleRun,
  markLifecycleRunning,
} from "../pi-extension/subagents/lifecycle-runtime.ts";
import {
  registerName,
  writeSubagentLoadout,
  type SubagentLoadout,
} from "../pi-extension/subagents/session.ts";

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

it("releases admission when session-directory creation fails before pane allocation", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-launch-failure-"));
  const parentSessionDir = join(root, "parent-sessions");
  const targetCwd = join(root, "target");
  const localConfigDir = join(targetCwd, ".pi");
  const sessionId = "parent-session";
  const artifactDir = join(parentSessionDir, "artifacts", sessionId);
  const priorRootId = process.env.PI_SUBAGENT_ROOT_ID;
  const priorRootArtifactDir = process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR;

  mkdirSync(parentSessionDir, { recursive: true });
  mkdirSync(localConfigDir, { recursive: true });
  // resolveSubagentPaths treats an existing .pi/agent path as the config dir.
  // Making it a file forces getDefaultSessionDirFor() to fail with ENOTDIR.
  writeFileSync(join(localConfigDir, "agent"), "not a directory", "utf8");
  delete process.env.PI_SUBAGENT_ROOT_ID;
  delete process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR;
  __test__.setExtensionConfigForTest({
    maxActiveSubagents: 1,
    statusEnabled: false,
    stalledAfterMs: 60_000,
  });

  try {
    await assert.rejects(
      __test__.launchSubagent(
        { name: "worker", task: "fail before pane allocation", cwd: targetCwd } as never,
        {
          sessionManager: {
            getSessionFile: () => join(parentSessionDir, "parent.jsonl"),
            getSessionId: () => sessionId,
            getSessionDir: () => parentSessionDir,
          },
          cwd: targetCwd,
        },
      ),
      /ENOTDIR|not a directory/i,
    );

    const coordinator = new RootTreeLifecycleCoordinator({
      rootArtifactDir: artifactDir,
      rootId: sessionId,
      maxActiveSubagents: 1,
    });
    assert.equal(
      coordinator.inspect().activeCount,
      0,
      "a failed launch must release its root-tree admission slot",
    );
  } finally {
    __test__.setExtensionConfigForTest(null);
    if (priorRootId === undefined) delete process.env.PI_SUBAGENT_ROOT_ID;
    else process.env.PI_SUBAGENT_ROOT_ID = priorRootId;
    if (priorRootArtifactDir === undefined) delete process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR;
    else process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR = priorRootArtifactDir;
    rmSync(root, { recursive: true, force: true });
  }
});

it("releases admission and closes an allocated pane after a later launch failure", async () => {
  const rootArtifactDir = mkdtempSync(join(tmpdir(), "subagent-post-allocation-failure-"));
  const priorRootId = process.env.PI_SUBAGENT_ROOT_ID;
  const priorRootArtifactDir = process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR;
  delete process.env.PI_SUBAGENT_ROOT_ID;
  delete process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR;

  try {
    const lifecycle = admitLifecycleRun({
      sessionId: "parent-session",
      artifactDir: rootArtifactDir,
      childId: "child-failed-launch",
      ownerId: "owner-failed-launch",
      maxActiveSubagents: 1,
    });
    markLifecycleRunning(lifecycle);
    const closedSurfaces: string[] = [];

    await __test__.settleFailedLaunch(
      "failed-launch",
      lifecycle,
      "owned-pane",
      new Error("session seed failed"),
      async (surface: string) => {
        closedSurfaces.push(surface);
      },
    );

    const record = lifecycle.coordinator.inspect().children["child-failed-launch"]!;
    assert.deepEqual(closedSurfaces, ["owned-pane"]);
    assert.equal(lifecycle.coordinator.inspect().activeCount, 0);
    assert.equal(record.terminalEvidence?.cancelled, true);
    assert.equal(record.lease.state, "released");
    assert.equal(record.transitions.cleanup.status, "complete");
  } finally {
    if (priorRootId === undefined) delete process.env.PI_SUBAGENT_ROOT_ID;
    else process.env.PI_SUBAGENT_ROOT_ID = priorRootId;
    if (priorRootArtifactDir === undefined) delete process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR;
    else process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR = priorRootArtifactDir;
    rmSync(rootArtifactDir, { recursive: true, force: true });
  }
});

it("settles a resumed launch and preserves its error when pane cleanup fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-resume-launch-failure-"));
  const binDir = join(root, "bin");
  const parentSessionDir = join(root, "parent-sessions");
  const sessionId = "parent-session";
  const artifactDir = join(parentSessionDir, "artifacts", sessionId);
  const childSessionFile = join(root, "child-session.jsonl");
  const parentSessionFile = join(parentSessionDir, "parent-session.jsonl");
  const herdrStateFile = join(root, "herdr-state");
  const herdrLogFile = join(root, "herdr.log");
  const previousEnv = new Map([
    ["PATH", process.env.PATH],
    ["PI_SUBAGENT_ROOT_ID", process.env.PI_SUBAGENT_ROOT_ID],
    ["PI_SUBAGENT_ROOT_ARTIFACT_DIR", process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR],
    ["PI_SUBAGENT_SHELL_READY_DELAY_MS", process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS],
    ["FAKE_HERDR_STATE", process.env.FAKE_HERDR_STATE],
    ["FAKE_HERDR_LOG", process.env.FAKE_HERDR_LOG],
  ]);

  mkdirSync(binDir, { recursive: true });
  mkdirSync(parentSessionDir, { recursive: true });
  writeFileSync(parentSessionFile, JSON.stringify({ type: "session", id: sessionId, version: 3 }) + "\n");
  writeFileSync(childSessionFile, JSON.stringify({ type: "session", id: "child-session", version: 3 }) + "\n");
  writeFileSync(herdrStateFile, "root\n", "utf8");

  const fakeHerdr = join(binDir, "herdr");
  writeFileSync(
    fakeHerdr,
    [
      "#!/bin/sh",
      "set -eu",
      "printf '%s\\n' \"$*\" >> \"$FAKE_HERDR_LOG\"",
      "case \"$1 $2\" in",
      "  'pane current')",
      "    printf '%s\\n' '{\"result\":{\"pane\":{\"pane_id\":\"workspace:p1\"}}}'",
      "    ;;",
      "  'pane layout')",
      "    if grep -q allocated \"$FAKE_HERDR_STATE\"; then",
      "      printf '%s\\n' '{\"result\":{\"layout\":{\"area\":{\"x\":0,\"y\":0,\"width\":160,\"height\":80},\"panes\":[{\"pane_id\":\"workspace:p1\",\"rect\":{\"x\":0,\"y\":0,\"width\":80,\"height\":80}},{\"pane_id\":\"workspace:p2\",\"rect\":{\"x\":80,\"y\":0,\"width\":80,\"height\":80}}]}}}'",
      "    else",
      "      printf '%s\\n' '{\"result\":{\"layout\":{\"area\":{\"x\":0,\"y\":0,\"width\":160,\"height\":80},\"panes\":[{\"pane_id\":\"workspace:p1\",\"rect\":{\"x\":0,\"y\":0,\"width\":160,\"height\":80}}]}}}'",
      "    fi",
      "    ;;",
      "  'pane split')",
      "    printf '%s\\n' allocated > \"$FAKE_HERDR_STATE\"",
      "    printf '%s\\n' '{\"result\":{\"pane\":{\"pane_id\":\"workspace:p2\"}}}'",
      "    ;;",
      "  'pane resize')",
      "    printf '%s\\n' '{\"result\":{}}'",
      "    ;;",
      "  'pane close')",
      "    exit 17",
      "    ;;",
      "  *)",
      "    exit 64",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeHerdr, 0o755);

  const loadout: SubagentLoadout = {
    agent: "worker",
    toolAllowlist: null,
    model: null,
    thinking: null,
    systemPromptMode: null,
    identity: null,
    spawnable: null,
    autoExit: true,
    cwd: root,
    projectCwd: root,
    agentDir: null,
    globalAgentDir: null,
  };
  registerName(artifactDir, "worker", {
    sessionFile: childSessionFile,
    sessionId: "child-session",
  });
  writeSubagentLoadout(childSessionFile, loadout);
  // Admission and pane allocation succeed; activity setup then fails with EEXIST.
  writeFileSync(join(artifactDir, "subagent-activity"), "not a directory", "utf8");

  delete process.env.PI_SUBAGENT_ROOT_ID;
  delete process.env.PI_SUBAGENT_ROOT_ARTIFACT_DIR;
  process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
  process.env.FAKE_HERDR_STATE = herdrStateFile;
  process.env.FAKE_HERDR_LOG = herdrLogFile;
  process.env.PATH = `${binDir}:${previousEnv.get("PATH") ?? ""}`;
  __test__.setExtensionConfigForTest({
    maxActiveSubagents: 1,
    statusEnabled: false,
    stalledAfterMs: 60_000,
  });

  const registeredTools: any[] = [];
  subagentsExtension({
    on() {},
    registerTool(tool: any) {
      registeredTools.push(tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendUserMessage() {},
    sendMessage() {},
    getAllTools() {
      return [];
    },
  } as any);
  const messageTool = registeredTools.find((tool) => tool.name === "subagent_message");
  assert.ok(messageTool, "expected subagent_message to be registered");

  try {
    await assert.rejects(
      messageTool.execute(
        "resume-call",
        { name: "worker", message: "continue" },
        undefined,
        undefined,
        {
          sessionManager: {
            getSessionFile: () => parentSessionFile,
            getSessionId: () => sessionId,
            getSessionDir: () => parentSessionDir,
          },
          cwd: root,
        },
      ),
      (error: unknown) =>
        error instanceof Error && /EEXIST|file already exists/i.test(error.message),
    );

    const coordinator = new RootTreeLifecycleCoordinator({
      rootArtifactDir: artifactDir,
      rootId: sessionId,
      maxActiveSubagents: 1,
    });
    const snapshot = coordinator.inspect();
    const records = Object.values(snapshot.children);
    assert.equal(snapshot.activeCount, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.terminalEvidence?.cancelled, true);
    assert.equal(records[0]?.lease.state, "released");
    assert.equal(records[0]?.transitions.cleanup.status, "pending");
    assert.match(readFileSync(herdrLogFile, "utf8"), /pane close workspace:p2/);
  } finally {
    __test__.setExtensionConfigForTest(null);
    for (const [name, value] of previousEnv) restoreEnvVar(name, value);
    rmSync(root, { recursive: true, force: true });
  }
});
