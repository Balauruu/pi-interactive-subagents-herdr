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
import {
  createPaneOwnership,
  parseHerdrPaneLayout,
  planOwnedClose,
  planOwnedSplit,
  planPaneReconciliation,
  registerOwnedSplit,
  unregisterOwnedPane,
  type LayoutPlan,
  type LayoutReason,
  type PaneOwnership,
} from "./pane-layout.ts";

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

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Ownership-proven asynchronous surface layout ──

/** A redacted outcome suitable for lifecycle diagnostics. Never includes Herdr output. */
export interface PaneLayoutOutcome {
  state: "completed" | "skipped" | "cancelled" | "failed";
  reason: LayoutReason | "command-failed" | "command-timeout" | "invalid-command-response";
  rootPaneId: string;
  ownerPaneCount: number;
  operationCount: number;
}

export interface HerdrExecutor {
  run(args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string }>;
}

export interface PaneLayoutCoordinatorOptions {
  rootPaneId: string;
  executor?: HerdrExecutor;
  commandTimeoutMs?: number;
  maxOperations?: number;
}

const DEFAULT_LAYOUT_COMMAND_TIMEOUT_MS = 3_000;
const DEFAULT_LAYOUT_OPERATION_BUDGET = 8;

function commandReason(error: unknown, signal?: AbortSignal): PaneLayoutOutcome["reason"] {
  if (signal?.aborted || (error as { name?: string } | undefined)?.name === "AbortError") return "aborted";
  const commandError = error as { killed?: boolean; signal?: string; code?: string } | undefined;
  if (commandError?.killed || commandError?.signal === "SIGTERM" || commandError?.code === "ETIMEDOUT") {
    return "command-timeout";
  }
  return "command-failed";
}

/**
 * Production executor: passes every pane id as an argv element, never a shell
 * fragment. The adapter returns stdout only to the coordinator for immediate
 * validation and intentionally does not retain command output.
 */
export function createHerdrExecutor(): HerdrExecutor {
  return {
    async run(args, options) {
      requireHerdr();
      const { stdout } = await execFileAsync("herdr", [...args], {
        encoding: "utf8",
        timeout: options.timeoutMs,
        signal: options.signal,
      });
      return { stdout: String(stdout) };
    },
  };
}

