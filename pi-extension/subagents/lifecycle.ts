import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const STATE_VERSION = 2;
const LEGACY_STATE_VERSION = 1;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PHASES = ["starting", "running", "waiting", "interactive", "terminal", "cancelled"] as const;
const ACTIVE_PHASES = ["starting", "running", "waiting", "interactive"] as const;
const TRANSITIONS = ["extraction", "delivery", "release", "cleanup", "layout", "notification"] as const;

type LifecyclePhase = (typeof PHASES)[number];
type ActiveLifecyclePhase = (typeof ACTIVE_PHASES)[number];
export type TransitionName = (typeof TRANSITIONS)[number];
type TransitionStatus = "pending" | "claimed" | "complete" | "ambiguous";

export type LifecycleErrorCode =
  | "invalid-identifier"
  | "invalid-configuration"
  | "invalid-evidence"
  | "capacity-exhausted"
  | "duplicate-child"
  | "unknown-child"
  | "ownership-mismatch"
  | "lease-mismatch"
  | "phase-terminal"
  | "terminal-evidence-required"
  | "terminal-evidence-immutable"
  | "transition-not-claimed"
  | "transition-owned"
  | "retry-exhausted"
  | "malformed-state"
  | "root-mismatch"
  | "lock-contended"
  | "persistence-failed";

/** A recoverable, redacted lifecycle error suitable for callers and diagnostics. */
export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;

  constructor(code: LifecycleErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "LifecycleError";
  }
}

export interface TerminalEvidence {
  /** Process exit code, if a process was started. */
  exitCode: number | null;
  /** The raw completion sentinel, never a prompt or transcript body. */
  sentinel: string | null;
  /** Stable reference to a transcript, never its contents. */
  transcriptRef: string | null;
  /** Stable reference to the child session, never a path derived from input. */
  sessionRef: string | null;
  cancelled: boolean;
  observedAt: string;
}

export interface LifecycleLease {
  token: string;
  ownerId: string;
  acquiredAt: string;
  releasedAt: string | null;
}

interface LifecycleTransition {
  status: TransitionStatus;
  ownerId: string | null;
  attempts: number;
  claimedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

export interface ChildLifecycleRecord {
  childId: string;
  phase: LifecyclePhase;
  lease: LifecycleLease & { state: "active" | "released" };
  terminalEvidence: TerminalEvidence | null;
  transitions: Record<TransitionName, LifecycleTransition>;
  createdAt: string;
  updatedAt: string;
  lastTransitionError: string | null;
}

export interface RootTreeLifecycleState {
  version: typeof STATE_VERSION;
  rootId: string;
  children: Record<string, ChildLifecycleRecord>;
  updatedAt: string;
}

export interface RootTreeLifecycleCoordinatorOptions {
  /** The root session's existing durable artifact directory. */
  rootArtifactDir: string;
  rootId: string;
  maxActiveSubagents: number;
  /** Includes the initial claim. Defaults to two attempts. */
  maxTransitionAttempts?: number;
  now?: () => Date;
  leaseTokenFactory?: () => string;
}

export interface RootIdentityInput {
  sessionId: string;
  inheritedRootId?: string | null;
}

function invalid(message: string): never {
  throw new LifecycleError("invalid-identifier", message);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value) || value.includes("..")) {
    invalid(`${label} must be a safe lifecycle identifier`);
  }
}

function assertLeaseToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{32,128}$/.test(value)) {
    throw new LifecycleError("lease-mismatch", "lease token is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isShortText(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f]/.test(value));
}

function isTerminalEvidence(value: unknown): value is TerminalEvidence {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ["cancelled", "exitCode", "observedAt", "sentinel", "sessionRef", "transcriptRef"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false;
  return (
    (value.exitCode === null || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) &&
    isShortText(value.sentinel) &&
    isShortText(value.transcriptRef) &&
    isShortText(value.sessionRef) &&
    typeof value.cancelled === "boolean" &&
    isTimestamp(value.observedAt)
  );
}

function sameTerminalEvidence(left: TerminalEvidence, right: TerminalEvidence): boolean {
  return (
    left.exitCode === right.exitCode &&
    left.sentinel === right.sentinel &&
    left.transcriptRef === right.transcriptRef &&
    left.sessionRef === right.sessionRef &&
    left.cancelled === right.cancelled &&
    left.observedAt === right.observedAt
  );
}

function newTransitions(): Record<TransitionName, LifecycleTransition> {
  return Object.fromEntries(
    TRANSITIONS.map((transition) => [
      transition,
      { status: "pending", ownerId: null, attempts: 0, claimedAt: null, completedAt: null, lastError: null },
    ]),
  ) as Record<TransitionName, LifecycleTransition>;
}

function validTransition(value: unknown): value is TransitionName {
  return typeof value === "string" && (TRANSITIONS as readonly string[]).includes(value);
}

function validPhase(value: unknown): value is LifecyclePhase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

function validActivePhase(value: unknown): value is ActiveLifecyclePhase {
  return typeof value === "string" && (ACTIVE_PHASES as readonly string[]).includes(value);
}

function isLifecycleTransition(value: unknown): value is LifecycleTransition {
  return (
    isRecord(value) &&
    (value.status === "pending" || value.status === "claimed" || value.status === "complete" || value.status === "ambiguous") &&
    (value.ownerId === null || assertIdentifierForSchema(value.ownerId)) &&
    typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts >= 0 &&
    (value.claimedAt === null || isTimestamp(value.claimedAt)) &&
    (value.completedAt === null || isTimestamp(value.completedAt)) &&
    (value.lastError === null || isShortText(value.lastError))
  );
}

function isChildRecord(value: unknown, childId: string): value is ChildLifecycleRecord {
  if (!isRecord(value) || value.childId !== childId || !validPhase(value.phase) || !isRecord(value.lease)) return false;
  const lease = value.lease;
  if (
    !assertIdentifierForSchema(lease.ownerId) || !assertLeaseForSchema(lease.token) ||
    (lease.state !== "active" && lease.state !== "released") || !isTimestamp(lease.acquiredAt) ||
    (lease.releasedAt !== null && !isTimestamp(lease.releasedAt)) ||
    !(value.terminalEvidence === null || isTerminalEvidence(value.terminalEvidence)) ||
    !isRecord(value.transitions) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) ||
    !(value.lastTransitionError === null || isShortText(value.lastTransitionError))
  ) return false;
  const evidence = value.terminalEvidence;
  if (
    (evidence === null && (value.phase === "terminal" || value.phase === "cancelled" || lease.state === "released")) ||
    (evidence !== null && (value.phase !== (evidence.cancelled ? "cancelled" : "terminal")))
  ) return false;
  return TRANSITIONS.every((name) => isLifecycleTransition(value.transitions[name]));
}

function assertIdentifierForSchema(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value) && !value.includes("..");
}

function assertLeaseForSchema(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32,128}$/.test(value);
}

function isLifecycleState(value: unknown): value is RootTreeLifecycleState {
  if (!isRecord(value) || value.version !== STATE_VERSION || !assertIdentifierForSchema(value.rootId) || !isRecord(value.children) || !isTimestamp(value.updatedAt)) return false;
  return Object.entries(value.children).every(([childId, child]) => assertIdentifierForSchema(childId) && isChildRecord(child, childId));
}

/** Add the independent notification transition to valid v1 state before use. */
function migrateLegacyState(value: unknown): unknown {
  if (!isRecord(value) || value.version !== LEGACY_STATE_VERSION || !isRecord(value.children)) return value;
  const upgraded = clone(value) as Record<string, unknown>;
  const children = upgraded.children as Record<string, unknown>;
  for (const child of Object.values(children)) {
    if (!isRecord(child) || !isRecord(child.transitions) || child.transitions.notification !== undefined) return value;
    child.transitions.notification = {
      status: "pending",
      ownerId: null,
      attempts: 0,
      claimedAt: null,
      completedAt: null,
      lastError: null,
    };
  }
  upgraded.version = STATE_VERSION;
  return upgraded;
}

