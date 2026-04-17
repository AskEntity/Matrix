/**
 * Compaction logic: checkpoint extraction, context rebuilding, and threshold management.
 * Used by the provider run loop to compress conversation context when it exceeds limits.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventSpec } from "./events.ts";

// ── Constants ──

/**
 * Compaction buffer ratios by context window size.
 * Smaller windows need more buffer (17%) because checkpoint + rebuilt context is a larger fraction.
 * 1M+ windows can use a smaller buffer (10%) — 900K trigger leaves room for 64K checkpoint + 16K rebuilt context.
 */
const COMPACT_BUFFER_RATIO_SMALL = 0.17;
const COMPACT_BUFFER_RATIO_LARGE = 0.1;
const LARGE_CONTEXT_THRESHOLD = 1_000_000;

/** Max output tokens for compaction checkpoint generation (64K). */
export const COMPACTION_MAX_TOKENS = 64_000;

/** Summarization instruction injected as a user message for in-context compaction. */
export const SUMMARIZATION_INSTRUCTION = `[SYSTEM: Context compression required. Generate a summary NOW.

Do NOT use any tools. Respond with ONLY the summary in <summary>...</summary> tags.

The raw event log preserves what happened; this summary preserves what you understood. Facts can be re-read from disk or tool results. The reasoning behind decisions, the user's direction, the moments that shifted course — those live only in what you write here.

Write the summary with these sections IN ORDER. Every section is required.

## 1. Story So Far (MOST CRITICAL)
Chronological narrative of the ENTIRE history — not a list of facts, but the story of decisions and discoveries. If there is a previous summary, integrate it with everything that happened since into one cohesive narrative. Each compaction deepens the story, not restarts it.

Start with the user's overarching intent — not individual requests, but the trajectory. What are they trying to build or achieve? What direction are they pushing? This through-line lets the resuming agent make decisions aligned with where the user is heading, not just what they last said.

Then, for each significant episode, capture:
- What was attempted and why it seemed right at the time
- What went wrong or what was discovered that changed the approach
- The reasoning that led to the final decision — not just "we decided X" but "we tried Y, discovered Z, and that's why X"
- User insights that course-corrected thinking — integrate them here with brief attribution; longer verbatim quotes belong in Section 8

This is the section the resuming agent will read most carefully. Facts can be re-derived from code, tests, and the raw event log. Reasoning cannot — once lost, the agent will repeat the same wrong approaches and miss the same insights.

For resolved issues: keep the LESSON (what class of problem was this, how to recognize it), drop the step-by-step debugging log. The journey matters, not every step.

For in-progress issues: keep the full narrative including what's been tried and what's currently hypothesized.

## 2. Current Phase
What the agent is doing RIGHT NOW: planning / implementing / testing / debugging / reviewing / orchestrating / done.
If debugging: include the exact error message, current hypothesis, and what has been tried.

(Sub-task status belongs in Section 4 — Tree Mental Model.)

## 3. Completed Work
What has been built, tested, committed, and merged.
Include specific file paths and function names.
Focus on outcomes, not blow-by-blow implementation steps.

Decisions and their reasoning belong in Section 1's narrative. This section is the concrete record of what was produced.

## 4. Tree Mental Model
The tree is on disk — don't snapshot it. Capture what the agent KNOWS about the tree that can't be re-derived from get_tree:
- Which sub tasks am I waiting on, and what do I expect from each?
- Which tasks have issues I need to address, and what's my plan for each?
- What ongoing conversations or negotiations am I having with which tasks?
- What am I planning to do next with the tree — what to create, start, merge, restructure?
- Any coordination concerns: tasks that depend on each other, potential merge conflicts, sequencing decisions.
- Communication state: pending clarifications, recent messages to/from tasks above or below.

## 5. Rejected Approaches & Lessons
Two categories:

**Technical lessons** — debugging insights that prevent repeating mistakes.
**Architectural/philosophical lessons** — design principles discovered through experience.

For each: state the principle, what triggered the discovery, and what was wrong about the initial assumption.

Decisions made within a single episode (and the alternatives rejected in that moment) belong in Section 1's narrative. This section is for the meta-level, reusable insights — patterns that transcend the immediate episode.

If nothing was learned, write "None so far."

## 6. Key Context
Important state and knowledge that is HARD to reconstruct from disk:
- Constraints or invariants that affect remaining work
- Environment or configuration state
- User preferences or style observations discovered during the session

## 7. Pending Work
Numbered list of ALL remaining tasks/steps to complete the goal.
Be specific: "implement X in file Y", "add test for Z", "merge child branch A".
For each item, note any dependencies on other items.

## 8. User Messages (Reference)
Verbatim or close paraphrase of user messages whose exact wording shaped decisions — in chronological order. On re-compaction, carry forward important quotes from the previous summary and append new ones. Section 1 captures the meaning and narrative; this section preserves the raw wording.

The raw event log preserves a complete transcript. This section is for the messages worth having immediately at hand on resume, without needing to re-read the log.

Rules:
- Be precise: file paths, function names, exact error messages, task IDs
- Do NOT repeat system prompt or task description content — the agent already has those
- Do NOT include file contents that can be re-read from disk
- Reasoning > facts. The agent can re-read files; it cannot re-derive WHY a decision was made.
- Preserve user voice: when a user's insight shaped a decision, include their words (or close paraphrase) with attribution, not just the conclusion
- On re-compaction, strengthen the narrative — condense details but preserve the arc. The journey becomes MORE important over time, not less. Recurring patterns are the highest-value content: once is an incident, twice is a pattern, three times is architecture. If a problem class appeared before and appears again, that recurrence IS the insight — highlight it explicitly.
- Length: use as many tokens as needed for complex sessions. Never truncate mid-thought.
- Each section must earn its space: if a section would be empty or trivial, write one line and move on. Spend tokens on narrative and reasoning, not formatting.]`;