function parseCommandJson(stdout: string): unknown | undefined {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function resultPaneId(response: unknown): string | undefined {
  const candidate = response as {
    result?: { pane?: { pane_id?: unknown }; pane_id?: unknown; id?: unknown };
  } | undefined;
  const paneId = candidate?.result?.pane?.pane_id ?? candidate?.result?.pane_id ?? candidate?.result?.id;
  return typeof paneId === "string" ? paneId : undefined;
}

function outcomeFromPlan(plan: LayoutPlan): PaneLayoutOutcome {
  return {
    state: plan.state,
    reason: plan.reason,
    rootPaneId: plan.rootPaneId,
    ownerPaneCount: plan.ownedPaneCount,
    operationCount: plan.operationCount,
  };
}

function failedOutcome(
  ownership: PaneOwnership,
  reason: PaneLayoutOutcome["reason"],
  operationCount = 0,
): PaneLayoutOutcome {
  return {
    state: reason === "aborted" ? "cancelled" : "failed",
    reason,
    rootPaneId: ownership.rootPaneId,
    ownerPaneCount: ownership.ownedPaneIds.size,
    operationCount,
  };
}

/**
 * One coordinator exists per trusted root pane. It owns its registered child
 * ids, serializes reconciliation, and treats layout failures as observable
 * results rather than destructive cleanup failures.
 */
export class PaneLayoutCoordinator {
  #ownership: PaneOwnership;
  #executor: HerdrExecutor;
  #timeoutMs: number;
  #maxOperations: number;
  #reconciliation: Promise<PaneLayoutOutcome> | undefined;

  constructor(options: PaneLayoutCoordinatorOptions) {
    this.#ownership = createPaneOwnership(options.rootPaneId);
    this.#executor = options.executor ?? createHerdrExecutor();
    this.#timeoutMs = options.commandTimeoutMs ?? DEFAULT_LAYOUT_COMMAND_TIMEOUT_MS;
    this.#maxOperations = options.maxOperations ?? DEFAULT_LAYOUT_OPERATION_BUDGET;
  }

  get rootPaneId(): string {
    return this.#ownership.rootPaneId;
  }

  get ownedPaneIds(): ReadonlySet<string> {
    return this.#ownership.ownedPaneIds;
  }

  async #snapshot(signal?: AbortSignal): Promise<{ snapshot?: unknown; outcome?: PaneLayoutOutcome }> {
    try {
      const { stdout } = await this.#executor.run(["pane", "layout", "--pane", this.rootPaneId], {
        timeoutMs: this.#timeoutMs,
        signal,
      });
      const snapshot = parseCommandJson(stdout);
      return snapshot === undefined
        ? { outcome: failedOutcome(this.#ownership, "invalid-command-response") }
        : { snapshot };
    } catch (error) {
      return { outcome: failedOutcome(this.#ownership, commandReason(error, signal)) };
    }
  }

  async #run(args: string[], signal?: AbortSignal): Promise<PaneLayoutOutcome | undefined> {
    try {
      await this.#executor.run(args, { timeoutMs: this.#timeoutMs, signal });
      return undefined;
    } catch (error) {
      return failedOutcome(this.#ownership, commandReason(error, signal), 1);
    }
  }

  /** Allocate one owned pane. Split failure rejects launch, rebalance failure does not revoke ownership. */
  async allocate(signal?: AbortSignal): Promise<string> {
    const read = await this.#snapshot(signal);
    if (read.outcome) throw new Error(`Herdr layout allocation failed: ${read.outcome.reason}`);
    const plan = planOwnedSplit(this.#ownership, read.snapshot, {
      signal,
      maxOperations: this.#maxOperations,
      allowForeignPanesForSplit: true,
    });
    if (plan.state !== "completed" || plan.reason !== "planned" || plan.operations[0]?.kind !== "split") {
      throw new Error(`Herdr layout allocation skipped: ${plan.reason}`);
    }
    const operation = plan.operations[0];
    let allocatedPaneId: string | undefined;
    try {
      const { stdout } = await this.#executor.run(
        ["pane", "split", operation.paneId, "--direction", operation.direction, "--no-focus"],
        { timeoutMs: this.#timeoutMs, signal },
      );
      const paneId = resultPaneId(parseCommandJson(stdout));
      if (!paneId) throw new Error("invalid split response");
      const registration = registerOwnedSplit(this.#ownership, paneId);
      if (registration.state !== "registered") throw new Error(`split registration ${registration.reason}`);
      this.#ownership = registration.ownership;
      allocatedPaneId = paneId;
    } catch (error) {
      const reason = error instanceof Error && error.message === "invalid split response"
        ? "invalid-command-response"
        : commandReason(error, signal);
      throw new Error(`Herdr pane split failed: ${reason}`);
    }

    // A post-split layout failure remains observable and retryable through the
    // separate terminal layout action. It never erases the allocated pane.
    await this.reconcile(signal);
    return allocatedPaneId!;
  }

  /** Coalesce duplicate reconciliation requests per root into one bounded command sequence. */
  reconcile(signal?: AbortSignal): Promise<PaneLayoutOutcome> {
    if (this.#reconciliation) return this.#reconciliation;
    const run = this.#reconcile(signal).finally(() => {
      if (this.#reconciliation === run) this.#reconciliation = undefined;
    });
    this.#reconciliation = run;
    return run;
  }

  async #reconcile(signal?: AbortSignal): Promise<PaneLayoutOutcome> {
    const read = await this.#snapshot(signal);
    if (read.outcome) return read.outcome;
    const plan = planPaneReconciliation(this.#ownership, read.snapshot, {
      signal,
      maxOperations: this.#maxOperations,
    });
    if (plan.state !== "completed" || plan.reason !== "planned") return outcomeFromPlan(plan);

    let completed = 0;
    for (const operation of plan.operations) {
      if (operation.kind !== "resize") continue;
      // Herdr resizes by fraction. Derive a capped one-step correction from
      // this validated measurement and never loop toward convergence.
      const parsed = parseHerdrPaneLayout(read.snapshot);
      const current = parsed.ok ? parsed.layout.panes.find((pane) => pane.paneId === operation.paneId) : undefined;
      const currentArea = current ? current.rect.width * current.rect.height : operation.targetArea;
      const amount = Math.min(0.25, Math.max(0.01, Math.abs(operation.targetArea - currentArea) / operation.targetArea));
      const failed = await this.#run([
        "pane", "resize", "--pane", operation.paneId, "--direction", operation.direction,
        "--amount", amount.toFixed(4),
      ], signal);
      if (failed) return { ...failed, operationCount: completed + failed.operationCount };
      completed++;
    }
    return { ...outcomeFromPlan(plan), operationCount: completed };
  }

  /** Close only a pane registered from a successful split. Repeated closes are safe no-ops. */
  async close(paneId: string, signal?: AbortSignal): Promise<PaneLayoutOutcome> {
    const read = await this.#snapshot(signal);
    if (read.outcome) return read.outcome;
    const plan = planOwnedClose(this.#ownership, read.snapshot, paneId, { signal, maxOperations: this.#maxOperations });
    if (plan.state !== "completed" || plan.reason !== "planned" || plan.operations[0]?.kind !== "close") {
      if (plan.reason === "already-closed") {
        this.#ownership = unregisterOwnedPane(this.#ownership, paneId);
        return {
          ...outcomeFromPlan(plan),
          ownerPaneCount: this.#ownership.ownedPaneIds.size,
        };
      }
      return outcomeFromPlan(plan);
    }
    const failed = await this.#run(["pane", "close", paneId], signal);
    if (failed) return failed;
    this.#ownership = unregisterOwnedPane(this.#ownership, paneId);
    return {
      state: "completed",
      reason: "planned",
      rootPaneId: this.rootPaneId,
      ownerPaneCount: this.#ownership.ownedPaneIds.size,
      operationCount: 1,
    };
  }
}

