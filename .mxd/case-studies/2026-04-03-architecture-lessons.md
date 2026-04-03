# Architecture Lessons: What Broke, Why, and What We Learned

> Technical patterns from 2026-04-03. Each lesson was earned by a production bug or a failed approach.

## 1. The Recurring Pattern: Two Codepaths Formatting Same Data

**Count this session: 3 instances**

Every time live-path and JSONL-reconstruction-path exist for the same data, they WILL diverge.

| Instance | Live path | JSONL path | Symptom |
|----------|-----------|------------|---------|
| Multiline split (earlier) | `\n` → N text blocks | Single text block | Cache miss on restart |
| Queue message merge | `formatQueueMessagesWithHeaders` joined | Separate blocks | Cache miss on restart |
| Image stripping | "Took a screenshot..." text | Full 730KB base64 | Cache miss on restart |

**The fix pattern**: Delete one codepath. Make both use THE SAME FUNCTION. `formatQueueMessage` → `formatEventForAI`. Byte-identical by construction.

**Architectural rule**: If you see two functions that "do similar things," don't add a shared helper. Delete one. "Delete until ONE remains."

## 2. JSON.stringify(node) Is a Time Bomb

`JSON.stringify(node, null, 2)` on a TaskNode includes `node.session` — which contains the entire `messages[]` array (2.65MB for a forked session). This gets written to JSONL as a tool_result.

Impact: 721K session → 1.75M → API rejection. Agent permanently bricked.

**Fix**: `stripSession(node)` — one function, all MCP tools use it.

**Rule**: Never serialize a runtime object directly. Always strip non-persistable fields. Think about what `JSON.stringify` will include, not just what you want it to include.

## 3. Cache Prefix Identity Is Fragile

Cache works when every byte is identical between requests. Any difference → full miss → $9 for 600K session.

What we learned about Anthropic cache:
- **Prefix order**: tools → system → messages (not system → tools)
- **Breakpoint position matters**: second-to-last user message is wrong when there's only 1 user message. Last message is always correct.
- **TTL**: 5min default, 1h costs 2x write but survives long operations. 1h is almost always cheaper than keepalive heartbeats.
- **Fork sharing**: forked sessions share the parent's cache prefix. Three 700K sessions = one cache entry. This is the cost moat.
- **Frozen tools**: session_config freezes tool definitions. Resume uses frozen tools → byte-identical → cache hit.

## 4. Concurrent Agent Loops: The Silent Killer

autoResumeProjects Phase 2 crash recovery calls `deliverMessage(task_complete)`. Without `quiet: true`, this eager-launches the parent. But autoResumeProjects is about to launch the parent too → two loops on same JSONL → interleaved events → out-of-order tool_results → permanent API 400.

**Detection infrastructure built**:
- `traceId` (ULID) on every event — detect interleaved loops
- `delay_ms` on mock turns — simulate streaming interrupts
- Reproducer test with traceId assertions

**Fix**: `quiet: true` on Phase 2 deliverMessage. Message goes to JSONL, recovered by findUnconsumedMessages when autoResume launches.

**Rule**: Any `deliverMessage` during startup MUST be `quiet: true`. Eager auto-launch during recovery = guaranteed duplicate.

## 5. Reset vs Send_Message: Destructive vs Preserving

| Operation | Effect | Use when |
|-----------|--------|----------|
| `send_message` to failed/closed task | Wakes it with full context | Task needs to continue/fix something |
| `reset_task` | Destroys JSONL, worktree, session. Cold start. | Approach was fundamentally wrong |

I used reset when send_message was sufficient → lost an agent's entire design context (login page with user's specific guidance). The $50 of exploration and user discussion: gone.

**Rule**: Default to send_message. Reset only when you're starting over.

## 6. buildSessionRepair: Defense-in-Depth, Not Primary Fix

buildSessionRepair's truncate mechanism has NEVER successfully auto-recovered a session in production. Every real corruption was manual JSONL editing.

But positional validation (tool_result must be before next assistant turn) IS valuable as defense-in-depth. It won't fix the root cause, but it prevents the cascading failure.

**Rule**: Repair mechanisms are insurance, not the fix. Find and fix the root cause (concurrent loops, race conditions) instead of trusting repair to catch everything.

## 7. Compaction Economics

| Setting | Trigger | Working space | Checkpoint |
|---------|---------|--------------|------------|
| Old (17% buffer) | 830K | 830K | ~20K |
| New (8% buffer, 1M only) | 920K | 920K | up to 64K |

90K more working space = ~45 extra conversation turns. Model supports 128K output, so 64K checkpoint is generous.

**Rule**: Compaction destroys nuance. Delay it as long as safely possible. The math: 920K + 64K + 16K = 1000K ≤ 1M.

## 8. Folder Transparency: Type Refactors Cascade

Adding `FolderNode` to `TreeNode = TaskNode | FolderNode` created 262 type errors. Good — each error was a location that needed to decide: tree structure (use parentId) or task ownership (use getTaskAbove)?

But fixing the type errors wasn't enough:
- `getTask()` returns undefined for folders → 4 runtime bugs found by audit
- `isDescendantOf` and `getDescendantIds` used `getTask()` → scope validation broken
- REST endpoints used `getTask()` for parent lookup → 3 bugs
- Parent chain notification used `getTask()` → notifications stopped at folders

**Rule**: After a type refactor, immediately audit ALL callers of the changed type. Write tests for the new discriminant. Don't trust "type errors fixed = done."

## 9. EventStore Generation Guard

Reset + clear + async agent cleanup = JSONL reappears (agent writes after clear).

Three-layer defense:
1. `stopTask` awaits agent loop promise (agent fully stops before clear)
2. EventStore generation guard (stale writes become no-op)
3. `awaitLoopExit` for launchingNodes gap

**Rule**: "Don't write" is safer than "repair after bad write." Generation guard is pure discard — it never mutates data, never retries, never creates new corruption.
