import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string): string[] {
  const raw = readFileSync(parentSessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  let truncateAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "message" && entry.message?.role === "user") {
        truncateAt = i;
        break;
      }
    } catch {
      // ignore malformed lines
    }
  }

  return lines.slice(0, truncateAt).filter((line) => {
    try {
      return JSON.parse(line).type !== "session";
    } catch {
      return true;
    }
  });
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Read the canonical session id from a session file's header.
 *
 * pi's `--session <id>` flag resolves against this header `id` (exact match,
 * then prefix), NOT the filename — so this is the value to hand back to the
 * orchestrator for follow-ups.
 */
/**
 * Read only the first line of a file without loading the whole thing into
 * memory. Session files grow to many MB, but the header we need is always the
 * first JSON line, so reading a small prefix keeps header lookups cheap — this
 * is what makes scanning a large session tree fast enough to avoid blocking the
 * event loop. Returns the first line (sans trailing newline), or null.
 */
function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a); // '\n'
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function getSessionId(sessionFile: string): string | null {
  return readHeaderId(sessionFile);
}

function readHeaderId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a session id (or id prefix) to a session file path by scanning every
 * `*.jsonl` under `sessionsRoot` and matching the header `id`. Mirrors pi's own
 * resolution order: exact match first, then prefix match. Most recently
 * modified file wins on ties. Returns null when nothing matches.
 */
export function resolveSessionFileById(sessionId: string, sessionsRoot: string): string | null {
  if (!sessionId || !existsSync(sessionsRoot)) return null;

  const candidates: Array<{ path: string; id: string; mtime: number }> = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const id = readHeaderId(full);
        if (!id) continue;
        let mtime = 0;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        candidates.push({ path: full, id, mtime });
      }
    }
  };
  walk(sessionsRoot);

  candidates.sort((a, b) => b.mtime - a.mtime);
  const exact = candidates.find((c) => c.id === sessionId);
  if (exact) return exact.path;
  const prefix = candidates.find((c) => c.id.startsWith(sessionId));
  return prefix ? prefix.path : null;
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string,
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number,
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}

export interface SessionStats {
  model: string | null;
  toolCount: number;
  /** Cumulative token usage across all assistant turns. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Current context size: the last assistant turn's totalTokens. */
  contextTokens: number;
  /** Cumulative cost in USD across all assistant turns. */
  cost: number;
}

/**
 * Parse a completed subagent session JSONL into aggregate stats for display:
 * model, tool-call count, cumulative token usage + cost, and current context
 * size. Cumulative usage fields are summed across every assistant turn; the
 * context size is taken from the last assistant turn's `totalTokens` (the live
 * context window occupancy). Returns null if the file can't be read.
 */
export function summarizeSessionStats(sessionFile: string): SessionStats | null {
  let entries: SessionEntry[];
  try {
    entries = readEntries(sessionFile);
  } catch {
    return null;
  }

  const stats: SessionStats = {
    model: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
  };

  for (const entry of entries) {
    if (entry.type === "model_change") {
      const modelId = (entry as { modelId?: unknown }).modelId;
      if (typeof modelId === "string" && modelId) stats.model = modelId;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (msg.role !== "assistant") continue;

    const model = (msg as { model?: unknown }).model;
    if (typeof model === "string" && model) stats.model = model;

    for (const block of msg.content) {
      if (block.type === "toolCall") stats.toolCount++;
    }

    const usage = (msg as { usage?: Record<string, unknown> }).usage;
    if (usage && typeof usage === "object") {
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      stats.inputTokens += num(usage.input);
      stats.outputTokens += num(usage.output);
      stats.cacheReadTokens += num(usage.cacheRead);
      stats.cacheWriteTokens += num(usage.cacheWrite);
      const total = num(usage.totalTokens);
      if (total > 0) stats.contextTokens = total;
      const cost = usage.cost;
      if (cost && typeof cost === "object") stats.cost += num((cost as Record<string, unknown>).total);
    }
  }

  return stats;
}