/** Build the full summarization instruction with the current working directory appended. */
export function buildSummarizationInstruction(cwd?: string): string {
	if (!cwd) return SUMMARIZATION_INSTRUCTION;
	return `${SUMMARIZATION_INSTRUCTION}\n\nCurrent working directory: ${cwd}`;
}

/**
 * Extract checkpoint text from an assistant response that should contain <summary>...</summary> tags.
 * If no tags found, uses the full response text as the checkpoint.
 * When `cwd` is provided, appends a system-generated context block with the working directory
 * and resume instructions (these are injected by the system, not written by the AI).
 * @internal Exported for testing
 */
export function extractCheckpoint(responseText: string, cwd?: string): string {
	const match = responseText.match(/<summary>([\s\S]*?)<\/summary>/);
	let checkpoint: string;
	if (match && match[1] !== undefined) {
		checkpoint = match[1].trim();
	} else {
		// No summary tags found — use full response text as checkpoint
		checkpoint = responseText.trim();
	}

	if (cwd) {
		checkpoint += `\n\n---\n\n## System Context (auto-generated)\nWorking directory: ${cwd}\n\nResume from this checkpoint. Your task is NOT done unless the checkpoint says "Current Phase: done". Continue working — check get_tree, follow the stimulus priority, and drive to completion.\nDo not cd to your current working directory — you are already there.`;
	}

	return checkpoint;
}

/**
 * Build the compacted context message after checkpoint generation.
 * Combines fresh memory and checkpoint into a single user message.
 * @internal Exported for testing
 */
export async function buildCompactedContext(
	checkpoint: string,
	cwd?: string,
): Promise<string> {
	// Re-read fresh memory from disk (agent may have updated it during session)
	let freshMemory = "";
	if (cwd) {
		try {
			const memPath = join(cwd, ".mxd", "memory.md");
			freshMemory = await readFile(memPath, "utf-8");
		} catch {
			// No memory file — that's fine
		}
	}

	const parts: string[] = [];
	if (freshMemory) {
		parts.push(
			`# .mxd/memory.md (Preloaded, do not read again)\n${freshMemory}`,
		);
	}
	parts.push(`## Checkpoint Summary\n\n${checkpoint}`);

	return parts.join("\n\n---\n\n");
}

/**
 * Get compaction thresholds derived from the context window.
 * @internal Exported for testing
 */
export function getCompactionThresholds(contextWindow: number): {
	compressThreshold: number;
	lazyCountThreshold: number;
} {
	const ratio =
		contextWindow >= LARGE_CONTEXT_THRESHOLD
			? COMPACT_BUFFER_RATIO_LARGE
			: COMPACT_BUFFER_RATIO_SMALL;
	const compressThreshold = Math.floor(contextWindow * (1 - ratio));
	return {
		compressThreshold,
		lazyCountThreshold: compressThreshold - 16_000,
	};
}

/**
 * Process compaction response: extract checkpoint, emit empty compact_marker,
 * return the checkpoint text for the caller to enqueue as a compacted_resume message.
 *
 * The caller (provider-shared.ts) is responsible for:
 * 1. Emitting refreshed session_config after compact_marker
 * 2. Enqueuing compacted_resume message (which triggers work_context hook)
 * 3. Rebuilding messages[]
 */
export async function* processCompaction(
	responseText: string,
	cwd: string | undefined,
	preCompactTokenCount: number,
	emit: ((spec: EventSpec) => void) | undefined,
	_contextWindow: number,
): AsyncGenerator<
	EventSpec,
	{
		checkpoint: string;
	} | null
> {
	const checkpoint = extractCheckpoint(responseText, cwd);

	try {
		const postCompactChars = checkpoint.length;
		const estimatedPostCompactTokens = Math.floor(postCompactChars / 4);
		const compactSavedTokens = Math.max(
			0,
			preCompactTokenCount - estimatedPostCompactTokens,
		);

		// Emit empty compact_marker (boundary only — content moves to compacted_resume message)
		const markerEvt: EventSpec = {
			type: "compact_marker",
			savedTokens: compactSavedTokens,
			ts: Date.now(),
		};
		emit?.(markerEvt);
		yield markerEvt;

		return { checkpoint };
	} catch (e) {
		const errEvt: EventSpec = {
			type: "error",
			message: `Compaction rebuild failed: ${e instanceof Error ? e.message : String(e)}`,
			ts: Date.now(),
		};
		emit?.(errEvt);
		yield errEvt;
		return null;
	}
}
