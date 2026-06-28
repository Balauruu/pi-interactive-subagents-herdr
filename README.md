# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with their current state — `starting`, `active`, `waiting`, `stalled`, or `running`. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

Subagent panes are created without stealing keyboard focus (cmux, tmux). Launch commands target child surfaces by explicit ID, so focus and command delivery are independent. Note: the `interactive` option controls parent status notifications, not terminal focus.

### Pane layout (tmux)

Under tmux, each subagent is a horizontal split off the parent pi pane. Left to itself, tmux halves the target pane on every split and dumps freed space onto a neighbor on close, so panes drift to wildly uneven widths. To prevent that, the extension automatically re-applies an even layout to the subagent window after every spawn and every exit (debounced so a burst of parallel spawns or staggered exits collapses into a single layout call). This only runs under tmux — cmux uses tabs, and zellij/wezterm manage their own layouts.

The layout is a single constant in `pi-extension/subagents/cmux.ts`:

```ts
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";
```

Change it to switch the geometry, then reload the extension (or restart pi):

| Value              | Geometry                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `even-horizontal`  | Equal columns across the window (matches a manual `Ctrl+b` then `Alt+1`). Default. |
| `main-vertical`    | One large main pane on the left, subagents tiled in a column on the right. |
| `tiled`            | Grid of roughly equal panes — scales best when many subagents run at once. |

The value is passed straight to `tmux select-layout`, so any named tmux layout works. An unrecognized value is ignored silently (the resize is best-effort and never blocks spawning), so double-check the spelling if a change seems to have no effect.

## What's Included

### Extensions

**Subagents** — 3 main-session tools + 1 command, plus 1 subagent-only tool:

| Tool               | Description                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `subagent`         | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately)                   |
| `subagent_message` | Steer a running subagent (by `name`) or resume a finished one (by `sessionId`)                    |
| `subagents_list`   | List available agent definitions                                                                  |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

### Bundled Agents

| Agent          | Model  | Tools                                            | Role                                                              |
| -------------- | ------ | ------------------------------------------------ | ----------------------------------------------------------------- |
| **scout**      | Haiku  | `read`, `grep`, `find`, `ls`                     | Fast read-only codebase recon — maps files, patterns, conventions |
| **researcher** | Sonnet | `web_search`, `web_fetch`                        | Web research — searches and synthesizes a sourced brief           |
| **worker**     | Sonnet | `read`, `write`, `edit`, `safe_bash`, `web_search`, `web_fetch` + spawning | General implementer — writes code, runs commands; may dispatch `scout`/`researcher` to protect its context |

