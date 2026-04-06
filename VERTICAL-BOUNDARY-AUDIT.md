# Vertical Dependency Boundary Audit

## Three Execution Layers

```
┌─────────────────────────────────────────────────┐
│  DAEMON LAYER                                   │
│  agent-lifecycle.ts, context.ts, event-system.ts│
│  DaemonContext, runAgentForNode, deliverMessage  │
├─────────────────────────────────────────────────┤
│  PROVIDER LOOP LAYER                            │
│  provider-shared.ts (runProviderLoop)           │
│  messages[], adapter, queue, emit callback      │
├─────────────────────────────────────────────────┤
│  TOOL HANDLER LAYER                             │
│  tool-execution.ts, orchestrator-tools.ts,      │
│  tools/definitions.ts                           │
└─────────────────────────────────────────────────┘
```

---

## Boundary 1: Daemon → Provider Loop

### What daemon passes down (via AgentRequest)

| Field | Structural? | Notes |
|-------|------------|-------|
| `cwd` | ✅ Structural | Agent needs a working directory |
| `projectPath` | ✅ Structural | Root-only, for project-root awareness |
| `systemPrompt` | ✅ Structural | Required for API call |
| `refreshSystemPrompt` | ✅ Structural | Compaction needs fresh prompt |
| `signal` | ✅ Structural | Cancellation mechanism |
| `resumeSessionId` | ✅ Structural | Session identity for resume |
| `model` | ✅ Structural | API needs model name |
| `queue` | ✅ Structural | Message delivery channel |
| `mcpToolDefs` | ✅ Structural | Tool registry for execution |
| `hasRunningChildren` | ✅ Structural | Implicit yield decision |
| `budgetUsd` | ✅ Structural | Budget enforcement |
| `cacheTtl` | ✅ Structural | Cache optimization |
| `emit` | ✅ Structural | Event output channel |
| `activeEvents` | ✅ Structural | Resume state |
| `debugSnapshotPath` | ✅ Structural | Diagnostic (non-load-bearing) |
| `getSession` | ⚠️ **Accidental** | Leaks daemon's TaskSession lookup into provider loop |
| `setMessages` | ⚠️ **Accidental** | Reverse binding: loop pushes state UP to daemon's hidden tool |
| `setAllTools` | ⚠️ **Accidental** | Same as setMessages — reverse binding |

### Analysis

**AgentRequest is mostly clean.** 17 fields, 14 structural. The interface reads like a config+IO bundle: "here's what you need to run (model, prompt, tools) and how to communicate (queue, emit, signal)."

**Three accidental crossings:**

1. **`getSession`**: Provider loop uses this to store `messages` and `allTools` on `TaskSession` for the debug dump endpoint. The loop also reads `session.cwd` to sync cwd changes from bash. This means the provider loop knows about `TaskSession` — a daemon-layer concept. The loop should own its own state and let the daemon read it through a callback, not write into daemon state.

2. **`setMessages` / `setAllTools`**: These are callbacks the daemon layer passes down so the provider loop can bind live references back UP into the daemon layer. The flow is: daemon creates `createOrchestratorTools()` which captures mutable refs → daemon passes `setMessages`/`setAllTools` in AgentRequest → provider loop calls them to bind the refs → evaluate_script handler reads them. This is a hidden reverse dependency: the tool handler (evaluate_script) reaches through the daemon layer to read provider loop state, using the provider loop as an unwitting intermediary.

### Operator/Resource split impact

The structural fields split naturally:
- **Operator concerns**: systemPrompt, model, budgetUsd, cacheTtl, hasRunningChildren
- **Resource concerns**: cwd, queue, emit, signal, mcpToolDefs, activeEvents
- **Mixed**: getSession (resource for cwd sync + operator for debug dump)

The accidental crossings (`getSession`, `setMessages`, `setAllTools`) are ALL caused by evaluate_script's need to introspect runtime state. Removing evaluate_script eliminates all three accidental crossings at this boundary.

---

## Boundary 2: Provider Loop → Tool Handler

### What the loop exposes to tool handlers

