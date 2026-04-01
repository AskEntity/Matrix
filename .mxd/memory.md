# Matrix Project Memory

> Single source of truth. Read on every session start. Full design: `Matrix.md`

## ⚠️ Architecture Discipline

Every bug fix MUST ask: (1) What caused this specific bug? (2) Why does the architecture make this class of bug easy?

**Anti-patterns**: duplicate codepaths, lifecycle dependency coupling, legacy fallbacks masking bugs, lazy optional fields, "unify" = adding a third path (delete until ONE remains).

## ⚠️ Task Execution Discipline

Creating tasks is CHEAP. Executing must be DELIBERATE. When user discusses design → draft + discuss. Only execute when they say "go" or explicitly ask to start.

## How to Run Tests

```bash
bun test              # ALL tests (unit + integration). Always use this.
bun run typecheck     # tsc --noEmit
bun run check         # biome lint + format
```

## Architecture Overview

```
Daemon (Hono: HTTP + SSE on :7433)
    ↑               ↑
   CLI (mxd)     Web UI (React, bundled by Bun)
```

- Two providers: `AnthropicCompatibleProvider`, `OpenAICompatibleProvider`. Shared `runProviderLoop` + `ProviderAdapter`.
- Three-layer config: global > repo > local. Auth groups define provider+credentials.
- Agent tree = Task tree. Each agent gets worktree + branch from parent's branch.
- All mutable APIs fire-and-forget. Observe via SSE.
- External MCP servers: `McpClientManager` (src/mcp-client.ts).

## Key Architectural Invariants

### JSONL Content Fidelity
JSONL event content = exact content sent to API. Zero transformation. No `.slice()`, no truncation on persisted content. UI truncation only in `stripEventForUI` (SSE layer) and frontend rendering.

### Tool Result Three-Part Invariant
Every tool_result must: (1) emit to JSONL, (2) yield to SSE, (3) push to messages[]. Missing any = orphan, missing UI, or API 400.

### Yield JSONL Invariant
Nothing written to JSONL after yield tool_call except by provider loop. External events go to queue, not JSONL. `hasPendingYield()` detects this state.

### Single Delivery Path
`deliverMessage` is THE message delivery path: JSONL write → queue delivery → flush → auto-launch. `quiet: true` for notifications. No other code writes message events to JSONL.

### ONE Codepath Per Task Operation
`src/task-operations.ts`: createTaskOp, updateTaskOp, deleteTaskOp, closeTaskOp, resetTaskOp, reorderTasksOp. MCP and REST are thin wrappers. Behavioral differences via explicit `if (editedBy === "user")`. REST is strict (all params required), MCP adds convenience.

### Two-Phase Message Lifecycle
Phase 1: `message` event persisted → frontend defers. Phase 2: `messages_consumed` → frontend materializes. `QueueMessage.ts` = `Event.ts` = timestamp in `[HH:MM:SS]` — all same value, set once at creation.

## Key Files

| File | Purpose |
|------|---------|
| src/task-operations.ts | Shared CRUD operations (MCP + REST call these) |
| src/tool-names.ts | MCP tool name constants + helpers |
| src/queue-message-factory.ts | QueueMessage factories (enforce id/ts invariant) |
| src/event-display.ts | Platform-agnostic tool display (single source) |
| web/api.ts | Centralized API URL builder |
| src/daemon/agent-lifecycle.ts | Agent launch, stop, deliverMessage, autoResume |
| src/provider-shared.ts | Run loop, ProviderAdapter, yield/done handling |
| src/events.ts | Event types, formatBodyForAI, orphan detection |
| src/event-store.ts | JSONL EventStore |
| src/event-converter.ts | walkEventsToMessages + EventConverterCallbacks |
| src/task-tracker.ts | Task tree, persistent task loading from .mxd/tasks/ |

## Agent Lifecycle

- `done()` → status update + `task_complete` to parent. Only path for completion.
- `yield()` = loop-level pause. Provider intercepts before executeTool.
- `end_turn` = implicit yield, never implicit done.
- `stopTask()` = per-task real interrupt (close queue + abort signal).
- On JSONL resume: pendingYieldToolCall → bypass to queue.wait (zero API call).
- autoResumeProjects: yielding → bypass, interrupted → resume with message.

## Persistent Tasks

`persistent: false | "reset" | "continue"` on TaskNode.
- `false`: regular. close = closed.
- `"reset"`: close → pending + clear session JSONL. Clean start each cycle.
- `"continue"`: close → pending + keep session JSONL. Resume with context.

Definition in `.mxd/tasks/<id>.json` (git-tracked): title, description, color, persistent mode. tree.json stores runtime state only. Two quality agents: Test Mutation + Architecture Mutation.

## Default Branch

Root node stores branch at init. `baseBranch` required on worktree create (no fallback). Child worktrees branch from parent's branch. System prompt is branch-agnostic.

## Session Config + Cache

`session_config` event at JSONL start: tools, systemStable, systemVariable. Frozen between compactions for cache stability. Anthropic cache: 3 breakpoints (tools, systemVariable, 2nd-to-last user message).

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` absolute.
- **Biome**: Typecheck BEFORE lint. No `!important`. No duplicate CSS properties.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`.
- **Daemon reload**: Commits don't auto-restart the daemon. Must manually restart after code changes.
- **Concurrent ULID**: Use full `ulid()` (26 chars) — sliced ULIDs collide within same millisecond.
- **Provider queue close**: Check `queue.isClosed` after tool execution, `return` immediately.
- **Never modify own JSONL from agent**: Current tool_call has no result yet → false orphan.

## Auth

Challenge-response with browser keypair (RSA-OAEP 2048). CLI `mxd auth <public_key>` → encrypted JWT → paste to browser. CLI auto-auth via `signCLIToken()`. Web session in localStorage (`mxd-jwt`).

## CLI Installation

`mxd` CLI is globally installed via `bun link`. Binary at `~/.bun/bin/mxd` → symlink to `src/cli.ts`. package.json has `"bin": { "mxd": "src/cli.ts" }`, cli.ts has `#!/usr/bin/env bun` shebang. After `bun link`, use `mxd` directly (not `bun run src/cli.ts`).

## Self-Bootstrap: Web Auth for Chrome DevTools

When testing via Chrome DevTools, take snapshot of login page → run `mxd auth <key>` → paste output → authenticated.

## Integration Test Framework

- `ValidatingMockAPI`: instruction-driven mock, sessionId-based conversation keying, prefix validation, field validation (rejects unknown API fields).
- Mock DSL: `{"blocks": [...]}` or `{"turns": [...]}` with assert/capture.
- `recreateApp()` simulates daemon restarts. Every restart test: crash → restart → resume → done().
- ~808 tests total (713 unit + 95 integration).

## Test-is-Golden Philosophy

Test is golden. Not spec, not architecture. Bottom-up: write tests → find simplest architecture that passes them. Architecture is replaceable long-term (tests anchor it), improved short-term via mutation testing. Reject spec-driven development.

## Architecture Quality: Feature Mutation Test

Pose hypothetical change, count files to modify. 1 = good, 3+ = problem. Architecture improves through mutation testing short-term; remains replaceable long-term because tests hold.

## ⚠️ AI Agent Laziness Patterns

1. **Fear of large changes** — revert/fallback instead of executing.
2. **Unnecessary fallbacks** — keep old path "just in case". Delete it.
3. **Won't communicate** — text blocks invisible to parent. Use send_message.
4. **Won't question architecture** — "why does this exist" > "how to make it work".
5. **"Unify" = add third path** — delete until ONE remains.

## User Preferences

- Close completed tasks, don't delete.
- Don't change auth config without permission.
- User communicates in Chinese.
- Discuss architecture before executing.
- "Delete until ONE remains" not "unify".

## Known Bugs (unfixed)

- Manual compaction during yield → consecutive user messages → API 400.
- Prefix violation after double restart (Restart N) — disabled in test.
- Flaky: `Fork from closed agent`, `BG5` — timing-dependent.



- Responses provider tests: initial user queue content includes the formatted header (working directory/timestamps), so assert with stringContaining for prompt text rather than exact raw content.
- Responses provider max_output_tokens currently follows context window sizing in provider loop tests (e.g. 128000 for gpt-4o-mini/gpt-4.1-mini here), not a small fixed cap.
- Provider-level yield tests are reliable for asserting streamed text/tool_call behavior and first-request formatting; full post-yield resume behavior is better covered at higher integration layers.

- Responses integration harness note: OpenAIResponsesCompatibleProvider does not accept an injected fetch in its constructor; isolated full-stack tests must mock globalThis.fetch around createApp/provider construction and restore it in teardown.
- Responses integration harness note: the first /responses call may be followed quickly by additional calls from the provider loop; assert request-shape and tool round-trip from captured request history rather than assuming a single request per scenario.

- **Tool input Zod validation**: `executeTool` validates all built-in tool inputs against their Zod schema before calling handlers. Rejects invalid types (e.g. string `"false"` for `z.literal(false)`) with a clear error message back to the model. External MCP tools (identified by empty `inputSchema {}`) skip validation. This is the correct fix for model-side type corruption — reject at the schema boundary, don't coerce downstream.

- OpenAI Responses provider function tool definitions now include strict: false in the outgoing tools payload; keep chat-completions/OpenAI provider unchanged unless intentionally expanding the experiment.
- For Responses provider payload tests, assert the exact tool shape in the captured request body (including strict: false) rather than only the schema, because compatibility bugs show up at the wire format boundary.

- UI live state fix: tree_updated now clears in-memory log/pending/older-history state for sessions that become pending with no session object, so reset_task and persistent close(reset) immediately match a fresh reload without waiting for event refetch.

## UI Derived State Reset Consistency

When switching projects, tasks, adding projects, or creating tasks, ALL derived state must be reset. The complete list of state that needs clearing:
- `logs`, `tokenUsage`, `pendingMessages`, `pendingClarifications`, `backgroundProcesses`, `activeAgents`, `olderEventsAvailable`
- `lastTurns`, `lastInputTokens`, `lastCacheCreationTokens`, `lastCacheReadTokens`, `lastOutputTokens`
- `selectedTaskId`, `rootNodeId`, `targetNodeId` (where applicable)

The `handlers.ts` `createActionHandlers` now receives `setTokenUsage`, `setPendingMessages`, `setBackgroundProcesses`, `setActiveAgents`, `setOlderEventsAvailable` so that `handleAddProject` and `handleDeleteProject` can reset all state.

`handleCreateTask` now selects the newly created task by reading the response body `{ id }` from the POST /tasks endpoint.


## OpenAI Provider Parity Audit (2026-04-01)

- Chat Completions provider (`OpenAICompatibleProvider`) is dead code — not wired into production. `createProviderFromAuth` in daemon/helpers.ts always creates Responses provider for OpenAI auth.
- Responses provider has 3 critical gaps vs Anthropic: (1) zero inner retry in callAPI, (2) no done() reminder injection, (3) no tool-use system prompt nudge.
- Integration tests: 95 Anthropic, 3 Responses, 0 Chat Completions. Recommended: parameterize existing tests with provider factory + shared MockAPI interface.
- Chat and Responses providers share near-identical event converter callbacks, buildToolResultsMessage, buildImplicitYieldMessage, computeCost — candidate for dedup.
- Responses `streamResponsesAPI` reads SSE events from response body manually (no SDK). Anthropic uses SDK streaming helpers.


- Responses provider `streamResponsesAPI` now has inner retry (5 attempts, exponential backoff) matching Anthropic provider. Retries 429/500/502/503/529, throws immediately on 400/401/403/404. `retryDelayMs` param for fast tests. Export `streamResponsesAPI` for direct unit testing to avoid outer retry loop interference from `runProviderLoop`.

## UI Event Fetching: Per-Session, Not Per-Project

The UI must fetch events per-session (using `api.taskEvents(projectId, sessionId)`) not per-project (`api.events(projectId)`). Forked sessions contain copies of parent events with the parent taskId; merging all sessions causes stale content to appear above the compaction line on refresh. The viewed session is `selectedTaskId ?? rootNodeId` — tracked via a ref for stable callbacks.

## Biome Lint Fix Patterns

- `noNonNullAssertion`: Replace `x!` with `x?.` for property access, `x as Type` for variable assignment, or extract + guard. In tests, `as TaskNode` / `as string` is the cleanest.
- `noNonNullAssertedOptionalChain`: Never mix `?.` and `!` (e.g. `x?.y!`). Use `x?.y ?? fallback` or `x?.y as Type`.
- `noExplicitAny`: Replace `any` with `Event`, `{ type: string }`, `unknown`, or specific interface.
- `useTemplate`: Replace `a + b` with template literals. Biome auto-fix handles most but marks them "unsafe".
- `biome check --write --unsafe` auto-fixes ~50% of `noNonNullAssertion` but creates `noNonNullAssertedOptionalChain` errors from `x!.y!` → `x?.y!`. Must manually fix those after.


## Bug Fix: Duplicate tool_result after daemon restart during bg await

**Root cause**: `stopAgent` and `stopTask` called `writeOrphanedToolResults` immediately after killing background processes. But the provider loop was still settling asynchronously — `cleanupSessionBackgroundProcesses` kills bg processes → `completionPromise` resolves → provider loop emits real `tool_result`. This races with `writeOrphanedToolResults` writing synthetic "interrupted" results → duplicate `tool_result` for same `toolCallId` → API 400.

**Fix**: Removed `writeOrphanedToolResults` from `stopAgent` and `stopTask`. Orphan detection only runs at restart/resume time (in `daemon.ts` autoResumeProjects and `launchAgent`/`runChildAgentInBackground`) when the provider loop is guaranteed dead. No race.

**Verified from real JSONL data** (matrix-docs project): `bg await` tool_call got both a synthetic "interrupted" result (ts=...520) and a real result from the provider loop (ts=...521, 1ms later). Confirmed the race condition.

**BG5 flaky test**: Not the same root cause — it is a timing-dependent test about bg completing during foreground tool execution, unrelated to daemon restart.


## Auto-Recovery from API 400

Feature: provider loop auto-recovers from 400 invalid_request_error (e.g. oversized image in tool_result). On 400, pops the broken user message, replaces with safe synthetic tool_results (matching tool_use IDs from the preceding assistant message) + recovery text, then retries.

- `enableAutoRecovery` on `AgentRequest` (default: not set). Production daemon sets `ctx.config.enableAutoRecovery ?? true`. Tests set `enableAutoRecovery: false` via `DaemonConfig` to avoid masking bugs.
- Only attempts once per session (`autoRecoveryAttempted` flag). Second 400 throws normally.
- Recovery builds Anthropic-format tool_result blocks with `is_error: true` + text explanation. Must match tool_use IDs in the preceding assistant message to satisfy API validation.
