import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadExtensionConfig,
  parseExtensionConfig,
} from "../pi-extension/subagents/status.ts";

const VALID_CONFIG = {
  maxActiveSubagents: 3,
  statusEnabled: true,
  stalledAfterMs: 60_000,
};

function withTempDir(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "subagents-config-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("subagent extension configuration", () => {
  it("accepts exactly the flat policy and returns an immutable copy", () => {
    const config = parseExtensionConfig(VALID_CONFIG, "fixture.json");

    assert.deepEqual(config, VALID_CONFIG);
    assert.equal(Object.isFrozen(config), true);
    assert.notEqual(config, VALID_CONFIG);
  });

  it("loads only the requested authoritative file", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify(VALID_CONFIG));

      assert.deepEqual(loadExtensionConfig(configPath), VALID_CONFIG);
      assert.throws(
        () => loadExtensionConfig(join(dir, "missing.json")),
        /Unable to read subagent extension config .*missing\.json/,
      );
    });
  });

  it("reports malformed JSON with its source and returns control to the caller", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "broken.json");
      writeFileSync(configPath, "{\n");

      assert.throws(
        () => loadExtensionConfig(configPath),
        /Invalid JSON in subagent extension config .*broken\.json/,
      );
      assert.equal(parseExtensionConfig(VALID_CONFIG, "next-fixture.json").statusEnabled, true);
    });
  });

  it("rejects missing and unknown fields with the source and field name", () => {
    assert.throws(
      () => parseExtensionConfig({}, "fixture.json"),
      /fixture\.json: maxActiveSubagents is required/,
    );
    assert.throws(
      () => parseExtensionConfig({ ...VALID_CONFIG, extra: true }, "fixture.json"),
      /fixture\.json: unknown key\(s\): extra/,
    );
    assert.throws(
      () => parseExtensionConfig({ ...VALID_CONFIG, status: { enabled: true } }, "fixture.json"),
      /fixture\.json: unknown key\(s\): status/,
    );
  });

  it("rejects inherited, nested, and wrong-type values", () => {
    const inherited = Object.create(VALID_CONFIG);
    assert.throws(
      () => parseExtensionConfig(inherited, "fixture.json"),
      /fixture\.json: root must be a plain object/,
    );
    assert.throws(
      () => parseExtensionConfig({ ...VALID_CONFIG, maxActiveSubagents: { value: 3 } }, "fixture.json"),
      /fixture\.json: maxActiveSubagents must be a positive safe integer/,
    );
    assert.throws(
      () => parseExtensionConfig({ ...VALID_CONFIG, statusEnabled: "true" }, "fixture.json"),
      /fixture\.json: statusEnabled must be a boolean/,
    );
  });

  it("rejects zero, negative, fractional, unsafe, and non-finite numeric policy", () => {
    for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => parseExtensionConfig({ ...VALID_CONFIG, maxActiveSubagents: value }, "fixture.json"),
        /fixture\.json: maxActiveSubagents must be a positive safe integer/,
      );
      assert.throws(
        () => parseExtensionConfig({ ...VALID_CONFIG, stalledAfterMs: value }, "fixture.json"),
        /fixture\.json: stalledAfterMs must be a positive safe integer/,
      );
    }
  });
});
