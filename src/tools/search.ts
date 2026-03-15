import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

/**
 * Truncate search output to a maximum number of entries.
 * For context mode (rg -C), entries are separated by "--" lines.
 * For other modes, each line is an entry.
 */
export function truncateSearchOutput(
	output: string,
	limit: number,
	hasContext: boolean,
): string {
	if (hasContext) {
		// Context mode: entries are blocks separated by "--" on its own line
		const blocks = output.split(/\n--\n/);
		if (blocks.length <= limit) return output;
		return `${blocks.slice(0, limit).join("\n--\n")}\n[... truncated at ${limit} entries]`;
	}
	// Line-based modes: each line is an entry
	const lines = output.split("\n");
	// Trailing newline produces an empty last element — don't count it
	const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
	const contentLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
	if (contentLines.length <= limit) return output;
	const result = contentLines.slice(0, limit).join("\n");
	return `${result}\n[... truncated at ${limit} entries]`;
}

/**
 * Pure JS search implementation using Bun.Glob + RegExp.
 * Replaces external rg/grep dependency for cross-platform reliability.
 */
export async function jsSearch(opts: {
	pattern: string;
	searchPath: string;
	glob?: string;
	contextLines?: number;
	outputMode: string;
	headLimit: number;
	caseInsensitive: boolean;
	excludedDirs?: string[];
	cwd: string;
}): Promise<string> {
	const {
		pattern,
		searchPath,
		glob,
		contextLines,
		outputMode,
		headLimit,
		caseInsensitive,
		excludedDirs,
		cwd: baseCwd,
	} = opts;

	const regex = new RegExp(pattern, caseInsensitive ? "i" : "");
	let absSearchPath = isAbsolute(searchPath)
		? searchPath
		: join(baseCwd, searchPath);

	// Discover files — handle path pointing to a file vs directory
	let adjustedSearchPath = searchPath;
	const pathStat = statSync(absSearchPath, { throwIfNoEntry: false });
	let files: string[];
	if (pathStat?.isFile()) {
		// Single file mode — path points to a file, not a directory
		files = [basename(absSearchPath)];
		absSearchPath = dirname(absSearchPath);
		adjustedSearchPath = isAbsolute(searchPath)
			? dirname(searchPath)
			: dirname(searchPath) === "."
				? ""
				: dirname(searchPath);
	} else if (glob) {
		// Use Bun.Glob to match files within searchPath
		const g = new Bun.Glob(glob);
		files = Array.from(g.scanSync({ cwd: absSearchPath, onlyFiles: true }));
	} else {
		// No glob — scan all files recursively
		const g = new Bun.Glob("**/*");
		files = Array.from(g.scanSync({ cwd: absSearchPath, onlyFiles: true }));
	}

	// Filter out common noisy directories (only matters for directory scans, not single files)
	const DEFAULT_SKIP_DIRS = [
		"node_modules/",
		".git/",
		"dist/",
		"out/",
		".worktrees/",
		".cache/",
		"coverage/",
		".next/",
		"build/",
	];
	if (!pathStat?.isFile()) {
		const skipDirs = excludedDirs
			? excludedDirs.map((d) => (d.endsWith("/") ? d : `${d}/`))
			: DEFAULT_SKIP_DIRS;
		if (skipDirs.length > 0) {
			files = files.filter(
				(f) =>
					!skipDirs.some(
						(prefix) =>
							f.startsWith(prefix) || f.includes(`/${prefix.slice(0, -1)}/`),
					),
			);
		}
	}

	// Sort for deterministic output
	files.sort();

	const ctxRange =
		contextLines && contextLines > 0 ? Math.min(contextLines, 10) : 0;
	const useContext = ctxRange > 0 && outputMode === "content";

	const outputLines: string[] = [];
	let entryCount = 0;

	for (const relFile of files) {
		if (entryCount >= headLimit) break;

		const filePath = join(absSearchPath, relFile);
		// Compute display path relative to baseCwd
		const displayPath =
			absSearchPath === baseCwd
				? relFile
				: adjustedSearchPath
					? join(adjustedSearchPath, relFile)
					: relFile;

		let content: string;
		try {
			content = await readFile(filePath, "utf-8");
		} catch {
			continue; // skip unreadable files (binary, permissions, etc.)
		}

		// Skip likely binary files (contains null bytes in first 8KB)
		if (content.slice(0, 8192).includes("\0")) continue;

		const lines = content.split("\n");

		if (outputMode === "files_with_matches") {
			for (const line of lines) {
				if (regex.test(line)) {
					outputLines.push(displayPath);
					entryCount++;
					break;
				}
			}
		} else if (outputMode === "count") {
			let count = 0;
			for (const line of lines) {
				if (regex.test(line)) count++;
			}
			if (count > 0) {
				outputLines.push(`${displayPath}:${count}`);
				entryCount++;
			}
		} else {
			// content mode — with optional context lines
			const matchIndices: number[] = [];
			for (let i = 0; i < lines.length; i++) {
				if (regex.test(lines[i] ?? "")) matchIndices.push(i);
			}
			if (matchIndices.length === 0) continue;

			if (useContext) {
				// Group matches into context blocks
				const blocks: string[] = [];
				// biome-ignore lint/style/noNonNullAssertion: length checked above
				let blockStart = Math.max(0, matchIndices[0]! - ctxRange);
				// biome-ignore lint/style/noNonNullAssertion: length checked above
				let blockEnd = Math.min(lines.length - 1, matchIndices[0]! + ctxRange);

				for (let m = 1; m < matchIndices.length; m++) {
					const mi = matchIndices[m] as number;
					const newStart = Math.max(0, mi - ctxRange);
					const newEnd = Math.min(lines.length - 1, mi + ctxRange);
					if (newStart <= blockEnd + 1) {
						// Merge with current block
						blockEnd = newEnd;
					} else {
						// Emit current block
						blocks.push(
							formatContextBlock(
								lines,
								blockStart,
								blockEnd,
								matchIndices,
								displayPath,
							),
						);
						blockStart = newStart;
						blockEnd = newEnd;
					}
				}
				blocks.push(
					formatContextBlock(
						lines,
						blockStart,
						blockEnd,
						matchIndices,
						displayPath,
					),
				);

				for (const block of blocks) {
					if (entryCount >= headLimit) break;
					if (outputLines.length > 0) outputLines.push("--");
					outputLines.push(block);
					entryCount++;
				}
			} else {
				// No context — just matching lines
				for (const idx of matchIndices) {
					if (entryCount >= headLimit) break;
					outputLines.push(`${displayPath}:${idx + 1}:${lines[idx]}`);
					entryCount++;
				}
			}
		}
	}

	let result = outputLines.join("\n");
	if (entryCount >= headLimit) {
		result += `\n[... truncated at ${headLimit} entries]`;
	}
	return result.slice(0, 20000);
}

function formatContextBlock(
	lines: string[],
	start: number,
	end: number,
	matchIndices: number[],
	filePath: string,
): string {
	const matchSet = new Set(matchIndices);
	const blockLines: string[] = [];
	for (let i = start; i <= end; i++) {
		const sep = matchSet.has(i) ? ":" : "-";
		blockLines.push(`${filePath}${sep}${i + 1}${sep}${lines[i]}`);
	}
	return blockLines.join("\n");
}
