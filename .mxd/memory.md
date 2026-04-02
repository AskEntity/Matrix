# Matrix Project Memory

> Single source of truth. Read on every session start. Full design: `Matrix.md`

## ⚠️ Architecture Discipline

Every bug fix MUST ask: (1) What caused this specific bug? (2) Why does the architecture make this class of bug easy?

**Anti-patterns**: duplicate codepaths, lifecycle dependency coupling, legacy fallbacks masking bugs, lazy optional fields, "unify" = adding a third path (delete until ONE remains).

## ⚠️ Task Execution Discipline

Creating tasks is CHEAP. Executing must be DELIBERATE. When user discusses design → draft + discuss. Only execute when they say "go" or explicitly ask to start.

## How to Run Tests

```bash
bun test              # ALL tests (unit + integration). ~1145 pass, 3 skip.
bun run typecheck     # tsc --noEmit
bun run check         # biome lint + format
```

## Architecture Overview

```
Daemon (Hono: HTTP + SSE on :7433)
    ↑               ↑
   CLI (mxd)     Web UI (React, bundled by Bun)
```

- Two providers: `AnthropicCompatibleProvider`, `OpenAIResponsesCompatibleProvider`. Shared `runProviderLoop` + `ProviderAdapter`.
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
`src/task-operations.ts`: createTaskOp, updateTaskOp, deleteTaskOp, closeTaskOp, resetTaskOp, reorderTasksOp. MCP and REST are thin wrappers. Behavioral differences via explicit `if (editedBy === "user")`.

### Two-Phase Message Lifecycle
Phase 1: `message` event persisted → frontend defers. Phase 2: `messages_consumed` → frontend materializes. `QueueMessage.ts` = `Event.ts` = timestamp in `[HH:MM:SS]` — all same value, set once at creation.

### JSONL-Memory Consistency
In-memory `messages[]` and JSONL events are two data structures. Recovery that only modifies `messages[]` doesn't persist — JSONL retains the poison. Any "fix" must touch JSONL, not just memory.

## Key Files

| File | Purpose |
|------|---------|
| src/task-operations.ts | Shared CRUD operations (MCP + REST call these) |
| src/tool-names.ts | MCP tool name constants + helpers |
| src/queue-message-factory.ts | QueueMessage factories (enforce id/ts invariant) |
| src/event-display.ts | Platform-agnostic tool display (single source) |
| web/api.ts | Centralized API URL builder |
| src/daemon/agent-lifecycle.ts | runAgentForNode, stop, deliverMessage, autoResume |
| src/provider-shared.ts | Run loop, ProviderAdapter, yield/done handling |
| src/events.ts | Event types, formatBodyForAI, buildSessionRepair |
| src/event-store.ts | JSONL EventStore (with truncateAfterLine) |
| src/event-converter.ts | walkEventsToMessages + EventConverterCallbacks |
| src/task-tracker.ts | Task tree, persistent task loading from .mxd/tasks/ |
| src/image-dimensions.ts | PNG/JPEG pixel dimension parsing |

## Agent Lifecycle

- Root and child agents use the same launch function: `runAgentForNode` in `agent-lifecycle.ts`
- `done()` = two-phase: Phase 1 (agent-side: close queue, loop exits) → Phase 2 (daemon-side: status→verify/failed, task_complete, done_notified marker). Intended orphan like yield — no tool_result written.
- `yield()` = loop-level pause. Provider intercepts before executeTool.
- `end_turn` = implicit yield, never implicit done.
- `stopTask()` = per-task real interrupt (close queue + abort signal via `TaskSession.abortController`).
- `launchingNodes: Set<string>` prevents duplicate launches during async setup.
- Session identity check in finally block prevents cleanup clobber when replacement agent launched.
- On JSONL resume, four states detected from JSONL shape:
  - **Explicit yield** (pendingYieldToolCall): bypass to queue.wait
  - **Done** (pendingDoneToolCall): wait for messages, write done tool_result with wake context
  - **Implicit yield** (hasPendingImplicitYield): bypass to queue.wait → handleImplicitYield
  - **Interrupted** (orphaned tools repaired): non-blocking queue drain → API call
