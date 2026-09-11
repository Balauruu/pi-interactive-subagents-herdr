import assert from "node:assert/strict";
import test from "node:test";

import { formatLiveTestPreflightFailure, preflightLiveTest } from "./live-test-guard.ts";

test("does not authorize live tests without the exact opt-in", () => {
  assert.deepEqual(preflightLiveTest({}), { status: "disabled" });
  assert.deepEqual(preflightLiveTest({ PI_LIVE_TESTS: "0" }), {
    status: "rejected",
    variable: "PI_LIVE_TESTS",
    reason: "invalid",
  });
});

test("requires a non-empty provider/model identifier before live side effects", () => {
  assert.deepEqual(preflightLiveTest({ PI_LIVE_TESTS: "1", HERDR_ENV: "1" }), {
    status: "rejected",
    variable: "PI_TEST_MODEL",
    reason: "missing",
  });
  assert.deepEqual(
    preflightLiveTest({ PI_LIVE_TESTS: "1", PI_TEST_MODEL: "not a model", HERDR_ENV: "1" }),
    { status: "rejected", variable: "PI_TEST_MODEL", reason: "invalid" },
  );
});

test("requires Herdr caller context after validating the authorized model", () => {
  assert.deepEqual(
    preflightLiveTest({ PI_LIVE_TESTS: "1", PI_TEST_MODEL: "anthropic/claude-haiku-4-5" }),
    { status: "rejected", variable: "HERDR_ENV", reason: "missing" },
  );
});

test("authorizes only an exact opt-in, valid model, and Herdr caller context", () => {
  assert.deepEqual(
    preflightLiveTest({
      PI_LIVE_TESTS: "1",
      PI_TEST_MODEL: "anthropic/claude-haiku-4-5",
      HERDR_ENV: "1",
    }),
    { status: "ready", model: "anthropic/claude-haiku-4-5" },
  );
});

test("rejection text names the invalid variable without echoing its value", () => {
  const rejected = preflightLiveTest({
    PI_LIVE_TESTS: "1",
    PI_TEST_MODEL: "secret model value",
    HERDR_ENV: "1",
  });
  assert.equal(rejected.status, "rejected");
  if (rejected.status === "rejected") {
    const message = formatLiveTestPreflightFailure(rejected);
    assert.match(message, /PI_TEST_MODEL/);
    assert.doesNotMatch(message, /secret model value/);
  }
});
