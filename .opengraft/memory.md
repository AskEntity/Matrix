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

## 1M Context Support
- Opus 4.6 and Sonnet 4.6 have 1M context by default — no beta header needed.
- Haiku and older models use 200k context window.
- getContextWindow(model) and getCompactionThresholds(contextWindow) make compaction model-aware.
- COMPRESS_THRESHOLD and CONTEXT_WINDOW are no longer global constants — computed per-session in runLoop.

## Draft Task Feature
- `draft?: boolean` on TaskNode — stored only when true, deleted when set to false (clean serialization)
- `updateDraft()` method on TaskTracker — sets or deletes the field
- Draft tasks blocked at execute_tasks validation, before worktree creation
- PATCH endpoint accepts `draft` field for toggling via API

## Clarify Input Sync Fix
- `clarifyAnswers` keyed by clarification `c.id` not `c.taskId` to avoid input sync between multiple clarifications from same task
- `handleClarifySubmit` takes `clarificationId`, looks up `taskId` from `pendingClarifications`
- Daemon `removePendingClarification` accepts optional `clarificationId` for precise removal
- POST /clarify accepts optional `clarificationId` in body

## extractArg Bracket Parsing Fix
- After bracket matching finds a result, check if what follows is end-of-string or `, key=`
- If not (e.g. `[NOT SCOPED] Add draft task, description=...`), fall through to simple extraction
- This prevents bracket matching from truncating non-JSON bracket-prefixed values

## update_task_status → update_task Rename
- Tool renamed from `update_task_status` to `update_task` with optional fields: status, title, description, draft
- All tracker methods (updateTitle, updateDescription, updateDraft) already existed — no task-tracker changes needed
- References updated across: agent-tools.ts, ToolCard.tsx, i18n.ts (en+zh), e2e.test.ts, OpenGraft.md, CHANGELOG.md

## Git Exclude for Worktrees
- `excludeWorktrees()` in ProjectManager adds `.worktrees` to `.git/info/exclude` (local gitignore)
- Called from both `createNew` (after git init) and `convertExisting` (after ensuring git repo exists)
- Idempotent: checks line-by-line so it won't duplicate the entry

## Structured Tool Events Refactor
- LogEntry now has optional `toolName`, `toolArgs`, `toolResult`, `isError` fields for structured tool data
- `createLogEntry()` accepts an optional `structured` parameter for these fields
- App.tsx WS handler passes structured data from agent_event alongside text fallback
- ActivityLog merge logic uses `toolName` to pair tool_use with tool_result (handles parallel calls via scan-ahead)
- ToolCard/LogEntryView prefer structured fields, fall back to text parsing for old event_history entries
- `getToolCardTitle()` has an optional `toolArgs` param; `getArg()` helper checks structured args first, then `extractArg()`
- `formatArgs` still exported from ToolCard.tsx — used by App.tsx to generate text fallback

## URL Hash Routing
- Hash format: `#<projectId>` or `#<projectId>/<taskId>` — no server changes needed
- `parseHash()` and `updateHash()` are module-level helpers in App.tsx
- Initial state reads from hash via `useMemo(() => parseHash(), [])` — runs once
- Hash update effect fires on `[projectId, selectedTaskId]` changes
- `hashchange` listener handles browser back/forward navigation
- `PROJECT_NODE_ID` is excluded from hash (treated as "no task selected")
- Auto-select-first-project effect validates that hash projectId exists in project list

## Yield Card Replacement Pattern
- Pre-scan in mergedVisible memo finds yield tool_results, scans BACKWARDS for matching tool_use, adds to consumedUseEntries set
- Consumed yield tool_use entries are skipped in the main loop (loading card disappears)
- Yield tool_result renders standalone as "▶ Resume from yield" (title-only card via isTitleOnlyCard)
- While waiting (no result yet), yield tool_use shows as normal loading card with spinner

