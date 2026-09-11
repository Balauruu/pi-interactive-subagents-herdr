# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in Herdr panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**Herdr-only fork.** See [Acknowledgements](#acknowledgements) for the upstream project.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own Herdr pane without stealing keyboard focus. A root-scoped coordinator selects safe split sources and bounded rebalancing from the current proven pane geometry. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Herdr owns pane layout and focus. The extension submits commands atomically through Herdr and reads the pane's detected terminal output. Each root-scoped coordinator trusts only its original root pane and child IDs returned by its own successful splits. It selects the largest proven pane and its longest usable axis, then performs at most one bounded reconciliation pass. It never changes a foreign, stale, or unproven pane.

## Root-tree lifecycle and recovery

Every fresh spawn and resumed session first acquires a durable admission lease before a Herdr pane or child process is allocated. The root session ID is propagated through `PI_SUBAGENT_ROOT_ID`, and its artifact boundary through `PI_SUBAGENT_ROOT_ARTIFACT_DIR`, so nested and resumed children share one cap. The root boundary contains `subagent-lifecycle.json`; it is an atomically replaced, root-scoped record, not a provider transcript or prompt store.

Each child record exposes its root and child identity, phase, lease state and timestamps, immutable terminal evidence references, per-transition status and attempts, and the last redacted transition error. Terminal evidence is persisted before extraction, parent delivery, lease release, pane close, or layout. Evidence retains only exit/sentinel/session/transcript references, never prompt text, transcript bodies, provider tokens, or environment values.

Settlement independently claims `extraction`, `delivery`, `release`, `cleanup`, and `layout`. A failure in one action cannot prevent the others, and completed claims are idempotent. Lease release is retried within the coordinator's fixed same-owner budget, while a failed parent-delivery attempt is conservatively not re-sent because a rejection may have occurred after delivery. Pane cleanup remains owner-fenced and layout is always a separate action.

### Troubleshooting lifecycle recovery

1. Inspect the root session's `subagent-lifecycle.json` after an interrupted run. Check the child phase, `lease.state`, terminal evidence, transition attempts, and redacted `lastTransitionError`.
2. If terminal evidence exists and the lease is still active, resume settlement from the proven owner. It will retry pending release, cleanup, and layout actions independently without replacing terminal evidence.
3. Do not delete a lock or close a pane when ownership cannot be proven. A malformed state, contended lock, unknown owner, or lease-token mismatch is intentionally left inspectable rather than speculatively recovered.
4. A delivery transition that exhausted its retry boundary records a redacted failure instead of sending the terminal result again. Resolve it through the parent/session recovery path, then inspect the durable evidence reference.

## Pane layout verification

A reconciliation returns only a structured, redacted outcome: root ID, owned-pane count, operation count, state, and stable reason. It does not retain raw Herdr output. The coordinator uses argv-based `execFile` calls, a three-second command timeout, `AbortSignal` propagation, root-scoped reconciliation coalescing, and a fixed eight-operation budget. Split failure rejects a launch. Layout or cleanup failure remains a separately recorded retryable lifecycle action and never blocks evidence delivery or admission release.

The provider-free real-CLI suite creates a unique no-focus Herdr workspace rooted in a temporary directory, performs split, layout, bounded resize, and owned close operations, then closes the workspace and removes that directory in `finally` cleanup. It verifies that the caller pane remains unchanged and accepts a minimum pane-area ratio of `0.60` as reasonably symmetric after representative spawn and cleanup sequences. This permits Herdr's single bounded fractional correction while rejecting an unchanged 1:2 split.

Run the real workspace suite only from a Herdr-managed pane:

```bash
PI_LIVE_TESTS=1 PI_TEST_MODEL=anthropic/claude-haiku-4-5 npm run test:layout:integration
```

`PI_TEST_MODEL` is accepted by the shared integration environment but this pane-only suite does not start Pi or invoke a provider. Outside a Herdr caller context it reports a skipped test rather than controlling a focused session. `npm test` remains the offline verification for the planner and failure/cancellation paths. S05 owns broader diagnostics, offline regressions, and guarded authorized live tests. S06 owns verification of the active deployed artifact and the complete real child/pane lifecycle.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated Herdr pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes its session if finished |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

`pi-web-access` provides `web_search`, `fetch_content`, `source_check`, and `get_search_content`. Restricted children disable extension discovery and explicitly load package extensions when present in the project `.pi/npm`, configured agent `npm`, or global agent `npm` package root, searched in that order (the default global root is `~/.pi/agent/npm`). Install them in one of those roots before listing their tools.

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | agent's model | Override the model for this spawn |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name only**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running** — the message is typed into the live pane (newlines flattened) and picked up at the next turn boundary. The call returns immediately; the eventual completion still arrives as a steer message.
- **Finished** — the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

Every spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name isn't registered, the session file is gone, or the session predates sandboxed resume.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd, and config roots — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openai-codex/gpt-5.6-luna` (max) | `read`, `grep`, `find`, `ls`, `ask_question` | Fast read-only codebase recon |
| **researcher** | `openai-codex/gpt-5.6-luna` (max) | `web_search`, `fetch_content`, `safe_bash`, `ask_question` | Web research, synthesized into a sourced brief |
| **worker** | `openai-codex/gpt-5.6-luna` (max) | `read`, `write`, `edit`, `bash`, `web_search`, `fetch_content`, `ask_question` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openai-codex/gpt-5.6-luna
thinking: max
tools: read, edit, write, safe_bash, web_search, fetch_content, ask_question
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Default model |
| `thinking` | string | `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Extension-backed: `web_search`, `fetch_content`, `source_check`, `get_search_content`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. The control tool `ask_question` is added to restricted children automatically. Only the extensions backing the requested or automatically granted tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, the session shuts down when the agent's turn ends — the agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally — only an escape/abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns).

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the allowed tools are loaded back in explicitly. There is no default toolset and no deny-list — a restricted agent gets its frontmatter tools plus the automatically granted `ask_question` control tool. The restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

The extension reads exactly one user-owned policy file: package-root `config.json` (copy `config.json.example`; it is gitignored). It must be a plain JSON object with **exactly** these keys. There are no defaults, example-file fallback, nested legacy status policy, or unknown keys. Initialization fails with the file and offending key when the file is absent, malformed, or invalid.

```json
{
  "maxActiveSubagents": 3,
  "statusEnabled": true,
  "stalledAfterMs": 60000
}
```

`maxActiveSubagents` and `stalledAfterMs` must be positive safe integers. `statusEnabled` must be a boolean. `stalledAfterMs` controls when missing or invalid activity snapshots become stalled; disabling status suppresses status transition registration.

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [Herdr](https://github.com/herdr-dev/herdr)

```bash
herdr integration install pi
herdr
# Start pi inside the Herdr pane
```

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture and status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