The **worker** is the only bundled agent granted the spawning toolset, and it may only spawn `scout` and `researcher` (see [`subagent_agents`](#subagent_agents)). `scout` and `researcher` are autonomous (`auto-exit: true`); `worker` runs interactively.

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in mux pane      → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks all running agents:

```
╭─ Subagents ───────────────────────────────── 3 running ─╮
│ 01:23  Scout: Auth (scout)            active · write 7m │
│ 00:45  Researcher (researcher)               stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

### In-progress status updates

The widget tracks each Pi-backed sub-agent from a child-written runtime snapshot and labels it with a coarse state:

- `starting` — launched, but no valid child snapshot has been observed yet
- `active` — the child is doing observed runtime work: agent turn, provider request, streaming, or tool execution
- `waiting` — the child finished a turn and is intentionally open for more input or another stage
- `stalled` — the parent has gone too long without a valid current child snapshot and can no longer trust the run is healthy
- `running` — fallback for backends without child snapshots (e.g. Claude)

These labels are no longer derived from session-file growth. Session JSONL is still used for transcript, resume, lineage, and result extraction, but Pi-backed liveness now comes from a small activity snapshot written by the child extension. A fixed internal watchdog marks a run as `stalled` when valid snapshots never appear, stop being readable, or stop matching the current child; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (e.g. `worker`) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and child snapshots are still recorded/classified regardless of the `interactive` setting. By default, agents with `auto-exit: true` are treated as autonomous and get stall pings; agents without it are treated as interactive and stay quiet. Override per-agent with `interactive: true|false` in frontmatter.

#### Configuration

Status display is controlled by `config.json` in the extension directory. Copy `config.json.example` to get started:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  }
}
```

`config.json` is gitignored so local overrides don't get committed.

---

## Spawning Subagents

```typescript
// Spawn an agent by its profile name
subagent({ agent: "scout", task: "Analyze the codebase..." });

// Cosmetic pane label (defaults to the agent name when omitted)
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });

// Custom working directory
subagent({ agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

The schema is intentionally small: each agent has a fixed, well-defined loadout (model, tools, system prompt) baked into its definition, so per-spawn override knobs were removed. You pick an `agent` and give it a `task`.

| Parameter | Type   | Default        | Description                                                                                  |
| --------- | ------ | -------------- | -------------------------------------------------------------------------------------------- |
| `agent`   | string | required       | Which agent to spawn. Must be a known/permitted agent (see [`subagents_list`](#subagents_list)). Loads that agent's fixed profile. |
| `task`    | string | required       | Task prompt for the sub-agent                                                                |
| `name`    | string | _agent name_   | Optional cosmetic label for the pane and widget row. Defaults to the agent name. Does not select the agent. |
| `model`   | string | —              | Override the agent's default model for this spawn                                            |
| `cwd`     | string | —              | Working directory for the sub-agent (see [Role Folders](#role-folders))                      |

---

## Messaging a subagent

`subagent_message` is the single tool for talking to a subagent after it has been spawned. It has two modes, selected by which argument you pass:

**Steer a running subagent** — pass `name` to type a follow-up instruction directly into the live pane:

```typescript
subagent_message({ name: "Scout", message: "Also check the auth middleware" });
```

The message is delivered into the child's TUI editor (newlines are flattened to spaces so it fires as one turn). The child picks it up at its next turn boundary. The call returns immediately and does **not**, by itself, produce a new result — the subagent's eventual completion still arrives as a steer message. The widget moves the child to `waiting` until it resumes work.

**Resume a finished subagent** — pass `sessionId` (returned in the completed subagent's result) to relaunch and continue that session:

```typescript
subagent_message({ sessionId: "019f05b2-f1c3", message: "Now write the tests too" });
```

Resuming is fire-and-forget async: the relaunched session always runs its follow-up task autonomously and its result is delivered later as a steer message, exactly like a fresh `subagent` spawn. (There is no per-call behavior knob — resume is always autonomous, matching this result-delivery model.)

> **Guard:** a `sessionId` that maps to a still-running subagent is rejected — resuming would launch a second process mutating the same session file. Steer it by `name` instead. There is no hard-abort tool; to forcibly stop a subagent, use its pane directly.

**`subagent_message` parameters:**
- `name` — exact display name of a running subagent to steer (mutually exclusive with `sessionId`)
- `sessionId` — id (or id prefix) of a finished session to resume (mutually exclusive with `name`)
- `message` (required) — the instruction or next task to deliver

---

## ask_question — Subagent Asks the Orchestrator

The `ask_question` tool lets a subagent ask its parent (the orchestrator that spawned it) a single freeform question — for ambiguous requirements, a decision that materially affects the work, a blocker, or confirmation only the parent has. It is framed like the top-level `ask_user_question` tool so agents reach for it proactively instead of guessing.

Unlike the old `caller_ping`, **the session stays open while it waits.** Auto-exit is suppressed for that turn, the subagent parks in a `waiting` state, and the parent replies with `subagent_message` — which lands as the subagent's next turn so it continues right where it paused.

**`ask_question` parameters:**
- `question` (required): The single freeform question. Include enough context to answer it directly. No options/multiple-choice — ask one question per call.

**Interaction flow:**
1. Child calls `ask_question({ question: "Found two migration files — use v1 or v2?" })`
2. The child's turn ends but the **session stays open** (parked as `waiting`); the tool returns *"Question sent — stop and wait for the reply."*
3. The parent's watcher picks up the question and steers a notification: *"Sub-agent worker-2 asks: Found two migration files — use v1 or v2?"* plus the unique subagent name (and session id as backup)
4. Parent replies while it runs via `subagent_message({ name, message })` (or `subagent_message({ sessionId, message })` if it has since exited)
5. The reply arrives as the subagent's next message and it continues with the parent's guidance

**Parallel questions are supported.** Each subagent has its own session and its own watcher, so multiple subagents can be waiting on answers at once. Default names are deduped at spawn (`worker`, `worker-2`, …), and every notification surfaces that unique name, so each reply targets the right subagent.

**Example:**
```typescript
// Inside a worker subagent
await ask_question({
  question: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session stays open. Parent answers with subagent_message({ name: "worker", message: "Use v2…" }),
// which arrives as this subagent's next turn.
```

> **Note:** `ask_question` is only available inside subagent contexts. Calling it from a standalone pi session returns an error.
>
> If the parent never replies, the subagent stays open indefinitely (shown as `waiting`) until the human closes its pane — mirroring interactive-agent behavior. There is no timeout.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
---

# My Agent

You are a specialized agent that does X...
```

The `tools` field is a strict allowlist. The child process is launched with extension discovery disabled (`--no-extensions`) and only the extensions backing the listed tools are loaded back in. An agent that lists no spawning tools and no `subagent_agents` simply cannot spawn anything.

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Default model (e.g. `anthropic/claude-sonnet-4-6`)                                                                                                                                                                                                                          |
| `thinking`    | string  | Thinking level: `minimal`, `medium`, `high`                                                                                                                                                                                                                                 |
| `tools`       | string  | Strict allowlist of tool names. Built-ins (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) plus custom-extension tools (`web_search`, `web_fetch`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`). Only the extensions backing these tools are loaded into the child. |
| `subagent_agents` | string | Comma-separated list of agent names this agent may spawn. **Presence of this field grants the full spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the listed agents. Omit it and the agent cannot spawn at all. |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `auto-exit`   | boolean | Auto-shutdown when the agent finishes its turn. If the user sends any input, auto-exit is permanently disabled and the user takes over the session. Recommended for autonomous agents (scout, researcher); not for interactive ones (worker). Also determines the default value of `interactive` (see below). |
| `interactive` | boolean | derived        | Override whether stall/recovery transitions wake the parent session. Defaults to the inverse of `auto-exit`: autonomous agents (`auto-exit: true`) are non-interactive and get stall pings; agents without `auto-exit` are interactive and stay quiet. Explicit values take precedence. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from discovery surfaces like `subagents_list`. The agent still remains directly invokable by explicit name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns. Set the mode per agent via the `session-mode` frontmatter field below.

```yaml
---
name: worker
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, the agent session shuts down automatically as soon as the agent finishes its turn. The agent just writes its final message and stops; there is no "done" tool to call. The last assistant message becomes the summary returned to the parent.

**Behavior:**

- The session closes after the agent's final message (on the `agent_end` event)
- If the user sends **any input** before the agent finishes, auto-exit is permanently disabled for that session — the user takes over interactively
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents are told to simply stop when finished, while interactive agents are told the session ends when the user exits the pane

**Auto-exit is suppressed while work is still in flight.** Even an `auto-exit` agent will *not* shut down at the end of a turn when either:

- it has a pending [`ask_question`](#ask_question--subagent-asks-the-orchestrator) awaiting the orchestrator's reply, or
- it spawned **its own child subagents** (e.g. a `worker` delegating to `scout`/`researcher`) that haven't finished yet.

In both cases the session parks as `waiting` instead of exiting, and resumes when the next turn lands (the reply, or a child's result steered back). This is what lets a worker write *"I'll wait for the results"* and stop without killing the session out from under its children — it stays open until the **last** child reports back, then the worker's final summary is returned to the orchestrator as usual. Child liveness is read from the spawning extension's live count, so a nested agent that never spawned anything still exits immediately as before.

**When to use:**

- ✅ Autonomous agents (scout, researcher) that run to completion
- ❌ Interactive agents (worker) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

### `interactive`

Controls whether status transitions (`stalled`, `recovered`) wake the parent session with a steer message.

**Default:** the inverse of `auto-exit`. Autonomous agents (`auto-exit: true`) are non-interactive and ping the parent on stall/recovery; agents without `auto-exit` are interactive and stay quiet.

**Why it exists:** Interactive agents can run for minutes or hours while the user thinks, types, and reads in the subagent's pane. Child snapshots still update the widget, but stalled/recovered supervision messages rarely need to wake the parent for user-driven sessions. Skipping the steer keeps the parent quiet until the child actually finishes.

**When to override:**

- Set `interactive: false` on an agent that doesn't auto-exit but you still want stall pings for
- Set `interactive: true` on an autonomous agent you'd rather check on yourself

```yaml
---
name: worker
# interactive defaults to true because auto-exit is not set
---
```

---

## Tool Access Control

Access is **whitelist-only**. Every sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`. Only the tools named in the agent's `tools` frontmatter are exposed, and only the extensions that register those tools are loaded back in via explicit `--extension` flags. There is no global default toolset and no deny-list to maintain — an agent gets exactly what it asks for.

### Spawns must name a known agent

The agent whitelist is enforced at **every** depth, not just for restricted sub-agents:

- A **restricted sub-agent** (one launched with `PI_SUBAGENT_ALLOWED`) may only spawn the agents pinned in its `subagent_agents` list.
- A **top-level session** may spawn any agent that appears in `subagents_list` (every discoverable definition).

Every `subagent` call must set `agent` to a name in the caller's permitted set. A missing `agent`, or one that doesn't resolve to a real definition (e.g. `agent: "wizard"`), is rejected — there is no agentless spawn route, so a child can never launch with an unrestricted, full-toolset profile by omitting its agent.

### Granting the ability to spawn: `subagent_agents`

Spawning is **off by default**. An agent cannot spawn sub-agents unless its frontmatter declares a `subagent_agents` list. Presence of that field:

1. Grants the full spawning toolset (`subagent`, `subagent_message`, `subagents_list`) — you do **not** list these in `tools`.
2. Loads this extension into the child process.
3. Restricts the child to spawning **only** the named agents. The child's `subagents_list` is filtered to that set, and `subagent` calls for any other agent are rejected. Enforced via the `PI_SUBAGENT_ALLOWED` env var.

```yaml
---
name: worker
tools: read, write, edit, safe_bash, web_search, web_fetch
subagent_agents: scout, researcher
---
```

### Recommended Configuration

| Agent      | `subagent_agents`   | Rationale                                              |
| ---------- | ------------------- | ------------------------------------------------------ |
| worker     | `scout, researcher` | Delegates recon/research to protect its own context    |
| scout      | _(omitted)_         | Read-only recon; should gather context, not spawn      |
| researcher | _(omitted)_         | Web research only; should research, not spawn          |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
tools: read, write, edit, safe_bash
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing the agent's allowlisted tools. Toggle with `Ctrl+Alt+O`:

```
[scout] — 4 tools  (Ctrl+Alt+O)                          ← collapsed
[scout] — 4 available  (Ctrl+Alt+O to collapse)          ← expanded
  read, grep, find, ls
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)
  - [WezTerm](https://wezfurlong.org/wezterm/)

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or tmux, zellij, wezterm
```

---

## Acknowledgements

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT
