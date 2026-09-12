import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyDeployment, writeJsonAtomically } from "../scripts/deploy-active-package.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(PROJECT_ROOT, "scripts", "deploy-active-package.ts");
const REPOSITORY = "github.com/Balauruu/pi-interactive-subagents-herdr";
const PREFIX = `git:${REPOSITORY}@`;
const OLD_COMMIT = "1111111111111111111111111111111111111111";
const VALID_CONFIG = { maxActiveSubagents: 3, statusEnabled: true, stalledAfterMs: 60_000 };

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function fixture(): { root: string; repo: string; settings: string; rollback: string; oldRef: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), "deploy-active-package-"));
  const repo = join(root, "candidate");
  const settings = join(root, "settings.json");
  const rollback = join(root, "settings.rollback.json");
  const oldRef = `${PREFIX}${OLD_COMMIT}`;
  try {
    execFileSync("git", ["init", "--quiet", repo]);
    git(repo, ["config", "user.email", "fixture@example.test"]);
    git(repo, ["config", "user.name", "Fixture"]);
    git(repo, ["remote", "add", "origin", `https://${REPOSITORY}`]);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", pi: { extensions: ["./pi-extension/subagents/index.ts"] } }));
    writeFileSync(join(repo, "config.json"), JSON.stringify(VALID_CONFIG));
    git(repo, ["add", "."]);
    git(repo, ["commit", "--quiet", "-m", "fixture"]);
    writeFileSync(settings, JSON.stringify({ unrelated: { keep: true }, packages: ["npm:unrelated", oldRef, "npm:also-unrelated"] }, null, 2));
    return { root, repo, settings, rollback, oldRef, head: git(repo, ["rev-parse", "HEAD"]) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function cleanup(value: { root: string }): void {
  rmSync(value.root, { recursive: true, force: true });
}

function command(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function output(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function assertFailure(result: ReturnType<typeof spawnSync>, phase: string): void {
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), new RegExp(`deploy-active-package ${phase}:`));
}

test("apply, verify, check, and compare-and-swap rollback preserve unrelated settings", () => {
  const value = fixture();
  try {
    const applied = command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", OLD_COMMIT]);
    assert.equal(applied.status, 0, output(applied));
    assert.match(output(applied), new RegExp(value.head));

    const settings = JSON.parse(readFileSync(value.settings, "utf8"));
    assert.deepEqual(settings, { unrelated: { keep: true }, packages: ["npm:unrelated", `${PREFIX}${value.head}`, "npm:also-unrelated"] });
    const metadata = JSON.parse(readFileSync(value.rollback, "utf8"));
    assert.deepEqual(Object.keys(metadata).sort(), ["candidateCommit", "candidatePackage", "candidateRemote", "previousPackage", "version"]);
    assert.equal(metadata.previousPackage, value.oldRef);
    assert.equal(metadata.candidatePackage, `${PREFIX}${value.head}`);

    const verified = command(["verify", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback]);
    assert.equal(verified.status, 0, output(verified));
    const beforeCheck = readFileSync(value.settings, "utf8");
    const checked = command(["rollback", "--check", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback]);
    assert.equal(checked.status, 0, output(checked));
    assert.equal(readFileSync(value.settings, "utf8"), beforeCheck);

    const rolledBack = command(["rollback", "--apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback]);
    assert.equal(rolledBack.status, 0, output(rolledBack));
    assert.equal(JSON.parse(readFileSync(value.settings, "utf8")).packages[1], value.oldRef);
    assertFailure(command(["rollback", "--apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback]), "compare-and-swap");
  } finally {
    cleanup(value);
  }
});

test("rejects missing or duplicate package ownership without mutation", () => {
  for (const packages of [["npm:only"], [`${PREFIX}${OLD_COMMIT}`, `${PREFIX}${"2".repeat(40)}`]]) {
    const value = fixture();
    try {
      writeFileSync(value.settings, JSON.stringify({ packages, preserved: "yes" }));
      const before = readFileSync(value.settings, "utf8");
      assertFailure(command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", OLD_COMMIT]), "settings");
      assert.equal(readFileSync(value.settings, "utf8"), before);
      assert.equal(existsSync(value.rollback), false);
    } finally {
      cleanup(value);
    }
  }
});

test("replaces rollback metadata only with an explicit current-candidate compare-and-swap", () => {
  const value = fixture();
  try {
    const first = command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", OLD_COMMIT]);
    assert.equal(first.status, 0, output(first));

    writeFileSync(join(value.repo, "recovery-candidate.txt"), "recovery candidate\n");
    git(value.repo, ["add", "recovery-candidate.txt"]);
    git(value.repo, ["commit", "--quiet", "-m", "recovery candidate"]);
    const nextHead = git(value.repo, ["rev-parse", "HEAD"]);
    const originalRollback = readFileSync(value.rollback, "utf8");
    writeFileSync(value.rollback, JSON.stringify({
      version: 1,
      previousPackage: value.oldRef,
      candidatePackage: `${PREFIX}${"3".repeat(40)}`,
      candidateCommit: "3".repeat(40),
      candidateRemote: REPOSITORY,
    }));
    assertFailure(
      command([
        "apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback,
        "--expect", value.head, "--replace-rollback",
      ]),
      "compare-and-swap",
    );
    writeFileSync(value.rollback, originalRollback);

    assertFailure(
      command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", value.head]),
      "rollback",
    );
    const replaced = command([
      "apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback,
      "--expect", value.head, "--replace-rollback",
    ]);
    assert.equal(replaced.status, 0, output(replaced));

    const settings = JSON.parse(readFileSync(value.settings, "utf8"));
    assert.equal(settings.packages[1], `${PREFIX}${nextHead}`);
    const metadata = JSON.parse(readFileSync(value.rollback, "utf8"));
    assert.equal(metadata.previousPackage, `${PREFIX}${value.head}`);
    assert.equal(metadata.candidatePackage, `${PREFIX}${nextHead}`);
  } finally {
    cleanup(value);
  }
});

test("restores prior rollback metadata when a replacement settings write fails", () => {
  const value = fixture();
  try {
    assert.equal(command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", OLD_COMMIT]).status, 0);
    writeFileSync(join(value.repo, "recovery-failure-candidate.txt"), "recovery failure candidate\n");
    git(value.repo, ["add", "recovery-failure-candidate.txt"]);
    git(value.repo, ["commit", "--quiet", "-m", "recovery failure candidate"]);
    const originalSettings = readFileSync(value.settings, "utf8");
    const originalRollback = JSON.parse(readFileSync(value.rollback, "utf8"));
    let calls = 0;
    assert.throws(
      () => applyDeployment({
        settings: value.settings,
        repo: value.repo,
        rollback: value.rollback,
        expect: value.head,
        replaceRollback: true,
      }, (path, json) => {
        calls += 1;
        if (calls === 2) throw new Error("injected replacement settings write failure");
        writeJsonAtomically(path, json);
      }),
      (error: unknown) => error instanceof Error
        && (error as Error & { phase?: string }).phase === "settings-write"
        && /atomic write failed.*injected replacement settings write failure/.test(error.message),
    );
    assert.equal(calls, 3);
    assert.equal(readFileSync(value.settings, "utf8"), originalSettings);
    assert.deepEqual(JSON.parse(readFileSync(value.rollback, "utf8")), originalRollback);
  } finally {
    cleanup(value);
  }
});

test("rejects malformed refs, stale old pins, and a candidate that is already active", () => {
  const value = fixture();
  try {
    assertFailure(command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", "abc"]), "arguments");
    assertFailure(command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", "2".repeat(40)]), "compare-and-swap");
    writeFileSync(value.settings, JSON.stringify({ packages: [`${PREFIX}${value.head}`] }));
    assertFailure(command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", value.head]), "compare-and-swap");
    writeFileSync(value.settings, JSON.stringify({ packages: [`${PREFIX}deadbeef`] }));
    assertFailure(command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", OLD_COMMIT]), "settings");
  } finally {
    cleanup(value);
  }
});

test("rejects wrong repositories, tracked candidate changes, manifest changes, and invalid strict config", () => {
  const cases: Array<{ change: (value: ReturnType<typeof fixture>) => void; phase: string }> = [
    { change: (value) => git(value.repo, ["remote", "set-url", "origin", "https://github.com/example/wrong"]), phase: "repository" },
    { change: (value) => writeFileSync(join(value.repo, "config.json"), `${JSON.stringify(VALID_CONFIG)}\n`), phase: "repository" },
    { change: (value) => { writeFileSync(join(value.repo, "package.json"), JSON.stringify({ pi: { extensions: [] } })); git(value.repo, ["add", "package.json"]); git(value.repo, ["commit", "--quiet", "-m", "invalid manifest"]); }, phase: "manifest" },
    { change: (value) => { writeFileSync(join(value.repo, "config.json"), JSON.stringify({ ...VALID_CONFIG, unknown: true })); git(value.repo, ["add", "config.json"]); git(value.repo, ["commit", "--quiet", "-m", "unknown config"]); }, phase: "config" },
    { change: (value) => { writeFileSync(join(value.repo, "config.json"), JSON.stringify({ ...VALID_CONFIG, maxActiveSubagents: 0 })); git(value.repo, ["add", "config.json"]); git(value.repo, ["commit", "--quiet", "-m", "invalid cap"]); }, phase: "config" },
    { change: (value) => { writeFileSync(join(value.repo, "config.json"), JSON.stringify({ ...VALID_CONFIG, statusEnabled: "true" })); git(value.repo, ["add", "config.json"]); git(value.repo, ["commit", "--quiet", "-m", "invalid status"]); }, phase: "config" },
    { change: (value) => { writeFileSync(join(value.repo, "config.json"), JSON.stringify({ ...VALID_CONFIG, stalledAfterMs: 0 })); git(value.repo, ["add", "config.json"]); git(value.repo, ["commit", "--quiet", "-m", "invalid timer"]); }, phase: "config" },
  ];
  for (const item of cases) {
    const value = fixture();
    try {
      item.change(value);
      assertFailure(command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", OLD_COMMIT]), item.phase);
      assert.equal(existsSync(value.rollback), false);
    } finally {
      cleanup(value);
    }
  }
});

test("rejects corrupt rollback state and a rollback candidate that no longer equals HEAD", () => {
  const value = fixture();
  try {
    assert.equal(command(["apply", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback, "--expect", OLD_COMMIT]).status, 0);
    writeFileSync(value.rollback, "{");
    assertFailure(command(["verify", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback]), "rollback");
    writeFileSync(value.rollback, JSON.stringify({ version: 1, previousPackage: value.oldRef, candidatePackage: `${PREFIX}${"3".repeat(40)}`, candidateCommit: "3".repeat(40), candidateRemote: REPOSITORY }));
    assertFailure(command(["rollback", "--check", "--settings", value.settings, "--repo", value.repo, "--rollback", value.rollback]), "rollback");
  } finally {
    cleanup(value);
  }
});

test("an interrupted second atomic write leaves the active settings byte-for-byte intact", () => {
  const value = fixture();
  try {
    const originalSettings = readFileSync(value.settings, "utf8");
    let calls = 0;
    assert.throws(() => applyDeployment({ settings: value.settings, repo: value.repo, rollback: value.rollback, expect: OLD_COMMIT }, (path, json) => {
      calls += 1;
      if (calls === 2) throw new Error("injected settings rename failure");
      writeJsonAtomically(path, json);
    }), (error: unknown) => error instanceof Error
      && (error as Error & { phase?: string }).phase === "settings-write"
      && /atomic write failed.*injected settings rename failure/.test(error.message));
    assert.equal(calls, 2);
    assert.equal(readFileSync(value.settings, "utf8"), originalSettings);
    assert.equal(existsSync(value.rollback), false);
  } finally {
    cleanup(value);
  }
});