/** Return the propagated root when supplied, otherwise the current session's stable id. */
export function deriveRootTreeId({ sessionId, inheritedRootId }: RootIdentityInput): string {
  assertIdentifier(sessionId, "session id");
  if (inheritedRootId !== undefined && inheritedRootId !== null) {
    assertIdentifier(inheritedRootId, "root id");
    return inheritedRootId;
  }
  return sessionId;
}

/**
 * A root-scoped durable admission and settlement store. Every mutation acquires
 * a directory lock then atomically renames a complete JSON snapshot, so another
 * process never observes a partial state file. A pre-existing lock is never
 * reaped: without proven ownership it is safer to fail admission than reclaim.
 */
export class RootTreeLifecycleCoordinator {
  readonly statePath: string;
  readonly lockPath: string;
  private readonly options: RootTreeLifecycleCoordinatorOptions;
  private readonly maxTransitionAttempts: number;
  private readonly now: () => Date;
  private readonly leaseTokenFactory: () => string;
  private activeLockToken: string | null = null;

  constructor(options: RootTreeLifecycleCoordinatorOptions) {
    this.options = options;
    assertIdentifier(options.rootId, "root id");
    if (!Number.isInteger(options.maxActiveSubagents) || options.maxActiveSubagents < 0) {
      throw new LifecycleError("invalid-configuration", "maxActiveSubagents must be a non-negative integer");
    }
    this.maxTransitionAttempts = options.maxTransitionAttempts ?? 2;
    if (!Number.isInteger(this.maxTransitionAttempts) || this.maxTransitionAttempts < 1) {
      throw new LifecycleError("invalid-configuration", "maxTransitionAttempts must be a positive integer");
    }
    if (typeof options.rootArtifactDir !== "string" || options.rootArtifactDir.length === 0) {
      throw new LifecycleError("invalid-configuration", "rootArtifactDir is required");
    }
    this.statePath = join(options.rootArtifactDir, "subagent-lifecycle.json");
    this.lockPath = join(options.rootArtifactDir, "subagent-lifecycle.lock");
    this.now = options.now ?? (() => new Date());
    this.leaseTokenFactory = options.leaseTokenFactory ?? (() => randomBytes(32).toString("hex"));
  }

  acquire(params: { childId: string; ownerId: string }): { admitted: boolean; lease: LifecycleLease } {
    assertIdentifier(params.childId, "child id");
    assertIdentifier(params.ownerId, "owner id");
    return this.mutate((state) => {
      const existing = state.children[params.childId];
      if (existing) {
        if (existing.lease.ownerId !== params.ownerId) {
          throw new LifecycleError("duplicate-child", "child id is already owned by another worker");
        }
        return { changed: false, result: { admitted: false, lease: this.publicLease(existing) } };
      }
      if (this.activeCount(state) >= this.options.maxActiveSubagents) {
        throw new LifecycleError("capacity-exhausted", "root-tree admission capacity is exhausted");
      }
      const timestamp = this.timestamp();
      const token = this.leaseTokenFactory();
      assertLeaseToken(token);
      state.children[params.childId] = {
        childId: params.childId,
        phase: "starting",
        lease: { token, ownerId: params.ownerId, acquiredAt: timestamp, releasedAt: null, state: "active" },
        terminalEvidence: null,
        transitions: newTransitions(),
        createdAt: timestamp,
        updatedAt: timestamp,
        lastTransitionError: null,
      };
      state.updatedAt = timestamp;
      return { changed: true, result: { admitted: true, lease: this.publicLease(state.children[params.childId]) } };
    });
  }

