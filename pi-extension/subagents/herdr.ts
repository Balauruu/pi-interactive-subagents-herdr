/**
 * Herdr surface layer.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, submit a command, read its screen, close it, and
 * poll for exit. Herdr owns pane layout and preserves focus during splits.
 *
 * Panes are identified by workspace-qualified Herdr ids such as `w1:p2`.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/** True when pi is running in a Herdr-managed pane. */
export function isMuxAvailable(): boolean {
  return !!process.env.HERDR_PANE_ID && hasCommand("herdr");
}

export function muxSetupHint(): string {
  return "Start pi inside Herdr (`herdr`).";
}

function requireHerdr(): void {
  if (!isMuxAvailable()) {
    throw new Error(`Herdr is required for subagents. ${muxSetupHint()}`);
  }
}

function runHerdrJson<T = any>(args: string[], operation: string): T {
  requireHerdr();
  const output = execFileSync("herdr", args, { encoding: "utf8" }).trim();
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new Error(`Invalid Herdr response from ${operation}: ${output}`, { cause: error });
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Surface layout ──

interface PaneLayout {
  area: { width: number };
  panes: Array<{ pane_id: string; rect: { width: number } }>;
  splits: Array<{ direction: "right" | "down"; ratio: number }>;
}

interface SurfacePlacement {
  direction: "right" | "down";
  source: string;
  columnIndex: number;
}

/**
 * Herdr's default split behavior creates a nested right-hand tree. Repeatedly
 * splitting the parent therefore makes the panes shrink geometrically. Keep
 * at most three agent columns beside the parent and rebalance their horizontal
 * split ratios. Additional agents are distributed vertically across the
 * shortest columns.
 */
const MIN_BALANCED_PANE_WIDTH = Math.max(
  1,
  Number(process.env.PI_SUBAGENT_MIN_PANE_WIDTH ?? "24"),
);
const MAX_HORIZONTAL_AGENT_COLUMNS = 3;
const MAX_RESIZE_STEP = 0.05;
let balancedParent: string | null = null;
const balancedColumns: string[][] = [];

function chooseSurfacePlacement(
  parent: string,
  columns: readonly (readonly string[])[],
): SurfacePlacement {
  if (columns.length < MAX_HORIZONTAL_AGENT_COLUMNS) {
    return { direction: "right", source: parent, columnIndex: columns.length };
  }

  let columnIndex = 0;
  for (let index = 1; index < columns.length; index++) {
    if (columns[index]!.length < columns[columnIndex]!.length) columnIndex = index;
  }

  const column = columns[columnIndex]!;
  return {
    direction: "down",
    source: column[column.length - 1]!,
    columnIndex,
  };
}

export const __surfaceLayoutTest__ = {
  chooseSurfacePlacement,
  maxHorizontalAgentColumns: MAX_HORIZONTAL_AGENT_COLUMNS,
};

function readPaneLayout(surface: string): PaneLayout | null {
  try {
    const response = runHerdrJson<{ result?: { layout?: PaneLayout } }>(
      ["pane", "layout", "--pane", surface],
      "pane layout",
    );
    return response.result?.layout ?? null;
  } catch {
    return null;
  }
}

function resizeSplit(
  pane: string,
  direction: "left" | "right",
  amount: number,
): boolean {
  if (!Number.isFinite(amount) || amount <= 0.001) return false;
  try {
    const response = runHerdrJson<{
      result?: { resize?: { changed?: boolean } };
    }>(
      [
        "pane",
        "resize",
        "--pane",
        pane,
        "--direction",
        direction,
        "--amount",
        amount.toFixed(4),
      ],
      "pane resize",
    );
    return response.result?.resize?.changed === true;
  } catch {
    return false;
  }
}

function rebalanceSurfaces(): void {
  if (!balancedParent || balancedColumns.length === 0) return;

  const balancedSurfaces = balancedColumns.map((column) => column[0]!);
  const totalColumns = balancedSurfaces.length + 1;
  let layout = readPaneLayout(balancedParent);
  let horizontalSplits = layout?.splits.filter((split) => split.direction === "right") ?? [];
  if (!layout || horizontalSplits.length < totalColumns - 1) return;

  const width = layout.area.width;
  const equalColumns = width >= totalColumns * MIN_BALANCED_PANE_WIDTH;
  const parentShare = equalColumns || totalColumns === 2 ? 1 / totalColumns : 0.4;
  const agentShare = (1 - parentShare) / balancedSurfaces.length;

  // Herdr reports this left-spine layout from outermost to innermost. The
  // oldest agent column is the outermost right-hand branch; the parent is the
  // innermost left-hand leaf.
  for (let splitIndex = 0; splitIndex < totalColumns - 1; splitIndex++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      layout = readPaneLayout(balancedParent) ?? layout;
      horizontalSplits = layout.splits.filter((split) => split.direction === "right");
      const current = horizontalSplits[splitIndex]?.ratio;
      if (typeof current !== "number") break;

      const firstLeafCount = totalColumns - 1 - splitIndex;
      const firstBranchShare = equalColumns
        ? firstLeafCount / totalColumns
        : parentShare + (firstLeafCount - 1) * agentShare;
      const secondBranchShare = equalColumns ? 1 / totalColumns : agentShare;
      const target = firstBranchShare / (firstBranchShare + secondBranchShare);
      const delta = target - current;
      if (Math.abs(delta) <= 0.01) break;

      const firstBranchRightmost =
        splitIndex === totalColumns - 2
          ? balancedParent
          : balancedSurfaces[splitIndex + 1];
      const secondBranchLeaf = balancedSurfaces[splitIndex];
      const pane = delta > 0 ? firstBranchRightmost : secondBranchLeaf;
      const direction = delta > 0 ? "right" : "left";
      const changed = resizeSplit(pane, direction, Math.min(Math.abs(delta), MAX_RESIZE_STEP));
      if (!changed) break;
    }
  }
}

