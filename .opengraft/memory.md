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

Pre-commit hooks run typecheck + lint + unit tests.

## Architecture

```
Daemon (Hono: HTTP + WS on :7433)
    ↑               ↑
   CLI            Web UI (React, bundled by Bun)
```

- Two active providers: AnthropicCompatibleProvider (Anthropic API), OpenAICompatibleProvider (raw fetch, no SDK). Claude Code provider deprecated.
- Three-layer config: global (`~/.opengraft/config.json`) > repo (`.opengraft/config.json`) > local (per-project in dataDir). Auth groups define provider+credentials combos.
- Agent tree = Task tree. Each agent gets worktree + branch. Lifecycle = branch lifecycle.
- Orchestrator has a real task node (root node with ID), not a PROJECT_NODE_ID hack.
- All mutable APIs fire-and-forget. Observe via WebSocket.
- MCP tools enable recursive orchestration (tested up to 5 levels deep).

## Key Files

| File | Purpose |
|------|---------|
| src/daemon.ts | HTTP server, routes, WS, ORCHESTRATOR_SYSTEM_PROMPT |
| src/agent-tools.ts | MCP tools (10), system prompts, ORCHESTRATION_KNOWLEDGE |
| src/agent-provider.ts | AgentProvider interface, AgentEvent, AgentSession types |
| src/anthropic-compatible-provider.ts | Anthropic API provider, built-in tools, in-context compaction |
| src/openai-compatible-provider.ts | OpenAI-compatible API provider (raw fetch) |
| src/config.ts | Three-layer config system, auth groups, resolve functions |
| src/task-tracker.ts | Task tree CRUD, JSON persistence, ensureRootNode |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue + globalAgentQueues |
| web/App.tsx | Web UI main component, WS event handling |
| web/components/ | 14+ modular components (ActivityLog, ToolCard, SettingsPanel, etc.) |

## Config System

- Global config: `~/.opengraft/config.json` — auth groups, daemon settings (port, sessionKeep)
- Repo config: `<project>/.opengraft/config.json` — project defaults, versioned in git
- Local config: `~/.opengraft/projects/<id>/config.json` — highest priority overrides
- `resolveConfig(global, repo, local)` merges with local > repo > global priority
- Auth groups: `{ "claude": { provider: "anthropic", claudeOauthToken: "..." } }` — referenced by `defaultAuth`/`childAuth`
- Daemon reads NO env vars (except PATH/HOME/NODE_ENV). All config from files.
- Settings UI: three tabs (Global/Project/Local) with inherited value placeholders

## Compaction (In-Context)

- `SUMMARIZATION_INSTRUCTION` injected as user message → model responds with `<summary>` tags → `extractCheckpoint()` parses
- `compactionPending` flag controls two-phase flow: inject instruction → extract checkpoint next iteration
- `buildCompactedContext()` rebuilds: task context + fresh memory from disk + checkpoint
- Compact lifecycle events: `compact_started` → shimmer bar appears → `compact` → bar updates with stats
- Manual compact via POST /compact → queue signal → yield loop re-enqueues → provider handles
- Short context guard (messages.length ≤ 4): emits full compact_started/compact cycle with savedTokens=0

## Structured Data Flow