Tool handlers receive their input through `executeTool()`:

```
executeTool(toolName, input, mcpHandlers, toolCallId)
```

| What flows down | How | Structural? |
|----------------|-----|-------------|
| Tool name | Direct param | ✅ Structural |
| Tool input (parsed JSON) | Direct param | ✅ Structural |
| Tool call ID | Direct param | ✅ Structural |
| Handler function | `mcpHandlers` Map lookup | ✅ Structural |

**This boundary is clean.** `executeTool` is a pure dispatcher. It takes a name, looks up a handler, validates input with Zod, calls the handler, and normalizes the result. The tool handler receives only `(args, {toolCallId})` — no provider loop state leaks through.

### What flows back up (ToolResult)

```typescript
interface ToolResult {
  content: string;       // Always string
  isError: boolean;
  cwd?: string;          // Bash tool updates cwd
  backgroundId?: string; // Bash background process
  backgroundCommand?: string;
  isImage?: boolean;     // read_file image result
  imageData?: string;
  mediaType?: string;
  mcpImages?: Array<...>; // External MCP images
  pending?: PendingState; // Running children info
}
```

| Field | Structural? | Notes |
|-------|------------|-------|
| `content` / `isError` | ✅ Structural | Core tool result |
| `cwd` | ✅ Structural | Bash legitimately changes working directory |
| `backgroundId` / `backgroundCommand` | ✅ Structural | Background process metadata for UI |
| `isImage` / `imageData` / `mediaType` | ✅ Structural | Image results for API |
| `mcpImages` | ✅ Structural | External MCP images |
| `pending` | ✅ Structural | Pending state for yield-like tools |

**This boundary is also clean.** ToolResult is a value type with no back-references. The only behavior-influencing field is `cwd`, which the loop uses to update its own state:

```typescript
// provider-shared.ts after executeTool
for (const exec of execResults) {
  if (exec.cwd) {
    cwd = exec.cwd;
    const currentSession = request.getSession?.(sessionId);
    if (currentSession) currentSession.cwd = exec.cwd;
  }
}
```

Note: the `request.getSession?.(sessionId)` here is the loop reaching through to daemon state to sync cwd. This is the `getSession` accidental crossing from Boundary 1 manifesting at the tool result handling point.

---

## Boundary 3: Tool Handler → Provider Loop (Upward Reach)

This is where the architecture gets interesting. Most tool handlers are pure functions. But three tools reach back into provider loop state:

### 3.1 `yield()` → Queue manipulation

```typescript
// orchestrator-tools.ts, yield handler
async () => {
  return {
    content: [{ type: "text", text: "" }],
    isError: false,
    _isYield: true,  // Signal to provider loop
  };
}
```

The yield handler doesn't directly touch the loop. Instead, it returns a `_isYield` flag. **But this flag is not part of the ToolResult type** — it's smuggled through the handler return value (CallToolResult has an index signature). The provider loop never sees this flag because `executeTool` strips it during normalization.

**Actually, yield is intercepted BEFORE executeTool.** The loop detects yield in the tool_use list and handles it at loop level:

```typescript
// provider-shared.ts
if (yieldToolUse && !hasOtherTools && !doneToolUse) {
  pendingYieldToolCall = { id: yieldToolUse.id, name: yieldToolUse.name };
  continue;  // Skip tool execution entirely
}
```

**Assessment: STRUCTURAL and CLEAN.** Yield is a loop-level control flow primitive. The loop MUST know about it. When yield is the only tool, the loop intercepts by name and `continue`s — `executeTool` never runs. When yield appears alongside other tools, the loop short-circuits it to a no-op success string before executeTool (also never runs). The handler's `_isYield` flag in the return value is **dead code** — no consumer reads it.

### 3.2 `done()` → Queue.close()

```typescript
// orchestrator-tools.ts, done handler
async (_args) => {
  // ... guard checks ...
  const queue = getQueue();
  if (queue) {
    queue.close();
  }
  return { content: [...], isError: false };
}
```

