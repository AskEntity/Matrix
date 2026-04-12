#!/usr/bin/env bun
/**
 * One-time JSONL migration script for the lifecycle refactor.
 * Run BEFORE daemon restart after deploying the new code.
 *
 * Converts:
 * 1. compact_marker: remove checkpoint field (empty boundary)
 * 2. compacted_resume event → message with source: "compacted_resume"
 * 3. summarization_request event → remove (merged into compact_started)
 * 4. task_started → agent_start
 * 5. orchestration_started → agent_start
 * 6. orchestration_completed → agent_end (reason: "done_passed"/"done_failed")
 * 7. agent_stopped → agent_end (reason: "stopped")
 * 8. budget_exceeded → agent_end (reason: "budget_exceeded")
 * 9. Remove header field from message events
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "./ulid.ts";

function migrateEvent(line: string): string | null {
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line);
	} catch {
		return line; // preserve unparseable lines
	}

	const type = event.type as string;

	switch (type) {
		case "compact_marker": {
			// Remove checkpoint field, keep savedTokens
			const { checkpoint: _, ...rest } = event;
			return JSON.stringify(rest);
		}

		case "compacted_resume": {
			// Convert standalone event → message with source: "compacted_resume"
			const id = ulid();
			const ts = (event.ts as number) ?? Date.now();
			const content = (event.content as string) ?? "";
			return JSON.stringify({
				type: "message",
				id,
				taskId: event.taskId ?? "",
				body: {
					source: "compacted_resume",
					id,
					ts,
					content,
				},
				ts,
				...(event.traceId ? { traceId: event.traceId } : {}),
			});
		}

		case "summarization_request":
			// Remove entirely — content merged into compact_started
			return null;

		case "task_started": {
			// → agent_start (without provider/model — not available on old event)
			return JSON.stringify({
				type: "agent_start",
				taskId: event.taskId,
				resume: false,
				model: "unknown",
				provider: "unknown",
				ts: event.ts,
				...(event.traceId ? { traceId: event.traceId } : {}),
			});
		}

		case "orchestration_started": {
			// → agent_start
			return JSON.stringify({
				type: "agent_start",
				taskId: event.taskId,
				resume: (event.resume as boolean) ?? false,
				model: (event.model as string) ?? "unknown",
				provider: (event.provider as string) ?? "unknown",
				ts: event.ts,
				...(event.traceId ? { traceId: event.traceId } : {}),
			});
		}

		case "orchestration_completed": {
			// → agent_end with stats
			return JSON.stringify({
				type: "agent_end",
				taskId: event.taskId,
				reason: (event.success as boolean) ? "done_passed" : "done_failed",
				stats: {
					costUsd: event.costUsd,
					turns: event.turns,
					inputTokens: event.inputTokens,
					cacheCreationTokens: event.cacheCreationTokens,
					cacheReadTokens: event.cacheReadTokens,
					outputTokens: event.outputTokens,
					childCosts: event.childCosts,
				},
				ts: event.ts,
				...(event.traceId ? { traceId: event.traceId } : {}),
			});
		}

		case "agent_stopped": {
			// → agent_end (reason: "stopped")
			return JSON.stringify({
				type: "agent_end",
				taskId: event.taskId,
				reason: "stopped",
				ts: event.ts,
				...(event.traceId ? { traceId: event.traceId } : {}),
			});
		}

		case "budget_exceeded": {
			// → agent_end (reason: "budget_exceeded")
			return JSON.stringify({
				type: "agent_end",
				taskId: event.taskId,
				reason: "budget_exceeded",
				ts: event.ts,
				...(event.traceId ? { traceId: event.traceId } : {}),
			});
		}

		case "message": {
			// Remove header field from message body
			const body = event.body as Record<string, unknown> | undefined;
			if (body && "header" in body) {
				const { header: _, ...restBody } = body;
				return JSON.stringify({ ...event, body: restBody });
			}
			return line; // no change needed
		}

		default:
			return line; // pass through unchanged
	}
}

function migrateFile(filePath: string): { changed: number; removed: number } {
	const content = readFileSync(filePath, "utf-8");
	const lines = content.split("\n");
	const output: string[] = [];
	let changed = 0;
	let removed = 0;

	for (const line of lines) {
		if (!line.trim()) {
			output.push(line);
			continue;
		}
		const result = migrateEvent(line);
		if (result === null) {
			removed++;
		} else if (result !== line) {
			output.push(result);
			changed++;
		} else {
			output.push(line);
		}
	}

	if (changed > 0 || removed > 0) {
		writeFileSync(filePath, output.join("\n"));
	}

	return { changed, removed };
}

// Main
const dataDir = join(process.env.HOME ?? "~", ".mxd");

const projectsDir = join(dataDir, "projects");
let totalChanged = 0;
let totalRemoved = 0;
let totalFiles = 0;

try {
	const projectIds = readdirSync(projectsDir);
	for (const projectId of projectIds) {
		const tasksDir = join(projectsDir, projectId, "tasks");
		try {
			const files = readdirSync(tasksDir).filter((f) => f.endsWith(".jsonl"));
			for (const file of files) {
				const filePath = join(tasksDir, file);
				const { changed, removed } = migrateFile(filePath);
				if (changed > 0 || removed > 0) {
					console.log(
						`  ${projectId}/${file}: ${changed} changed, ${removed} removed`,
					);
					totalChanged += changed;
					totalRemoved += removed;
					totalFiles++;
				}
			}
		} catch {
			// No tasks dir — skip
		}
	}
} catch {
	console.error("No projects directory found at", projectsDir);
	process.exit(1);
}

console.log(
	`\nMigration complete: ${totalFiles} files, ${totalChanged} events changed, ${totalRemoved} events removed.`,
);