- Tool events: LogEntry has `toolName`, `toolArgs`, `toolResult`, `isError` — all text-based parsing removed
- Queue messages: `rawMessages` (structured) in WS events; `formatQueueMessage()` uses XML tags for LLM injection only
- No text parsing fallbacks anywhere — all paths use structured data

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` (append) or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` must be absolute. `bun install` in new worktrees.
- **Prompt caching**: Don't put per-agent variables in system prompt — breaks cache sharing.
- **macOS CWD**: `/var` → `/private/var` symlink. Fixed with `realpathSync()`.
- **Biome**: Always typecheck BEFORE `bun run check` (--write can be destructive on broken JSX).
- **Template literals**: Use `${"$"}` for literal `$` in backtick strings in agent-tools.ts.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`. Use `?? ""` or `!`.
- **OpenAI test mocking**: URL-based dispatch (check `/models` vs `/chat/completions`). Always `clearContextWindowCache()` in `finally`.

## Daemon Lifecycle

- `activeSessions` Map is single source of truth for running state.
- `stopAgent()`: single function for all stop operations. Resets in_progress children to failed.
- Agent crash cleanup: catch block broadcasts `agent_stopped`, finally block wraps `tracker.save()` in try/catch.
- Orphan reset on startup: in_progress tasks → failed (skip root node).
- Session auto-prune on startup (`config.sessionKeep`, default: 5).

## Web UI

- **Activity log**: Tool cards (collapsible), MCP tools get purple accent. Structured fields only.
- **Auto-scroll**: sentinel div + `scrollIntoView({ block: "end", behavior: "instant" })`.
- **Thinking indicator**: `isSelectedTaskRunning` = `running && (isOrchestratorNode || selectedNode?.status === "in_progress")`.
- **Compact bar**: shimmer animation appears on `compact_started`, updated in-place on `compact` (no duplicates).
- **User messages**: appear at agent-received time (via rawMessages), pending chip for immediate feedback.
- **URL hash routing**: `#<projectId>/<taskId>` format.
- **IME**: composingRef + keyCode 229 + isComposing triple-check for CJK input.

## Image Support

- read_file: detects png/jpg/jpeg/gif/webp (NOT svg), returns base64 with `isImage/imageData/mediaType` flags.
- User paste: AppFooter handles `image/*` clipboard items, 5MB limit, base64 via FileReader.
- MCP yield tool: returns images as `{ type: "image", data, mimeType }` — providers must convert to their native format (not JSON.stringify).
- Anthropic: `ImageBlockParam` with `source.type: "base64"`. OpenAI: `image_url` with data URI.

## Bash Background Processes

- `executeBashWithTimeout()`: foreground timeout → background promotion → completions via `background_complete` queue messages.
- cd wrapper injected to warn on redundant directory changes.
- Per-session cleanup in `backgroundProcesses` Map.
\n## Compact Notification Deduplication Fix\n- compact_started fires from 3 places (yield tool, implicit yield, cancellation point). When manual compact is clicked, yield tool emits compact_started AND re-enqueues, then provider emits compact_started again, causing duplicates.\n- Fix: in compact_started handler, scan backwards through logs for existing compact entry without checkpoint (entry.type === "compact" && !entry.checkpoint). If found, skip adding a new one.\n- Removed compacting state from App.tsx entirely — no longer needed since the compact log entry bar itself shows the correct state (shimmer while no checkpoint, stats when checkpoint arrives).\n- Removed compacting prop and og-compressing-indicator block from ActivityLog.tsx.\n- The thinking indicator was previously gated on !compacting — simplified to just running.

## SettingsPanel Refactor: Save/Revert Pattern
- Draft state per tab: `draftGlobal`, `draftRepo`, `draftLocal` initialized from `layers`, reset via `useEffect` when `layers` changes after save.
- `updateDraft` helper: patches draft object; empty string / undefined / null all mean "delete the key" (equals "inherit from lower layer").
- `isDirty` uses `JSON.stringify` deep comparison to detect changes including complex objects (authGroups, mcpServers).
- `buildPatch` computes PATCH diff: only sends fields that changed. Missing fields in draft (vs saved) become `null` in patch to explicitly clear.
- AuthGroupsSection/McpServersSection now accept `draft + onDraftChange` instead of calling `updateGlobal/updateRepo/updateLocal` directly — this is critical for the tab-level Save to capture auth group and MCP changes.
- `settings.revert` i18n key added to both en and zh.
- CSS: `.og-settings-tab-actions` for Save/Revert bar, `.og-settings-dirty` for the asterisk indicator.