  updatePhase(params: { childId: string; ownerId: string; leaseToken: string; phase: ActiveLifecyclePhase }): ChildLifecycleRecord {
    assertIdentifier(params.childId, "child id");
    assertIdentifier(params.ownerId, "owner id");
    assertLeaseToken(params.leaseToken);
    if (!validActivePhase(params.phase)) throw new LifecycleError("phase-terminal", "terminal phases require terminal evidence");
    return this.mutate((state) => {
      const child = this.assertLeaseOwner(state, params);
      if (child.terminalEvidence) throw new LifecycleError("phase-terminal", "terminal child phase cannot change");
      if (child.phase === params.phase) return { changed: false, result: clone(child) };
      child.phase = params.phase;
      this.touch(state, child);
      return { changed: true, result: clone(child) };
    });
  }

  persistTerminalEvidence(params: { childId: string; ownerId: string; leaseToken: string; evidence: TerminalEvidence }): { persisted: boolean; record: ChildLifecycleRecord } {
    assertIdentifier(params.childId, "child id");
    assertIdentifier(params.ownerId, "owner id");
    assertLeaseToken(params.leaseToken);
    if (!isTerminalEvidence(params.evidence)) throw new LifecycleError("invalid-evidence", "terminal evidence has an invalid shape");
    return this.mutate((state) => {
      const child = this.assertLeaseOwner(state, params);
      if (child.terminalEvidence) {
        if (!sameTerminalEvidence(child.terminalEvidence, params.evidence)) {
          throw new LifecycleError("terminal-evidence-immutable", "terminal evidence is already immutable");
        }
        return { changed: false, result: { persisted: false, record: clone(child) } };
      }
      child.terminalEvidence = clone(params.evidence);
      child.phase = params.evidence.cancelled ? "cancelled" : "terminal";
      this.touch(state, child);
      return { changed: true, result: { persisted: true, record: clone(child) } };
    });
  }

  claimTransition(params: { childId: string; ownerId: string; leaseToken: string; transition: TransitionName }): { claimed: boolean; attempts: number } {
    assertIdentifier(params.childId, "child id");
    assertIdentifier(params.ownerId, "owner id");
    assertLeaseToken(params.leaseToken);
    if (!validTransition(params.transition)) throw new LifecycleError("invalid-configuration", "unknown lifecycle transition");
    return this.mutate((state) => {
      const child = this.assertLeaseOwner(state, params);
      if (!child.terminalEvidence) {
        throw new LifecycleError("terminal-evidence-required", "terminal evidence must be persisted before settlement");
      }
      const transition = child.transitions[params.transition];
      if (transition.status === "complete" || transition.status === "ambiguous") return { changed: false, result: { claimed: false, attempts: transition.attempts } };
      if (transition.status === "claimed") {
        if (transition.ownerId !== params.ownerId) throw new LifecycleError("transition-owned", "transition is claimed by another owner");
        if (transition.attempts >= this.maxTransitionAttempts) throw new LifecycleError("retry-exhausted", "transition retry budget is exhausted");
        // A caller must finish a claim before trying again. Returning no-op avoids duplicate work.
        return { changed: false, result: { claimed: false, attempts: transition.attempts } };
      }
      if (transition.attempts >= this.maxTransitionAttempts) throw new LifecycleError("retry-exhausted", "transition retry budget is exhausted");
      transition.status = "claimed";
      transition.ownerId = params.ownerId;
      transition.attempts += 1;
      transition.claimedAt = this.timestamp();
      transition.lastError = null;
      this.touch(state, child);
      return { changed: true, result: { claimed: true, attempts: transition.attempts } };
    });
  }

