/**
 * Compaction logic: checkpoint extraction, context rebuilding, and threshold management.
 * Used by the provider run loop to compress conversation context when it exceeds limits.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "./events.ts";

// ── Constants ──

/** Reserve ~17% as compaction buffer — compress when messages exceed this */
const COMPACT_BUFFER_RATIO = 0.17;

/** Summarization instruction injected as a user message for in-context compaction. */
export const SUMMARIZATION_INSTRUCTION = `[SYSTEM: Context compression required. Generate a checkpoint summary NOW.

Do NOT use any tools. Respond with ONLY the checkpoint in <summary>...</summary> tags.

Write the checkpoint with these sections IN ORDER. Every section is required.

## 1. Story So Far (MOST CRITICAL)
Chronological narrative of the session — not a list of facts, but the story of decisions and discoveries.

For each significant episode, capture:
- What was attempted and why it seemed right at the time
- What went wrong or what was discovered that changed the approach
- The reasoning that led to the final decision — not just "we decided X" but "we tried Y, discovered Z, and that's why X"
- User insights that course-corrected thinking — preserve their actual words/reasoning, not just their conclusion

This is the section the resuming agent will read most carefully. Facts can be re-derived from code and tests. Reasoning cannot — once lost, the agent will repeat the same wrong approaches and miss the same insights.

For resolved issues: keep the LESSON (what class of problem was this, how to recognize it), drop the step-by-step debugging log. The journey matters, not every step.

For in-progress issues: keep the full narrative including what's been tried and what's currently hypothesized.

## 2. Current Phase
What the agent is doing RIGHT NOW: planning / implementing / testing / debugging / reviewing / orchestrating / done
If debugging: include the exact error message, current hypothesis, and what has been tried.
If orchestrating: which sub tasks are running, which are blocked, what's being waited on.

## 3. Completed Work
What has been built, tested, committed, and merged — with key decisions and their reasoning.
Include specific file paths and function names.
For each significant decision: state the choice AND the rejected alternative with reasoning.
Focus on outcomes, not blow-by-blow implementation steps.

## 4. Tree Mental Model
The tree is on disk — don't snapshot it. Capture what the agent KNOWS about the tree that can't be re-derived from get_tree:
- Which sub tasks am I waiting on, and what do I expect from each?
- Which tasks have issues I need to address, and what's my plan for each?
- What ongoing conversations or negotiations am I having with which tasks?
- What am I planning to do next with the tree — what to create, start, merge, restructure?
- Any coordination concerns: tasks that depend on each other, potential merge conflicts, sequencing decisions.

## 5. Rejected Approaches & Lessons
Two categories:

**Technical lessons** — debugging insights that prevent repeating mistakes.
**Architectural/philosophical lessons** — design principles discovered through experience.

For each: state the principle, what triggered the discovery, and what was wrong about the initial assumption.

If nothing was learned, write "None so far."

## 6. Key Context
Important state and knowledge that is HARD to reconstruct from disk:
- Constraints or invariants that affect remaining work
- Environment or configuration state
- Communication state: pending clarifications, recent messages to/from tasks above or below
- User preferences or style observations discovered during the session

## 7. Pending Work
Numbered list of ALL remaining tasks/steps to complete the goal.
Be specific: "implement X in file Y", "add test for Z", "merge child branch A".
For each item, note any dependencies on other items.

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
	const compressThreshold = Math.floor(
		contextWindow * (1 - COMPACT_BUFFER_RATIO),
	);
	return {
		compressThreshold,
		lazyCountThreshold: compressThreshold - 16_000,
	};
}

/**
 * Process compaction response: extract checkpoint, rebuild context, record events.
 * Returns the new user content and usage info, or null on failure.
 */
export async function* processCompaction(
	responseText: string,
	cwd: string | undefined,
	preCompactTokenCount: number,
	emit: ((event: Event) => void) | undefined,
	contextWindow: number,
): AsyncGenerator<
	Event,
	{
		userContent: string;
		estimatedInputTokens: number;
	} | null
> {
	const checkpoint = extractCheckpoint(responseText, cwd);

	try {
		const compactedContent = await buildCompactedContext(checkpoint, cwd);
		const userContent = cwd
			? `Working directory: ${cwd}\n\n${compactedContent}`
			: compactedContent;
		const postCompactChars = userContent.length;
		const estimatedPostCompactTokens = Math.floor(postCompactChars / 4);
		const compactSavedTokens = Math.max(
			0,
			preCompactTokenCount - estimatedPostCompactTokens,
		);

		// Emit compact_marker + compacted_resume events
		if (emit) {
			emit({
				type: "compact_marker",
				checkpoint,
				savedTokens: compactSavedTokens,
				taskId: "",
				ts: Date.now(),
			});
			emit({
				type: "compacted_resume",
				content: userContent,
				cwd,
				taskId: "",
				ts: Date.now(),
			});
		}

		const usageEvt: Event = {
			type: "usage",
			inputTokens: estimatedPostCompactTokens,
			contextWindow,
			estimated: true,
			taskId: "",
			ts: Date.now(),
		};
		emit?.(usageEvt);
		yield usageEvt;
		// compact_marker already emitted above — yield for consumer loop
		yield {
			type: "compact_marker",
			checkpoint,
			savedTokens: compactSavedTokens,
			taskId: "",
			ts: Date.now(),
		};

		return { userContent, estimatedInputTokens: estimatedPostCompactTokens };
	} catch (e) {
		const errEvt: Event = {
			type: "error",
			taskId: "",
			message: `Compaction rebuild failed: ${e instanceof Error ? e.message : String(e)}`,
			ts: Date.now(),
		};
		emit?.(errEvt);
		yield errEvt;
		return null;
	}
}
