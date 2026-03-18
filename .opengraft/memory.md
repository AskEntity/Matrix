# OpenGraft Project Memory

> Single source of truth. Read on every session start. Full design: `OpenGraft.md`

## Operating Mode

**Autonomy**: Level 10. Work continuously. Don't ask questions — decide and move.
**Workflow**: Create tasks first, refine later. Tasks persist after compaction, mental notes don't.

## How to Run Tests

```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/anthropic-compatible-provider.test.ts src/openai-compatible-provider.test.ts src/message-queue.test.ts src/agent-tools-helpers.test.ts src/config.test.ts
bun run typecheck   # tsc --noEmit
bun run check       # biome lint + format
```

Pre-commit hooks run typecheck + lint + unit tests.

## Architecture

```
Daemon (Hono: HTTP + WS on :7433, admin :7434)
    ↑               ↑
   CLI            Web UI (React, bundled by Bun)
```

- Two providers: AnthropicCompatibleProvider, OpenAICompatibleProvider. Both share `src/tools/` and compaction.
- Three-layer config: global > repo > local. Auth groups define provider+credentials.
- Agent tree = Task tree. Each agent gets worktree + branch. Lifecycle = branch lifecycle.
- All mutable APIs fire-and-forget. Observe via WebSocket.
- External MCP servers: `McpClientManager` (src/mcp-client.ts), tools get `jsonSchema` (not Zod).

## Key Files

| File | Purpose |
|------|---------|
| src/daemon.ts | Hono app, routes, ORCHESTRATOR_SYSTEM_PROMPT |
| src/daemon/ | context, event-system, helpers, agent-lifecycle, routes/ |
| src/agent-tools.ts | MCP tools, system prompts, ORCHESTRATION_KNOWLEDGE |
| src/anthropic-compatible-provider.ts | Anthropic provider, compaction, retry |
| src/tools/ | definitions.ts, search.ts, bash.ts, executor.ts |
| src/config.ts | Config system, auth groups, DEFAULT_MODEL |
| src/task-tracker.ts | Task tree CRUD, JSON persistence |
| src/worktree-manager.ts | Git worktree lifecycle |
| src/message-queue.ts | MessageQueue + globalAgentQueues |
| src/persistent-queue.ts | Disk-backed message persistence |
| src/session-store.ts | SessionStore (cache + disk) for session history |
| src/canonical-events.ts | CanonicalEvent types + eventsToAnthropicMessages converter |
| src/daemon/routes/auth.ts | WebAuthn/Passkey auth middleware + endpoints |
| web/App.tsx | Web UI main, WS/handlers |
| web/ws-handler.ts | WS event processing (processEvent, UpdateOp) |
| web/components/ | 15+ components (ActivityLog, ToolCard, SettingsPanel, etc.) |

## Core Design Principles

- **Cache invariant**: All in-memory state (queues, sessions) is cache of disk. Eviction = optimization. Daemon restart = rebuild from disk.
- **MCP/REST parity**: Same observable behavior regardless of entry point. Only difference: message source + REST notifies parent chain.
- **Message delivery guarantee**: Messages ALWAYS delivered. Active queue → enqueue directly. No queue → persist to disk + launch agent.
- **`globalAgentQueues`** is sole source of truth for running agents. Delete BEFORE close (callers see "no queue" not "closed queue").

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` absolute. `bun install` in new worktrees.
- **Biome**: Typecheck BEFORE `bun run check`. Rejects `!important` (use double-class selectors). Rejects duplicate CSS properties (use CSS variables for progressive enhancement).
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`.
- **Template literals**: `${"$"}` for literal `$` in agent-tools.ts backtick strings.
- **React**: ErrorBoundary needs `override` keyword. `web/hooks.ts` re-exports types from `src/types.ts`. Always `type="button"` on buttons.
- **Inline styles vs media queries**: Inline `style={{ flex: val }}` beats CSS. Use CSS custom properties: `style={{ '--var': val }}` + `flex: var(--var)` in CSS, override with direct `flex: 1` in media query.
- **Daemon reload**: System daemon (LaunchAgent), not `bun --watch`. Web changes need manual restart. Commits do NOT auto-restart.
- **Compact signal in yield**: MUST `break` after re-enqueue — prevents infinite sync loop.
- **Don't edit src/ directly as orchestrator**: Use child tasks in worktrees.

## Agent Lifecycle

- `stopAgent()` cascades: closes child queues via `globalAgentQueues`, sets children to `failed`.
- `done()` sets tracker status + broadcasts `task_completed`. Does NOT exit loop — enters implicit yield via `queue.wait()`.
- Loop exits ONLY when queue is closed (stop signal).
- Stop = pause (root stays in_progress → auto-resume on restart). Only `done()` changes to passed/failed.
- `runChildAgentInBackground` handles ALL child lifecycle: queue, streaming, done() detection, cost, completion events.

## Task System

- 7 statuses: draft, pending, in_progress, testing, passed, failed, stuck, closed.
- `close_task`: removes worktree, status → closed. `delete_task`: full removal. `reset_task`: removes worktree + session, status → pending.
- `send_message_to_child` is universal: auto-creates worktree + launches agent if not running. Resumes if passed/failed/closed.
- `deliverMessage()`: single path for all delivery. Persist on miss, enqueue on hit.

