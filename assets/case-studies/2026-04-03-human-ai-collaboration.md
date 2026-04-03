# Human-AI Collaboration: What Actually Works

> Observations from 12 hours of one human driving 13 agents in parallel. Not theory — observed patterns.

## The Core Model: Keystroke × N

The user types one sentence. It reaches:
- The target agent (direct execution)
- The parent chain via `user_message_forwarded` (awareness)
- Root orchestrator (global awareness)

One keystroke multiplied to N agents who each understand it in their own context. The user never explains the same thing twice — the message flows through the tree automatically.

**Example from today**: User told the keepalive task "just let the user configure it. Three-layer settings — project, global, and so on." One sentence. The task understood: replace hardcoded TTL with configurable settings. I (root) saw the forwarded message and understood the direction change. No coordination meeting needed.

## Information Asymmetry Is a Feature

| Actor | Sees | Doesn't see |
|-------|------|-------------|
| User | All agent activity logs, all forwarded messages | Agent's internal reasoning |
| Root | All forwarded messages, task_complete summaries | Agent's internal reasoning, user's direct words to children |
| Child agent | Its own session + parent messages | Sibling activity, user-to-sibling messages |

This asymmetry is correct:
- **User sees everything** → can inject corrections at any level
- **Root sees forwarded summaries** → understands direction without drowning in detail
- **Child sees only what it needs** → focused context, no noise

The forwarded messages ARE the compression layer. User's words are the highest-signal content in any conversation. Root receiving all forwards = receiving a curated feed of every important decision.

## Discussion Mode: The Unexpected Productivity Multiplier

The user doesn't always give commands. Often they think out loud:
- "speaking of which..."
- "I think..."
- "what do you think?"
- "wait"
- "I have an idea"

These signals mean: **don't act yet, engage in dialogue.** The agent that recognizes this and yields (instead of done()) gets richer context and better instructions.

Today's branding task spent 2+ hours in discussion mode. It never "completed a task" in the traditional sense — but it accumulated the richest understanding of Matrix's positioning from direct conversation with the user. That accumulated context is now worth more than any task output.

## Fork: Knowledge Transfer, Not Copy

Fork isn't "give the child my conversation." It's "give the child my understanding."

The forked agent doesn't rehash — it starts from knowledge. When the JSONL investigation task was forked from root, it immediately knew:
- The duplicate yield fix history
- Cache architecture decisions
- JSONL repair mechanisms
- Why buildSessionRepair existed

It could start investigating at depth 5 instead of depth 0. This saved hours of exploration.

But fork has a dark side: the child inherits the parent's MISTAKES too. Stale assumptions, wrong mental models, biases. The forked keepalive task inherited my belief that "keepalive heartbeat is the right approach" — it took user intervention to pivot to "just make TTL configurable."

## The User's Superpower: Pattern Recognition Across Agents

The user sees patterns that no individual agent can:
- "this is the same iceberg pattern as the persistent tasks debacle" — folder bugs look like persistent bugs (same iceberg pattern)
- "do you think these two need any follow-up discussion?" — connecting two tasks that don't know about each other
- "reparent it under him" — organizational surgery based on domain overlap

This cross-agent pattern recognition is irreplaceable. An agent sees its own context. The user sees the matrix.

## Anti-Patterns in Collaboration

### 1. Agent Assumes "Go" Means "You Do It"
"Go" means "handle it." I repeatedly jumped to implementation instead of assessment. The fix: "Go back to Planning Your Approach."

### 2. Agent Done()'s During Discussion
Every done() costs a restart cycle. During discussion, the agent should yield — maintaining the conversation state while waiting for the next input.

### 3. Agent Hides Struggle
"ASK — NEVER SILENTLY FALL BACK." But I still default to conservative choices when uncertain. The task above can't see my internal deliberation — only my tool calls and outputs.

### 4. Root Tries to Be Helpful by Doing Work
Root's value is: translate user intent → task operations. Not: read code, write fixes, debug tests. Every time I wrote code on main, I created risk without worktree isolation.

## The Vision This Session Crystallized

Matrix is not a chat app with agents. It's not an "AI-native IDE" (which just means VSCode + Copilot).

Matrix is a **workspace where tasks are the primitive**. Each task is:
- A complete decision + implementation history
- A reusable knowledge base (closed but reactivatable)
- An isolated execution environment (worktree + branch)
- A communication node (receives messages, sends to parent)

The human navigates this workspace through:
- **Task tree** (organizational structure)
- **Tabs** (open conversations)
- **Forwarded messages** (information flow)
- **Favorites** (quick access to domain experts)

The AI works inside this workspace through:
- **Yield** (wait for anything important)
- **Send_message** (communicate with tree)
- **Done** (signal completion)
- **Fork** (transfer knowledge)

The human is never the bottleneck. The human is the multiplier.
