/**
 * Integration test harness for pi-interactive-subagents.
 *
 * Provides utilities to:
 * - Detect whether Herdr is available
 * - Create isolated test environments with test agent definitions
 * - Start real pi sessions in Herdr panes
 * - Poll for file creation and screen output
 * - Clean up panes and temp files after tests
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  isMuxAvailable,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
} from "../../pi-extension/subagents/herdr.ts";
import { parseHerdrPaneLayout, type HerdrPaneLayout } from "../../pi-extension/subagents/pane-layout.ts";
import {
  formatLiveTestPreflightFailure,
  preflightLiveTest,
  type LiveTestPreflight,
} from "../live-test-guard.ts";
import { verifyDeployment } from "../../scripts/deploy-active-package.ts";

// Re-export Herdr surface primitives for tests
export {
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  shellEscape,
};

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

/**
 * Absolute path to the extension source in the working tree.
 *
 * Integration tests must exercise the code on the current branch — NOT the
 * version installed as a pi-package under `~/.pi/agent/git/...` or the project
 * mirror under `.pi/git/...`, which stays pinned to the last released tag.
 *
 * We force-load this file via `pi -ne -e <path>` in startPi() below so local
 * edits are always the code under test, regardless of what pi-packages are
 * installed on the host.
 */
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

// ── Configuration ──

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

// ── Backend detection ──

/**
 * Detect Herdr only after the shared live-test preflight has authorized it.
 * This keeps accidental test runs from probing external infrastructure.
 */
export function getAvailableBackends(preflight: LiveTestPreflight): string[] {
  return preflight.status === "ready" && isMuxAvailable() ? ["herdr"] : [];
}

export function getFocusedSurface(): string | null {
  try {
    const response = JSON.parse(execFileSync("herdr", ["pane", "current", "--current"], { encoding: "utf8" }));
    return response.result?.pane?.pane_id ?? null;
  } catch {
    return null;
  }
}

// ── Test environment ──

export interface TestEnv {
  /** Temp directory serving as the test project root */
  dir: string;
  /** Dedicated Pi session store; never shares the planning session. */
  sessionDir: string;
  /** Panes created during the test (cleaned up automatically) */
  surfaces: string[];
  /** Temp files to clean up */
  tempFiles: string[];
}

/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  mkdirSync(agentsDir, { recursive: true });

  // Copy test agent definitions into the project-local agents dir. A live
  // suite must use its explicitly authorized model for nested Pi sessions too,
  // rather than silently switching providers via fixture frontmatter.
  const preflight = preflightLiveTest(process.env);
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (!file.endsWith(".md")) continue;
      const source = join(TEST_AGENTS_SRC, file);
      const destination = join(agentsDir, file);
      if (preflight.status !== "ready") {
        cpSync(source, destination);
        continue;
      }
      const definition = readFileSync(source, "utf8");
      if (!/^model:\s*\S+/m.test(definition)) {
        throw new Error(`Live test agent ${file} does not declare a model.`);
      }
      writeFileSync(destination, definition.replace(/^model:\s*\S+/m, `model: ${preflight.model}`));
    }
  }

  const sessionDir = join(dir, ".pi-test-sessions");
  mkdirSync(sessionDir, { recursive: true });
  return { dir, sessionDir, surfaces: [], tempFiles: [] };
}

/**
 * Clean up all resources created during the test.
 */
export async function cleanupTestEnv(env: TestEnv): Promise<void> {
  for (const surface of env.surfaces) {
    try {
      await closeSurface(surface);
    } catch {}
  }
  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch {}
  }
  try {
    rmSync(env.dir, { recursive: true, force: true });
  } catch {}
}

/**
 * Create a surface and register it for automatic cleanup.
 */
export async function createTrackedSurface(env: TestEnv, name: string): Promise<string> {
  const surface = await createSurface(name);
  env.surfaces.push(surface);
  return surface;
}

export async function createTrackedSurfaceSplit(
  env: TestEnv,
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): Promise<string> {
  const surface = await createSurfaceSplit(name, direction, fromSurface);
  env.surfaces.push(surface);
  return surface;
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface);
}

// ── Pane-only layout workspace ──

const HERDR_COMMAND_TIMEOUT = 5_000;

export interface PaneLayoutWorkspace {
  workspaceId: string;
  rootPaneId: string;
  dir: string;
}

