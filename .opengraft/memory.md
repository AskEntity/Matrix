# OpenGraft Project Memory

> Single source of truth. Read on every session start. Full design: `OpenGraft.md`

## Operating Mode

**Autonomy**: Level 10. Work continuously. Don't ask questions — decide and move.
**Workflow**: Create tasks first, refine later. Tasks persist after compaction, mental notes don't.

## How to Run Tests

```bash
bun test src/daemon.test.ts src/project-manager.test.ts src/task-tracker.test.ts src/worktree-manager.test.ts src/anthropic-compatible-provider.test.ts src/openai-compatible-provider.test.ts src/message-queue.test.ts src/agent-tools-helpers.test.ts src/config.test.ts src/canonical-events.test.ts src/event-store.test.ts
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
| src/canonical-events.ts | StrongEvent types + provider converters (+ legacy CanonicalEvent) |
| src/event-store.ts | JSONL EventStore — append-only event persistence |
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
- `done()` = explicit yield: sets tracker status, broadcasts `task_completed`, then calls `waitForQueueMessages()` (same as yield()). Blocks the tool handler — provider never makes another API call after done(). Wake messages arrive as done()'s tool_result.
- `yield()` and `done()` share `waitForQueueMessages()` helper. Both tools = "block and wait for messages." yield() is an explicit tool for AI psychology ("I called a tool, something will happen"). Implicit yield (end_turn) is equivalent but AI is reluctant to use it.
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

## Canonical Events (StrongEvent System)

- **Two-tier events**: Old `CanonicalEvent` (unknown[], provider-specific) + new `StrongEvent` (strongly-typed, provider-agnostic). Dual-write during migration. Old system to be removed in cleanup phase.
- **StrongEvent types**: `user_message`, `assistant_text`, `tool_call`, `tool_result`, `queue_message`, `compacted_resume`, `summarization_request`, `budget_warning`, `compact_marker`. Each has `ts: number` timestamp.
- **EventStore** (`src/event-store.ts`): JSONL append-only. `readActive()` returns events after last `compact_marker`.
- **Converters**: `strongEventsToAnthropicMessages()` and `strongEventsToOpenAIMessages()` reconstruct provider messages from strong events. Key batching: consecutive assistant_text + tool_call → single assistant message; consecutive tool_result → single user message (Anthropic) or individual tool messages (OpenAI).
- **Deterministic verification** at end of each provider runLoop. Known mismatch for cancellation-point queue images (not yet captured as separate StrongEvent).
- **Compaction**: `compact_marker` event replaces `events.length = 0`. Converter skips events before last marker.
- `AgentRequest.eventStore` + `getEventStore()` in daemon helpers. `DaemonContext.eventStores` map.

## CF Tunnel

- Running as macOS LaunchAgent (`com.cloudflare.cloudflared`), domain `t.opengraft.com`.
- rpID must match page domain for WebAuthn.

## User Preferences

- Don't delete completed tasks — close only.
- Don't change auth config values without permission.

## Slash Commands

- Frontend slash commands (/compact, /clear) handled in `web/handlers.ts` via `handleSlashCommand()`. `pendingCompact` state removed — WS events drive UI feedback.

## StrongEvent Converter Fixes (March 2026)

- **Bug 1 (assistant text-only format)**: `strongEventsToAnthropicMessages` must always use array `content` for assistant messages (e.g., `[{type: "text", text: "..."}]`), matching what the Anthropic API returns in `response.content`. Never use bare string for assistant content.
- **Bug 2 (idle vs working queue wrapper)**: Standalone `queue_message` events (from implicit yield/idle drain) use `[Messages received while you were idle:]` wrapper with `Process these messages...` suffix. Queue messages between tool_results (cancellation point) use `[Messages received while you were working:]` wrapper without suffix.
- **caller field**: Converter adds `caller: {type: "direct"}` to tool_use blocks to match Anthropic API response format, eliminating need for stripCaller workaround.
- **OpenAI converter**: Same idle/working distinction applies. Standalone queue_messages produce a user message; cancellation-point queue_messages append to last tool result content.
- **Mocking Anthropic SDK**: Create fake stream with `{[Symbol.asyncIterator]: async function*() {...}, finalMessage: () => Promise.resolve(response)}`. Replace `(provider as any).client` with mock object providing `messages.stream` and `messages.countTokens`.


## StrongEvent Verification Results

- All tested scenarios (echo+tools, fail+resume, implicit yield, rapid messages, orchestrator self-check) show PERFECT match between StrongEvents and provider messages.
- **Known acceptable mismatch**: trailing empty `{"role":"assistant","content":[]}` after done() — Anthropic protocol artifact, StrongEvents correctly omit it.
- **send_message_to_child double-delivery**: message appears both in initial prompt AND as queue_message. Design decision (at-least-once delivery), not a bug.


## Child Agent Done() Deadlock Fix (March 2026)

- **Root cause**: done()=yield blocks on `waitForQueueMessages()` before `tool_result` event is emitted. `runChildCore` waited for `tool_result` with `tool === "mcp__opengraft__done"` to close the queue, but it never arrived → deadlock.
- **Fix**: In `createAgentContext`, the `onTaskEvent` callback now detects `task_completed` events (emitted by done() BEFORE blocking) and closes the child queue. This unblocks `waitForQueueMessages()` immediately. Only applies to child agents (`depth > 0`).
- **Two event paths in agent lifecycle**: (1) `onTaskEvent` callback fires synchronously during tool execution (goes to WebSocket broadcast), (2) provider stream yields `AgentEvent` types to `runChildCore`. `task_completed` flows through path 1, not path 2.
- **The `tool_result` detection in `runChildCore` remains as fallback** for edge cases where done() returns without blocking.
