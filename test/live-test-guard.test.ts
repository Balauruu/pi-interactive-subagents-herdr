import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatLiveTestPreflightFailure, preflightLiveTest } from "./live-test-guard.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_ENTRYPOINTS = ["test:integration", "test:layout:integration", "test:provider:integration", "test:deployed:integration"] as const;
const { PI_LIVE_TESTS: _optIn, PI_TEST_MODEL: _model, ...BASE_ENVIRONMENT } = process.env;

function assertRejectedEntrypoint(
  entrypoint: (typeof LIVE_ENTRYPOINTS)[number],
  environment: Record<string, string>,
  expectedVariable: string,
): void {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-live-test-guard-"));
  const sideEffectFile = join(temporaryDirectory, "external-command-called");
  const fakeCommand = join(temporaryDirectory, "herdr");

  try {
    writeFileSync(fakeCommand, "#!/bin/sh\nprintf '%s\\n' \"$0\" >> \"$LIVE_TEST_SIDE_EFFECT_FILE\"\n");
    chmodSync(fakeCommand, 0o755);
    for (const command of ["pi", "pane"]) {
      const commandPath = join(temporaryDirectory, command);
      writeFileSync(commandPath, "#!/bin/sh\nprintf '%s\\n' \"$0\" >> \"$LIVE_TEST_SIDE_EFFECT_FILE\"\n");
      chmodSync(commandPath, 0o755);
    }

    const result = spawnSync("npm", ["run", entrypoint], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...BASE_ENVIRONMENT,
        ...environment,
        PATH: `${temporaryDirectory}${delimiter}${BASE_ENVIRONMENT.PATH ?? ""}`,
        LIVE_TEST_SIDE_EFFECT_FILE: sideEffectFile,
      },
      timeout: 10_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    assert.notEqual(result.status, 0, `${entrypoint} unexpectedly succeeded: ${output}`);
    assert.match(output, new RegExp(`Live test guard rejected: ${expectedVariable}`));
    assert.doesNotMatch(output, /\nℹ tests \d|\n# tests \d|PI_LIVE_TESTS is not enabled/);
    assert.equal(existsSync(sideEffectFile), false, `${entrypoint} invoked an external live-test helper`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("does not authorize live tests without the exact opt-in", () => {
  assert.deepEqual(preflightLiveTest({}), { status: "disabled" });
  assert.deepEqual(preflightLiveTest({ PI_LIVE_TESTS: "0" }), {
    status: "rejected",
    variable: "PI_LIVE_TESTS",
    reason: "invalid",
  });
});

test("requires a non-empty provider/model identifier before live side effects", () => {
  assert.deepEqual(preflightLiveTest({ PI_LIVE_TESTS: "1" }), {
    status: "rejected",
    variable: "PI_TEST_MODEL",
    reason: "missing",
  });
  assert.deepEqual(
    preflightLiveTest({ PI_LIVE_TESTS: "1", PI_TEST_MODEL: "not a model" }),
    { status: "rejected", variable: "PI_TEST_MODEL", reason: "invalid" },
  );
});

test("rejects blank, malformed, and near-miss authorization values", () => {
  for (const [environment, variable, reason] of [
    [{ PI_LIVE_TESTS: "" }, "PI_LIVE_TESTS", "invalid"],
    [{ PI_LIVE_TESTS: "01" }, "PI_LIVE_TESTS", "invalid"],
    [{ PI_LIVE_TESTS: "1 ", PI_TEST_MODEL: "provider/model" }, "PI_LIVE_TESTS", "invalid"],
    [{ PI_LIVE_TESTS: "1", PI_TEST_MODEL: "" }, "PI_TEST_MODEL", "missing"],
    [{ PI_LIVE_TESTS: "1", PI_TEST_MODEL: " " }, "PI_TEST_MODEL", "invalid"],
    [{ PI_LIVE_TESTS: "1", PI_TEST_MODEL: "provider/model/" }, "PI_TEST_MODEL", "invalid"],
  ] as const) {
    assert.deepEqual(preflightLiveTest(environment), { status: "rejected", variable, reason });
  }
});

test("authorizes only an exact opt-in and valid provider/model", () => {
  assert.deepEqual(
    preflightLiveTest({
      PI_LIVE_TESTS: "1",
      PI_TEST_MODEL: "anthropic/claude-haiku-4-5",
    }),
    { status: "ready", model: "anthropic/claude-haiku-4-5" },
  );
});

test("rejection text names the invalid variable without echoing its value", () => {
  const rejected = preflightLiveTest({
    PI_LIVE_TESTS: "1",
    PI_TEST_MODEL: "secret model value",
  });
  assert.equal(rejected.status, "rejected");
  if (rejected.status === "rejected") {
    const message = formatLiveTestPreflightFailure(rejected);
    assert.match(message, /PI_TEST_MODEL/);
    assert.doesNotMatch(message, /secret model value/);
  }
});

test("each live npm entrypoint rejects before test discovery or external helpers", () => {
  const rejectedEnvironments = [
    [{}, "PI_LIVE_TESTS"],
    [{ PI_LIVE_TESTS: "" }, "PI_LIVE_TESTS"],
    [{ PI_LIVE_TESTS: "01" }, "PI_LIVE_TESTS"],
    [{ PI_LIVE_TESTS: "1" }, "PI_TEST_MODEL"],
    [{ PI_LIVE_TESTS: "1", PI_TEST_MODEL: " " }, "PI_TEST_MODEL"],
    [{ PI_LIVE_TESTS: "1", PI_TEST_MODEL: "provider/model/" }, "PI_TEST_MODEL"],
  ] as const;

  for (const [environment, variable] of rejectedEnvironments) {
    for (const entrypoint of LIVE_ENTRYPOINTS) {
      assertRejectedEntrypoint(entrypoint, environment, variable);
    }
  }
});