## Project Creation UX Fix
- handleAddProject in App.tsx must mirror onProjectChange behavior: reset selectedTaskId + clear logs
- AppHeader accepts creatingProject prop to disable form and show og-spinner during creation
- WebSocket auto-reconnects on projectId change (projectId is in useWebSocket dependency array + separate subscribe effect)

## Tool Card Merge
- ActivityLog `mergedVisible` scan-ahead correctly handles interleaved entries between tool_use and tool_result
- The `taskId` check in `findMatchingResult` prevents cross-child matching
- "Loading card never completes" bug was likely stale HMR — restart daemon after code changes

## Auto-scroll Sentinel Pattern
- ActivityLog uses a `bottomRef` sentinel div at the end of scroll content instead of `scrollTop = scrollHeight`
- `bottomRef.current?.scrollIntoView({ block: "end", behavior: "instant" })` reliably reaches absolute bottom
- Works regardless of layout timing (textarea resize, thinking indicator, etc.)

## Thinking Indicator Scoping
- `running` prop is global (any agent running), but thinking should only show for the viewed task
- Fix: snapshot `visible.length` when `running` transitions to true via `visibleLengthOnRunStartRef`
- Only show thinking if `visible.length > snapshot` (entries have grown → this task is active)
- The 40px scroll threshold in handleScroll is fine with the sentinel div (empty div = 0px height)

## Text-Based Tool Parsing Removed
- Deleted `parseToolUse`, `parseToolResult`, `extractArg` from ToolCard.tsx — all text-based parsing gone
- `getToolCardTitle` signature changed: `(toolName, toolArgs: Record<string, unknown> | undefined, resultContent, nodeMap)` — no more `argsStr` param
- `getArg(args, key)` is the new simple helper: reads from structured `Record<string, unknown>` only
- `isTitleOnlyCard` signature simplified: `(toolName, toolArgs?)` — no more `argsStr`
- `McpToolCardBody` takes `toolArgs` instead of `argsStr` — no more manual key=value parsing
- ToolCard and LogEntryView use `entry.toolName`, `entry.toolArgs`, `entry.toolResult`, `entry.isError` directly
- App.tsx: tool_use text is just the tool name (for search); tool_result text is just the content
- ActivityLog `getToolName` simplified to just `entry.toolName ?? ""`
- `formatArgs` still exported from ToolCard.tsx but no longer imported by App.tsx
- `update_task` card title now shows draft/undraft/rename/update labels based on which fields are being updated


## Claude Code Web Search
- `claude --allowedTools "WebSearch" -p "query"` — can be used for web search for unfamiliar APIs
- Useful when agent encounters unknown frameworks or needs latest API documentation

## Image Support in read_file
- `executeTool` return type extended with optional `isImage`, `imageData`, `mediaType` fields
- Supported image extensions: png, jpg, jpeg, gif, webp (NOT svg — Anthropic API only supports these 4 media types)
- Anthropic provider: tool_result content uses array format with `{ type: "image", source: { type: "base64", ... } }` + text description
- OpenAI provider: tool results are text-only, so images are injected as a separate user message with `image_url` type (base64 data URI)
- `OpenAIMessage.content` type expanded to `string | null | Array<{type: "text"} | {type: "image_url"}>` to support multi-modal content
- Compaction transcript serialization in OpenAI provider extracts only text parts from array content, skipping image data

## Image Upload/Paste Support (Web UI → Daemon → Providers)
- `QueueImage` interface in message-queue.ts: `{ base64: string, mediaType: string }`
- User QueueMessage extended with optional `images?: QueueImage[]`
- Daemon `handleInjectMessage` accepts optional images, POST /message and WS inject_message both support images
- Anthropic provider: `extractQueueImages()` helper converts QueueMessage images to Anthropic `ImageBlockParam` format
  - Implicit yield: images added to content array alongside text
  - Cancellation point: images mixed into tool_results user message via spread into content array
  - Type narrowing: `media_type` cast to `ImageMediaType` union (`"image/jpeg" | "image/png" | "image/gif" | "image/webp"`)
