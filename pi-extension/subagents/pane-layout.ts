/**
 * Pure, ownership-aware planning for Herdr pane layouts.
 *
 * This module deliberately does not invoke Herdr.  The command adapter owns
 * process execution and registers a returned pane id only after a successful
 * extension-owned split.
 */

export type LayoutOutcomeState = "completed" | "skipped" | "cancelled" | "failed";

export type LayoutReason =
  | "aborted"
  | "malformed-layout"
  | "empty-layout"
  | "duplicate-pane-id"
  | "mixed-ownership"
  | "stale-owned-pane"
  | "unknown-pane"
  | "root-pane-protected"
  | "already-balanced"
  | "planned"
  | "command-budget-exhausted"
  | "duplicate-owned-pane"
  | "invalid-pane-id"
  | "already-closed";

export interface PaneRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutPane {
  paneId: string;
  rect: PaneRectangle;
}

export interface HerdrPaneLayout {
  area: PaneRectangle;
  panes: readonly LayoutPane[];
}

export type LayoutParseResult =
  | { ok: true; layout: HerdrPaneLayout }
  | { ok: false; reason: "malformed-layout" | "empty-layout" | "duplicate-pane-id" };

export type LayoutOperation =
  | { kind: "split"; paneId: string; direction: "right" | "down" }
  | {
      kind: "resize";
      paneId: string;
      direction: "left" | "right" | "up" | "down";
      targetArea: number;
    }
  | { kind: "close"; paneId: string };

export interface LayoutPlan {
  state: LayoutOutcomeState;
  reason: LayoutReason;
  rootPaneId: string;
  ownedPaneCount: number;
  operationCount: number;
  operations: readonly LayoutOperation[];
}

export interface PaneOwnership {
  readonly rootPaneId: string;
  readonly ownedPaneIds: ReadonlySet<string>;
}

export interface OwnershipRegistration {
  ownership: PaneOwnership;
  state: "registered" | "skipped";
  reason: "planned" | "duplicate-owned-pane" | "invalid-pane-id";
}

export interface PlannerOptions {
  /** A fixed cap prevents a bad snapshot from causing unbounded mutation. */
  maxOperations?: number;
  /** A caller can cancel before any command is handed to the adapter. */
  signal?: AbortSignal;
  /** Area variance tolerated before a resize is considered useful. */
  balanceTolerance?: number;
}

const DEFAULT_MAX_OPERATIONS = 8;
const DEFAULT_BALANCE_TOLERANCE = 0.05;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPaneId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function parseRectangle(value: unknown): PaneRectangle | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (![x, y, width, height].every((number) => typeof number === "number" && Number.isFinite(number))) {
    return undefined;
  }
  if ((width as number) <= 0 || (height as number) <= 0) return undefined;
  return { x: x as number, y: y as number, width: width as number, height: height as number };
}

/**
 * Parse only the stable Herdr layout fields needed by the planner.  The
 * adapter may pass either a layout object or the usual `{ result: { layout } }`
 * response envelope.  Parse errors intentionally contain no raw response.
 */
export function parseHerdrPaneLayout(value: unknown): LayoutParseResult {
  const envelope = isRecord(value) && isRecord(value.result) ? value.result : value;
  if (!isRecord(envelope)) return { ok: false, reason: "malformed-layout" };
  const candidate = isRecord(envelope.layout) ? envelope.layout : envelope;
  if (!isRecord(candidate) || !Array.isArray(candidate.panes)) {
    return { ok: false, reason: "malformed-layout" };
  }

  const area = parseRectangle(candidate.area);
  if (!area) return { ok: false, reason: "malformed-layout" };
  if (candidate.panes.length === 0) return { ok: false, reason: "empty-layout" };

  const paneIds = new Set<string>();
  const panes: LayoutPane[] = [];
  for (const value of candidate.panes) {
    if (!isRecord(value) || !isPaneId(value.pane_id) || paneIds.has(value.pane_id)) {
      return { ok: false, reason: !isRecord(value) || !isPaneId(value.pane_id) ? "malformed-layout" : "duplicate-pane-id" };
    }
    const rect = parseRectangle(value.rect);
    if (!rect) return { ok: false, reason: "malformed-layout" };
    paneIds.add(value.pane_id);
    panes.push({ paneId: value.pane_id, rect });
  }

  return { ok: true, layout: { area, panes } };
}