- autoResumeProjects: finds in_progress nodes with JSONL + crash recovery for interrupted Phase 2 (done without done_notified).

## JSONL Repair

`buildSessionRepair()` in events.ts handles all repair:
- **Orphan only** (tool_call without result): append interrupted results, no truncation
- **Duplicate results** (>1 result for same tool_call): truncate from first duplicate + status message
- `EventStore.truncateAfterLine(sessionId, lineIndex)`: rewrites file keeping lines 0..lineIndex
- Repair runs in runAgentForNode before provider loop starts

## Persistent Tasks

`persistent: boolean` on TaskNode (discriminated union: `RegularTaskNode | PersistentTaskNode`).
- `false`: regular task. Full lifecycle (pending → in_progress → verify/failed → closed).
- `true`: persistent task. Status: `"in_progress" | "verify" | "pending"`.
  - `done()` → verify/failed (same as regular). `close_task` → verify→pending. `reset_task` rejected.
  - `done()` still fires `task_complete` to parent. Session preserved.
  - `get_tree` shows status when "verify", hides for in_progress/pending.
  - Changeable via `update_task(persistent: true/false)`.

Definition in `.mxd/tasks/<id>.json` (git-tracked): title, description, color, persistent. tree.json stores runtime state only. `savePersistentDef` auto-commits via git. Called from createTaskOp (when persistent set) and updateTaskOp (when title/description/color changes).

Four top-level persistent domains:
- **Design Philosophy** 🟣 — ITA, anti-patterns, system prompt (sub-domain)
- **Task System Design** 🟣 — depth, pinned tasks, meeting mode, partial completion, flow
- **Agent Loop** 🟠 — launch, provider loop, yield/resume, stop/restart, JSONL repair, image validation, OpenAI provider
- **User Interaction** 🔵 — Web UI + CLI

## Image Handling

- **Pixel dimension guard**: `getImageDimensions(buffer)` in `src/image-dimensions.ts` parses PNG/JPEG headers. read_file rejects >8000px per dimension.
- **Provider-level byte size**: `validateImage?` on `ProviderAdapter`. Anthropic: 5MB decoded. OpenAI: 20MB decoded. Four filter points in `runProviderLoop`.
- **Streaming text partial**: `ctx.streamingText: Map<string, string>` tracks text_delta. Batch events endpoint injects synthetic `assistant_text` with `partial: true`.

## Session Config + Cache

`session_config` event at JSONL start: tools, systemStable, systemVariable. Frozen between compactions for cache stability. Anthropic cache: 3 breakpoints (tools, systemVariable, 2nd-to-last user message).

## Default Branch

Root node stores branch at init. `baseBranch` required on worktree create (no fallback). Child worktrees branch from parent's branch.

## Auth

Challenge-response with browser keypair (RSA-OAEP 2048). CLI `mxd auth <public_key>` → encrypted JWT → paste to browser. CLI auto-auth via `signCLIToken()`.

## CLI Installation

`mxd` CLI globally installed via `bun link`. package.json `"bin": { "mxd": "src/cli.ts" }`, cli.ts has `#!/usr/bin/env bun` shebang.

## Integration Test Framework