**This is the most significant boundary violation.** The done() handler reaches into provider loop state (the queue) through a closure and closes it. The queue closure causes `handleImplicitYield` to throw → loop detects closed queue → exits.

The flow: `tool handler → getQueue() closure → provider loop's queue → loop exit`

This is **accidental** in the current form. The done handler's job is to signal "I'm done." The mechanism (closing the queue) couples the handler to the loop's internal event mechanism. A cleaner boundary would be done() returning a signal (like yield's `_isYield`) that the loop intercepts.

**But there's a subtlety**: done() is intercepted by name at loop level (like yield):

```typescript
if (doneToolUse && !hasOtherTools) {
  const doneResult = execResults[doneIndex];
  if (doneResult && !doneResult.isError) {
    doneExitReason = ...;
    return buildResult(...);
  }
}
```

So done() IS executed by executeTool (unlike yield which is skipped), and its side effect (queue.close()) runs during execution. The loop then checks the result and exits if successful. The queue.close() is actually redundant with the loop-level exit — but it's needed to prevent any concurrent queue.wait() from blocking.

**Assessment: STRUCTURAL intent, ACCIDENTAL mechanism.** The intent (signal done) is structural. The mechanism (closure-captured queue.close()) is an accidental coupling that should be a return-value signal.

### 3.3 `evaluate_script` → Everything

```typescript
// orchestrator-tools.ts, evaluate_script handler
const evalContext = {
  messages: messagesRef,      // Provider loop's messages[]
  tracker,                     // Daemon's TaskTracker
  queue: getQueue(),           // Provider loop's queue
  deps,                        // OrchestratorToolsDeps
  projectId,
  taskId: currentTaskId,
  sessionId: currentTaskId,
  daemonCtx: deps.daemonCtx,  // Full DaemonContext
  allTools: allToolsRef,       // Provider loop's tools
};
```

**This is ALL-layer penetration.** evaluate_script gives the agent access to:
- Provider loop state: `messages`, `allTools`, `queue`
- Daemon state: `tracker`, `daemonCtx`, `deps`
- Cross-cutting: `projectId`, `sessionId`

**Assessment: INTENTIONALLY ACCIDENTAL.** evaluate_script exists precisely to break all boundaries for debugging. It's the "escape hatch." The boundaries are broken by design, and it's marked `hidden` so it doesn't appear in tool definitions. But it creates the reverse-binding complexity in Boundary 1 (`setMessages`/`setAllTools`).

---

## Boundary 4: Tool Handler → Daemon (Direct Reach)

### 4.1 Orchestrator tools capture daemon state via closures

`createOrchestratorTools()` receives `OrchestratorToolsDeps` which contains:

| Dep | What it provides | Used by |
|-----|-----------------|---------|
| `tracker` | TaskTracker (full tree CRUD) | get_tree, get_task, create_task, update_task, send_message, done, etc. |
| `emit` | Event emission | clarify, update_task notifications |
| `broadcastTree` | SSE broadcast | All tree-modifying ops |
| `clearEventStore` | JSONL deletion | close_task, delete_task, reset_task |
| `hasEventStore` | JSONL existence check | send_message (cold-start detection), fork_task_context |
| `copySessionFrom` | JSONL copy | fork_task_context |
| `stopTask` | Agent lifecycle control | reset_task |
| `awaitLoopExit` | Agent lifecycle sync | reset_task |
| `daemonCtx` | Full DaemonContext | evaluate_script only |
| `listProjects` / `getProject` / `getTracker` | Cross-project state | list_projects, send_message_to_project |

**AND** `LifecycleDeps`:

| Dep | What it provides | Used by |
|-----|-----------------|---------|
| `deliverMessage` | Message delivery + auto-launch | send_message (both directions) |
| `injectMessageToProject` | Cross-project messaging | send_message_to_project |

### Analysis

These are all **structural** for the tools that need them. The orchestrator tools ARE the interface between agent decisions and daemon state. The agent says "create a task" and the handler writes to the tracker, emits events, broadcasts.

However, the granularity is questionable:

