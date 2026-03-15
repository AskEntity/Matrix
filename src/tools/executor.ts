import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { MessageQueue } from "../message-queue.ts";
import {
	executeBashWithTimeout,
	getBackgroundStatus,
	getRunningBackgroundCount,
	getRunningBackgroundSummary,
	killBackgroundProcess,
} from "./bash.ts";
import { jsSearch } from "./search.ts";

/** @internal Exported for testing */
export function resolvePath(p: string, cwd: string): string {
	return isAbsolute(p) ? p : join(cwd, p);
}

/** @internal Exported for testing */
export async function executeTool(
	name: string,
	input: Record<string, unknown>,
	cwd: string,
	fallbackCwd?: string,
	sessionId?: string,
	queue?: MessageQueue,
): Promise<{
	content: string;
	isError: boolean;
	cwd?: string;
	isImage?: boolean;
	imageData?: string;
	mediaType?: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}> {
	switch (name) {
		case "bash": {
			const bgAction = input.bg_action as string | undefined;
			const backgroundId = input.background_id as string | undefined;

			// Handle background process management actions
			if (bgAction) {
				if (!backgroundId) {
					return {
						content: "Error: background_id is required when bg_action is set.",
						isError: true,
					};
				}
				if (!sessionId) {
					return {
						content:
							"Error: no session context for background process management.",
						isError: true,
					};
				}

				if (bgAction === "kill") {
					const result = killBackgroundProcess(sessionId, backgroundId);
					if (result === null) {
						return {
							content: `Background process ${backgroundId} not found.`,
							isError: true,
						};
					}
					return { content: result, isError: false };
				}

				if (bgAction === "status") {
					const result = getBackgroundStatus(sessionId, backgroundId);
					if (result === null) {
						return {
							content: `Background process ${backgroundId} not found.`,
							isError: true,
						};
					}
					return { content: result, isError: false };
				}

				return {
					content: `Unknown bg_action: ${bgAction}. Use 'kill' or 'status'.`,
					isError: true,
				};
			}

			const command = input.command as string;
			const hardTimeout = 600000; // 10 min safety timeout (not exposed to agent)
			const foregroundTimeout = Math.min(
				Math.max((input.foreground_timeout as number) ?? 120000, 0),
				hardTimeout,
			);

			// Warn about running background commands
			const bgWarning =
				sessionId && getRunningBackgroundCount(sessionId) > 0
					? `[Note: ${getRunningBackgroundCount(sessionId)} background command(s) still running]\n${getRunningBackgroundSummary(sessionId)}\n\n`
					: "";

			try {
				const result = await executeBashWithTimeout(
					command,
					cwd,
					fallbackCwd,
					foregroundTimeout,
					hardTimeout,
					sessionId,
					queue,
				);
				return {
					...result,
					content: bgWarning + result.content,
				};
			} catch (e) {
				return {
					content: `${bgWarning}Error: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "read_file": {
			const path = resolvePath(input.path as string, cwd);
			const ext = path.split(".").pop()?.toLowerCase();
			const IMAGE_MEDIA_TYPES: Record<
				string,
				"image/jpeg" | "image/png" | "image/gif" | "image/webp"
			> = {
				png: "image/png",
				jpg: "image/jpeg",
				jpeg: "image/jpeg",
				gif: "image/gif",
				webp: "image/webp",
			};
			const imageMediaType = ext ? IMAGE_MEDIA_TYPES[ext] : undefined;

			if (imageMediaType) {
				try {
					const data = readFileSync(path);
					const base64 = data.toString("base64");
					return {
						content: `[Image: ${basename(path)}]`,
						isError: false,
						isImage: true,
						imageData: base64,
						mediaType: imageMediaType,
					};
				} catch (e) {
					return {
						content: `Error reading file: ${e instanceof Error ? e.message : String(e)}`,
						isError: true,
					};
				}
			}

			const offset = Math.max(1, (input.offset as number) ?? 1);
			const limit = input.limit as number | undefined;
			try {
				const raw = readFileSync(path, "utf-8");
				if (offset === 1 && !limit) {
					return { content: raw, isError: false };
				}
				const lines = raw.split("\n");
				const start = offset - 1; // convert to 0-based
				const sliced =
					limit !== undefined
						? lines.slice(start, start + limit)
						: lines.slice(start);
				const remaining = lines.length - (start + sliced.length);
				let content = sliced.join("\n");
				if (remaining > 0) {
					content += `\n[... ${remaining} more lines, use offset=${offset + sliced.length} to continue]`;
				}
				return { content, isError: false };
			} catch (e) {
				return {
					content: `Error reading file: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "write_file": {
			const path = resolvePath(input.path as string, cwd);
			const content = input.content as string;
			try {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content, "utf-8");
				return { content: `File written: ${path}`, isError: false };
			} catch (e) {
				return {
					content: `Error writing file: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "edit_file": {
			const path = resolvePath(input.path as string, cwd);
			const oldStr = input.old_string as string;
			const newStr = input.new_string as string;
			const replaceAll = (input.replace_all as boolean) ?? false;
			try {
				if (!existsSync(path)) {
					return { content: `File not found: ${path}`, isError: true };
				}
				const content = readFileSync(path, "utf-8");
				const occurrences = content.split(oldStr).length - 1;
				if (occurrences === 0) {
					return { content: "old_string not found in file", isError: true };
				}
				if (!replaceAll && occurrences > 1) {
					return {
						content: `old_string found ${occurrences} times — must be unique. Use replace_all=true to replace all.`,
						isError: true,
					};
				}
				const updated = replaceAll
					? content.replaceAll(oldStr, newStr)
					: content.replace(oldStr, newStr);
				writeFileSync(path, updated, "utf-8");
				const msg =
					replaceAll && occurrences > 1
						? `File edited: ${path} (${occurrences} replacements)`
						: `File edited: ${path}`;
				return { content: msg, isError: false };
			} catch (e) {
				return {
					content: `Error editing file: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "list_files": {
			const pattern = (input.pattern as string) ?? "*";
			try {
				const glob = new Bun.Glob(pattern);
				const files: string[] = [];
				for await (const file of glob.scan({ cwd, dot: false })) {
					files.push(file);
					if (files.length >= 500) break;
				}
				return { content: files.join("\n") || "(no files)", isError: false };
			} catch (e) {
				return {
					content: `Error: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		case "search": {
			const pattern = input.pattern as string;
			const searchPath = (input.path as string) ?? ".";
			const glob = input.glob as string | undefined;
			const contextLines = input.context as number | undefined;
			const outputMode = (input.output_mode as string) ?? "content";
			const headLimit = Math.min((input.head_limit as number) ?? 50, 200);
			const caseInsensitive = (input.case_insensitive as boolean) ?? false;
			const excludedDirs = input.excluded_dirs as string[] | undefined;
			// TODO: implement multiline search — currently jsSearch uses line-by-line matching,
			// so the 'multiline' param (input.multiline) is accepted in the schema but ignored here.

			try {
				const result = await jsSearch({
					pattern,
					searchPath,
					glob,
					contextLines,
					outputMode,
					headLimit,
					caseInsensitive,
					excludedDirs,
					cwd,
				});
				return { content: result || "(no matches)", isError: false };
			} catch (e) {
				return {
					content: `Error: ${e instanceof Error ? e.message : String(e)}`,
					isError: true,
				};
			}
		}

		default:
			return { content: `Unknown tool: ${name}`, isError: true };
	}
}