## WebAuthn/Passkey Authentication

- Auth is ALWAYS on when credentials exist. `enforced` only controls whether registration is allowed.
- Main port (7433) requires auth. Admin port (7434) localhost-only, no auth.
- Middleware exempts `/`, `/web/*`, `/auth/*`. First-run bypass when no credentials.
- `resolveOrigin` respects `X-Forwarded-Proto` for CF Tunnel.
- simplewebauthn v13: `Uint8Array<ArrayBuffer>` type, `{optionsJSON}` wrapper for `startRegistration`.

## Mobile Layout

- `viewport-fit=cover` + `100dvh` (not `100vh` — iOS Safari bug).
- `@media (max-width: 768px)`: sidebar = fixed slide-in overlay, detail panel hidden, activity log fills height.
- Safe area: `env(safe-area-inset-top/bottom)` on header/footer.
- Panel flex ratios via CSS custom properties (`--split-ratio`, `--activity-ratio`) so media queries can override.

## Compaction

- `buildSummarizationInstruction(cwd)` includes CWD in checkpoint template.
- "Key Insights & Rejected Approaches" — high-level design principles, not API quirks.
- Anthropic SDK timeout: 20 minutes (default 10min insufficient for large contexts under load).

## SSE Error Retry

- SSE stream errors have `APIError.status === undefined`. Retry catches: RateLimitError, APIConnectionError, InternalServerError, status 529, AND status undefined.

## Canonical Events (SessionStore Phase 2-3)

- `CanonicalEvent` types in `src/canonical-events.ts`. Recorded at every `messages.push` in provider.
- `eventsToAnthropicMessages()` converter verified deterministic for user_message, assistant_response, tool_results.
- On compaction, `events.length = 0` mirrors `messages.length = 0`.

## CF Tunnel

- Running as macOS LaunchAgent (`com.cloudflare.cloudflared`), domain `t.opengraft.com`.
- rpID must match page domain for WebAuthn.

## User Preferences

- Don't delete completed tasks — close only.
- Don't change auth config values without permission.

## Slash Commands

- Frontend slash commands (/compact, /clear) are handled in `web/handlers.ts` via `handleSlashCommand()`, intercepted in `handleSubmit` before chat message dispatch.
- `pendingCompact` state was removed — compact UI feedback comes entirely from WS events (compact_started → compact completion).
- The compact button in TokenUsageBadge still works as secondary trigger, same code path.


## OpenAI Canonical Events

- OpenAI provider now records CanonicalEvent at every messages.push site, matching Anthropic provider pattern.
- `assistant_response.content` stores `[{...historyMsg}]` — the full OpenAI message object wrapped in an array.
- `tool_results.results` stores individual `{ role: "tool", tool_call_id, name, content }` messages.
- `eventsToOpenAIMessages()` spreads assistant_response.content and tool_results.results directly (they are already OpenAI format).
- Events persist via both `setSync` (mid-loop) and `set` (final), same as Anthropic.


## StrongEvent + EventStore (Phase 1)

- `StrongEvent` type added alongside old `CanonicalEvent` (not replacing yet — Phase 4 cleanup).
- Uses `ts` (not `timestamp`) for brevity in JSONL serialization.
- `EventStore` in `src/event-store.ts`: JSONL append-only, `readActive()` filters by last `compact_marker`.
- `strongEventsToAnthropicMessages()`: key batching logic — assistant_text + tool_calls → single assistant message, tool_results + queue_messages → single user message.
- Standalone `assistant_text` (no tool_calls) uses simple string content. With tool_calls, uses content array.
- `queue_message` events between `tool_result` events merge into the same user message with XML-tagged text blocks.



## StrongEvent Integration (Phase 2)

- EventStore recording runs alongside old CanonicalEvent[] recording (dual-write). Old system not removed yet — Phase 4 cleanup.
- `eventStore.append()` at each `messages.push` site. `eventStore.appendBatch()` for assistant content blocks and tool_results.
- `assistant_response` → split into individual `assistant_text` + `tool_call` StrongEvents.
- `tool_results` → split into individual `tool_result` StrongEvents. Content uses `toolResult.content` (from the modified toolResults array, which includes cancellation-appended text).
- Cancellation-point queue images: added to the last tool_result event's images array (converter collects all images from all tool_results in a batch).
- Compaction: `compact_marker` event appended to EventStore (replaces conceptual `events.length = 0`). Followed by `compacted_resume` event.
- Deterministic verification: `strongEventsToAnthropicMessages(eventStore.readActive(sessionId))` compared against `messages` at end of runLoop. Known mismatch for image tool results (converter produces string content + separate image blocks; messages array has array content on tool_result).
- `AgentRequest.eventStore` field added to `src/agent-provider.ts`.
- `getEventStore()` helper in `src/daemon/helpers.ts`, same directory as SessionStore (`{dataDir}/sessions/{projectId}`).
- `DaemonContext.eventStores` map added to `src/daemon/context.ts`.