1. **`tracker`** is passed as a full object, not as individual operations. Every tool handler can call any tracker method. The ToolDef audit (sibling task) likely identified that most tools need only specific tracker operations (e.g., `getTask`, `allNodes` for read; `addTask`, `updateStatus` for write).

2. **`deliverMessage`** is the critical boundary crossing. It's the daemon's auto-launch mechanism exposed to tool handlers. When send_message calls `deliverMessage`, it can trigger `ensureChildAgentRunning` → `runAgentForNode` → full agent lifecycle. A tool handler action cascades into daemon infrastructure.

3. **`stopTask` / `awaitLoopExit`** in reset_task means a tool handler can stop sibling agents. This is structurally necessary (an orchestrator needs to reset stuck children) but architecturally dangerous (a tool handler indirectly controls other agents' lifecycles).

### Operator/Resource split impact

The orchestrator tools deps split into:
- **Operator scope** (task tree operations): tracker, broadcastTree, deliverMessage, stopTask, awaitLoopExit, listProjects, getProject, getTracker, injectMessageToProject
- **Resource scope** (session/JSONL operations): clearEventStore, hasEventStore, copySessionFrom, emit
- **Escape hatch**: daemonCtx (evaluate_script only)

---

## Boundary 5: Cross-Cutting State

State shared across layers without clear single ownership:

### 5.1 `messages[]` (Provider loop state, leaked to daemon + tools)

| Layer | Access | How |
|-------|--------|-----|
| Provider loop | Owner: creates, mutates, passes to API | Direct |
| Daemon | Reads via `session.messages` | `setMessages` reverse binding |
| Tool handler | Reads via `evalContext.messages` | `setMessages` → `messagesRef` closure |

**messages[] should be provider-loop-private.** The daemon only needs it for debug dump (optional), and evaluate_script needs it for introspection (optional). Neither is a production-critical use case.

### 5.2 `allTools[]` (Provider loop state, leaked to daemon + tools)

Same pattern as messages[]: owned by provider loop, leaked via `setAllTools` for debug dump and evaluate_script.

### 5.3 `queue` (Daemon-created, provider-loop-consumed, tool-handler-mutated)

| Layer | Access | How |
|-------|--------|-----|
| Daemon | Creates (MessageQueue), manages lifecycle | `runAgentForNode` creates queue, attaches to TaskSession |
| Provider loop | Consumes (wait/drain), checks isClosed | `AgentRequest.queue` |
| Tool handler | done() closes it; tools read state via `getQueue()` closure | `getSession().queue` |

**Queue ownership is split.** Daemon creates and destroys it. Provider loop reads from it. Tool handler (done) mutates it. This three-way sharing is the root cause of the done() boundary violation.

### 5.4 `TaskSession` (Daemon-owned, provider-loop-mutates, tool-handler-reads)

```typescript
interface TaskSession {
  queue: MessageQueue;           // Daemon creates, loop consumes, done() closes
  abortController: AbortController; // Daemon creates, daemon aborts
  cwd: string;                   // Daemon initializes, loop mutates (via bash result)
  fallbackCwd: string;           // Daemon initializes, tool reads
  depth: number;                 // Daemon computes, tool reads
  backgroundProcesses: Map;      // Tool writes, daemon cleans up
  foregroundExecutions: Map;     // Tool writes, daemon resolves (stopTask)
  messages?: unknown[];          // Loop binds, daemon reads (debug)
  allTools?: unknown[];          // Loop binds, daemon reads (debug)
}
```

**TaskSession is the worst cross-cutting state.** Every layer touches it. The daemon creates it, the provider loop writes to it (messages, allTools, cwd), tool handlers write to it (backgroundProcesses, foregroundExecutions), and the daemon reads from it (debug dump, cleanup).

### 5.5 `cwd` (Bash tool → Provider loop → Daemon)

The bash tool returns a new `cwd` in ToolResult. Provider loop updates its local `cwd` variable AND writes to `session.cwd`. The daemon uses `session.cwd` for worktree cleanup and new agent launches.

This is structural — cwd must be shared. But the flow goes: tool handler → provider loop → daemon session (via getSession), making it a three-layer write chain.

---

## Summary: Boundary Crossing Map

### Clean Boundaries (✅)
- **Daemon → Loop via AgentRequest**: 14/17 fields are structural, well-defined config+IO
- **Loop → Handler via executeTool**: Pure dispatch, no state leaks
- **Handler → Loop via ToolResult**: Value type, no back-references

### Accidental Crossings (⚠️)

| Crossing | Direction | Cause | Blocks Op/Resource Split? |
|----------|-----------|-------|--------------------------|
| `getSession` on AgentRequest | Daemon→Loop | Loop writes cwd to session; debug dump reads messages | **Partially** — cwd sync is structural, debug dump is not |
| `setMessages` / `setAllTools` | Loop→Daemon (reverse) | evaluate_script needs runtime state | **No** — only evaluate_script uses this, which is hidden |
| `done()` closes queue | Handler→Loop | done() signal via side effect instead of return value | **Yes** — done() mechanism couples handler to loop internals |
| `evaluate_script` full context | Handler→All layers | Debug escape hatch | **No** — hidden tool, not part of normal flow |
| `TaskSession` three-way mutation | All layers | Daemon-owned but loop+handler write to it | **Yes** — TaskSession is a grab bag of cross-layer state |

### Structural Crossings That May Need Refactoring

| Crossing | Direction | Why structural | Improvement |
|----------|-----------|---------------|-------------|
| `deliverMessage` in tool handlers | Handler→Daemon | send_message triggers agent launch | Clean — handler expresses intent, daemon implements |
| `stopTask` in reset_task | Handler→Daemon | Orchestrator needs to stop children | Clean — wrapped in OrchestratorToolsDeps |
| Queue three-way ownership | All layers | Queue IS the inter-layer communication | Consider: daemon owns, loop borrows, handler signals through loop |

---

## Recommendations for Operator/Resource Split

### Priority 1: Split TaskSession

TaskSession conflates:
- **Session identity** (queue, abortController) → Daemon owns
- **Working state** (cwd, fallbackCwd, depth) → Provider loop owns
- **Runtime processes** (backgroundProcesses, foregroundExecutions) → Tool handlers own
- **Debug state** (messages, allTools) → Provider loop owns, daemon reads

Split into: `SessionControl` (daemon), `LoopState` (provider loop), `ProcessState` (tool handlers). Each layer owns its piece.

### Priority 2: Make done() a return-value signal

Instead of done() handler closing the queue, make it return a signal (like yield's loop-level detection). The provider loop already intercepts done by name — it can close the queue itself:

```typescript
// Current: handler closes queue (boundary violation)
// Proposed: handler returns signal, loop closes queue (clean boundary)
if (doneToolUse && !hasOtherTools) {
  // Loop already does this check — just add queue.close() here
  queue.close();
  return buildResult(...);
}
```

This eliminates the tool handler → provider loop crossing.

### Priority 3: Remove setMessages/setAllTools from AgentRequest

Replace the reverse binding with a callback-based read:

```typescript
// Instead of: loop.setMessages(msgs) → daemon.session.messages = msgs
// Use: daemon asks loop for state when needed
interface LoopStateProvider {
  getMessages(): unknown[];
  getTools(): JsonTool[];
}
```

This eliminates the provider loop → daemon reverse dependency.

### Priority 4: Formalize the OrchestratorToolsDeps interface for operator/resource

The current `OrchestratorToolsDeps` is already a dependency injection interface. Extend it to clearly separate:

```typescript
interface OperatorDeps {
  tracker: TaskTracker;      // Read + write tree
  deliverMessage: (...) => Promise<void>;
  stopTask: (...) => Promise<boolean>;
  // ... all tree/agent lifecycle operations
}

interface ResourceDeps {
  emit: (event: Event) => void;
  clearEventStore: (id: string) => void;
  hasEventStore: (id: string) => boolean;
  copySessionFrom: (...) => Promise<{eventCount: number}>;
}
```

Each tool declares which deps it needs. The runtime passes only the relevant subset.
