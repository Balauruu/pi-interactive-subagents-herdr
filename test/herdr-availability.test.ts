import assert from "node:assert/strict";
import test from "node:test";

import { __herdrTest__ } from "../pi-extension/subagents/herdr.ts";

const validPane = JSON.stringify({ result: { pane: { pane_id: "workspace:root" } } });

test("resolves a current Herdr pane from CLI JSON without HERDR_PANE_ID", () => {
  assert.equal(__herdrTest__.currentHerdrPaneIdFromProbe(() => validPane), "workspace:root");
});

test("rejects an unavailable Herdr CLI probe", () => {
  assert.equal(__herdrTest__.currentHerdrPaneIdFromProbe(() => {
    throw new Error("Herdr pane current failed");
  }), null);
});

test("rejects malformed or pane-less Herdr CLI responses", () => {
  assert.equal(__herdrTest__.currentHerdrPaneIdFromProbe(() => "not JSON"), null);
  assert.equal(__herdrTest__.currentHerdrPaneIdFromProbe(() => JSON.stringify({ result: { pane: {} } })), null);
  assert.equal(__herdrTest__.currentHerdrPaneIdFromProbe(() => JSON.stringify({ result: { pane: { pane_id: "" } } })), null);
});

test("keeps generated-script metadata comment-only across injected newlines", () => {
  const script = __herdrTest__.renderLongCommandScript(
    "printf '%s\n' launched",
    "# Subagent launch script for safe\nprintf injected\r\n# Surface: workspace:root",
  );

  assert.equal(
    script,
    [
      "#!/bin/bash",
      "# Subagent launch script for safe",
      "# printf injected",
      "# Surface: workspace:root",
      "printf '%s\n' launched",
      "",
    ].join("\n"),
  );
});
