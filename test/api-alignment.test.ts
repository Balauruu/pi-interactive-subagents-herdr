import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as {
  pi?: { extensions?: unknown };
};

describe("Pi API alignment", () => {
  it("loads the sole manifest-declared extension with the current public APIs", async () => {
    assert.deepEqual(manifest.pi?.extensions, ["./pi-extension/subagents/index.ts"]);

    const entrypoint = join(projectRoot, manifest.pi.extensions[0]);
    assert.equal(existsSync(entrypoint), true, `Declared extension does not exist: ${entrypoint}`);

    const extension = await import(pathToFileURL(entrypoint).href);
    assert.equal(typeof extension.default, "function");
  });
});
