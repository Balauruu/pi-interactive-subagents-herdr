import {
  deriveRootTreeId,
  LifecycleError,
  RootTreeLifecycleCoordinator,
  type LifecycleLease,
  type TerminalEvidence,
} from "./lifecycle.ts";

const ROOT_ID_ENV = "PI_SUBAGENT_ROOT_ID";
const ROOT_ARTIFACT_ENV = "PI_SUBAGENT_ROOT_ARTIFACT_DIR";
const DEFAULT_MAX_ACTIVE = 4;

export interface LifecycleRun {
  coordinator: RootTreeLifecycleCoordinator;
  rootId: string;
  rootArtifactDir: string;
  childId: string;
  ownerId: string;
  lease: LifecycleLease;
}

export interface SettlementActions {
  extraction?: () => void | Promise<void>;
  delivery?: () => void | Promise<void>;
  cleanup?: () => void | Promise<void>;
  layout?: () => void | Promise<void>;
}

function safeError(error: unknown): string {
  // Action errors can contain terminal output, prompts, environment values, or
  // provider diagnostics. Persist only a stable category, never their text.
  return error instanceof LifecycleError
    ? `lifecycle ${error.code}`
    : "external lifecycle action failed";
}

function capacityFromEnv(): number {
  const parsed = Number(process.env.PI_SUBAGENT_MAX_ACTIVE ?? DEFAULT_MAX_ACTIVE);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_ACTIVE;
}

/** Acquire before any pane or process allocation and expose only safe propagation metadata. */
export function admitLifecycleRun(params: {
  sessionId: string;
  artifactDir: string;
  childId: string;
  ownerId: string;
  maxActiveSubagents?: number;
}): LifecycleRun {
  const rootId = deriveRootTreeId({ sessionId: params.sessionId, inheritedRootId: process.env[ROOT_ID_ENV] });
  const rootArtifactDir = process.env[ROOT_ARTIFACT_ENV] || params.artifactDir;
  const coordinator = new RootTreeLifecycleCoordinator({
    rootArtifactDir,
    rootId,
    maxActiveSubagents: params.maxActiveSubagents ?? capacityFromEnv(),
  });
  const admission = coordinator.acquire({ childId: params.childId, ownerId: params.ownerId });
  if (!admission.admitted) {
    throw new LifecycleError("duplicate-child", "launch child id was already admitted");
  }
  return { coordinator, rootId, rootArtifactDir, childId: params.childId, ownerId: params.ownerId, lease: admission.lease };
}

/** Shell-safe environment assignments propagated to fresh and resumed descendants. */
export function lifecycleEnvParts(run: LifecycleRun, shellEscape: (value: string) => string): string[] {
  return [
    `${ROOT_ID_ENV}=${shellEscape(run.rootId)}`,
    `${ROOT_ARTIFACT_ENV}=${shellEscape(run.rootArtifactDir)}`,
  ];
}

export function markLifecycleRunning(run: LifecycleRun): void {
  run.coordinator.updatePhase({
    childId: run.childId,
    ownerId: run.ownerId,
    leaseToken: run.lease.token,
    phase: "running",
  });
}

export function persistLifecycleTerminal(run: LifecycleRun, evidence: TerminalEvidence): void {
  run.coordinator.persistTerminalEvidence({
    childId: run.childId,
    ownerId: run.ownerId,
    leaseToken: run.lease.token,
    evidence,
  });
}

async function independentlySettle(
  run: LifecycleRun,
  transition: "extraction" | "delivery" | "release" | "cleanup" | "layout",
  action: (() => void | Promise<void>) | undefined,
): Promise<void> {
  try {
    const prior = run.coordinator.inspect().children[run.childId]?.transitions[transition];
    const claim = run.coordinator.claimTransition({ childId: run.childId, ownerId: run.ownerId, leaseToken: run.lease.token, transition });
    if (!claim.claimed) return;
    try {
      // Parent delivery is an externally visible side effect. A rejection after
      // invocation is ambiguous, so consume the bounded retry rather than risk
      // sending the same terminal result twice.
      if (transition === "delivery" && prior?.attempts && prior.lastError) {
        run.coordinator.completeTransition({
          childId: run.childId,
          ownerId: run.ownerId,
          leaseToken: run.lease.token,
          transition,
          error: "delivery retry suppressed after prior failure",
        });
        return;
      }
      if (transition === "release") run.coordinator.releaseLease({ childId: run.childId, ownerId: run.ownerId, leaseToken: run.lease.token });
      else await action?.();
      run.coordinator.completeTransition({ childId: run.childId, ownerId: run.ownerId, leaseToken: run.lease.token, transition });
    } catch (error) {
      run.coordinator.completeTransition({ childId: run.childId, ownerId: run.ownerId, leaseToken: run.lease.token, transition, error: safeError(error) });
    }
  } catch {
    // A conflicting owner or exhausted retry budget is durable state. Do not perform speculative work.
  }
}

/** Execute every terminal action independently. Terminal evidence must already be durable. */
export async function settleLifecycleRun(run: LifecycleRun, actions: SettlementActions): Promise<void> {
  await independentlySettle(run, "extraction", actions.extraction);
  await independentlySettle(run, "delivery", actions.delivery);
  await independentlySettle(run, "release");
  await independentlySettle(run, "cleanup", actions.cleanup);
  await independentlySettle(run, "layout", actions.layout);
}

/** Pre-launch failures become cancellation evidence and still release their admission slot. */
export async function abandonLifecycleRun(run: LifecycleRun, error: unknown): Promise<void> {
  try {
    persistLifecycleTerminal(run, {
      exitCode: null,
      sentinel: null,
      transcriptRef: null,
      sessionRef: null,
      cancelled: true,
      observedAt: new Date().toISOString(),
    });
  } catch {
    return;
  }
  await settleLifecycleRun(run, {});
  void error;
}
