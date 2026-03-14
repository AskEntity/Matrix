# OpenGraft Project Memory

> Single source of truth. Read on every session start. Full design: `OpenGraft.md`

## Operating Mode

**Autonomy**: Level 10. Work continuously. Don't ask questions — decide and move.
**Workflow**: Create tasks first, refine later. Never just mentally note things — create tasks (they persist after compaction, notes don't).

## How to Run Tests

```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/anthropic-compatible-provider.test.ts src/openai-compatible-provider.test.ts src/message-queue.test.ts src/agent-tools-helpers.test.ts
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

Pre-commit hooks run typecheck + lint + unit tests. i18n check: `bash scripts/check-i18n.sh`.

## Architecture

```
Daemon (Hono: HTTP + WS on :7433)
    ↑               ↑
   CLI            Web UI (React, bundled by Bun)
```

- Three providers: ClaudeAgentSdkProvider (subprocess), AnthropicCompatibleProvider (Anthropic API), OpenAICompatibleProvider (OpenAI-compatible API)
- Provider selection: `OG_PROVIDER=openai|direct|claude-code` or auto-detect from model name prefix (`gpt-`, `o3-`, `deepseek-`)
- Agent tree = Task tree. Each agent gets worktree + branch. Lifecycle = branch lifecycle.
- All mutable APIs fire-and-forget. Observe via WebSocket.
- MCP tools enable recursive orchestration (tested up to 5 levels deep).

## Key Files

| File | Purpose |
|------|---------|
| src/daemon.ts | HTTP server, routes, WS, ORCHESTRATOR_SYSTEM_PROMPT |
| src/agent-tools.ts | MCP tools (10), system prompts, ORCHESTRATION_KNOWLEDGE |
| src/agent-provider.ts | AgentProvider interface, AgentEvent, AgentSession types |
| src/anthropic-compatible-provider.ts | Anthropic API provider, built-in tools (bash/read/edit/search), compaction |
| src/openai-compatible-provider.ts | OpenAI-compatible API provider (raw fetch, no SDK) |
| src/claude-agent-sdk-provider.ts | Claude Code SDK subprocess provider |
| src/task-tracker.ts | Task tree CRUD, JSON persistence |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue + globalAgentQueues |
| src/project-config.ts | Per-project config (model, provider, budget, etc.) |
| web/App.tsx | Web UI main component |
| web/hooks.ts | React hooks (useWebSocket, useProjects, useTasks, useAgent, useProjectConfig) |
| web/i18n.ts | Localization (en/zh), LocaleProvider, useLocale, t() |
| web/style.css | CSS design system, themes (dark/light/cute-light/cute-dark) |
| web/components/ | 14 modular components split from App.tsx |

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| POST | /projects/:id/orchestrate/agent | Start orchestration |
| POST | /projects/:id/restart | Restart agent |
| POST | /projects/:id/stop | Stop agent |
| POST | /projects/:id/message | Message root agent |
| POST | /projects/:id/tasks/:nodeId/message | Message specific agent |
| POST | /projects/:id/tasks/:nodeId/continue | Continue failed task |
| PATCH | /projects/:id/tasks/:nodeId | Update task |
| GET/PATCH | /projects/:id/config | Project config CRUD |
| POST | /projects/:id/clarify | Answer clarification |
| WS | /ws | Real-time events |

## Project Config

Fields: `model`, `childModel`, `provider`, `budgetUsd`, `clarifyTimeoutMs`, `maxDepth` (default: 3)
Priority: API param > project config > env var > hardcoded default

## Provider Configuration

| Provider | Env Vars | Notes |
|----------|----------|-------|
| direct (Anthropic) | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | Default provider |
| openai | `OPENAI_API_KEY`, `OPENAI_BASE_URL` (optional) | For GPT-4o, DeepSeek, local models |
| claude-code | N/A | Uses Claude Code SDK subprocess |

Model env: `OG_MODEL` > `ANTHROPIC_MODEL` > `OPENAI_MODEL`

## Compaction System

- `compressMessages()` returns ONE user message: task context + fresh memory + checkpoint summary + recent transcript (~80k chars as text).
- No tail message preservation, no bridge messages, no tool_result orphaning issues.
- `CHECKPOINT_SYSTEM_PROMPT` exported from direct-provider.ts, shared by both providers.
- DirectProvider uses Anthropic streaming API; OpenAIProvider uses raw fetch to same endpoint.
- `SUMMARY_MAX_TOKENS = 32768`, `TRANSCRIPT_CHAR_LIMIT = 640k chars`.

## OpenAI Provider Details

- Uses raw `fetch` (no SDK dependency). Tool format: `{ type: "function", function: { name, description, parameters } }`.
- Messages: `tool` role with `tool_call_id` (not `tool_result` blocks in user messages).
- Session files: `.openai.json` suffix to avoid conflicts with DirectProvider.
- Context windows: gpt-4o=128k, o3=200k, deepseek=64k. Default=128k.
- Pricing lookup: exact match first, then prefix match, default gpt-4o.
- Mock `fetch` in tests: `as unknown as typeof fetch` (Bun mock type lacks `preconnect`).

## OpenAI Provider — Dynamic Context Window
- `fetchContextWindowFromAPI()` queries `GET {baseUrl}/models` (note: NOT `/v1/models` — the baseUrl already includes `/v1`) with `Authorization: Bearer` header.
- Results cached in module-level `Map<string, number>` called `contextWindowCache`.
- In `runLoop()`, the API fetch is called before the static `getContextWindow()` fallback. Uses `apiContextWindow ?? getContextWindow(model)`.
- `clearContextWindowCache()` exported for test cleanup.
- API response shape: `{ data: [{ id: string, context_length?: number }] }`.

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` (append) or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` must be absolute. `bun install` in new worktrees.
- **Prompt caching**: Don't put per-agent variables in system prompt — breaks cache sharing.
- **macOS CWD**: `/var` → `/private/var` symlink. Fixed with `realpathSync()`.
- **Biome**: Always typecheck BEFORE `bun run check` (--write can be destructive on broken JSX).
- **Template literals**: Use `${"$"}` for literal `$` in backtick strings in agent-tools.ts.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`. Use `?? ""` or `!`.
- **Compaction streaming**: Use `client.messages.stream().finalMessage()` not `create()` (avoids 10min timeout).

## Daemon Lifecycle

- `activeSessions` Map is single source of truth for running state.
- `stopAgent()`: single function for all stop operations. Resets in_progress children to failed.
- Orphan reset: in_progress tasks → failed on startup and on agent crash/stop.
- Session auto-prune on startup (OG_SESSION_KEEP env, default: 5).
- `runChildAgentInBackground()` extracted for reusable child agent launching.

## Web UI

- **Activity log**: Tool cards (collapsible), MCP tools get purple accent. Title-only cards for yield/get_tree/delete_task/update_task_status.
- **Token badge**: green (<50%), yellow (50-80%), red (>80%). Cost badge shows after completion.
- **Task selection**: defaults to root (PROJECT_NODE_ID). No "all activity" view.
- **ErrorBoundary**: class component wrapping AppInner for graceful crash recovery.
- **WebSocket**: onMessageRef pattern to avoid reconnection on callback change.
- **IME**: composingRef + keyCode 229 + isComposing triple-check for CJK input.

## Task Execution Efficiency
- Avoid running full test suites in every child task — use `bun run typecheck` for quick validation.
- Pre-commit hooks run typecheck + lint + tests automatically.
- Dynamic context window lookup: OpenAI provider now queries GET /v1/models for context_length field with caching. Fallback chain: /v1/models API → CONTEXT_WINDOWS static map → DEFAULT_CONTEXT_WINDOW (128k). Exported clearContextWindowCache() for testing.

## Orchestration Philosophy

- **Always create tasks** — don't use "wait for previous task" as an excuse to not create one. Task descriptions can be updated later.
- **Parallel by default** — most tasks have independent scopes.少量冲突也可以并行运行任务树。
- **Only skip creating** when a task is so heavily dependent on another that even scoping is impossible (extremely rare).
- **Tree, not list** — prefer deep parallel trees over flat sequential lists.

## Test Mock Pattern for OpenAI Provider
- When mocking `globalThis.fetch` in runLoop integration tests, use URL-based dispatch instead of plain callCount. `fetchContextWindowFromAPI()` calls `GET /models` before chat completions, so a naive counter will be off by one.
- Pattern: check if URL includes `/models` (without `/chat/`) → return models response; if `/chat/completions` → use chat-specific counter.
- Always call `clearContextWindowCache()` in `finally` blocks to prevent cache leaking between tests.
