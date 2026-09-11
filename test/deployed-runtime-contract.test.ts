import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { applyDeployment } from "../scripts/deploy-active-package.ts";
import {
  buildDeployedPiCommand,
  cleanupTestEnv,
  createTestEnv,
  queuePiInput,
  sendPiInput,
  verifyDeployedRuntimeIdentity,
  waitForDeliveredSubagent,
  waitForFile,
} from "./integration/harness.ts";

const REPOSITORY = "github.com/Balauruu/pi-interactive-subagents-herdr";
const PREFIX = `git:${REPOSITORY}@`;
const OLD_COMMIT = "1".repeat(40);
const CONFIG = { maxActiveSubagents: 3, statusEnabled: true, stalledAfterMs: 60_000 };

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function fixture(): { root: string; agentDir: string; repo: string; rollback: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "deployed-runtime-contract-"));
  const agentDir = join(root, "agent");
  const repo = join(root, "candidate");
  const rollback = join(agentDir, "settings.m001-s06.rollback.json");
  try {
    mkdirSync(agentDir, { recursive: true });
    execFileSync("git", ["init", "--quiet", repo]);
    git(repo, ["config", "user.email", "fixture@example.test"]);
    git(repo, ["config", "user.name", "Fixture"]);
    git(repo, ["remote", "add", "origin", `https://${REPOSITORY}`]);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ pi: { extensions: ["./pi-extension/subagents/index.ts"] } }));
    writeFileSync(join(repo, "config.json"), JSON.stringify(CONFIG));
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "fixture"]);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:unrelated", `${PREFIX}${OLD_COMMIT}`] }));
    applyDeployment({ settings: join(agentDir, "settings.json"), repo, rollback, expect: OLD_COMMIT });
    return { root, agentDir, repo, rollback, head: git(repo, ["rev-parse", "HEAD"]) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test("deployed Pi command uses normal package discovery with isolated roots", () => {
  const command = buildDeployedPiCommand({
    agentDir: "/active/pi-agent",
    sessionDir: "/tmp/isolated-sessions",
    testDir: "/tmp/isolated-project",
    model: "openai-codex/gpt-5.6-sol",
    task: "call the installed subagent tool",
  });
  assert.match(command, /PI_CODING_AGENT_DIR='\/active\/pi-agent'/);
  assert.match(command, /PI_CODING_AGENT_SESSION_DIR='\/tmp\/isolated-sessions'/);
  assert.match(command, /pi --model 'openai-codex\/gpt-5.6-sol'/);
  assert.doesNotMatch(command, /(?:^|\s)(?:-e|-ne|--extension|--no-extensions)(?:\s|$)/);
  assert.throws(() => buildDeployedPiCommand({ agentDir: "", sessionDir: "/s", testDir: "/p", model: "m/x", task: "x" }), /agentDir is required/);
});

test("identity verification requires matching active pin, checkout, manifest, config, and rollback candidate", () => {
  const value = fixture();
  try {
    const verified = verifyDeployedRuntimeIdentity({ agentDir: value.agentDir, repo: value.repo, rollback: value.rollback });
    assert.equal(verified.candidatePackage, `${PREFIX}${value.head}`);
    assert.equal(verified.previousPackage, `${PREFIX}${OLD_COMMIT}`);

    const settingsPath = join(value.agentDir, "settings.json");
    const before = readFileSync(settingsPath, "utf8");
    writeFileSync(value.rollback, JSON.stringify({
      version: 1,
      previousPackage: `${PREFIX}${OLD_COMMIT}`,
      candidatePackage: `${PREFIX}${"2".repeat(40)}`,
      candidateCommit: "2".repeat(40),
      candidateRemote: REPOSITORY,
    }));
    assert.throws(
      () => verifyDeployedRuntimeIdentity({ agentDir: value.agentDir, repo: value.repo, rollback: value.rollback }),
      /rollback candidate does not match checkout identity/,
    );
    assert.equal(readFileSync(settingsPath, "utf8"), before, "identity mismatch must fail before mutating settings or launching Pi");
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("temporary project and child session state are removed by bounded cleanup", async () => {
  const env = createTestEnv();
  assert.equal(existsSync(env.sessionDir), true);
  await cleanupTestEnv(env);
  assert.equal(existsSync(env.dir), false);
});

test("file polling honors its requested timeout when a marker never appears", async () => {
  const missing = join(tmpdir(), `deployed-runtime-missing-${process.pid}-${Date.now()}`);
  const started = Date.now();
  await assert.rejects(() => waitForFile(missing, 25), /Timeout \(25ms\)/);
  assert.ok(Date.now() - started < 250, "polling must not sleep past its bounded timeout");
});

test("delivered-result polling finds a successful structured parent message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deployed-runtime-result-"));
  try {
    const nested = join(dir, "cwd");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "session.jsonl"), [
      JSON.stringify({ type: "session", id: "header" }),
      JSON.stringify({
        type: "custom_message",
        customType: "subagent_result",
        details: { name: "Replacement-proof", exitCode: 0 },
        display: true,
      }),
    ].join("\n"));
    await waitForDeliveredSubagent(dir, "Replacement-proof", 25);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delivered-result polling fails immediately for a matching non-zero result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deployed-runtime-result-failed-"));
  try {
    writeFileSync(join(dir, "session.jsonl"), JSON.stringify({
      type: "custom_message",
      customType: "subagent_result",
      details: { name: "Replacement-failed", exitCode: 9 },
      display: true,
    }));
    await assert.rejects(
      () => waitForDeliveredSubagent(dir, "Replacement-failed", 25),
      /delivered exit code 9/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deployed Pi input rejects an empty user turn before touching Herdr", () => {
  assert.throws(() => sendPiInput("pane", "  "), /Pi input is required/);
  assert.throws(() => queuePiInput("pane", "  "), /Pi input is required/);
});

test("deployed integration command rejects missing live authorization before test discovery", () => {
  const result = spawnSync(process.execPath, ["test/live-test-entrypoint.ts"], {
    cwd: resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /PI_LIVE_TESTS is missing/);
});