/** Creates immutable root-scoped ownership with only the root as a trusted anchor. */
export function createPaneOwnership(rootPaneId: string): PaneOwnership {
  if (!isPaneId(rootPaneId)) throw new TypeError("A valid root pane id is required.");
  return { rootPaneId, ownedPaneIds: new Set<string>() };
}

/** Registers only an id returned from a successful extension-owned split. */
export function registerOwnedSplit(ownership: PaneOwnership, paneId: string): OwnershipRegistration {
  if (!isPaneId(paneId)) return { ownership, state: "skipped", reason: "invalid-pane-id" };
  if (paneId === ownership.rootPaneId || ownership.ownedPaneIds.has(paneId)) {
    return { ownership, state: "skipped", reason: "duplicate-owned-pane" };
  }
  return {
    ownership: { rootPaneId: ownership.rootPaneId, ownedPaneIds: new Set([...ownership.ownedPaneIds, paneId]) },
    state: "registered",
    reason: "planned",
  };
}

/** Removes an owned id after the adapter has confirmed its close command. */
export function unregisterOwnedPane(ownership: PaneOwnership, paneId: string): PaneOwnership {
  if (!ownership.ownedPaneIds.has(paneId)) return ownership;
  const ownedPaneIds = new Set(ownership.ownedPaneIds);
  ownedPaneIds.delete(paneId);
  return { rootPaneId: ownership.rootPaneId, ownedPaneIds };
}

function emptyPlan(ownership: PaneOwnership, state: LayoutOutcomeState, reason: LayoutReason): LayoutPlan {
  return {
    state,
    reason,
    rootPaneId: ownership.rootPaneId,
    ownedPaneCount: ownership.ownedPaneIds.size,
    operationCount: 0,
    operations: [],
  };
}

function operationBudget(options: PlannerOptions): number {
  const requested = options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
  return Number.isInteger(requested) && requested >= 0 ? requested : DEFAULT_MAX_OPERATIONS;
}

function trustedPaneIds(ownership: PaneOwnership): Set<string> {
  return new Set([ownership.rootPaneId, ...ownership.ownedPaneIds]);
}

function validateSnapshot(ownership: PaneOwnership, value: unknown, options: PlannerOptions):
  | { plan: LayoutPlan }
  | { layout: HerdrPaneLayout; trusted: Set<string> } {
  if (options.signal?.aborted) return { plan: emptyPlan(ownership, "cancelled", "aborted") };
  const parsed = parseHerdrPaneLayout(value);
  if (!parsed.ok) return { plan: emptyPlan(ownership, "failed", parsed.reason) };

  const present = new Set(parsed.layout.panes.map((pane) => pane.paneId));
  const trusted = trustedPaneIds(ownership);
  for (const paneId of trusted) {
    if (!present.has(paneId)) return { plan: emptyPlan(ownership, "skipped", "stale-owned-pane") };
  }
  if (parsed.layout.panes.some((pane) => !trusted.has(pane.paneId))) {
    return { plan: emptyPlan(ownership, "skipped", "mixed-ownership") };
  }
  return { layout: parsed.layout, trusted };
}

function paneArea(pane: LayoutPane): number {
  return pane.rect.width * pane.rect.height;
}

function sortByAreaThenId(panes: readonly LayoutPane[]): LayoutPane[] {
  return [...panes].sort((left, right) => paneArea(right) - paneArea(left) || left.paneId.localeCompare(right.paneId));
}

function resizeDirection(pane: LayoutPane, anchor: LayoutPane): "left" | "right" | "up" | "down" {
  const paneCenterX = pane.rect.x + pane.rect.width / 2;
  const paneCenterY = pane.rect.y + pane.rect.height / 2;
  const anchorCenterX = anchor.rect.x + anchor.rect.width / 2;
  const anchorCenterY = anchor.rect.y + anchor.rect.height / 2;
  if (Math.abs(anchorCenterX - paneCenterX) >= Math.abs(anchorCenterY - paneCenterY)) {
    return anchorCenterX >= paneCenterX ? "right" : "left";
  }
  return anchorCenterY >= paneCenterY ? "down" : "up";
}