const layoutCoordinators = new Map<string, PaneLayoutCoordinator>();

export function paneLayoutCoordinator(rootPaneId = process.env.HERDR_PANE_ID): PaneLayoutCoordinator {
  if (!rootPaneId) throw new Error("HERDR_PANE_ID is not set.");
  let coordinator = layoutCoordinators.get(rootPaneId);
  if (!coordinator) {
    coordinator = new PaneLayoutCoordinator({ rootPaneId });
    layoutCoordinators.set(rootPaneId, coordinator);
  }
  return coordinator;
}

/** Create a non-focused, registered extension pane before process launch. */
export async function createSurface(_name: string, signal?: AbortSignal): Promise<string> {
  return paneLayoutCoordinator().allocate(signal);
}

/** Compatibility wrapper for callers that explicitly choose a split source. */
export async function createSurfaceSplit(
  _name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (fromSurface && fromSurface !== paneLayoutCoordinator().rootPaneId) {
    throw new Error("Only the trusted root coordinator may select split sources.");
  }
  if (direction !== "right" && direction !== "down") throw new Error(`Herdr supports only right and down splits, not ${direction}.`);
  return paneLayoutCoordinator().allocate(signal);
}

/** Submit a command atomically with Enter. */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  execFileSync("herdr", ["pane", "run", surface, command], { encoding: "utf8" });
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath = options?.scriptPath ?? join(tmpdir(), "pi-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });
  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) scriptParts.push(options.scriptPreamble.trimEnd());
  scriptParts.push(command);
  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", { mode: 0o755 });
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
    const { stdout } = await execFileAsync("herdr", [...common, "--source", "detection"], { encoding: "utf8" });
    if (stdout.trim()) return stdout;
  } catch {}
  const { stdout } = await execFileAsync("herdr", [...common, "--source", "visible"], { encoding: "utf8" });
  return stdout;
}

/** Close a known owned pane. Failures are thrown so lifecycle cleanup remains retryable. */
export async function closeSurface(surface: string, signal?: AbortSignal): Promise<PaneLayoutOutcome> {
  const outcome = await paneLayoutCoordinator().close(surface, signal);
  if (outcome.state === "failed" || outcome.state === "cancelled") throw new Error(`Herdr pane close failed: ${outcome.reason}`);
  return outcome;
}

/** Rebalance known owned panes as a separate failure-isolated lifecycle action. */
export async function layoutSurfaces(signal?: AbortSignal): Promise<PaneLayoutOutcome> {
  const outcome = await paneLayoutCoordinator().reconcile(signal);
  if (outcome.state === "failed" || outcome.state === "cancelled") throw new Error(`Herdr pane layout failed: ${outcome.reason}`);
  return outcome;
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
