# Matrix Project Memory

> Single source of truth. Read on every session start.

## How to Run

```bash
bun test              # ~1153 pass, 3 skip
bun run typecheck     # tsc --noEmit
bun run check         # biome lint + format
```

## Architecture

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

## Key Invariants

1. **JSONL Content Fidelity**: Event content = exact content sent to API. Zero transformation.
2. **Tool Result Three-Part**: Every tool_result: (1) emit to JSONL, (2) yield to SSE, (3) push to messages[].
3. **Yield JSONL**: Nothing written to JSONL after yield/done tool_call except by provider loop.
4. **Single Delivery Path**: `deliverMessage` is THE message path: JSONL write → queue delivery → flush → auto-launch.
5. **ONE Codepath Per Operation**: `task-operations.ts` shared by MCP and REST.
6. **JSONL-Memory Consistency**: Recovery must touch JSONL, not just memory.

## Key Files

| File | Purpose |
|------|---------|
| src/task-operations.ts | Shared CRUD (MCP + REST) |
| src/daemon/agent-lifecycle.ts | runAgentForNode, deliverMessage, autoResume |
| src/provider-shared.ts | Run loop, ProviderAdapter, yield/done |
| src/events.ts | Event types, formatBodyForAI, buildSessionRepair |
| src/event-store.ts | JSONL EventStore |
| src/event-converter.ts | walkEventsToMessages |
| src/task-tracker.ts | Task tree, persistent task loading |
| src/anthropic-compatible-provider.ts | Anthropic Messages API |
| src/orchestrator-tools.ts | MCP tool definitions |
| src/system-prompts.ts | Agent system prompt |

## Agent Lifecycle — Two-Phase Done

- `done()` = intended orphan (like yield). No tool_result written at call time.
  - **Phase 1** (agent-side): close queue, loop exits. doneSummary captured.
  - **Phase 2** (daemon-side, after session=null): update status (verify/failed), deliver task_complete to parent, write done_notified marker.
  - **session=null is the irreversibility boundary**: Before null, late messages → relaunch. After null, commit.
- `yield()` = loop-level pause. Provider intercepts before executeTool.
- `end_turn` = implicit yield, never implicit done.
- `stopTask()` = close queue + abort signal.
- JSONL resume detects: explicit yield, done orphan, implicit yield, interrupted (repaired).
- Crash recovery: done without done_notified → complete Phase 2 on restart.

## Task Status Model

`pending → in_progress → verify (done passed) / failed (done failed)`

- close_task: verify→closed (regular), verify→pending (persistent)
- "passed" status removed — only verify exists now
- Persistent tasks: `in_progress | verify | pending`. close_task deletes worktree, next wake gets fresh branch.

## Persistent Tasks

Definition in `.mxd/tasks/<id>.json` (git-tracked). tree.json stores runtime state only.

Four top-level domains:
- **Design Philosophy** 🟣 — ITA, anti-patterns, system prompt
- **Task System Design** 🟣 — task model, persistent model, tree structure, communication
- **Agent Loop** 🟠 — lifecycle, runtime, OpenAI provider
- **User Interaction** 🔵 — Web UI + CLI

## Cache TTL

- `SessionConfigEvent.cacheTtl?: "1h"` — stored in session_config, inherited via fork.
- Root + persistent = `"1h"`, regular children = `undefined` (5min default).
- ALL breakpoints use consistent TTL. Extended cache TTL (1h) is GA — no beta header needed.
- **PITFALL**: Never add per-request `anthropic-beta` headers — overrides client's `defaultHeaders`, breaks OAuth.
- `{type: "ephemeral"}` ≠ `{type: "ephemeral", ttl: "1h"}` — TTL is part of prefix identity.
- Prefix validation: system+tools strict JSON compare; message breakpoint position can move but value must match.

## OAuth

- Claude OAuth requires `You are Claude Code, Anthropic's official CLI for Claude.` as first system block (only in OAuth mode, not API key mode).
- OAuth beta header `oauth-2025-04-20` set on client `defaultHeaders`, not per-request.
- Health check in daemon.ts also includes this preamble for OAuth mode.

## Auth

Challenge-response with browser keypair (RSA-OAEP 2048). CLI auto-auth via `signCLIToken()`.

## Integration Test Framework

- `ValidatingMockAPI`: instruction-driven mock, sessionId-based conversation keying, prefix validation.
- `recreateApp()` simulates daemon restarts. `readSessionEvents` flushes before reading.

## Known Pitfalls

- **memory.md**: Never `write_file` to append. Use `edit_file` or `echo >>`.
- **Git worktrees**: `extensions.worktreeConfig` required. `core.hooksPath` absolute.
- **Biome**: Typecheck BEFORE lint. No `!important`. No duplicate CSS properties.
- **noUncheckedIndexedAccess**: Array index returns `T | undefined`.
- **Daemon reload**: Must manually restart after code changes.
- **Concurrent ULID**: Use full `ulid()` (26 chars) — sliced ULIDs collide.
- **Provider queue close**: Check `queue.isClosed` after tool execution, `return` immediately.
- **Never modify own JSONL from agent**: Current tool_call has no result → false orphan.
- **Async JSONL writes**: Flush before reading in tests.
- **delete_task cascades**: Returns 400 with children.
- **Abort signal leak**: catch/finally check `sessionWasReplaced`.

## Known Bugs (unfixed)

- Manual compaction during yield → consecutive user messages → API 400.
- Prefix violation after double restart (Restart N) — disabled in test.
- Flaky: `Fork from closed agent` — timing-dependent.
- ensureChildAgentRunning trusts worktreePath without checking dir exists (ghost worktree).
- Persistent task re-wake doesn't inform agent of new worktree path (done tool_result should carry cwd).

## Design Principles

1. **Context window is the scarcest resource for domain owners**: They don't execute because debug traces destroy global perspective.
2. **Whoever introduces a change owns ALL consequences**: prompt, UI, tests, docs. File ownership by change origin, not filename.
3. **Route by domain, not by file**: Domain owners manage, delegate everything.
4. **Creating tasks is cheap, executing is deliberate**: Draft first, execute when user says go.
5. **Delete until ONE remains**: Never add a third path. One tested path > two half-tested.
6. **ITA**: Intention → Test → Architecture. Tests are the single source of truth.

## Unresolved Design (prioritized)

1. Branch staleness on persistent wake (~5 lines, highest value)
2. Description ownership enforcement (reject non-root/user edits on persistent tasks)
3. Message routing expansion (subtree + parent chain, not just direct parent/child)
