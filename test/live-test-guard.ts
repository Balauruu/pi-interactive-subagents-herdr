/**
 * Pure authorization preflight for tests that can touch a live Herdr session.
 * Call this before detecting Herdr or creating any test resources.
 */
export type LiveTestEnvironment = Readonly<Record<string, string | undefined>>;

export type LiveTestPreflight =
  | { status: "disabled" }
  | { status: "rejected"; variable: "PI_LIVE_TESTS" | "PI_TEST_MODEL"; reason: "missing" | "invalid" }
  | { status: "ready"; model: string };

const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * Authorize a live test without reading process state or invoking external commands.
 * A missing opt-in disables live tests. Any supplied opt-in other than "1" is rejected.
 */
export function preflightLiveTest(environment: LiveTestEnvironment): LiveTestPreflight {
  const optIn = environment.PI_LIVE_TESTS;
  if (optIn === undefined) return { status: "disabled" };
  if (optIn !== "1") return { status: "rejected", variable: "PI_LIVE_TESTS", reason: "invalid" };

  const model = environment.PI_TEST_MODEL;
  if (model === undefined || model.length === 0) {
    return { status: "rejected", variable: "PI_TEST_MODEL", reason: "missing" };
  }
  if (!MODEL_IDENTIFIER.test(model)) {
    return { status: "rejected", variable: "PI_TEST_MODEL", reason: "invalid" };
  }

  return { status: "ready", model };
}

/** Return a stable, redacted explanation suitable for test failure output. */
export function formatLiveTestPreflightFailure(preflight: Exclude<LiveTestPreflight, { status: "disabled" | "ready" }>): string {
  return `Live test guard rejected: ${preflight.variable} is ${preflight.reason}.`;
}
