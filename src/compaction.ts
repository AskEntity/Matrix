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

## 1. User Requests (MOST CRITICAL)
Chronological timeline of every user message or parent instruction received, with the tasks created/completed in response to each. For each entry:
- The message (verbatim or close paraphrase)
- Tasks created in response (IDs, titles)
- Tasks completed/merged in response (what was accomplished)
- Decisions made or deferred
This creates a complete narrative thread. The resuming agent has NO access to previous messages — this is the only record.
For resolved requests, state the outcome concisely. Do not carry forward debugging narratives or step-by-step problem-solving details from issues that are fully resolved.

## 2. Current Phase
What the agent is doing RIGHT NOW: planning / implementing / testing / debugging / reviewing / orchestrating / done
If debugging: include the exact error message and what has been tried.

## 3. Completed Work
What has been built, tested, committed, and merged — with key architectural and technical decisions.
Include specific file paths and function names. Note WHY decisions were made, not just what.
Focus on outcomes and key decisions. Omit debugging journeys and error traces for issues already resolved.

## 4. Task Tree State
Current live task tree. Only tasks that currently exist (pending/in_progress/failed/draft). For each: ID, title, status, branch. Omit completed/merged tasks (they're recorded in Section 1's timeline). Group: Running → Failed → Pending → Draft.

## 5. Key Insights & Rejected Approaches
Design principles and mental models discovered during this session — especially from failed approaches.
Focus on HIGH-LEVEL insights that prevent entire CLASSES of bugs, not one-off technical fixes.

Good examples:
- "Auth should always be on — 'enforced' only controls registration, not authentication"
- "MCP and HTTP code paths must share implementation, not duplicate logic"
- "Cache invariant: all in-memory state is a cache of disk state — destroying and recreating it should be invisible"
- "Never split by step (types → implementation → tests) — split by module/feature for parallelism"

Bad examples (these belong in code comments, not in the checkpoint):
- "startRegistration(options) directly doesn't work, need {optionsJSON: options}"
- "Cookie secure:true doesn't work on HTTP localhost"
- "CDN path /v3/fonts returns 404, use /v2/fonts instead"

For each insight: state the principle, and briefly note what triggered the discovery.
If truly nothing was learned, write "None so far."

## 6. Key Context
Important state and knowledge that is HARD to reconstruct from disk:
- Constraints or invariants that affect the remaining work
- Environment or configuration state
- Communication state: pending clarifications, recent messages to/from parent or children

## 7. Pending Work
Numbered list of ALL remaining tasks/steps to complete the goal.
Be specific: "implement X in file Y", "add test for Z", "merge child branch A".

Rules:
- Be precise: file paths, function names, exact error messages, task IDs
- Do NOT repeat system prompt or task description content — the agent already has those
- Do NOT include file contents that can be re-read from disk
- Focus on context that is HARD to reconstruct: decisions, state, user intent, failures
- Include ALL user messages/requests — verbatim or close paraphrase, never summarize away
- Each user request must note: what was asked → what was done → what was the outcome
- Aim for thoroughness — lost context is far more expensive than a longer checkpoint
- Length: use as many tokens as needed for complex sessions. Never truncate mid-thought.
- On re-compaction, resolved issues need only their resolution noted — not the journey to get there. Retain useful architectural and decision context.]`;

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
			const memPath = join(cwd, ".opengraft", "memory.md");
			freshMemory = await readFile(memPath, "utf-8");
		} catch {
			// No memory file — that's fine
		}
	}

	const parts: string[] = [];
	if (freshMemory) {
		parts.push(
			`# .opengraft/memory.md (Preloaded, do not read again)\n${freshMemory}`,
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