- `ValidatingMockAPI`: instruction-driven mock, sessionId-based conversation keying, prefix validation, field validation.
- Mock DSL: `{"blocks": [...]}` or `{"turns": [...]}` with assert/capture.
- `recreateApp()` simulates daemon restarts. `readSessionEvents` flushes EventStore before reading.
- ~1145 tests (unit + integration). 3 skipped (E2E).

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` absolute.
- **Biome**: Typecheck BEFORE lint. No `!important`. No duplicate CSS properties.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`.
- **Daemon reload**: Commits don't auto-restart the daemon. Must manually restart after code changes.
- **Concurrent ULID**: Use full `ulid()` (26 chars) — sliced ULIDs collide within same millisecond.
- **Provider queue close**: Check `queue.isClosed` after tool execution, `return` immediately.
- **Never modify own JSONL from agent**: Current tool_call has no result yet → false orphan.
- **Async JSONL writes**: `emitEvent` fire-and-forgets `eventStore.append()`. Flush before reading in tests.
- **delete_task cascades**: Deletes all descendants AND session JSONL. Enforced: returns 400 with children. Use `update_task` to change persistent mode, not delete+recreate.
- **Abort signal leak**: After stop, old runAgentForNode settles async. catch/finally check `sessionWasReplaced` to suppress stale error events.

## Known Bugs (unfixed)

- Manual compaction during yield → consecutive user messages → API 400.
- Prefix violation after double restart (Restart N) — disabled in test.
- Flaky: `Fork from closed agent` — timing-dependent.

## OpenAI Provider

- Chat Completions (`OpenAICompatibleProvider`) is dead code — not wired into production.
- `createProviderFromAuth` always creates `OpenAIResponsesCompatibleProvider` for OpenAI auth.
- Responses `streamResponsesAPI` has inner retry (5 attempts, exponential backoff) matching Anthropic. `retryDelayMs` param for fast tests.
- Function tool definitions include `strict: false` in outgoing payload.
- **Tool input Zod validation**: `executeTool` validates all built-in tool inputs against Zod schema. Rejects invalid types at schema boundary. External MCP tools (empty `inputSchema {}`) skip validation.

## Auto-Recovery from API 400

Provider loop auto-recovers from 400 invalid_request_error. On 400, pops broken user message, replaces with safe synthetic tool_results + recovery text, retries once (`autoRecoveryAttempted` flag). Production: `enableAutoRecovery ?? true`. Tests: `enableAutoRecovery: false`.

## UI Notes

- Event fetching: per-session (`api.taskEvents(projectId, sessionId)`) not per-project. Forked sessions contain parent events — merging causes stale content.
- Derived state reset: ALL state cleared on project/task switch (logs, tokenUsage, pendingMessages, etc.).
- Lifecycle entry collapse: consecutive lifecycle-only entries collapsed, keeping last per run.
- Agent status: `activeAgents` Set updated globally for agent_active/idle/stopped events, regardless of viewed session.

## User Preferences

- Close completed tasks, don't delete.
- Don't change auth config without permission.
- User communicates in Chinese.
- Discuss architecture before executing.
- "Delete until ONE remains" not "unify".

## Test-is-Golden / ITA Philosophy

Three layers: Intention → Test → Architecture. Three mutations guard each layer:
- **Intention Mutation**: is this behavior what users actually want?
- **Test Mutation**: do tests catch code changes?
- **Architecture Mutation**: can the code evolve?

Tests are the single source of truth. Bottom-up: write tests → find simplest architecture that passes them. Architecture is replaceable long-term, improved short-term. Reject spec-driven development.

## ⚠️ AI Agent Laziness Patterns

1. **Fear of large changes** — revert/fallback instead of executing.
2. **Unnecessary fallbacks** — keep old path "just in case". Delete it.
3. **Won't communicate** — text blocks invisible to parent. Use send_message.
4. **Won't question architecture** — "why does this exist" > "how to make it work".
5. **"Unify" = add third path** — delete until ONE remains.

## System Prompt v2 Rewrite (2026-04-02)