function syncBalancedParent(parent: string): void {
  if (balancedParent === parent) return;
  balancedParent = parent;
  balancedColumns.length = 0;
}

function untrackBalancedSurface(surface: string): boolean {
  for (let columnIndex = 0; columnIndex < balancedColumns.length; columnIndex++) {
    const column = balancedColumns[columnIndex]!;
    const surfaceIndex = column.indexOf(surface);
    if (surfaceIndex < 0) continue;

    column.splice(surfaceIndex, 1);
    if (column.length === 0) balancedColumns.splice(columnIndex, 1);
    return true;
  }
  return false;
}

// ── Surface primitives ──

/** Create a non-focused pane in the next available agent-column slot. */
export function createSurface(name: string): string {
  const parent = process.env.HERDR_PANE_ID;
  if (!parent) throw new Error("HERDR_PANE_ID is not set.");

  syncBalancedParent(parent);
  const placement = chooseSurfacePlacement(parent, balancedColumns);
  const pane = createSurfaceSplit(name, placement.direction, placement.source);

  if (placement.direction === "down") {
    balancedColumns[placement.columnIndex]!.push(pane);
  }

  return pane;
}

/** Create a Herdr split in the given direction. */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  if (direction !== "right" && direction !== "down") {
    throw new Error(`Herdr supports only right and down splits, not ${direction}.`);
  }

  const source = fromSurface ?? process.env.HERDR_PANE_ID;
  if (!source) throw new Error("HERDR_PANE_ID is not set.");
  const response = runHerdrJson<{
    result?: { pane?: { pane_id?: string } };
  }>(["pane", "split", source, "--direction", direction, "--no-focus"], "pane split");
  const pane = response.result?.pane?.pane_id;
  if (!pane) throw new Error("Herdr pane split returned no pane id.");

  if (direction === "right" && source === process.env.HERDR_PANE_ID) {
    syncBalancedParent(source);
    balancedColumns.push([pane]);
    rebalanceSurfaces();
  }

  return pane;
}

/** Submit a command atomically with Enter. */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  execFileSync("herdr", ["pane", "run", surface, command], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/** Read pane output without ANSI styling. */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  const common = ["pane", "read", surface, "--format", "text", "--lines", String(Math.max(1, lines))];
  try {
    const detection = execFileSync("herdr", [...common, "--source", "detection"], { encoding: "utf8" });
    if (detection.trim()) return detection;
  } catch {}
  return execFileSync("herdr", [...common, "--source", "visible"], { encoding: "utf8" });
}

/** Read pane output asynchronously without ANSI styling. */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const common = ["pane", "read", surface, "--format", "text", "--lines", String(Math.max(1, lines))];
  try {
    const { stdout } = await execFileAsync("herdr", [...common, "--source", "detection"], {
      encoding: "utf8",
    });
    if (stdout.trim()) return stdout;
  } catch {}
  const { stdout } = await execFileAsync("herdr", [...common, "--source", "visible"], {
    encoding: "utf8",
  });
  return stdout;
}

/** Close a Herdr pane. */
export function closeSurface(surface: string): void {
  const tracked = untrackBalancedSurface(surface);
  runHerdrJson(["pane", "close", surface], "pane close");
  if (tracked) rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