- OpenAI provider: `extractQueueImageParts()` helper converts to `image_url` format with data URIs
  - Implicit yield: images added to content array
  - Cancellation point: images injected as separate user message
  - MCP tool results: image blocks extracted separately, not JSON.stringify'd; pushed to imageResults for user message injection
- agent-tools.ts yield tool: extracts images from queue messages, returns as MCP `{ type: "image", data, mimeType }` content blocks
- Web UI: AppFooter accepts `attachedImages`, `onImageAttach`, `onImageRemove` props
  - Paste handler on textarea detects `image/*` clipboard items
  - 5MB size limit per image (MAX_IMAGE_SIZE_BYTES constant)
  - Image previews shown above textarea with hover-to-reveal remove button
  - Images cleared on submit
- hooks.ts `sendMessage` accepts optional images parameter


## Bash foreground_timeout + Background Queue
- `executeBashWithTimeout()` extracted in anthropic-compatible-provider.ts — handles CWD tracking, foreground timeout, and background promotion
- `executeTool()` now accepts optional `sessionId` and `queue` params (backward compatible — both default to undefined)
- Background processes tracked per-session in `backgroundProcesses` Map, cleaned up on stop()
- `foreground_timeout` defaults to `timeout` value (fully foreground) — only backgrounds when explicitly set lower
- Background completions delivered as `background_complete` QueueMessage, formatted by `formatQueueMessage` in agent-tools.ts
- OpenAI provider reuses all of this via imported `executeTool` and `cleanupSessionBackgroundProcesses`

## Cd Wrapper Injection
- `executeBashWithTimeout` in anthropic-compatible-provider.ts prepends a shell `cd()` function that warns when already in the target directory
- The function uses `builtin cd` to resolve the target path and compares with `$(pwd)` — warns to stderr if same
- Default for no-args cd is `$HOME` (not `.`) to match normal bash behavior
- Template literal escaping: `${"$"}` trick for shell variables inside backtick strings
- Both Anthropic and OpenAI providers benefit since OpenAI imports `executeTool` which calls `executeBashWithTimeout`

## Compaction Audit Findings
- All user messages ARE included in fullTranscript — no filtering by role, no per-message truncation
- Queue messages (parent_update, user injections) are already converted to standard messages before compressMessages — safe
- Image content: Anthropic drops image data to "[block]" in transcript (expected for text summary). Fixed tool_result with array content (e.g. image+text) to extract text parts instead of showing generic "[result]"
- TRANSCRIPT_CHAR_LIMIT (640k chars) truncates from HEAD (oldest dropped) — recent messages always preserved
- Recent transcript (~80k chars) is included verbatim in the compressed output for detailed context
- The compressed output = 1 user message: task context + fresh memory + checkpoint summary + recent transcript

## Thinking Indicator Scoping
- `isSelectedTaskRunning` computed in App.tsx: checks if selected task is `in_progress` or is PROJECT_NODE_ID
- Passed to ActivityLog instead of global `running`

## Manual Compaction Trigger
- `compact` source type in QueueMessage — signal-only, no content
- POST /projects/:id/compact enqueues compact signal
- Providers use `manualCompactRequested` flag — triggers pre-call compression regardless of token count
- UI: compress button in TokenUsageBadge (shown when running)

## Lifecycle Event TaskId Assignment
- task_started/task_completed: 2 log entries — one with child taskId, one with parent taskId (nodeMapRef lookup)
- Root-level events (orchestration_started/completed, etc.) use PROJECT_NODE_ID

## In-Context Compaction
- No separate API call — inject `SUMMARIZATION_INSTRUCTION` as user message, model responds with `<summary>` tags
- `compactionPending` flag controls two-phase flow: inject instruction → extract checkpoint next iteration
- `extractCheckpoint()` parses tags, falls back to full text
- `buildCompactedContext()` rebuilds context with fresh memory from disk