  completeTransition(params: { childId: string; ownerId: string; leaseToken: string; transition: TransitionName; error?: string }): { completed: boolean; attempts: number } {
    assertIdentifier(params.childId, "child id");
    assertIdentifier(params.ownerId, "owner id");
    assertLeaseToken(params.leaseToken);
    if (!validTransition(params.transition)) throw new LifecycleError("invalid-configuration", "unknown lifecycle transition");
    if (
      params.error !== undefined &&
      (typeof params.error !== "string" ||
        params.error.trim() === "" ||
        !isShortText(params.error) ||
        !isShortText(`${params.transition}: ${params.error}`))
    ) {
      throw new LifecycleError("invalid-configuration", "transition error is invalid");
    }
    return this.mutate((state) => {
      const child = this.assertLeaseOwner(state, params);
      const transition = child.transitions[params.transition];
      if (transition.status === "complete") return { changed: false, result: { completed: false, attempts: transition.attempts } };
      if (transition.status !== "claimed") throw new LifecycleError("transition-not-claimed", "transition must be claimed before completion");
      if (transition.ownerId !== params.ownerId) throw new LifecycleError("transition-owned", "transition is claimed by another owner");
      if (params.error !== undefined) {
        transition.status = "pending";
        transition.lastError = params.error;
        child.lastTransitionError = `${params.transition}: ${params.error}`;
        this.touch(state, child);
        return { changed: true, result: { completed: false, attempts: transition.attempts } };
      }
      transition.status = "complete";
      transition.completedAt = this.timestamp();
      transition.lastError = null;
      this.touch(state, child);
      return { changed: true, result: { completed: true, attempts: transition.attempts } };
    });
  }

  /**
   * Fence a claimed external transition after invocation has an unknown result.
   * It is terminal but deliberately not reported as complete, so recovery can
   * inspect the redacted error without risking a duplicate parent-visible send.
   */
  fenceAmbiguousTransition(params: { childId: string; ownerId: string; leaseToken: string; transition: TransitionName; error: string }): { fenced: boolean; attempts: number } {
    assertIdentifier(params.childId, "child id");
    assertIdentifier(params.ownerId, "owner id");
    assertLeaseToken(params.leaseToken);
    if (!validTransition(params.transition)) throw new LifecycleError("invalid-configuration", "unknown lifecycle transition");
    if (typeof params.error !== "string" || !isShortText(params.error) || params.error.trim() === "") throw new LifecycleError("invalid-configuration", "transition error is invalid");
    return this.mutate((state) => {
      const child = this.assertLeaseOwner(state, params);
      const transition = child.transitions[params.transition];
      if (transition.status === "ambiguous") return { changed: false, result: { fenced: false, attempts: transition.attempts } };
      if (transition.status !== "claimed") throw new LifecycleError("transition-not-claimed", "transition must be claimed before fencing");
      if (transition.ownerId !== params.ownerId) throw new LifecycleError("transition-owned", "transition is claimed by another owner");
      transition.status = "ambiguous";
      transition.completedAt = this.timestamp();
      transition.lastError = params.error;
      child.lastTransitionError = `${params.transition}: ${params.error}`;
      this.touch(state, child);
      return { changed: true, result: { fenced: true, attempts: transition.attempts } };
    });
  }

  releaseLease(params: { childId: string; ownerId: string; leaseToken: string }): { released: boolean; lease: LifecycleLease } {
    assertIdentifier(params.childId, "child id");
    assertIdentifier(params.ownerId, "owner id");
    assertLeaseToken(params.leaseToken);
    return this.mutate((state) => {
      const child = this.assertLeaseOwner(state, params);
      if (!child.terminalEvidence) {
        throw new LifecycleError("terminal-evidence-required", "terminal evidence must be persisted before lease release");
      }
      if (child.lease.state === "released") return { changed: false, result: { released: false, lease: this.publicLease(child) } };
      child.lease.state = "released";
      child.lease.releasedAt = this.timestamp();
      this.touch(state, child);
      return { changed: true, result: { released: true, lease: this.publicLease(child) } };
    });
  }