function herdrJson(args: string[]): unknown {
  let stdout: string;
  try {
    stdout = execFileSync("herdr", args, { encoding: "utf8", timeout: HERDR_COMMAND_TIMEOUT });
  } catch {
    throw new Error(`Herdr ${args.slice(0, 2).join(" ")} command failed`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Herdr ${args.slice(0, 2).join(" ")} returned invalid JSON`);
  }
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Herdr ${label} was missing`);
  return value;
}

/** Create a no-focus Herdr workspace rooted in a unique temporary directory. */
export function createPaneLayoutWorkspace(label: string): PaneLayoutWorkspace {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-layout-"));
  try {
    const response = herdrJson(["workspace", "create", "--cwd", dir, "--label", label, "--no-focus"]);
    const result = (response as { result?: { workspace?: { workspace_id?: unknown }; root_pane?: { pane_id?: unknown } } }).result;
    return {
      workspaceId: requiredId(result?.workspace?.workspace_id, "workspace id"),
      rootPaneId: requiredId(result?.root_pane?.pane_id, "root pane id"),
      dir,
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Parse only validated rectangle data; raw Herdr command output is not retained. */
export function readPaneLayout(rootPaneId: string): HerdrPaneLayout {
  const parsed = parseHerdrPaneLayout(herdrJson(["pane", "layout", "--pane", rootPaneId]));
  if (!parsed.ok) throw new Error(`Herdr returned ${parsed.reason} layout data`);
  return parsed.layout;
}

/** Always remove the workspace and its temporary directory, even after a failed assertion. */
export function cleanupPaneLayoutWorkspace(workspace: PaneLayoutWorkspace): void {
  try {
    herdrJson(["workspace", "close", workspace.workspaceId]);
  } finally {
    rmSync(workspace.dir, { recursive: true, force: true });
  }
}

export function paneExists(rootPaneId: string, paneId: string): boolean {
  return readPaneLayout(rootPaneId).panes.some((pane) => pane.paneId === paneId);
}

// ── Pi session management ──

/**
 * Start a pi session in a Herdr pane with the subagents extension loaded.
 * Returns immediately — the pi process runs asynchronously in the surface.
 *
 * The command ends with a sentinel so we can detect when pi exits:
 *   `pi ...; echo '__TEST_DONE_'$?'__'`
 */
export function startPi(
  surface: string,
  testDir: string,
  task: string,
  opts?: { extraArgs?: string },
): void {
  const preflight = preflightLiveTest(process.env);
  if (preflight.status === "disabled") {
    throw new Error("Live test guard rejected: PI_LIVE_TESTS is missing.");
  }
  if (preflight.status === "rejected") {
    throw new Error(formatLiveTestPreflightFailure(preflight));
  }

  const model = preflight.model;
  const extra = opts?.extraArgs ?? "";

  // Force pi to load the working-tree extension (not an installed pi-package
  // snapshot). `-ne` disables extension auto-discovery, `-e <path>` loads the
  // current branch's source directly. Without this, the tests silently run
  // against whatever version is checked out under `~/.pi/agent/git/...`.
  const cmd = [
    `cd ${shellEscape(testDir)} &&`,
    `pi`,
    `-ne`,
    `-e ${shellEscape(EXTENSION_SOURCE)}`,
    `--model ${shellEscape(model)}`,
    extra,
    shellEscape(task),
  ]
    .filter(Boolean)
    .join(" ");

  sendLongCommand(surface, `${cmd}; echo '__TEST_DONE_'$?'__'`, {
    scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
  });
}

export interface DeployedRuntimeIdentityOptions {
  agentDir: string;
  repo: string;
  rollback: string;
}

/** Prove normal package discovery resolves the same approved candidate as the active settings pin. */
export function verifyDeployedRuntimeIdentity(options: DeployedRuntimeIdentityOptions) {
  return verifyDeployment({
    settings: join(resolve(options.agentDir), "settings.json"),
    repo: resolve(options.repo),
    rollback: resolve(options.rollback),
  });
}

export interface DeployedPiCommandOptions {
  agentDir: string;
  sessionDir: string;
  testDir: string;
  task: string;
  model: string;
}

/** Build a normal auto-discovery command with no source or extension overrides. */
export function buildDeployedPiCommand(options: DeployedPiCommandOptions): string {
  for (const [label, value] of Object.entries({
    agentDir: options.agentDir,
    sessionDir: options.sessionDir,
    testDir: options.testDir,
    model: options.model,
  })) {
    if (!value || value.trim() === "") throw new Error(`Deployed Pi ${label} is required.`);
  }
  return [
    `cd ${shellEscape(resolve(options.testDir))} &&`,
    `PI_CODING_AGENT_DIR=${shellEscape(resolve(options.agentDir))}`,
    `PI_CODING_AGENT_SESSION_DIR=${shellEscape(resolve(options.sessionDir))}`,
    "pi",
    `--model ${shellEscape(options.model)}`,
    shellEscape(options.task),
  ].join(" ");
}

/** Start a distinct Pi process through the active package ownership path. */
export function startDeployedPi(surface: string, options: Omit<DeployedPiCommandOptions, "model">): void {
  const preflight = preflightLiveTest(process.env);
  if (preflight.status === "disabled") throw new Error("Live test guard rejected: PI_LIVE_TESTS is missing.");
  if (preflight.status === "rejected") throw new Error(formatLiveTestPreflightFailure(preflight));

  mkdirSync(options.sessionDir, { recursive: true });
  const command = buildDeployedPiCommand({ ...options, model: preflight.model });
  sendLongCommand(surface, `${command}; echo '__TEST_DONE_'$?'__'`, {
    scriptPath: join(options.testDir, `test-deployed-launch-${Date.now()}.sh`),
  });
}

/** Submit a distinct user turn or slash command to an idle Pi pane. */
export function sendPiInput(surface: string, input: string): void {
  if (!input.trim()) throw new Error("Pi input is required.");
  sendCommand(surface, input);
}

/** Queue a follow-up user turn through Pi's documented Alt+Enter binding. */
export function queuePiInput(surface: string, input: string): void {
  if (!input.trim()) throw new Error("Pi input is required.");
  execFileSync("herdr", ["pane", "send-text", surface, input], { encoding: "utf8" });
  execFileSync("herdr", ["pane", "send-keys", surface, "alt+enter"], { encoding: "utf8" });
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the surface's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readScreenAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(Math.min(2000, Math.max(0, timeout - (Date.now() - start))));
  }

  let finalScreen = "";
  try {
    finalScreen = readScreen(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (existsSync(path)) {
        const content = readFileSync(path, "utf8");
        if (!contentPattern || contentPattern.test(content)) return content;
      }
    } catch {}
    await sleep(Math.min(2000, Math.max(0, timeout - (Date.now() - start))));
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

/**
 * Wait for the pi process in a surface to exit (sentinel detection).
 * Returns the exit code.
 */
export async function waitForPiExit(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
  const match = screen.match(/__TEST_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : -1;
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