/** Chooses the largest proven leaf and splits across its longest usable axis. */
export function planOwnedSplit(ownership: PaneOwnership, snapshot: unknown, options: PlannerOptions = {}): LayoutPlan {
  const validated = validateSnapshot(ownership, snapshot, options);
  if ("plan" in validated) return validated.plan;
  if (operationBudget(options) < 1) return emptyPlan(ownership, "failed", "command-budget-exhausted");

  const source = sortByAreaThenId(validated.layout.panes)[0]!;
  const direction = source.rect.width >= source.rect.height ? "right" : "down";
  const operations: LayoutOperation[] = [{ kind: "split", paneId: source.paneId, direction }];
  return {
    state: "completed",
    reason: "planned",
    rootPaneId: ownership.rootPaneId,
    ownedPaneCount: ownership.ownedPaneIds.size,
    operationCount: operations.length,
    operations,
  };
}

/**
 * Plans one bounded rebalance from a single validated snapshot.  It never
 * iterates toward convergence and never includes a pane that ownership did
 * not prove.
 */
export function planPaneReconciliation(ownership: PaneOwnership, snapshot: unknown, options: PlannerOptions = {}): LayoutPlan {
  const validated = validateSnapshot(ownership, snapshot, options);
  if ("plan" in validated) return validated.plan;

  const panes = sortByAreaThenId(validated.layout.panes);
  if (panes.length < 2) return emptyPlan(ownership, "completed", "already-balanced");

  const targetArea = panes.reduce((sum, pane) => sum + paneArea(pane), 0) / panes.length;
  const tolerance = Math.max(0, options.balanceTolerance ?? DEFAULT_BALANCE_TOLERANCE);
  const anchor = panes[0]!;
  const operations: LayoutOperation[] = panes.slice(1)
    .filter((pane) => Math.abs(paneArea(pane) - targetArea) / targetArea > tolerance)
    .map((pane) => ({
      kind: "resize" as const,
      paneId: pane.paneId,
      direction: resizeDirection(pane, anchor),
      targetArea,
    }));

  if (operations.length === 0) return emptyPlan(ownership, "completed", "already-balanced");
  if (operations.length > operationBudget(options)) {
    return emptyPlan(ownership, "failed", "command-budget-exhausted");
  }
  return {
    state: "completed",
    reason: "planned",
    rootPaneId: ownership.rootPaneId,
    ownedPaneCount: ownership.ownedPaneIds.size,
    operationCount: operations.length,
    operations,
  };
}

/** Plans an owner-safe close. A stale second close is a completed no-op. */
export function planOwnedClose(ownership: PaneOwnership, snapshot: unknown, paneId: string, options: PlannerOptions = {}): LayoutPlan {
  if (options.signal?.aborted) return emptyPlan(ownership, "cancelled", "aborted");
  if (paneId === ownership.rootPaneId) return emptyPlan(ownership, "skipped", "root-pane-protected");
  if (!ownership.ownedPaneIds.has(paneId)) return emptyPlan(ownership, "skipped", "unknown-pane");

  const parsed = parseHerdrPaneLayout(snapshot);
  if (!parsed.ok) return emptyPlan(ownership, "failed", parsed.reason);
  if (!parsed.layout.panes.some((pane) => pane.paneId === paneId)) {
    return emptyPlan(ownership, "completed", "already-closed");
  }
  if (operationBudget(options) < 1) return emptyPlan(ownership, "failed", "command-budget-exhausted");

  const operations: LayoutOperation[] = [{ kind: "close", paneId }];
  return {
    state: "completed",
    reason: "planned",
    rootPaneId: ownership.rootPaneId,
    ownedPaneCount: ownership.ownedPaneIds.size,
    operationCount: operations.length,
    operations,
  };
}
