/**
 * Process-level authorization for npm commands that launch live Herdr tests.
 * Keep this module dependency-free except for the pure guard: it must run before
 * Node discovers test files, probes Herdr, or creates temporary resources.
 */
import { formatLiveTestPreflightFailure, preflightLiveTest } from "./live-test-guard.ts";

const preflight = preflightLiveTest(process.env);

if (preflight.status === "ready") {
  process.exitCode = 0;
} else if (preflight.status === "disabled") {
  process.stderr.write("Live test guard rejected: PI_LIVE_TESTS is missing.\n");
  process.exitCode = 1;
} else {
  process.stderr.write(`${formatLiveTestPreflightFailure(preflight)}\n`);
  process.exitCode = 1;
}
