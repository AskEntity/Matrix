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
- Provider selection: `OG_PROVIDER=openai|anthropic|claude-code` (also accepts `direct` for backward compat). Auto-detect from model name prefix (`gpt-`, `o3-`, `deepseek-`).
- Provider `name` field: `"anthropic"` (was `"direct-api"`), `"openai"`, `"claude-code"`
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
| web/App.tsx | Web UI main component, WS event handling |
| web/hooks.ts | React hooks (useWebSocket, useProjects, useTasks, useAgent, useProjectConfig) |
| web/i18n.ts | Localization (en/zh), LocaleProvider, useLocale, t() |
| web/style.css | CSS design system, themes (dark/light/cute-light/cute-dark) |
| web/components/ | 14+ modular components split from App.tsx |

## Provider Configuration

| Provider | Env Vars | Notes |
|----------|----------|-------|
| anthropic | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` | Default provider |
| openai | `OPENAI_API_KEY`, `OPENAI_BASE_URL` (optional) | For GPT-4o, DeepSeek, local models |
| claude-code | N/A | Uses Claude Code SDK subprocess |

Model env: `OG_MODEL` > `ANTHROPIC_MODEL` > `OPENAI_MODEL`

## Compaction System

- `compressMessages()` returns ONE user message: task context + fresh memory + checkpoint summary + recent transcript (~80k chars as text).
- `CHECKPOINT_SYSTEM_PROMPT` exported from anthropic-compatible-provider.ts, shared by both providers.
- `SUMMARY_MAX_TOKENS = 32768`, `TRANSCRIPT_CHAR_LIMIT = 640k chars`.
- UI: compact boundary bar with shimmer animation (runs 2x then stops).

## OpenAI Provider Details

- Uses raw `fetch` (no SDK dependency). Tool format: `{ type: "function", function: { name, description, parameters } }`.
- Messages: `tool` role with `tool_call_id` (not `tool_result` blocks in user messages).
- Session files: `.openai.json` suffix to avoid conflicts with AnthropicCompatibleProvider.
- `fetchContextWindowFromAPI()` queries `GET {baseUrl}/models` with caching. Fallback: static map → 128k default.
- **Test mocking**: Use URL-based dispatch (check `/models` vs `/chat/completions`) instead of plain callCount — `fetchContextWindowFromAPI()` makes an extra fetch. Always call `clearContextWindowCache()` in `finally`.

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` (append) or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` must be absolute. `bun install` in new worktrees.
- **Prompt caching**: Don't put per-agent variables in system prompt — breaks cache sharing.
- **macOS CWD**: `/var` → `/private/var` symlink. Fixed with `realpathSync()`.
- **Biome**: Always typecheck BEFORE `bun run check` (--write can be destructive on broken JSX).
- **Template literals**: Use `${"$"}` for literal `$` in backtick strings in agent-tools.ts.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`. Use `?? ""` or `!`.
- **Compaction streaming**: Use `client.messages.stream().finalMessage()` not `create()` (avoids 10min timeout).
- **CSS specificity**: Place descending-specificity selectors (e.g. `.og-tool-card-loading .og-tool-card-name`) AFTER base selectors to avoid biome warnings.

## Daemon Lifecycle

- `activeSessions` Map is single source of truth for running state.
- `stopAgent()`: single function for all stop operations. Resets in_progress children to failed.
- Orphan reset: in_progress tasks → failed on startup and on agent crash/stop.
- Session auto-prune on startup (OG_SESSION_KEEP env, default: 5).
- `runChildAgentInBackground()` extracted for reusable child agent launching.

## Web UI

- **Activity log**: Tool cards (collapsible), MCP tools get purple accent. Title-only cards for yield/get_tree/delete_task/update_task_status.
- **Tool cards**: Standalone `tool_use` entries show loading state (spinner + pulse). `getToolCardTitle()` accepts `nodeMap` to resolve taskId→title.
- **Textarea**: Auto-resize on paste via `useEffect` on `prompt` prop. `ResizeObserver` on log container keeps auto-scroll working when textarea grows.
- **Queue messages**: Prefixed by source type (← From Parent, ↑ Child Report).
- **Token badge**: green (<50%), yellow (50-80%), red (>80%). Cost badge shows after completion.
- **Task selection**: defaults to root (PROJECT_NODE_ID). No "all activity" view.
- **ErrorBoundary**: class component wrapping AppInner for graceful crash recovery.
- **WebSocket**: onMessageRef pattern to avoid reconnection on callback change.
- **IME**: composingRef + keyCode 229 + isComposing triple-check for CJK input.
- **Text truncation**: Collapsed titles may truncate (40-80 chars). Expanded content shows FULL text — no caps.

## Orchestration Philosophy

- **Always create tasks** — don't use "wait for previous task" as an excuse to not create one.
- **Parallel by default** — most tasks have independent scopes.
- **Tree, not list** — prefer deep parallel trees over flat sequential lists.
