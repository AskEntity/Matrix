# Matrix Documentation Update Plan

> Prepared by branding task. To be sent to matrix-docs project for execution.

## Core Messaging Shift

**Old**: "One Developer, Team-Quality Code — powered by multi-agent AI."
**New**: "One Developer, Team-Quality Code — An IDE where every tab is a task, every task is a complete story."

Matrix is not a coding assistant. It's an IDE built for AI agents — where the file tree is a task tree, every tab holds a complete decision history, and your project's knowledge compounds instead of resetting.

---

## index.md (Landing Page)

### Hero
```
name: Matrix
text: "One Developer,\nTeam-Quality Code"
tagline: "An IDE where every tab is a task, every task is a complete story — from first idea to final merge."
```

### Intro paragraph (below hero, above features)

> Imagine an IDE where the file tree is a task tree. Open a tab — you see not code, but the full journey: the exploration, the dead ends, the design decisions, the user guidance, the final implementation. Close it — the knowledge stays, ready to be forked into the next challenge.
>
> This is Matrix. AI agents are the developers. You are the architect. Your input takes seconds; their execution takes minutes. One person, an entire team's throughput.

### The Bottleneck paragraph

> Other tools make you wait. You type a prompt, watch the agent work, review, type the next prompt. You are the bottleneck — every agent-second is gated by your attention.
>
> Matrix inverts this. Your one-sentence decision keeps an agent busy for 20 minutes. While it works, you're already talking to another agent, reviewing a third one's diff, drafting an idea for tomorrow. Five agents running, each on their own branch, each with full context. Your input is always the shorter side of the equation.
>
> You don't watch agents work. You make decisions across a tree of work — corrections, approvals, new directions — and the tree grows faster than you can prune it.

### Memory paragraph

> This only works because every task remembers everything. You don't re-explain context when you switch tabs. The agent you talked to yesterday still knows what you said. The agent you closed last week can be woken up with one message. Your project's institutional knowledge compounds — it never resets, never starts from scratch.

### Feature cards (update)

1. **Task Tree** — "Your project is a tree of tasks, not a pile of files. Each node holds a complete decision history — the why, not just the what."
2. **Tree-Parallel Execution** — "Say 'go.' Five agents start working simultaneously, each on its own git branch. Your input time < their execution time."
3. **Living Memory** — "Closed tasks aren't dead. Fork their context into new work. Every session builds on the last. Knowledge compounds, never resets."
4. **ITA Methodology** — "Intention → Test → Architecture. Tests are truth, not specs. Three mutations guard quality at every level."
5. **Your Decisions, Any Depth** — "Talk to any agent at any level of the tree. The entire parent chain is notified. No blind spots."
6. **Self-Bootstrapping** — "Matrix develops itself using itself. The ultimate dogfooding."

---

## why.md

### Keep
- ITA section (excellent, minimal changes needed)
- Self-bootstrapping section
- Persistent tasks case study (valuable lesson)
- "The Lever" opening
- Two Problems (hallucination + tunnel vision)

### Update

**Competitor section — rewrite with current landscape:**

Don't attack. Acknowledge good design. Then show the gap.

