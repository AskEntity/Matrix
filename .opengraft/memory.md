# OpenGraft Project Memory

> Single source of truth. Read on every session start. Full design: `OpenGraft.md`

## Operating Mode

**Autonomy**: Level 10. Work continuously. Don't ask questions — decide and move.
**Workflow**: Create tasks first, refine later. Never just mentally note things — create tasks (they persist after compaction, notes don't).

## How to Run Tests

```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/anthropic-compatible-provider.test.ts src/openai-compatible-provider.test.ts src/message-queue.test.ts src/agent-tools-helpers.test.ts src/config.test.ts
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

Pre-commit hooks run typecheck + lint + unit tests.

## Architecture

```
Daemon (Hono: HTTP + WS on :7433)
    ↑               ↑
   CLI            Web UI (React, bundled by Bun)
```

- Two providers: AnthropicCompatibleProvider (Anthropic API), OpenAICompatibleProvider (raw fetch, no SDK).
- Three-layer config: global (`~/.opengraft/config.json`) > repo (`.opengraft/config.json`) > local (per-project). Auth groups define provider+credentials.
- Agent tree = Task tree. Each agent gets worktree + branch. Lifecycle = branch lifecycle.
- Orchestrator has a real task node (root node with ID).
- All mutable APIs fire-and-forget. Observe via WebSocket.
- MCP tools enable recursive orchestration (tested up to 5 levels deep).
- Own `ToolDefinition` type and `tool()` factory in `src/tool-definition.ts`.

## Key Files

| File | Purpose |
|------|---------|
| src/daemon.ts | HTTP server, routes, WS, ORCHESTRATOR_SYSTEM_PROMPT |
| src/agent-tools.ts | MCP tools (10), system prompts, ORCHESTRATION_KNOWLEDGE |
| src/agent-provider.ts | AgentProvider interface, AgentEvent, AgentSession types |
| src/tool-definition.ts | ToolDefinition type, tool() factory, CallToolResult |
| src/anthropic-compatible-provider.ts | Anthropic API provider, built-in tools, in-context compaction |
| src/openai-compatible-provider.ts | OpenAI-compatible API provider (raw fetch) |
| src/config.ts | Three-layer config system, auth groups, resolve functions |
| src/task-tracker.ts | Task tree CRUD, JSON persistence, ensureRootNode |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue + globalAgentQueues |
| web/App.tsx | Web UI main component, WS event handling |
| web/components/ | 14+ modular components (ActivityLog, ToolCard, SettingsPanel, etc.) |

## Config System

- Global: `~/.opengraft/config.json` — auth groups, daemon settings (port, sessionKeep)
- Repo: `<project>/.opengraft/config.json` — project defaults, versioned in git
- Local: `~/.opengraft/projects/<id>/config.json` — highest priority overrides
- `resolveConfig(global, repo, local)` merges with local > repo > global priority
- Auth groups: `{ "claude": { provider: "anthropic", claudeOauthToken: "..." } }` — referenced by `defaultAuth`/`childAuth`
- Daemon reads NO env vars (except PATH/HOME/NODE_ENV). All config from files.
- Settings UI: three tabs (Global/Project/Local) with Save/Revert buttons. Test isolation via `globalConfigPath` param.

## Compaction (In-Context)

- `SUMMARIZATION_INSTRUCTION` injected as user message → model responds with `<summary>` tags → `extractCheckpoint()` parses
- `compactionPending` flag: inject instruction → extract checkpoint next iteration → `buildCompactedContext()`
- Compact lifecycle: `compact_started` → shimmer bar (infinite animation) → `compact` → bar updates in-place
- Manual compact: POST /compact → queue signal → yield tool re-enqueues → provider handles

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` (append) or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` must be absolute. `bun install` in new worktrees.
- **Prompt caching**: Don't put per-agent variables in system prompt — breaks cache sharing.
- **macOS CWD**: `/var` → `/private/var` symlink. Fixed with `realpathSync()`.
- **Biome**: Always typecheck BEFORE `bun run check` (--write can be destructive on broken JSX).
- **Template literals**: Use `${"$"}` for literal `$` in backtick strings in agent-tools.ts.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`. Use `?? ""` or `!`.
- **OpenAI test mocking**: URL-based dispatch (check `/models` vs `/chat/completions`). Always `clearContextWindowCache()` in `finally`.
- **Compact signal in yield**: Yield tool filters compact signals and re-enqueues them. MUST `break` after re-enqueue — without break, `waitForMessage()` immediately returns the re-enqueued compact → infinite sync loop → 100% CPU.
- **Orchestrator must never edit src files directly**: Use child tasks in worktrees. Direct edits trigger bun --watch daemon restart.

## Daemon Lifecycle

- `activeSessions` Map is single source of truth for running state.
- `stopAgent()`: single function for all stop operations. Resets in_progress children to failed.
- Agent crash cleanup: catch broadcasts `agent_stopped`, finally wraps `tracker.save()` in try/catch.
- Orphan reset on startup: in_progress tasks → failed (skip root node).

## Web UI

- **Activity log**: Tool cards (collapsible), MCP tools get purple accent. Structured fields only.
- **Yield cards**: Completed yield pairs hidden. Only pending yield (agent waiting) shows as "⏸ Yield".
- **Auto-scroll**: sentinel div + `scrollIntoView`. Two mechanisms: `visible.length` useEffect for new entries, MutationObserver (`childList + subtree + characterData`) for in-place text growth from streaming text_delta. Don't use ResizeObserver on scroll container — it only fires on container resize, not inner content growth.
- **Thinking indicator**: `isSelectedTaskRunning` checks running + node status.
- **Compact bar**: shimmer runs indefinitely until checkpoint arrives.
- **User messages**: appear at agent-received time (via rawMessages), pending chip for feedback.
- **URL hash routing**: `#<projectId>/<taskId>` format.
- **IME**: composingRef + keyCode 229 + isComposing triple-check for CJK input.
- **Streaming**: `text_delta` events appended to last text entry per taskId. 80ms throttle.
- **Stop button**: Handles 404 gracefully (session already gone) — resets UI running state. Backend also resets orphaned in_progress root nodes on 404.

## Image Support

- read_file: detects png/jpg/jpeg/gif/webp (NOT svg), returns base64.
- User paste: AppFooter handles clipboard images, 5MB limit.
- MCP yield tool: returns images as `{ type: "image", data, mimeType }`.
