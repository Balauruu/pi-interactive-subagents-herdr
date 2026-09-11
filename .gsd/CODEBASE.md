# Codebase Map

Generated: 2026-09-11T12:38:39Z | Files: 42 | Described: 0/42
<!-- gsd:codebase-meta {"generatedAt":"2026-09-11T12:38:39Z","fingerprint":"a89a3fe6d55c60c9685ab3bdc6bb397f19e5fb57","fileCount":42,"truncated":false} -->

### (root)/
- `.gitignore`
- `config.json.example`
- `LICENSE`
- `package-lock.json`
- `package.json`
- `README.md`

### agents/
- `agents/researcher.md`
- `agents/scout.md`
- `agents/worker.md`

### pi-extension/subagents/
- `pi-extension/subagents/activity.ts`
- `pi-extension/subagents/herdr.ts`
- `pi-extension/subagents/index.ts`
- `pi-extension/subagents/lifecycle-runtime.ts`
- `pi-extension/subagents/lifecycle.ts`
- `pi-extension/subagents/pane-layout.ts`
- `pi-extension/subagents/session.ts`
- `pi-extension/subagents/status.ts`
- `pi-extension/subagents/subagent-done.ts`

### pi-extension/subagents/plugin/.claude-plugin/
- `pi-extension/subagents/plugin/.claude-plugin/plugin.json`

### pi-extension/subagents/plugin/hooks/
- `pi-extension/subagents/plugin/hooks/hooks.json`
- `pi-extension/subagents/plugin/hooks/on-stop.sh`

### pi-extension/subagents/tools/
- `pi-extension/subagents/tools/safe-bash.ts`

### test/
- `test/api-alignment.test.ts`
- `test/config.test.ts`
- `test/failure-visibility.test.ts`
- `test/lifecycle-integration.test.ts`
- `test/lifecycle.test.ts`
- `test/live-test-guard.test.ts`
- `test/live-test-guard.ts`
- `test/owned-transitions-integration.test.ts`
- `test/owned-transitions.test.ts`
- `test/pane-layout-integration.test.ts`
- `test/pane-layout.test.ts`
- `test/settlement-faults.test.ts`
- `test/system-prompt-mode.test.ts`
- `test/test.ts`

### test/integration/
- `test/integration/harness.ts`
- `test/integration/pane-layout.test.ts`
- `test/integration/subagent-lifecycle.test.ts`
- `test/integration/surface.test.ts`

### test/integration/agents/
- `test/integration/agents/test-echo.md`
- `test/integration/agents/test-ping.md`
