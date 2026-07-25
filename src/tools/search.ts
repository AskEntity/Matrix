import { type Dirent, readdirSync, statSync } from "node:fs";
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
 * Directories skipped when scanning a directory, unless the caller passes its own
 * `excludedDirs`. This list is the ONLY thing that decides what a search ignores —
 * the walker itself must reach everything else, hidden directories included.
 *
 * ⚠️ `.worktrees/` is load-bearing: every sub-agent worktree is a full second copy
 * of the repo, so dropping it turns one search from the main checkout into N copies
 * of every hit. Pinned by a test.
 *
 * ⚠️ Mirrored in prose in the `excluded_dirs` param description (tools/definitions.ts).
 * A test pins the two together — a prose copy of a list rots silently.
 */
export const DEFAULT_SKIP_DIRS = [
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

/**
 * Is this walk-relative path inside one of `skipDirs`? Each entry ends with `/`,
 * so a name is only matched as a whole path segment — `build/` never matches
 * `rebuild.ts`.
 *
 * ONE predicate, two walkers (`search` and `list_files`). A second copy would
 * drift silently: nothing compares them, and both would keep answering.
 */
export function isInSkippedDir(
	relPath: string,
	skipDirs: readonly string[],
): boolean {
	return skipDirs.some(
		(prefix) => relPath.startsWith(prefix) || relPath.includes(`/${prefix}`),
	);
}

/**
 * The default skips, minus any directory the caller's pattern NAMES.
 *
 * `search` lets you reach a skipped directory by pointing `path` into it, or by
 * passing `excluded_dirs: []`. `list_files` takes a pattern and nothing else, so
 * without this rule the skip list would remove an ability with no replacement:
 * `list_files("node_modules/zod/**")` would answer "(no files)".
 *
 * The rule is: you named it, you get it. Comparing against the trailing-slash
 * form is what keeps it from firing by accident — a pattern hunting for
 * `*build*.ts` does not contain `build/`. When it does fire wrongly it hands over
 * MORE files than expected, never fewer, which is the recoverable direction.
 */
export function skipDirsForPattern(pattern: string): string[] {
	return DEFAULT_SKIP_DIRS.filter((dir) => !pattern.includes(dir));
}

/**
 * A glob with no `/` in it is a FILENAME pattern, and a filename pattern means
 * "at any depth" — that is what `--glob '*.ts'` means to ripgrep and what every
 * caller typing `*.ts` is saying. Bun.Glob disagrees: `*` never crosses `/`, so
 * an un-normalized `*.ts` matched only files sitting directly in the walk root.
 * From a repo root `search` answered `(no matches)` and `list_files` answered
 * `(no files)`, both of which read exactly like an answer.
 *
 * A glob that DOES contain `/` is a PATH pattern and is passed through
 * untouched: `src/*.ts` stays anchored at the walk root and must not start
 * reaching `deep/src/inner.ts`. Same split ripgrep makes.
 *
 * Promoting loses nothing — a leading `**` matches zero directories too, so the
 * promoted pattern is a strict superset of the original and still returns the
 * top-level file. (Phrased without the literal prefix on purpose: writing it
 * inside this block comment would close the comment.)
 *
 * Named for what it decides, not for who asked first: `search`'s `glob` and
 * `list_files`'s `pattern` are the same question, and a name carrying one tool's
 * label is how the second caller ends up with a second copy.
 */
export function normalizeGlobDepth(glob: string): string {
	return glob.includes("/") ? glob : `**/${glob}`;
}

/**
 * List every file under `root`, skipping `skipDirs` AT DESCENT rather than
 * afterwards, optionally keeping only those matching `glob`.
 *
 * ## Why this is not a `Bun.Glob.scanSync` call
 *
 * `scanSync` has no notion of a skip list, so the only way to use it is to
 * enumerate everything and discard. Measured from the main checkout with two
 * live worktrees: 62,987 files enumerated, 1,265 kept. The other 61,722 were
 * `node_modules/`, `.git/` and `.worktrees/` — all three in `DEFAULT_SKIP_DIRS`,
 * all three read from disk and immediately thrown away. The cost scales with
 * the number of concurrent sub-agents, since each worktree is another full copy
 * of the repo.
 *
 * Pruning at descent is not a faster way to get the same answer — it is the
 * same answer without opening the directories whose contents were never going
 * to be used. `isInSkippedDir` is asked about the DIRECTORY, once, instead of
 * about each of its files.
 *
 * ## Symlinks: `isFile()`/`isDirectory()`, never `statSync`
 *
 * `readdirSync`'s dirents are lstat-based, so a symlink answers false to BOTH
 * predicates and is dropped by both branches. That is not a gap — it is exactly
 * what `scanSync({onlyFiles: true})` does, measured rather than assumed:
 * given a symlink to a file, a symlink to a directory, a broken symlink and a
 * directory symlinked to its own ancestor, `scanSync` returned only the real
 * files, never the links, and never descended the linked directory.
 *
 * Reproducing that matters twice over. Using `statSync` instead would start
 * returning symlinked files that `search` has never returned, AND would descend
 * symlinked directories — which is how a loop (`a/link -> a`) becomes an
 * infinite walk. Not following links is what makes this terminate structurally,
 * so there is no visited-inode set to keep.
 *
 * ## No cap
 *
 * Every file is collected and then sorted, because `jsSearch`'s `headLimit`
 * counts MATCHES and applies to sorted order. Stopping the walk early would
 * silently change which files a capped search looks at. (`list_files` caps
 * during its walk — but its cap is on the returned list, which is a different
 * question.)
 */
export function walkFiles(
	root: string,
	skipDirs: readonly string[],
	glob?: string,
): string[] {
	const matcher = glob ? new Bun.Glob(normalizeGlobDepth(glob)) : null;
	const out: string[] = [];
	// Explicit stack rather than recursion: depth is bounded by the filesystem,
	// not by anything we control, and the traversal order does not matter because
	// the result is sorted.
	const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];

	while (stack.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: length checked by the loop
		const { abs, rel } = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			// Unreadable directory — permissions, or it vanished mid-walk. Skipping
			// matches `scanSync`, which yields what it can rather than failing the
			// whole search over one directory.
			continue;
		}
		for (const entry of entries) {
			// Forward slashes, always. This string is both what the caller sees and
			// what the glob is matched against; `join()` would write `\` on Windows
			// and break both.
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				// THE PRUNE. `isInSkippedDir` wants a path it can match whole
				// segments in, and every skip entry ends in `/` — so the directory is
				// asked about in its trailing-slash form. One predicate, asked once
				// per directory instead of once per file inside it.
				if (isInSkippedDir(`${childRel}/`, skipDirs)) continue;
				stack.push({ abs: join(abs, entry.name), rel: childRel });
			} else if (entry.isFile()) {
				if (!matcher || matcher.match(childRel)) out.push(childRel);
			}
			// Everything else — symlinks, sockets, fifos, block devices — falls
			// through deliberately. See the symlink note above.
		}
	}

	out.sort();
	return out;
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
	multiline?: boolean;
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
		multiline,
		excludedDirs,
		cwd: baseCwd,
	} = opts;

	let flags = "g";
	if (caseInsensitive) flags += "i";
	if (multiline) flags += "s";
	const regex = new RegExp(pattern, flags);
	const lineRegex = new RegExp(pattern, caseInsensitive ? "i" : "");
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
	} else {
		// The skip list is applied AT DESCENT, inside the walk — an excluded
		// directory is never opened, rather than being enumerated in full and then
		// discarded. Measured on the main checkout: the old walk-then-filter read
		// 68,641 files to return 320.
		//
		// `excluded_dirs: []` still means "no exclusions" and reaches everything,
		// and pointing `path` INTO a skipped directory still works, because the
		// skip list is matched against paths relative to the walk root — the root
		// itself is not part of them. Both are pinned by tests.
		const skipDirs = excludedDirs
			? excludedDirs.map((d) => (d.endsWith("/") ? d : `${d}/`))
			: DEFAULT_SKIP_DIRS;
		files = walkFiles(absSearchPath, skipDirs, glob);
	}

	// `walkFiles` already sorted; single-file mode is one entry. Sorting here would
	// be the only thing keeping the walk's output deterministic if that changed, so
	// it stays as the explicit statement of the contract.
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

		if (multiline) {
			// Multiline mode: match against full content using 's' flag
			regex.lastIndex = 0;
			const matches: Array<{ startLine: number; endLine: number }> = [];
			// Build line offset table for O(log n) offset-to-line lookups
			const lineOffsets: number[] = [0];
			for (let i = 0; i < lines.length - 1; i++) {
				lineOffsets.push(
					(lineOffsets[i] as number) + (lines[i] as string).length + 1,
				);
			}

			for (let m = regex.exec(content); m !== null; m = regex.exec(content)) {
				const startOffset = m.index;
				const endOffset = m.index + m[0].length - 1;
				const startLine = offsetToLine(lineOffsets, startOffset);
				const endLine = offsetToLine(lineOffsets, endOffset);
				matches.push({ startLine, endLine });
				// Prevent infinite loop on zero-length matches
				if (m[0].length === 0) regex.lastIndex++;
			}

			if (matches.length === 0) continue;

			if (outputMode === "files_with_matches") {
				outputLines.push(displayPath);
				entryCount++;
			} else if (outputMode === "count") {
				outputLines.push(`${displayPath}:${matches.length}`);
				entryCount++;
			} else {
				// content mode — collect all lines touched by matches
				const matchLineSet = new Set<number>();
				for (const match of matches) {
					for (let i = match.startLine; i <= match.endLine; i++) {
						matchLineSet.add(i);
					}
				}
				const matchIndices = Array.from(matchLineSet).sort((a, b) => a - b);

				if (useContext) {
					const blocks: string[] = [];

					// Find contiguous groups
					let groupStartIdx = 0;
					for (let k = 1; k < matchIndices.length; k++) {
						const prevEnd = (matchIndices[k - 1] as number) + ctxRange;
						const currStart = (matchIndices[k] as number) - ctxRange;
						if (currStart > prevEnd + 1) {
							// Emit previous group
							const gEnd = Math.min(
								lines.length - 1,
								(matchIndices[k - 1] as number) + ctxRange,
							);
							blocks.push(
								formatContextBlock(
									lines,
									Math.max(
										0,
										(matchIndices[groupStartIdx] as number) - ctxRange,
									),
									gEnd,
									matchIndices,
									displayPath,
								),
							);
							groupStartIdx = k;
						}
					}
					// Emit last group
					blocks.push(
						formatContextBlock(
							lines,
							Math.max(0, (matchIndices[groupStartIdx] as number) - ctxRange),
							Math.min(
								lines.length - 1,
								(matchIndices[matchIndices.length - 1] as number) + ctxRange,
							),
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
					// No context — show lines that are part of matches
					for (const idx of matchIndices) {
						if (entryCount >= headLimit) break;
						outputLines.push(`${displayPath}:${idx + 1}:${lines[idx]}`);
						entryCount++;
					}
				}
			}
		} else {
			// Standard line-by-line mode
			if (outputMode === "files_with_matches") {
				for (const line of lines) {
					if (lineRegex.test(line)) {
						outputLines.push(displayPath);
						entryCount++;
						break;
					}
				}
			} else if (outputMode === "count") {
				let count = 0;
				for (const line of lines) {
					if (lineRegex.test(line)) count++;
				}
				if (count > 0) {
					outputLines.push(`${displayPath}:${count}`);
					entryCount++;
				}
			} else {
				// content mode — with optional context lines
				const matchIndices: number[] = [];
				for (let i = 0; i < lines.length; i++) {
					if (lineRegex.test(lines[i] ?? "")) matchIndices.push(i);
				}
				if (matchIndices.length === 0) continue;

				if (useContext) {
					// Group matches into context blocks
					const blocks: string[] = [];
					// biome-ignore lint/style/noNonNullAssertion: length checked above
					let blockStart = Math.max(0, matchIndices[0]! - ctxRange);
					let blockEnd = Math.min(
						lines.length - 1,
						// biome-ignore lint/style/noNonNullAssertion: length checked above
						matchIndices[0]! + ctxRange,
					);

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
	}

	let result = outputLines.join("\n");
	if (entryCount >= headLimit) {
		result += `\n[... truncated at ${headLimit} entries]`;
	}
	return result.slice(0, 20000);
}

/**
 * Binary search to find which line a byte offset falls on.
 */
function offsetToLine(lineOffsets: number[], offset: number): number {
	let lo = 0;
	let hi = lineOffsets.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((lineOffsets[mid] as number) <= offset) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return lo;
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