  /** Reads one atomic snapshot without a lock and never returns live mutable state. */
  inspect(): RootTreeLifecycleState & { activeCount: number } {
    const state = this.readState();
    return { ...clone(state), activeCount: this.activeCount(state) };
  }

  private mutate<T>(operation: (state: RootTreeLifecycleState) => { changed: boolean; result: T }): T {
    this.acquireLock();
    try {
      const state = this.readState();
      const outcome = operation(state);
      if (outcome.changed) this.writeState(state);
      return outcome.result;
    } finally {
      this.releaseLock();
    }
  }

  private readState(): RootTreeLifecycleState {
    if (!existsSync(this.statePath)) {
      return { version: STATE_VERSION, rootId: this.options.rootId, children: {}, updatedAt: this.timestamp() };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch {
      throw new LifecycleError("malformed-state", "lifecycle state is unreadable or malformed");
    }
    const upgraded = migrateLegacyState(parsed);
    if (!isLifecycleState(upgraded)) throw new LifecycleError("malformed-state", "lifecycle state does not match the supported schema");
    if (upgraded.rootId !== this.options.rootId) throw new LifecycleError("root-mismatch", "artifact state belongs to another root");
    return upgraded;
  }

  private writeState(state: RootTreeLifecycleState): void {
    const temporaryPath = `${this.statePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
      renameSync(temporaryPath, this.statePath);
    } catch {
      try { rmSync(temporaryPath, { force: true }); } catch { /* preserve the prior state even if cleanup fails */ }
      throw new LifecycleError("persistence-failed", "lifecycle state could not be persisted");
    }
  }

  private acquireLock(): void {
    if (this.activeLockToken) throw new LifecycleError("lock-contended", "coordinator already owns a lifecycle lock");
    const token = randomBytes(16).toString("hex");
    const ownerPath = join(this.lockPath, "owner");
    let created = false;
    try {
      mkdirSync(this.options.rootArtifactDir, { recursive: true });
      mkdirSync(this.lockPath);
      created = true;
      writeFileSync(ownerPath, token, { encoding: "utf8", flag: "wx" });
      this.activeLockToken = token;
    } catch {
      if (created) {
        try { rmdirSync(this.lockPath); } catch { /* a non-empty lock is ambiguous and must remain */ }
      }
      throw new LifecycleError("lock-contended", "lifecycle state is locked or unavailable");
    }
  }

  private releaseLock(): void {
    const token = this.activeLockToken;
    if (!token) return;
    const ownerPath = join(this.lockPath, "owner");
    try {
      if (readFileSync(ownerPath, "utf8") !== token) return;
      unlinkSync(ownerPath);
      rmdirSync(this.lockPath);
      this.activeLockToken = null;
    } catch {
      // The mutation outcome is durable. Leave a lock rather than deleting a lock we cannot prove we own.
    }
  }

  private assertLeaseOwner(state: RootTreeLifecycleState, params: { childId: string; ownerId: string; leaseToken: string }): ChildLifecycleRecord {
    const child = state.children[params.childId];
    if (!child) throw new LifecycleError("unknown-child", "child lifecycle record does not exist");
    if (child.lease.ownerId !== params.ownerId) throw new LifecycleError("ownership-mismatch", "child lifecycle record belongs to another owner");
    if (child.lease.token !== params.leaseToken) throw new LifecycleError("lease-mismatch", "lease token does not match the child lifecycle record");
    return child;
  }

  private activeCount(state: RootTreeLifecycleState): number {
    return Object.values(state.children).filter((child) => child.lease.state === "active").length;
  }

  private publicLease(child: ChildLifecycleRecord): LifecycleLease {
    return { token: child.lease.token, ownerId: child.lease.ownerId, acquiredAt: child.lease.acquiredAt, releasedAt: child.lease.releasedAt };
  }

  private touch(state: RootTreeLifecycleState, child: ChildLifecycleRecord): void {
    const timestamp = this.timestamp();
    child.updatedAt = timestamp;
    state.updatedAt = timestamp;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
