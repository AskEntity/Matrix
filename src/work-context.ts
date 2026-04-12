/**
 * Work context builder — generates the content for work_context messages.
 * Injected on fresh sessions and after compaction via enqueue hook.
 * Contains: memory.md + task description + git context + instructions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build work_context content from the project's memory.md and working directory.
 * This replaces the old `header` field on messages.
 */
export function buildWorkContextContent(cwd?: string): string {
	if (!cwd) return "";

	const parts: string[] = [];
	parts.push(`Working directory: ${cwd}`);

	// Read memory.md
	try {
		const memory = readFileSync(join(cwd, ".mxd", "memory.md"), "utf-8");
		if (memory) {
			parts.push(
				`# .mxd/memory.md (Preloaded, do not read again)\n${memory}`,
			);
		}
	} catch {
		// No memory file — that's fine
	}

	return parts.join("\n\n");
}
