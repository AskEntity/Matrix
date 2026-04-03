# Task Scheduling: How Decisions Actually Flow

> Case study from the 2026-04-03 session. Captures how the user drove task scheduling — what worked, what didn't, what could be automated.

## The Reality: User Is the Scheduler

The system prompt says root orchestrator manages work. In practice, the user made every scheduling decision today:

- "do it" → I create task + start it
- "fork" → I fork context into a task
- "let him do it" / "create a child" → I delegate to sub-tasks
- "don't merge yet" → I hold a verified task
- "reset it" → I reset a task (sometimes wrongly)

Root orchestrator's actual role was: **translate user intent into task system operations**. Not "decide what to do next" but "execute the decision the user already made."

## What the User Did That I Couldn't

### 1. Scope Judgment
User consistently caught me underestimating scope:
- "it's just 4 lines" → turned into 50-test audit task
- "just fix it real quick" → needed 7-file change across message format, factory, converter, frontend, mock, tests
- "should you really pass? you haven't even finished" → I declared done prematurely

The user's scope intuition comes from understanding the **full dependency graph** — something I can't see from inside one task's context.

### 2. Cross-Task Awareness
User directed information flow between tasks:
- "tell him about the concerns I've been raising" → transfer my context to a child
- "just ask him directly" → reuse a closed task instead of creating new
- "reparent it under him, let them discuss" → organizational surgery I'd never initiate
- "you three just talk to each other directly via send_message" → three agents collaborating

### 3. Quality Gate
- "don't merge" → held reset_task fix for days because of instability gut feeling (correct!)
- "debugging these tests makes me doubt the stability of this feature" → deferred merge based on debugging smell
- "try to break your own system" → adversarial testing mandate
- "if we can't reproduce it, our assumptions and fixes are just talk" → TDD enforcement

### 4. Discussion Mode Recognition
User naturally switches between:
- **Command**: "do it" / "start" / "go" → immediate action
- **Discussion**: "what do you think" / "I think..." / "speaking of which..." → yield and talk
- **Correction**: "no" / "listen to me" / "that's wrong" → stop and reassess
- **Exploration**: "search the web" / "take a look for me" → research

I learned (slowly) to not done() during discussion. The prompt now captures this as "discussion mode."

## What Could Be Better

### Currently Manual → Could Be Semi-Auto
1. **Fork decision**: User says "fork" because they know the child needs context. Could auto-suggest: "This task touches files you've read — fork recommended?"
2. **Merge timing**: I merge when task_complete arrives. Could auto-merge if: tests pass + diff is clean + no user hold.
3. **Scope warning**: When I estimate "just a few lines," could check: how many files reference this? How many tests touch it?

### Should Stay Manual
1. **What to work on next** — user's priorities are context-dependent
2. **When to hold a merge** — gut feeling about stability can't be automated
3. **Reparenting for collaboration** — organizational decisions require strategic thinking
4. **Design direction** — "VSCode-style tabs" vs "chat interface" is a human judgment

## Key Pattern: Input Time < Execution Time

The user's scheduling works because:
- User types one sentence (~5 seconds)
- Agent executes for 5-20 minutes
- During execution, user talks to other agents

The bottleneck is never the user. The bottleneck is: does the agent understand the intent correctly? Better task descriptions and discussion mode reduce misunderstanding.

## Anti-Patterns Observed

1. **Root doing work**: I repeatedly tried to "just fix this quickly" on main — no worktree, no rollback, scope always larger than expected.
2. **Premature done()**: Calling done() after each user message instead of maintaining discussion.
3. **Reset instead of send_message**: Destroyed a task's context (login page) when send_message would have preserved it.
4. **Reparenting to bypass done() guard**: Moved a running child out of a parent's tree so parent could done(). Should have waited.
5. **Using evaluate_script for everything**: Reparent, batch operations, tree manipulation — should use proper MCP tools.