Major rewrite: 286 insertions, 442 deletions (net -156 lines). 10 chapters + closing.
- Three roles: root orchestrator, persistent domain owner, worker. Managers never write code.
- done() universal and non-terminal (persistent tasks: "round finished", not "gone forever").
- "Keep tree shallow 2-3 levels" removed — replaced with "without depth limit".
- Fork explained as "changing jobs" — identity continuity, not denial.
- Memory callee-saved convention: inherited portion untouched, append freely.
- Three Mutations chapter: test, architecture, intention.
- "ASK — NEVER SILENTLY FALL BACK" elevated to boldest statement in prompt.
- Adversarial testing with vivid example (PIN + top up scenario).


## Two-Phase done() Lifecycle (2026-04-02)

### Design
- **Phase 1** (agent-side): done() handler closes queue + returns. No status update, no parent notification. Intended orphan like yield — no tool_result written to JSONL. Provider loop detects done, sets doneExitReason + doneSummary, exits.
- **Phase 2** (daemon-side, in runAgentForNode): After loop exits with done exit reason, updates status (verify/failed), delivers task_complete to parent, writes `done_notified` crash-safe marker to JSONL.
- **Crash recovery**: `findInterruptedDonePhase2` in daemon.ts detects orphaned TOOL_DONE without done_notified → completes Phase 2 on restart. Also fixes stale status (done_notified exists but status still in_progress).

### Status Changes
- "verify" added to TaskStatus: `done("passed")` → verify, `done("failed")` → failed.
- closeTaskOp: verify→closed (regular), verify→pending (persistent). Rejects in_progress/pending/draft.
- PersistentTaskNode status: `"in_progress" | "verify" | "pending"`.
- buildSessionRepair: TOOL_DONE skipped alongside TOOL_YIELD (not treated as orphans).
- AgentResult.doneSummary carries summary from done() handler through to Phase 2.

### Done Resume from JSONL
When JSONL has done orphan (last tool_call is TOOL_DONE with no result), provider loop waits for wake messages, writes synthetic tool_result with "You previously called done()" context.

### Key Pitfalls
- waitForDone test helper must check "verify" in addition to "passed"/"failed".
- Root agents no longer block in waitForQueueMessages after done() — loop exits immediately.
- Background processes may be killed by cleanup before completing after done().
- closeTaskOp now rejects pending/draft status — tests must set passed/verify before close_task.
- **Phase 2 ordering is critical**: session=null is the irreversibility boundary. Phase 2 (status update, parent notification) runs AFTER session cleanup, not before. Before session=null: late messages → relaunch (reversible). After session=null: commit verify + notify parent (irreversible). No race window.

## Domain Owner Routing Rules

Route by **domain**, not by **file**. Key principle: **whoever introduces a change owns ALL consequences** (prompt, UI, tests, docs). Domain owners NEVER write code — they manage and understand. Delegate everything.

## Two-Phase Done() (merged 2026-04-02)

23 files, +1489/-795. done() → verify status, close_task unified (persistent→pending, regular→closed), Phase 2 in runAgentForNode after session cleanup, crash recovery. 1145 tests pass.

## Cache TTL for Persistent Tasks (2026-04-02)

- `SessionConfigEvent.cacheTtl?: "1h"` — stored in session_config, inherited via fork.
- Root + persistent = `"1h"`, regular children = `undefined` (5min default).
- On resume, `cacheTtl` from stored session_config (not recomputed) — preserves fork inheritance.
- ALL breakpoints (system, tools, messages) use consistent TTL. Extended cache TTL (1h) is GA — no beta header needed.
- **PITFALL**: Never add per-request `anthropic-beta` headers — they override client's `defaultHeaders` (including OAuth header `oauth-2025-04-20`), breaking OAuth mode.
- `{type: "ephemeral"}` and `{type: "ephemeral", ttl: "1h"}` are DIFFERENT cache entries — TTL is part of prefix identity.
- `AgentRequest.isOrchestrator` replaced with `cacheTtl?: "1h"`. Same on ProviderAdapter.callAPI.
- Prefix validation: system+tools strict JSON compare; message breakpoint position can move but value must match; all other messages compared with cache_control included.