> **Claude Code Agent Teams** are impressive — multiple sessions coordinating with a team lead, shared task lists, direct messaging. But restart your terminal and every teammate is gone. No persistent identity, no memory across sessions (GitHub issue #33764: "teams and tasks do not persist"). CLAUDE.md carries a few notes forward; everything else starts from scratch. Users report losing 4 hours of context to compaction with no recovery path.
>
> **Cursor Parallel Agents** run up to 8 agents with git worktree isolation. But they all receive the same prompt — they don't coordinate, they don't communicate, they don't share discoveries. Merge conflicts become a bigger problem than the work itself.
>
> **Superset, Conductor, ParallelCode** orchestrate existing CLI agents — Claude Code, Codex, Gemini CLI — in parallel worktrees. Good isolation. But they're wrappers: no custom agent loop, no session persistence, no cross-agent memory, no recursive task tree.
>
> What none of them have:
> - **Tasks as the primitive** — not sessions, not files. Each task is a permanent record of decisions, implementation, and context.
> - **Recursive tree with communication** — agents spawn sub-agents, report progress, escalate problems. Not flat parallelism.
> - **Memory through git** — .mxd/memory.md merges through branches. Knowledge flows upward through the tree.
> - **Session persistence** — crash, restart, wake up exactly where you left off. 99.97% cache hit on restart.
> - **Fork** — transfer hundreds of thousands of tokens of exploration context to a new agent in seconds.

**Add "IDE" positioning:**

> They call Cursor "AI-native." It's a code editor with better autocomplete. VS2026 calls itself "AI-native" — it's Visual Studio with deeper Copilot integration.
>
> An AI-native IDE should be built for AI agents, not for humans who use AI. The unit of work should be a task, not a file. The navigation should be a task tree, not a file explorer. The history should be decision records, not git blame.
>
> Matrix is that IDE. We built our own agent loop from the provider API up — not a wrapper around Claude Code, not a framework integration. This is how you get session persistence, cache efficiency, two-phase lifecycle management, and recursive task orchestration. You can't get these by wrapping someone else's CLI.

### Key Insight: Information Flows at the Right Level

> When you talk to an agent deep in the tree — "use the hexagonal icon", "don't merge this yet", "write more tests" — the parent chain receives a one-line CC notification. Not the full conversation. Not the 500K context. Just your driving force.
>
> Root sees all of these, from every active agent. A stream of the most important decisions happening across the entire project — corrections, approvals, redirections — in real-time. Root doesn't need each agent's full context to understand what's happening. Your words ARE the summary. This is how one person manages a tree of parallel work without drowning in information.
>
> Compare this to CC Agent Teams: the team lead has its own context window. It doesn't see what you told a teammate directly. Or Cursor parallel agents: they don't communicate at all. Matrix's forwarding mechanism means the human's decisions are always visible at every level that matters.

### Key Insight: Every Keystroke Multiplied by N

> You type one sentence to one agent. That sentence automatically flows up the tree — every ancestor sees it. Root's inbox becomes a live stream of your decisions across the entire project: "use hexagonal icon", "don't merge yet", "write more tests", "cover all tools."
>
> Today's session: the user sent messages to 8 different agents. Root received all of them as CC notifications — without entering any child session. One inbox, an entire tree's decision flow.
>
> This is zero-config. No subscriptions, no webhooks, no chat groups. The tree structure IS the information router. Your every keystroke scales to N active agents — not because you typed it N times, but because the tree carries it upward automatically.
>
> This is why "human is not the bottleneck" isn't about removing the human. It's about **multiplying every human input by the width of the tree**. You say one thing; N agents are informed.

### Key Insight: Fork Transfers Cache, Not Just Knowledge

> Claude Code's fork regenerates tools and system prompt from scratch. Cache prefix breaks. You pay full creation cost again.
>
> Matrix's fork copies the frozen session_config — the exact same JsonTool[] definitions, the exact same system prompt. The API sees the same prefix bytes → cache hit. Three agents forked from the same parent share one 600K cache prefix. You pay for creation once; all three read from it.
>
> This isn't a nice-to-have. At 600K tokens, a cache miss costs ~$3. Five forks with CC-style cache breaks = $15. Matrix: $3 total. The difference compounds with every fork, every restart, every daemon cycle.

### CC Cache Reality (2026)

Include real data from CC's own community:
- --resume causes full cache miss (deferred_tools_delta injection changes between fresh/resumed sessions)
- Custom Bun fork's string replacement breaks cache prefix if conversation contains sentinel value
- Tool schema bytes change mid-session (fixed in v2.1.88, but shows the class of bug)
- Users burning 5-hour session limits in 90 minutes due to cache regression (2659 upvotes on Reddit)
- "Every --resume causes a full cache miss on the entire conversation history" — direct quote

Matrix doesn't have this class of bug because tools are frozen once at session start, never regenerated. Resume replays the same JSONL → same bytes → same cache.

### Key Insight: Nobody Else Has Solved This

Searched extensively. The landscape in 2026:
- CC's own cache has had THREE regressions since January 2026. Users filed bugs with 2,659 upvotes. --resume = full miss. fork = tools regenerated = prefix broken. Tool schema changes mid-session (fixed v2.1.88).
- OpenClaw community fork exists specifically to "fix insane token burn" — 70% cost reduction by restructuring system prompt. But still no frozen session_config.
- Academic paper "Don't Break the Cache" (arxiv) confirms strategic cache control > naive caching. Research stage, not product.
- Codex team says caching is "top priority" but each session rebuilds tools.
- Nobody has: frozen JsonTool persisted in JSONL, fork that inherits cache identity, breakpoint that works with 1 user message, 99.97% measured hit rate, multi-session prefix sharing.

This is a genuine technical moat. Not a feature checkbox — a fundamental architectural advantage that compounds with every session, every fork, every restart.

### Real Data Point (Today, 2026-04-03)

> 1.5 hours of active work. Three 700K context windows running simultaneously. Multiple child agents doing folder implementation, UI redesign (4 phases), mock showcase, login redesign, two critical bug fixes, system prompt improvements, competitive research.
>
> Claude Max plan usage: **22%**. Resets in 3 hours.
>
> CC users report burning their 5-hour limit in 90 minutes with ONE session due to cache regression. We ran THREE massive sessions plus a dozen children and used a fifth of the budget.
>
> This is what cache engineering looks like in production. Not benchmarks — real work, real output, real cost.

### Key Insight: The 1M Context Window Is a Trap Without Cache Engineering

> Anthropic gives you a 1M token context window. Generous! But at $3/M input tokens, a single 700K session costs $2.10 per API call without caching. Three sessions? $6.30 per call. An active agent makes a call every minute. Do the math.
>
> CC users discovered this the hard way in March 2026 — cache regression burned through 5-hour session limits in 90 minutes. 2,659 upvotes on Reddit. The 1M window is only affordable with near-perfect cache hit rates.
>
> Matrix runs three 700K sessions simultaneously — each a treasure of accumulated project knowledge — and pays for one. Frozen tools, frozen system prompt, byte-identical JSONL reconstruction, shared prefix across forks. Cache read: $0.30/M instead of $3/M. The same 700K call costs $0.21 instead of $2.10.
>
> The big context window isn't a feature. Cache engineering is the feature. Without it, the 1M window is a billing trap.

### Remove
- All persistent task feature descriptions (already deleted from code)
- References to `await_background` tool
- Any "three roles" mentions (only two roles now: root + task orchestrator)

---

## concepts.md

### Add
- Folder nodes: visual grouping, no lifecycle, transparent to ownership
- Two-phase done(): agent decides → daemon commits
- Verify status in lifecycle
- Discussion mode: user talks to agent, yield not done
- User message forwarding: CC to parent chain
- Updated tool table: add folder tools (create_folder, delete_folder, rename_folder), remove await_background

### Update
- Task lifecycle diagram: add verify, update transitions
- UI description: tab-based layout, sidebar collapse/resize, view mode switcher
- Remove persistent task references

---

## architecture.md

### Add
- Cache architecture section: frozen JsonTool in session_config, prefix order (tools→system→messages), breakpoint on last user message, TTL (1h root, 5min default)
- Two-phase done() implementation: Phase 1 (agent-side), Phase 2 (daemon-side), crash recovery
- Folder/TreeNode type: discriminated union, getTaskAbove/getTasksBelow
- traceId on events (if merged)
- EventStore generation guard (if merged)
- buildSessionRepair positional validation (if merged)

### Update
- Remove activeSessions Map (deleted)
- Remove startSession from ProviderAdapter (merged into runAgentForNode)
- Remove buildImplicitYieldMessage (merged into buildUserTurn)
- Update tool architecture: JsonTool as golden source, frozen in session_config
- Update agent lifecycle: single launch path (runAgentForNode for both root and child)
- Fix any remaining persistent task references

### Remove
- All persistent task implementation details
- await_background references

---

## getting-started.md

### Update
- UI description: tabs, sidebar collapse, view mode switcher (not "two areas")
- Slash commands: add any new ones, update descriptions
- Auth flow: keep RSA-OAEP for now (not changing)
- Task lifecycle: add verify status

---

### Key Insight: Drive Coding — Not Vibe, Not Oversee

> **Vibe coding**: throw a prompt at AI, hope for the best, accept whatever comes back. Fast but fragile. METR found experienced developers were 19% slower with AI tools while believing they were 20% faster — because they were waiting, not driving.
>
> **Oversee coding**: watch one agent work, review, give next instruction, watch again. You're the bottleneck. Every agent-second is gated by your attention.
>
> **Drive coding**: you are the driver. Five engines, one steering wheel. Every correction — "use this icon", "don't merge yet", "write more tests" — lands instantly at the right agent, the right level. You never lose control because your input IS the system's driving force. The agent's 500K context is just executing your 30-character decision.
>
> The feeling: you're conducting an orchestra, not recording one instrument at a time. Switch to the violins — "more vibrato." Back to percussion — "slower tempo." The brass section is already playing what you asked for 5 minutes ago. Everything moves in parallel, everything responds to your baton.
>
> This is what today looked like: 2 hours, 15 tasks completed, 3 massive context windows, a dozen child agents — and the human was never waiting. The human was always the one making the next decision while agents executed the last one.

### Key Insight: Self-Evolution Through Daily Use

> Matrix develops itself using itself. But more than that — the ideas for what to build next come FROM using it.
>
> Today alone, usage generated 15+ insights that became drafts, tasks, or prompt improvements:
> - "I can't create a task inside a folder" → discovered scope validation bug → audit task → 50 tests → 4 bugs fixed
> - "This agent done() too eagerly during discussion" → new prompt section: discussion mode
> - "I keep wanting to do it myself" → new prompt: "implement or delegate?" + "go means handle it"
> - "Login page looks cramped" → task → redesign → shipped
> - "Sessions share cache prefix!" → key insight for branding
>
> - `await_background` tool deleted entirely → yield() is the one path for all waiting. -360 lines. Intention mutation: agents don't wait for a specific process, they wait for "the next important thing."
>
> None of these were planned. Every one emerged from the friction of actual work. Draft tasks capture these moments — zero ceremony, one sentence, the idea is preserved. Some become tasks today, some next week, some never. But the insight is never lost.
>
> This is intention mutation made tangible. You don't discover what to build by writing specs. You discover it by building, and capturing what surprises you along the way.

### Before and After: The Persist Story

> 27 hours before today's session, Matrix had "persistent tasks" — 21 permanent agent nodes, each with its own session, designed to be long-lived domain experts. It was clean on paper.
>
> Reality: every node was an isolated session that didn't share context. Each wake-up missed cache (tools weren't frozen). Knowledge fragmented across 21 separate conversations. Root became a routing layer — pure overhead. "Corporate disease" — hierarchy without efficiency.
>
> We deleted it. -1,940 lines. Zero test failures. Every use case was already covered by regular tasks + fork + send_message.
>
> Today, the same project, the same person, the same token budget: flat tree + folders + temporary deep workers + fork context transfer + CC forwarding. 2 hours, 22% usage, 15 tasks, root fully aware of everything. The architecture was wrong, the tests told us, we deleted it, and the replacement is 10x better.
>
> This is ITA in action. Not "we planned it perfectly." We tried boldly, detected fast, reversed cheaply, and the test suite made it safe.

