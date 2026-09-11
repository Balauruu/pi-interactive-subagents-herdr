import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  acknowledgeOwnedQuestionEnvelope,
  readOwnedQuestionEnvelope,
  ownedQuestionEventId,
  writeOwnedQuestionEnvelope,
} from "../pi-extension/subagents/session.ts";

function withDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "owned-question-integration-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("owned question envelope integration", () => {
  it("retains a question after a failed parent send and acknowledges it only after a successful retry", async () => {
    await withDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const questionEventId = ownedQuestionEventId({ rootId: "root", parentId: "parent", childId: "child", sessionId: "child-session" });
      writeOwnedQuestionEnvelope(sessionFile, {
        eventId: questionEventId,
        rootId: "root",
        parentId: "parent",
        childId: "child",
        ownerId: "owner",
        sessionId: "child-session",
        question: "Which target should I use?",
      });

      const first = readOwnedQuestionEnvelope(sessionFile, questionEventId);
      assert.equal(first?.question, "Which target should I use?");
      assert.throws(() => { throw new Error("parent transport rejected"); });
      assert.ok(readOwnedQuestionEnvelope(sessionFile, questionEventId), "failed delivery must retain the envelope");
      assert.ok(existsSync(`${sessionFile}.ask`));

      acknowledgeOwnedQuestionEnvelope(sessionFile, questionEventId, "2026-09-11T12:00:00.000Z");
      assert.equal(readOwnedQuestionEnvelope(sessionFile, questionEventId), null, "acknowledged questions are no-ops");
      assert.ok(existsSync(`${sessionFile}.ask.ack`));
    });
  });

  it("rejects malformed and foreign envelopes without exposing their question text", async () => {
    await withDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const questionEventId = ownedQuestionEventId({ rootId: "root", parentId: "parent", childId: "child", sessionId: "child-session" });
      writeOwnedQuestionEnvelope(sessionFile, {
        eventId: questionEventId,
        rootId: "root",
        parentId: "parent",
        childId: "child",
        ownerId: "owner",
        sessionId: "child-session",
        question: "Keep private",
      });
      assert.equal(readOwnedQuestionEnvelope(sessionFile, ownedQuestionEventId({ rootId: "root", parentId: "parent", childId: "other-child", sessionId: "child-session" })), null);
    });
  });
});
