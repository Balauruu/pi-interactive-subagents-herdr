import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_REPOSITORY = "github.com/Balauruu/pi-interactive-subagents-herdr";
const PACKAGE_PREFIX = `git:${PACKAGE_REPOSITORY}@`;
const EXTENSION_ENTRY = "./pi-extension/subagents/index.ts";
const CONFIG_KEYS = ["maxActiveSubagents", "statusEnabled", "stalledAfterMs"];
const COMMIT = /^[0-9a-f]{40}$/;

class DeployError extends Error {
  readonly phase: string;

  constructor(phase: string, message: string) {
    super(message);
    this.phase = phase;
  }
}

type Options = { settings: string; repo: string; rollback: string; expect?: string };
type RollbackState = {
  version: 1;
  previousPackage: string;
  candidatePackage: string;
  candidateCommit: string;
  candidateRemote: string;
};
type AtomicWriter = (path: string, value: unknown) => void;

function fail(phase: string, message: string): never {
  throw new DeployError(phase, message);
}

function asObject(value: unknown, phase: string, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return fail(phase, `${label} must be a plain JSON object`);
  }
  return value as Record<string, unknown>;
}

function readJson(path: string, phase: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return fail(phase, `cannot read ${path}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return fail(phase, `invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

function assertExactKeys(object: Record<string, unknown>, keys: string[], phase: string, label: string): void {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(phase, `${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function validateConfig(repo: string): void {
  const config = asObject(readJson(resolve(repo, "config.json"), "config"), "config", "config.json");
  assertExactKeys(config, CONFIG_KEYS, "config", "config.json");
  if (!Number.isSafeInteger(config.maxActiveSubagents) || (config.maxActiveSubagents as number) < 1) {
    fail("config", "maxActiveSubagents must be a positive safe integer");
  }
  if (typeof config.statusEnabled !== "boolean") fail("config", "statusEnabled must be a boolean");
  if (!Number.isSafeInteger(config.stalledAfterMs) || (config.stalledAfterMs as number) < 1) {
    fail("config", "stalledAfterMs must be a positive safe integer");
  }
}

function validateManifest(repo: string): void {
  const manifest = asObject(readJson(resolve(repo, "package.json"), "manifest"), "manifest", "package.json");
  const pi = asObject(manifest.pi, "manifest", "package.json pi");
  if (!Array.isArray(pi.extensions) || !pi.extensions.includes(EXTENSION_ENTRY)) {
    fail("manifest", `package.json must declare ${EXTENSION_ENTRY}`);
  }
}

function runGit(repo: string, args: string[], phase: string): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const details = error as { stderr?: string; message: string };
    return fail(phase, `git ${args.join(" ")} failed: ${(details.stderr || details.message).trim()}`);
  }
}

function normalizeRemote(remote: string): string {
  return remote.trim().replace(/^git@/, "").replace(/^ssh:\/\//, "").replace(/^https?:\/\//, "").replace(/\.git\/?$/, "").replace(/\/$/, "");
}

function candidateFromRepo(repo: string): { commit: string; remote: string; packageRef: string } {
  const remote = runGit(repo, ["remote", "get-url", "origin"], "repository");
  if (normalizeRemote(remote) !== PACKAGE_REPOSITORY) {
    fail("repository", `origin must identify ${PACKAGE_REPOSITORY}`);
  }
  const commit = runGit(repo, ["rev-parse", "HEAD"], "repository");
  if (!COMMIT.test(commit)) fail("repository", "HEAD must resolve to a full lowercase commit ID");
  const dirty = runGit(repo, ["status", "--porcelain=v1", "--untracked-files=no"], "repository");
  if (dirty.length > 0) fail("repository", "tracked candidate checkout is dirty");
  validateManifest(repo);
  validateConfig(repo);
  return { commit, remote: PACKAGE_REPOSITORY, packageRef: `${PACKAGE_PREFIX}${commit}` };
}

function parsePackageRef(value: unknown, phase: string, label: string): string {
  if (typeof value !== "string" || !value.startsWith(PACKAGE_PREFIX) || !COMMIT.test(value.slice(PACKAGE_PREFIX.length))) {
    fail(phase, `${label} must be a ${PACKAGE_REPOSITORY} package ref pinned to a full lowercase commit ID`);
  }
  return value;
}

function packageEntry(settings: Record<string, unknown>, phase: string): { index: number; value: string } {
  if (!Array.isArray(settings.packages)) fail(phase, "settings packages must be an array");
  const matches = settings.packages.flatMap((value, index) => typeof value === "string" && value.startsWith(PACKAGE_PREFIX) ? [{ index, value }] : []);
  if (matches.length !== 1) fail(phase, `settings must contain exactly one ${PACKAGE_REPOSITORY} package entry`);
  return { index: matches[0]!.index, value: parsePackageRef(matches[0]!.value, phase, "settings package entry") };
}

function readSettings(path: string, phase: string): Record<string, unknown> {
  return asObject(readJson(path, phase), phase, "settings.json");
}

function validateRollback(value: unknown): RollbackState {
  const state = asObject(value, "rollback", "rollback metadata");
  assertExactKeys(state, ["version", "previousPackage", "candidatePackage", "candidateCommit", "candidateRemote"], "rollback", "rollback metadata");
  if (state.version !== 1) fail("rollback", "rollback metadata version must be 1");
  const previousPackage = parsePackageRef(state.previousPackage, "rollback", "previousPackage");
  const candidatePackage = parsePackageRef(state.candidatePackage, "rollback", "candidatePackage");
  if (previousPackage === candidatePackage) fail("rollback", "rollback package refs must differ");
  if (typeof state.candidateCommit !== "string" || !COMMIT.test(state.candidateCommit) || candidatePackage !== `${PACKAGE_PREFIX}${state.candidateCommit}`) {
    fail("rollback", "candidateCommit must match candidatePackage");
  }
  if (state.candidateRemote !== PACKAGE_REPOSITORY) fail("rollback", "candidateRemote does not identify the approved repository");
  return state as RollbackState;
}

function replacementSettings(settings: Record<string, unknown>, entry: { index: number }, packageRef: string): Record<string, unknown> {
  const packages = [...(settings.packages as unknown[])];
  packages[entry.index] = packageRef;
  return { ...settings, packages };
}

/** Atomically replaces one JSON file without ever truncating its previous contents. */
export function writeJsonAtomically(path: string, value: unknown): void {
  const target = resolve(path);
  const temp = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeForPhase(phase: string, path: string, value: unknown, atomicWrite: AtomicWriter): void {
  try {
    atomicWrite(path, value);
  } catch (error) {
    if (error instanceof DeployError) throw error;
    fail(phase, `atomic write failed for ${path}: ${(error as Error).message}`);
  }
}

export function applyDeployment(options: Options, atomicWrite: AtomicWriter = writeJsonAtomically): { settingsPath: string; previousPackage: string; candidatePackage: string } {
  if (!options.expect || !COMMIT.test(options.expect)) fail("arguments", "apply requires --expect with a full lowercase commit ID");
  const candidate = candidateFromRepo(options.repo);
  const settings = readSettings(options.settings, "settings");
  const current = packageEntry(settings, "settings");
  if (current.value !== `${PACKAGE_PREFIX}${options.expect}`) fail("compare-and-swap", "observed settings package ref does not match --expect");
  if (current.value === candidate.packageRef) fail("compare-and-swap", "candidate package ref is already active");
  if (existsSync(options.rollback)) fail("rollback", "rollback metadata already exists and will not be overwritten");
  const rollback: RollbackState = {
    version: 1,
    previousPackage: current.value,
    candidatePackage: candidate.packageRef,
    candidateCommit: candidate.commit,
    candidateRemote: candidate.remote,
  };
  writeForPhase("rollback-write", options.rollback, rollback, atomicWrite);
  writeForPhase("settings-write", options.settings, replacementSettings(settings, current, candidate.packageRef), atomicWrite);
  return { settingsPath: options.settings, previousPackage: current.value, candidatePackage: candidate.packageRef };
}

export function verifyDeployment(options: Omit<Options, "expect">): { settingsPath: string; previousPackage: string; candidatePackage: string; rollbackDigest: string } {
  const candidate = candidateFromRepo(options.repo);
  const settings = readSettings(options.settings, "settings");
  const current = packageEntry(settings, "settings");
  const rollbackValue = readJson(options.rollback, "rollback");
  const rollback = validateRollback(rollbackValue);
  if (current.value !== candidate.packageRef) fail("verify", "settings package ref does not match checkout HEAD");
  if (rollback.candidatePackage !== candidate.packageRef || rollback.candidateCommit !== candidate.commit || rollback.candidateRemote !== candidate.remote) {
    fail("verify", "rollback candidate does not match checkout identity");
  }
  return { settingsPath: options.settings, previousPackage: rollback.previousPackage, candidatePackage: candidate.packageRef, rollbackDigest: sha256(JSON.stringify(rollbackValue)) };
}

export function checkRollback(options: Omit<Options, "expect">, apply: boolean, atomicWrite: AtomicWriter = writeJsonAtomically): { settingsPath: string; previousPackage: string; candidatePackage: string; applied: boolean } {
  const candidate = candidateFromRepo(options.repo);
  const settings = readSettings(options.settings, "settings");
  const current = packageEntry(settings, "settings");
  const rollback = validateRollback(readJson(options.rollback, "rollback"));
  if (rollback.candidatePackage !== candidate.packageRef || rollback.candidateCommit !== candidate.commit) {
    fail("rollback", "rollback candidate does not match checkout HEAD");
  }
  if (current.value !== rollback.candidatePackage) fail("compare-and-swap", "candidate package ref is no longer active");
  if (apply) writeForPhase("settings-write", options.settings, replacementSettings(settings, current, rollback.previousPackage), atomicWrite);
  return { settingsPath: options.settings, previousPackage: rollback.previousPackage, candidatePackage: rollback.candidatePackage, applied: apply };
}

function parseArguments(argv: string[]): { mode: "apply" | "verify" | "rollback"; rollbackMode?: "check" | "apply"; options: Options } {
  const [mode, ...rest] = argv;
  if (mode !== "apply" && mode !== "verify" && mode !== "rollback") fail("arguments", "mode must be apply, verify, or rollback");
  const values: Partial<Options> = {};
  let rollbackMode: "check" | "apply" | undefined;
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (token === "--check" || token === "--apply") {
      if (mode !== "rollback" || rollbackMode) fail("arguments", "rollback requires exactly one of --check or --apply");
      rollbackMode = token === "--check" ? "check" : "apply";
      continue;
    }
    if (token === "--settings" || token === "--repo" || token === "--rollback" || token === "--expect") {
      const key = token.slice(2) as keyof Options;
      const value = rest[++index];
      if (!value || values[key] !== undefined) fail("arguments", `--${key} requires one value`);
      values[key] = value;
      continue;
    }
    fail("arguments", `unknown argument ${token}`);
  }
  if (!values.settings || !values.repo || !values.rollback) fail("arguments", "--settings, --repo, and --rollback are required");
  if (mode === "rollback" && !rollbackMode) fail("arguments", "rollback requires --check or --apply");
  if (mode !== "apply" && values.expect) fail("arguments", "--expect is only valid with apply");
  return { mode, rollbackMode, options: { settings: resolve(values.settings), repo: resolve(values.repo), rollback: resolve(values.rollback), expect: values.expect } };
}

export function main(argv = process.argv.slice(2)): void {
  const command = parseArguments(argv);
  let outcome: Record<string, unknown>;
  if (command.mode === "apply") outcome = applyDeployment(command.options);
  else if (command.mode === "verify") outcome = verifyDeployment(command.options);
  else outcome = checkRollback(command.options, command.rollbackMode === "apply");
  console.log(JSON.stringify({ status: "ok", mode: command.mode, ...outcome }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    if (error instanceof DeployError) console.error(`deploy-active-package ${error.phase}: ${error.message}`);
    else console.error(`deploy-active-package unexpected: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