### Closing Statement Direction (Landing Page)

> Anthropic gave everyone a 1M token context window. Most people are afraid of it — compacting to 200K, anxious about cost, running one session at a time.
>
> We built three 700K rooms inside it. Each one holds a living agent with complete project memory — every design decision, every dead end, every user correction. They share the same hallway (cache prefix), so you pay for one and get three. The landlord (you) walks into any room at any moment, says one sentence, and the agent adjusts.
>
> 3 hours. 30% of a Max plan. Three 800K sessions on Opus 4-6. 1,400 API calls across 13 tasks. 503M total input tokens processed. 99.4% cache hit rate.
>
> Fifteen tasks completed — bugs fixed, UI redesigned, branding discussed, competitive research conducted, all in parallel. Multiple daemon restarts, zero cache loss. Every agent comes back in seconds with full memory. One developer driving everything.
>
> CC users report burning their 5-hour limit in 90 minutes with one session. We ran three massive sessions plus a dozen children for 3 hours and used less than a third of the quota.
>
> The 1M context window isn't a feature. It's a building. We're the first ones who actually moved in.

---

## Case Studies to Integrate

4 case studies written by root at `.mxd/case-studies/`. These should be referenced or excerpted in the docs:

### For why.md:
- **session-journey.md** — the full arc of today. Use as the central narrative in "Self-Bootstrapping" section. Key quotes: "I wrote that rule about myself" (root agent learning from mistakes), before/after behavior table, 503M tokens / 99.4% cache / 30% quota.
- **human-ai-collaboration.md** — "The Core Model: Keystroke × N" section is ready-made landing page content. "Information Asymmetry Is a Feature" table. "Discussion Mode: The Unexpected Productivity Multiplier." "The user sees the matrix" (cross-agent pattern recognition).
- **architecture-lessons.md** — "The Recurring Pattern: Two Codepaths Formatting Same Data" (3 instances found today, all the same fix). Use in the technical depth section. "Concurrent Agent Loops: The Silent Killer" — the real root cause story.

### For concepts.md:
- **task-scheduling.md** — "The Reality: User Is the Scheduler." What could be semi-auto vs must stay manual. Shows the actual human-AI division of labor.
- **human-ai-collaboration.md** — Anti-patterns section maps directly to the system prompt rules. Each anti-pattern has a today-example.

### For architecture.md:
- **architecture-lessons.md** — All 9 lessons are technical reference material. Cache prefix identity, concurrent loops, EventStore generation guard, compaction economics.

### Key quotes to surface on landing page:
- "One keystroke multiplied to N agents who each understand it in their own context."
- "The user sees patterns that no individual agent can."
- "Root's actual role: translate user intent → task system operations."
- "Input time < execution time. The bottleneck is never the user."
- "Matrix is a workspace where tasks are the primitive."

## Priority Order

1. **index.md** — first impression, most impact
2. **why.md** — core positioning, competitor comparison
3. **concepts.md** — user-facing feature descriptions
4. **architecture.md** — technical accuracy
5. **getting-started.md** — practical correctness
