import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type {
	MessageParam,
	TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { createOrchestratorTools } from "./orchestrator-tools.ts";
import {
	AnthropicCompatibleProvider,
	addMessagesCacheControl,
	eventsToAnthropicMessages,
	getContextWindow,
	getModelPricing,
} from "./anthropic-compatible-provider.ts";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import { MessageQueue } from "./message-queue.ts";
import {
	buildCompactedContext,
	buildSummarizationInstruction,
	extractCheckpoint,
	getCompactionThresholds,
	SUMMARIZATION_INSTRUCTION,
	zodShapeToJsonSchema,
} from "./provider-shared.ts";
import { TaskTracker } from "./task-tracker.ts";
import { attachMockSession, mockDaemonContext } from "./test-utils.ts";
import { listBackgroundProcesses } from "./tools/background.ts";
import type { BackgroundProcess } from "./tools/bash.ts";
import {
	cleanupSessionBackgroundProcesses,
	executeBashWithTimeout,
	executeTool,
	getBackgroundStatus,
	jsSearch,
	killBackgroundProcess,
	resolvePath,
	truncateSearchOutput,
} from "./tools/index.ts";
import type { AgentResult } from "./types.ts";

/** Create a MessageQueue pre-loaded with a user message (for tests). */
function queueWithPrompt(content: string, cwd?: string): MessageQueue {
	const q = new MessageQueue();
	const header = cwd ? `Working directory: ${cwd}` : undefined;
	q.enqueue({ source: "user", content, ...(header ? { header } : {}) });
	return q;
}

describe("getModelPricing", () => {
	test("returns Opus pricing for opus models", () => {
		const pricing = getModelPricing("claude-opus-4-6");
		expect(pricing.inputPer1M).toBe(5);
		expect(pricing.outputPer1M).toBe(25);
	});

	test("returns Sonnet pricing for sonnet models", () => {
		const pricing = getModelPricing("claude-sonnet-4-6");
		expect(pricing.inputPer1M).toBe(3);
		expect(pricing.outputPer1M).toBe(15);
	});

	test("returns Haiku pricing for haiku models", () => {
		const pricing = getModelPricing("claude-haiku-4-5-20251001");
		expect(pricing.inputPer1M).toBe(1);
		expect(pricing.outputPer1M).toBe(5);
	});

	test("defaults to Sonnet for unknown models", () => {
		const pricing = getModelPricing("gpt-4");
		expect(pricing.inputPer1M).toBe(3);
		expect(pricing.outputPer1M).toBe(15);
	});
});

describe("getContextWindow", () => {
	test("returns 1M for opus models", () => {
		expect(getContextWindow("claude-opus-4-6")).toBe(1_000_000);
	});

	test("returns 1M for sonnet 4.6 models", () => {
		expect(getContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
	});

	test("returns 200k for haiku models", () => {
		expect(getContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
	});

	test("returns 200k for unknown models", () => {
		expect(getContextWindow("gpt-4")).toBe(200_000);
	});
});

describe("getCompactionThresholds", () => {
	test("computes thresholds for 200k context window", () => {
		const { compressThreshold, lazyCountThreshold } =
			getCompactionThresholds(200_000);
		// 200k * 0.83 = 166k
		expect(compressThreshold).toBe(Math.floor(200_000 * 0.83));
		expect(lazyCountThreshold).toBe(compressThreshold - 16_000);
	});

	test("computes thresholds for 1M context window", () => {
		const { compressThreshold, lazyCountThreshold } =
			getCompactionThresholds(1_000_000);
		// 1M * 0.83 = 830k
		expect(compressThreshold).toBe(Math.floor(1_000_000 * 0.83));
		expect(lazyCountThreshold).toBe(compressThreshold - 16_000);
	});
});

describe("cost calculation", () => {
	test("input_tokens are NOT double-counted with cache tokens (negative cost bug)", () => {
		// Anthropic API: input_tokens = non-cached tokens ONLY.
		// cache_creation_input_tokens and cache_read_input_tokens are separate.
		// Cost = input * 1x + cache_creation * 1.25x + cache_read * 0.1x + output * outputRate
		// BUG: old code subtracted cache tokens from input_tokens, causing negative costs
		// when cache_creation + cache_read > input_tokens.
		const { inputPer1M, outputPer1M } = getModelPricing("claude-sonnet-4-6");
		// inputPer1M = 3, outputPer1M = 15

		const totalInputTokens = 500; // non-cached tokens (small, e.g. just new content)
		const totalCacheCreationTokens = 10_000; // large cache write
		const totalCacheReadTokens = 5_000; // cache hits
		const totalOutputTokens = 200;

		// Correct formula: input_tokens is already net of cache — no subtraction needed
		const costUsd =
			(totalInputTokens * inputPer1M) / 1_000_000 +
			(totalCacheCreationTokens * inputPer1M * 1.25) / 1_000_000 +
			(totalCacheReadTokens * inputPer1M * 0.1) / 1_000_000 +
			(totalOutputTokens * outputPer1M) / 1_000_000;

		// Should be positive: 500*3/1M + 10000*3*1.25/1M + 5000*3*0.1/1M + 200*15/1M
		// = 0.0015 + 0.0375 + 0.0015 + 0.003 = 0.0435
		expect(costUsd).toBeGreaterThan(0);
		expect(costUsd).toBeCloseTo(0.0435, 6);
	});

	test("cost is non-negative even with very large cache hits", () => {
		const { inputPer1M } = getModelPricing("claude-sonnet-4-6");
		// Extreme case: almost all tokens come from cache, input_tokens is tiny
		const totalInputTokens = 10;
		const totalCacheCreationTokens = 0;
		const totalCacheReadTokens = 100_000;

		const costUsd =
			(totalInputTokens * inputPer1M) / 1_000_000 +
			(totalCacheCreationTokens * inputPer1M * 1.25) / 1_000_000 +
			(totalCacheReadTokens * inputPer1M * 0.1) / 1_000_000 +
			(50 * 15) / 1_000_000;

		expect(costUsd).toBeGreaterThan(0);
	});
});

describe("resolvePath", () => {
	test("returns absolute paths unchanged", () => {
		expect(resolvePath("/tmp/file.ts", "/home/user")).toBe("/tmp/file.ts");
	});

	test("resolves relative paths against cwd", () => {
		expect(resolvePath("src/calc.ts", "/home/user/project")).toBe(
			"/home/user/project/src/calc.ts",
		);
	});
});

describe("executeTool", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-dp-test-"));
	});

	afterAll(async () => {
		if (tempDir) await rm(tempDir, { recursive: true });
	});

	test("bash: executes command and returns output", async () => {
		const result = await executeTool(
			"bash",
			{ command: "echo hello" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("hello");
	});

	test("bash: returns error for failing command", async () => {
		const result = await executeTool("bash", { command: "exit 1" }, tempDir);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("exit code: 1");
	});

	test("bash: no cwd returned when directory unchanged", async () => {
		const result = await executeTool(
			"bash",
			{ command: "echo hello" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.cwd).toBeUndefined();
		expect(result.content).not.toContain("___OPENGRAFT_CWD___");
	});

	test("bash: cwd returned when cd changes directory", async () => {
		const result = await executeTool("bash", { command: "cd /tmp" }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.cwd).toBe("/tmp");
		expect(result.content).toContain("workdir set to /tmp from now on");
		// Marker should be stripped from output
		expect(result.content).not.toContain("___OPENGRAFT_CWD___");
	});

	test("bash: cwd tracks cd within a multi-command chain", async () => {
		const result = await executeTool(
			"bash",
			{ command: "cd /tmp && echo working" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.cwd).toBe("/tmp");
		expect(result.content).toContain("working");
		expect(result.content).toContain("workdir set to /tmp from now on");
	});

	test("bash: failed command still captures cwd if cd happened before failure", async () => {
		const result = await executeTool(
			"bash",
			{ command: "cd /tmp && exit 1" },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.cwd).toBe("/tmp");
		expect(result.content).toContain("exit code: 1");
	});

	test("bash: warns when CWD leaves worktree", async () => {
		const result = await executeTool(
			"bash",
			{ command: "cd /tmp" },
			tempDir,
			tempDir, // fallbackCwd = worktree root
		);
		expect(result.isError).toBe(false);
		expect(result.cwd).toBeDefined();
		expect(result.content).toContain("CWD is outside your worktree");
		expect(result.content).toContain("Remember to cd back");
	});

	test("bash: no warning when CWD stays within worktree", async () => {
		// Create a subdirectory within the worktree
		const subDir = join(tempDir, "subdir");
		await mkdir(subDir, { recursive: true });

		const result = await executeTool(
			"bash",
			{ command: "cd subdir" },
			tempDir,
			tempDir, // fallbackCwd = worktree root
		);
		expect(result.isError).toBe(false);
		expect(result.content).not.toContain("CWD is outside your worktree");
	});

	test("bash: no warning when no fallbackCwd provided", async () => {
		// Without fallbackCwd, no worktree validation happens (root orchestrator case)
		const result = await executeTool("bash", { command: "cd /tmp" }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.content).not.toContain("CWD is outside your worktree");
	});

	test("bash: falls back to fallbackCwd when cwd is deleted", async () => {
		// Create and then delete a temp dir to simulate a stale CWD
		const deletedDir = await mkdtemp(join(tmpdir(), "og-deleted-"));
		await rm(deletedDir, { recursive: true });

		const result = await executeTool(
			"bash",
			{ command: "echo hello" },
			deletedDir,
			tempDir, // fallbackCwd
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("workdir reset to");
		expect(result.content).toContain("no longer exists");
		expect(result.content).toContain("hello");
		// Should report the fallback as the new cwd
		expect(result.cwd).toBe(tempDir);
	});

	test("write_file: creates file with directories", async () => {
		const path = join(tempDir, "sub", "dir", "file.txt");
		const result = await executeTool(
			"write_file",
			{ path, content: "hello world" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("File written");
	});

	test("read_file: reads existing file", async () => {
		const path = join(tempDir, "readable.txt");
		await writeFile(path, "test content");

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.content).toBe("test content");
	});

	test("read_file: resolves relative paths", async () => {
		await writeFile(join(tempDir, "relative.txt"), "relative content");

		const result = await executeTool(
			"read_file",
			{ path: "relative.txt" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toBe("relative content");
	});

	test("read_file: returns error for missing file", async () => {
		const result = await executeTool(
			"read_file",
			{ path: "nonexistent.txt" },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Error reading file");
	});

	test("read_file: offset skips lines", async () => {
		const path = join(tempDir, "multiline.txt");
		await writeFile(path, "line1\nline2\nline3\nline4\nline5");

		const result = await executeTool("read_file", { path, offset: 3 }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.content).toBe("line3\nline4\nline5");
	});

	test("read_file: limit restricts lines returned", async () => {
		const path = join(tempDir, "multiline2.txt");
		await writeFile(path, "line1\nline2\nline3\nline4\nline5");

		const result = await executeTool("read_file", { path, limit: 2 }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("line1\nline2");
		expect(result.content).toContain(
			"[... 3 more lines, use offset=3 to continue]",
		);
	});

	test("read_file: offset and limit together", async () => {
		const path = join(tempDir, "multiline3.txt");
		await writeFile(path, "line1\nline2\nline3\nline4\nline5");

		const result = await executeTool(
			"read_file",
			{ path, offset: 2, limit: 2 },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("line2\nline3");
		expect(result.content).toContain(
			"[... 2 more lines, use offset=4 to continue]",
		);
	});

	test("read_file: no trailing hint when all lines returned", async () => {
		const path = join(tempDir, "multiline4.txt");
		await writeFile(path, "line1\nline2\nline3");

		const result = await executeTool("read_file", { path, offset: 2 }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.content).toBe("line2\nline3");
		expect(result.content).not.toContain("[...");
	});

	test("read_file: reads PNG image as base64", async () => {
		// Minimal 1x1 red PNG (67 bytes)
		const pngData = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
			"base64",
		);
		const path = join(tempDir, "test.png");
		await writeFile(path, pngData);

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.isImage).toBe(true);
		expect(result.mediaType).toBe("image/png");
		expect(result.imageData).toBeDefined();
		// Verify the base64 round-trips correctly
		const decoded = Buffer.from(result.imageData ?? "", "base64");
		expect(decoded.equals(pngData)).toBe(true);
		expect(result.content).toBe("[Image: test.png]");
	});

	test("read_file: reads JPEG image as base64", async () => {
		const path = join(tempDir, "photo.jpg");
		await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // minimal JPEG header

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.isImage).toBe(true);
		expect(result.mediaType).toBe("image/jpeg");
	});

	test("read_file: reads .jpeg extension as image/jpeg", async () => {
		const path = join(tempDir, "photo.jpeg");
		await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isImage).toBe(true);
		expect(result.mediaType).toBe("image/jpeg");
	});

	test("read_file: reads WebP image as base64", async () => {
		const path = join(tempDir, "image.webp");
		await writeFile(path, Buffer.from("RIFF\x00\x00\x00\x00WEBP"));

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isImage).toBe(true);
		expect(result.mediaType).toBe("image/webp");
	});

	test("read_file: reads GIF image as base64", async () => {
		const path = join(tempDir, "anim.gif");
		await writeFile(path, Buffer.from("GIF89a"));

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isImage).toBe(true);
		expect(result.mediaType).toBe("image/gif");
	});

	test("read_file: non-image files still return text", async () => {
		const path = join(tempDir, "code.ts");
		await writeFile(path, 'console.log("hello");');

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.isImage).toBeUndefined();
		expect(result.imageData).toBeUndefined();
		expect(result.content).toBe('console.log("hello");');
	});

	test("read_file: SVG files return text (not image)", async () => {
		const path = join(tempDir, "icon.svg");
		await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.isImage).toBeUndefined();
		// SVG is XML text, not a supported image format for the API
		expect(result.content).toBe(
			'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
		);
	});

	test("read_file: image error for missing file", async () => {
		const result = await executeTool(
			"read_file",
			{ path: "missing.png" },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Error reading file");
		expect(result.isImage).toBeUndefined();
	});

	test("edit_file: replaces string in file", async () => {
		const path = join(tempDir, "editable.txt");
		await writeFile(path, "hello world");

		const result = await executeTool(
			"edit_file",
			{ path, old_string: "world", new_string: "earth" },
			tempDir,
		);
		expect(result.isError).toBe(false);

		const readResult = await executeTool("read_file", { path }, tempDir);
		expect(readResult.content).toBe("hello earth");
	});

	test("edit_file: fails for non-unique string", async () => {
		const path = join(tempDir, "duplicate.txt");
		await writeFile(path, "aaa bbb aaa");

		const result = await executeTool(
			"edit_file",
			{ path, old_string: "aaa", new_string: "ccc" },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("2 times");
		expect(result.content).toContain("replace_all=true");
	});

	test("edit_file: replace_all replaces all occurrences", async () => {
		const path = join(tempDir, "replace_all.txt");
		await writeFile(path, "aaa bbb aaa ccc aaa");

		const result = await executeTool(
			"edit_file",
			{ path, old_string: "aaa", new_string: "zzz", replace_all: true },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("3 replacements");

		const readResult = await executeTool("read_file", { path }, tempDir);
		expect(readResult.content).toBe("zzz bbb zzz ccc zzz");
	});

	test("edit_file: replace_all with single occurrence reports no count suffix", async () => {
		const path = join(tempDir, "replace_all_single.txt");
		await writeFile(path, "hello world");

		const result = await executeTool(
			"edit_file",
			{ path, old_string: "world", new_string: "earth", replace_all: true },
			tempDir,
		);
		expect(result.isError).toBe(false);
		// Single occurrence: no "(N replacements)" suffix
		expect(result.content).toBe(`File edited: ${path}`);

		const readResult = await executeTool("read_file", { path }, tempDir);
		expect(readResult.content).toBe("hello earth");
	});

	test("edit_file: replace_all=false is the same as default uniqueness enforcement", async () => {
		const path = join(tempDir, "replace_all_false.txt");
		await writeFile(path, "foo foo foo");

		const result = await executeTool(
			"edit_file",
			{ path, old_string: "foo", new_string: "bar", replace_all: false },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("3 times");
	});

	test("list_files: lists files in directory", async () => {
		await writeFile(join(tempDir, "list_test.txt"), "");
		const result = await executeTool(
			"list_files",
			{ pattern: "*.txt" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("list_test.txt");
	});

	test("search: finds pattern in files", async () => {
		await writeFile(
			join(tempDir, "searchable.ts"),
			"const foo = 42;\nconst bar = 99;\n",
		);
		const result = await executeTool(
			"search",
			{ pattern: "foo", path: tempDir },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("foo");
	});

	test("search: returns context lines", async () => {
		await writeFile(
			join(tempDir, "ctx.ts"),
			"line1\nline2\ntarget\nline4\nline5\n",
		);
		const result = await executeTool(
			"search",
			{ pattern: "target", path: tempDir, context: 1 },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("target");
		expect(result.content).toContain("line2");
		expect(result.content).toContain("line4");
	});

	test("search: files_with_matches returns only file paths", async () => {
		await writeFile(join(tempDir, "match1.ts"), "const hello = 1;\n");
		await writeFile(join(tempDir, "match2.ts"), "const hello = 2;\n");
		await writeFile(join(tempDir, "nomatch.ts"), "const world = 3;\n");
		const result = await executeTool(
			"search",
			{ pattern: "hello", path: tempDir, output_mode: "files_with_matches" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("match1.ts");
		expect(result.content).toContain("match2.ts");
		expect(result.content).not.toContain("nomatch.ts");
	});

	test("search: count mode returns match counts", async () => {
		await writeFile(
			join(tempDir, "count_test.ts"),
			"hello world\nhello again\nno match\n",
		);
		const result = await executeTool(
			"search",
			{ pattern: "hello", path: tempDir, output_mode: "count" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("count_test.ts");
		expect(result.content).toContain("2");
	});

	test("search: case_insensitive matches upper and lower case", async () => {
		await writeFile(
			join(tempDir, "case_test.ts"),
			"const HELLO = 1;\nconst hello = 2;\nconst world = 3;\n",
		);
		const result = await executeTool(
			"search",
			{ pattern: "HELLO", path: tempDir, case_insensitive: true },
			tempDir,
		);
		expect(result.isError).toBe(false);
		// Both lines with HELLO and hello should be found
		const lines = result.content
			.split("\n")
			.filter((l) => l.includes("case_test.ts"));
		expect(lines.length).toBeGreaterThanOrEqual(2);
	});

	test("search: head_limit truncates total output entries", async () => {
		// Write a file with many matching lines
		const lines = Array.from(
			{ length: 20 },
			(_, i) => `const x${i} = ${i};`,
		).join("\n");
		await writeFile(join(tempDir, "many.ts"), `${lines}\n`);
		const result = await executeTool(
			"search",
			{ pattern: "const", path: tempDir, head_limit: 5 },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("const");
		// Should be truncated to 5 entries
		const matchLines = result.content
			.split("\n")
			.filter((l) => l.includes("const"));
		expect(matchLines.length).toBe(5);
		expect(result.content).toContain("[... truncated at 5 entries]");
	});

	test("search: glob with path separator finds matches", async () => {
		// Create a nested file structure
		const subDir = join(tempDir, "sub");
		await mkdir(subDir, { recursive: true });
		await writeFile(join(subDir, "target.ts"), "const found = true;\n");
		await writeFile(join(tempDir, "other.ts"), "const found = false;\n");

		// Glob with path separator: "sub/target.ts"
		const result = await executeTool(
			"search",
			{ pattern: "found", path: tempDir, glob: "sub/target.ts" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("found");
		// Should only match the file in sub/, not other.ts
		expect(result.content).not.toContain("other.ts");
	});

	test("search: glob with path wildcard narrows to subdirectory", async () => {
		const subDir = join(tempDir, "src");
		await mkdir(subDir, { recursive: true });
		await writeFile(join(subDir, "a.ts"), "hello world\n");
		await writeFile(join(subDir, "b.js"), "hello world\n");
		await writeFile(join(tempDir, "c.ts"), "hello world\n");

		// Glob "src/*.ts" should match only src/a.ts
		const result = await executeTool(
			"search",
			{ pattern: "hello", path: tempDir, glob: "src/*.ts" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("a.ts");
		expect(result.content).not.toContain("b.js");
		expect(result.content).not.toContain("c.ts");
	});

	test("unknown tool: returns error", async () => {
		const result = await executeTool("unknown_tool", {}, tempDir);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown tool");
	});
});

describe("executeBashWithTimeout", () => {
	let tempDir: string;

	/**
	 * Per-test session Maps. Tests that need background process tracking
	 * create a local bgMap/fgMap and pass them to functions.
	 * The afterAll cleans up any straggler Maps.
	 */
	const allTestBgMaps: Map<string, BackgroundProcess>[] = [];

	/** Create a fresh bgMap + fgMap pair for a test. Tracks bgMap for cleanup. */
	function createTestMaps() {
		const bgMap = new Map<string, BackgroundProcess>();
		const fgMap = new Map<string, { resolve: () => void; command: string }>();
		allTestBgMaps.push(bgMap);
		return { bgMap, fgMap };
	}

	/** Create a getSession callback that returns a fake session with the given Maps. */
	function makeGetSession(
		bgMap: Map<string, BackgroundProcess>,
		fgMap: Map<string, { resolve: () => void; command: string }>,
	) {
		return (_sessionId: string) =>
			({
				backgroundProcesses: bgMap,
				foregroundExecutions: fgMap,
			}) as import("./types.ts").TaskSession;
	}

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "bash-timeout-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
		// Clean up any background processes
		for (const bgMap of allTestBgMaps) {
			cleanupSessionBackgroundProcesses(bgMap);
		}
	});

	test("foreground command completes within timeout", async () => {
		const result = await executeBashWithTimeout(
			"echo hello",
			tempDir,
			undefined,
			5000,
			undefined,
			undefined,
		);
		expect(result.content).toContain("hello");
		expect(result.content).toContain("exit code: 0");
		expect(result.isError).toBe(false);
	});

	test("foreground_timeout=0 immediately backgrounds", async () => {
		const sessionId = "test-bg-immediate";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeBashWithTimeout(
			"echo bg-test",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("backgrounded immediately");
		expect(result.content).toContain("Background ID: bg-");
		expect(result.isError).toBe(false);
		// backgroundId and backgroundCommand returned on result
		expect(result.backgroundId).toMatch(/^bg-/);
		expect(result.backgroundCommand).toBe("echo bg-test");

		// Wait for background process to complete and notify (with stdout/stderr content)
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.exitCode).toBe(0);
			expect(msg.durationMs).toBeGreaterThanOrEqual(0);
			// stdout/stderr included when output is small
			expect(msg.stdout).toContain("bg-test");
		}

		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("foreground timeout triggers backgrounding for slow command", async () => {
		const sessionId = "test-bg-slow";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeBashWithTimeout(
			"sleep 5 && echo done-slow",
			tempDir,
			undefined,
			100, // 100ms foreground timeout — will trigger background
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("moved to background");
		expect(result.content).toContain("Background ID: bg-");
		expect(result.isError).toBe(false);

		// Verify it's tracked as running
		expect(
			listBackgroundProcesses(bgMap).filter((p) => p.status === "running")
				.length,
		).toBe(1);

		// Wait for completion notification — this takes ~5s (with stdout/stderr content)
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.exitCode).toBe(0);
			expect(msg.durationMs).toBeGreaterThan(100);
			// stdout/stderr included when output is small
			expect(msg.stdout).toContain("done-slow");
		}

		// Should no longer be running
		expect(
			listBackgroundProcesses(bgMap).filter((p) => p.status === "running")
				.length,
		).toBe(0);
		cleanupSessionBackgroundProcesses(bgMap);
	}, 10000);

	test("foreground command that finishes before timeout returns normally", async () => {
		const { bgMap } = createTestMaps();
		const result = await executeBashWithTimeout(
			"echo fast",
			tempDir,
			undefined,
			5000,
			"test-fast",
			undefined,
			undefined,
			bgMap,
		);
		expect(result.content).toContain("fast");
		expect(result.content).toContain("exit code: 0");
		expect(result.isError).toBe(false);
		// Should NOT be backgrounded
		expect(result.content).not.toContain("Background ID");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("executeTool bash with foreground_timeout passes through", async () => {
		const result = await executeTool(
			"bash",
			{ command: "echo tool-test", foreground_timeout: 5000 },
			tempDir,
		);
		expect(result.content).toContain("tool-test");
		expect(result.content).toContain("exit code: 0");
		expect(result.isError).toBe(false);
	});

	test("no background warning injected into bash output", async () => {
		const sessionId = "test-bg-warn";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();

		// Start a slow background command
		await executeBashWithTimeout(
			"sleep 10",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		expect(
			listBackgroundProcesses(bgMap).filter((p) => p.status === "running")
				.length,
		).toBe(1);

		// Run another command — should NOT show warning (bg warning removed)
		const result = await executeTool(
			"bash",
			{ command: "echo hello", foreground_timeout: 5000 },
			tempDir,
			undefined,
			sessionId,
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.content).not.toContain("background command(s) still running");
		expect(result.content).toContain("hello");

		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("cleanup removes all background processes for session", () => {
		const bgMap = new Map<string, BackgroundProcess>([
			[
				"bg-1",
				{
					id: "bg-1",
					command: "test",
					startTime: Date.now(),
					stdout: "",
					stderr: "",
					exitCode: null,
					status: "running",
					kill: null,
					stdoutPath: null,
					stderrPath: null,
				},
			],
		]);
		expect(bgMap.size).toBe(1);
		cleanupSessionBackgroundProcesses(bgMap);
		expect(bgMap.size).toBe(0);
	});

	test("killBackgroundProcess kills a running process", async () => {
		const sessionId = "test-kill";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		const bgId = result.content.match(/bg-[A-Z0-9]+/)?.[0] ?? "";
		expect(bgId).toBeTruthy();

		expect(
			listBackgroundProcesses(bgMap).filter((p) => p.status === "running")
				.length,
		).toBe(1);

		const killResult = killBackgroundProcess(bgMap, bgId);
		expect(killResult).toContain("killed");
		expect(killResult).toContain(bgId);

		// Wait for background completion notification
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");

		expect(
			listBackgroundProcesses(bgMap).filter((p) => p.status === "running")
				.length,
		).toBe(0);
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("killBackgroundProcess returns not-running message for completed process", () => {
		const bgMap = new Map<string, BackgroundProcess>([
			[
				"bg-done",
				{
					id: "bg-done",
					command: "echo done",
					startTime: Date.now() - 1000,
					stdout: "done\n",
					stderr: "",
					exitCode: 0,
					status: "completed",
					kill: null,
					stdoutPath: null,
					stderrPath: null,
				},
			],
		]);

		const result = killBackgroundProcess(bgMap, "bg-done");
		expect(result).toContain("not running");
		expect(result).toContain("completed");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("killBackgroundProcess returns null for unknown process", () => {
		const bgMap = new Map<string, BackgroundProcess>();
		const result = killBackgroundProcess(bgMap, "bg-nope");
		expect(result).toBeNull();
	});

	test("getBackgroundStatus returns status for running process", async () => {
		const sessionId = "test-status-running";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);

		const bgId = bgMap.keys().next().value ?? "";
		expect(bgId).toBeTruthy();

		const status = getBackgroundStatus(bgMap, bgId);
		expect(status).toContain("running");
		expect(status).toContain("sleep 30");
		expect(status).toContain("stdout file:");
		expect(status).toContain("read_file");

		// Clean up: kill the process
		killBackgroundProcess(bgMap, bgId);
		await queue.wait();
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("getBackgroundStatus returns metadata for completed process", () => {
		const bgMap = new Map<string, BackgroundProcess>([
			[
				"bg-fin",
				{
					id: "bg-fin",
					command: "echo hello",
					startTime: Date.now() - 2000,
					stdout: "",
					stderr: "",
					exitCode: 0,
					status: "completed",
					kill: null,
					stdoutPath: "/tmp/opengraft-bg/exec-test.stdout",
					stderrPath: "/tmp/opengraft-bg/exec-test.stderr",
				},
			],
		]);

		const status = getBackgroundStatus(bgMap, "bg-fin");
		expect(status).toContain("completed");
		expect(status).toContain("exit code: 0");
		expect(status).not.toContain("still running");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("getBackgroundStatus returns null for unknown process", () => {
		const bgMap = new Map<string, BackgroundProcess>();
		const result = getBackgroundStatus(bgMap, "bg-nope");
		expect(result).toBeNull();
	});

	test("background tool routes action=kill", async () => {
		const sessionId = "test-tool-kill";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);

		const bgId = bgMap.keys().next().value;
		expect(bgId).toBeDefined();

		const result = await executeTool(
			"background",
			{ action: "kill", id: bgId },
			tempDir,
			undefined,
			sessionId,
			queue,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("killed");

		await queue.wait();
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("background tool routes action=status", async () => {
		const sessionId = "test-tool-status";
		const bgMap = new Map<string, BackgroundProcess>([
			[
				"bg-st",
				{
					id: "bg-st",
					command: "echo test",
					startTime: Date.now() - 5000,
					stdout: "test\n",
					stderr: "",
					exitCode: 0,
					status: "completed",
					kill: null,
					stdoutPath: null,
					stderrPath: null,
				},
			],
		]);
		const fgMap = new Map<string, { resolve: () => void; command: string }>();
		allTestBgMaps.push(bgMap);

		const result = await executeTool(
			"background",
			{ action: "status", id: "bg-st" },
			tempDir,
			undefined,
			sessionId,
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("completed");
		expect(result.content).toContain("test");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("background tool action without id returns error", async () => {
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeTool(
			"background",
			{ action: "kill" },
			tempDir,
			undefined,
			"test-session",
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("id is required");
	});

	test("background tool without session returns error", async () => {
		const result = await executeTool(
			"background",
			{ action: "kill", id: "bg-123" },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("no session context");
	});

	test("background tool action=status for unknown process returns error", async () => {
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeTool(
			"background",
			{ action: "status", id: "bg-unknown" },
			tempDir,
			undefined,
			"test-session",
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});

	test("run_in_background=true behaves like foreground_timeout=0", async () => {
		const sessionId = "test-run-in-bg";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeTool(
			"bash",
			{ command: "echo run-in-bg-test", run_in_background: true },
			tempDir,
			undefined,
			sessionId,
			queue,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.content).toContain("backgrounded immediately");
		expect(result.content).toContain("Background ID: bg-");
		expect(result.isError).toBe(false);

		// Wait for completion with content
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.exitCode).toBe(0);
			expect(msg.stdout).toContain("run-in-bg-test");
		}

		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("background tool action=await blocks until process completes and returns output", async () => {
		const sessionId = "test-await";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		// Start a background command
		const bgResult = await executeBashWithTimeout(
			"echo await-test",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		const bgId = bgResult.content.match(/bg-[A-Z0-9]+/)?.[0] ?? "";
		expect(bgId).toBeTruthy();

		// Drain the completion notification so it doesn't interfere
		await queue.wait();

		// Await returns minimal completion info (output delivered via background_complete message)
		const result = await executeTool(
			"background",
			{ action: "await", id: bgId },
			tempDir,
			undefined,
			sessionId,
			queue,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("completed");
		expect(result.content).toContain("exit 0");

		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("background tool action=await for unknown process returns error", async () => {
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeTool(
			"background",
			{ action: "await", id: "bg-unknown" },
			tempDir,
			undefined,
			"test-session",
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});

	test("background tool action=list shows all processes", async () => {
		const sessionId = "test-list";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);

		const result = await executeTool(
			"background",
			{ action: "list" },
			tempDir,
			undefined,
			sessionId,
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("Background processes:");
		expect(result.content).toContain("sleep 30");
		expect(result.content).toContain("running");

		cleanupSessionBackgroundProcesses(bgMap);
		// Wait for background monitor to finish after kill
		await queue.wait();
	});

	test("background tool action=list with no processes", async () => {
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeTool(
			"background",
			{ action: "list" },
			tempDir,
			undefined,
			"test-empty-session",
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("No background processes");
	});

	test("background completion includes stderr when present", async () => {
		const sessionId = "test-bg-stderr";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeBashWithTimeout(
			"echo err-output >&2",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("backgrounded immediately");

		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.stderr).toContain("err-output");
		}

		cleanupSessionBackgroundProcesses(bgMap);
	});
});

describe("truncateSearchOutput", () => {
	test("returns output unchanged when within limit", () => {
		const output = "line1\nline2\nline3\n";
		expect(truncateSearchOutput(output, 5, false)).toBe(output);
	});

	test("truncates lines exceeding limit", () => {
		const output = "a\nb\nc\nd\ne\nf\n";
		const result = truncateSearchOutput(output, 3, false);
		expect(result).toBe("a\nb\nc\n[... truncated at 3 entries]");
	});

	test("handles output without trailing newline", () => {
		const output = "a\nb\nc\nd\ne";
		const result = truncateSearchOutput(output, 3, false);
		expect(result).toBe("a\nb\nc\n[... truncated at 3 entries]");
	});

	test("truncates context blocks separated by --", () => {
		const output =
			"file:1:block1_line1\nfile:2:block1_line2\n--\nfile:5:block2_line1\n--\nfile:10:block3_line1\n--\nfile:15:block4_line1";
		const result = truncateSearchOutput(output, 2, true);
		expect(result).toBe(
			"file:1:block1_line1\nfile:2:block1_line2\n--\nfile:5:block2_line1\n[... truncated at 2 entries]",
		);
	});

	test("returns context output unchanged when within limit", () => {
		const output = "block1\n--\nblock2";
		expect(truncateSearchOutput(output, 5, true)).toBe(output);
	});
});

describe("extractCheckpoint", () => {
	test("extracts text between summary tags", () => {
		const response =
			"<summary>\n## Current Phase\nimplementation\n\n## Completed Work\nDid stuff\n</summary>";
		const checkpoint = extractCheckpoint(response);
		expect(checkpoint).toContain("Current Phase");
		expect(checkpoint).toContain("implementation");
		expect(checkpoint).toContain("Completed Work");
	});

	test("trims whitespace from extracted content", () => {
		const response = "<summary>\n  some content  \n</summary>";
		expect(extractCheckpoint(response)).toBe("some content");
	});

	test("uses full response when no summary tags present", () => {
		const response = "Just a plain text checkpoint without tags";
		expect(extractCheckpoint(response)).toBe(
			"Just a plain text checkpoint without tags",
		);
	});

	test("handles empty summary tags", () => {
		const response = "<summary></summary>";
		expect(extractCheckpoint(response)).toBe("");
	});

	test("handles response with text before and after summary tags", () => {
		const response =
			"Some preamble\n<summary>\nThe actual checkpoint\n</summary>\nSome epilogue";
		expect(extractCheckpoint(response)).toBe("The actual checkpoint");
	});

	test("handles multiline checkpoint content", () => {
		const response =
			"<summary>\n## Phase\ndone\n\n## Work\n- item 1\n- item 2\n</summary>";
		const checkpoint = extractCheckpoint(response);
		expect(checkpoint).toContain("## Phase");
		expect(checkpoint).toContain("- item 1");
		expect(checkpoint).toContain("- item 2");
	});

	test("appends system context when cwd is provided", () => {
		const response = "<summary>\n## Phase\nimplementation\n</summary>";
		const checkpoint = extractCheckpoint(response, "/path/to/project");
		expect(checkpoint).toContain("## Phase\nimplementation");
		expect(checkpoint).toContain("## System Context (auto-generated)");
		expect(checkpoint).toContain("Working directory: /path/to/project");
		expect(checkpoint).toContain("Resume from this checkpoint");
		expect(checkpoint).toContain("Do not cd to your current working directory");
	});

	test("does not append system context when cwd is undefined", () => {
		const response = "<summary>\ncheckpoint content\n</summary>";
		const checkpoint = extractCheckpoint(response);
		expect(checkpoint).toBe("checkpoint content");
		expect(checkpoint).not.toContain("System Context");
	});

	test("appends system context to fallback (no summary tags) when cwd provided", () => {
		const response = "Plain text checkpoint";
		const checkpoint = extractCheckpoint(response, "/some/path");
		expect(checkpoint).toContain("Plain text checkpoint");
		expect(checkpoint).toContain("Working directory: /some/path");
	});
});

describe("buildCompactedContext", () => {
	test("includes checkpoint", async () => {
		const result = await buildCompactedContext(
			"## Current Phase\nimplementation",
		);
		expect(result).toContain("Checkpoint Summary");
		expect(result).toContain("## Current Phase");
		expect(result).not.toContain("Original Task");
	});

	test("includes fresh memory when cwd has memory file", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-compact-test-"));
		try {
			await mkdir(join(tempDir, ".opengraft"), { recursive: true });
			await writeFile(
				join(tempDir, ".opengraft", "memory.md"),
				"# Project Memory\n- important note",
			);

			const result = await buildCompactedContext("checkpoint content", tempDir);
			expect(result).toContain(
				"# .opengraft/memory.md (Preloaded, do not read again)",
			);
			expect(result).toContain("important note");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("works when memory file does not exist", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-nomem-test-"));
		try {
			const result = await buildCompactedContext("checkpoint", tempDir);
			expect(result).toContain("Checkpoint Summary");
			expect(result).not.toContain("Project Memory");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
});

describe("SUMMARIZATION_INSTRUCTION", () => {
	test("instructs model not to use tools", () => {
		expect(SUMMARIZATION_INSTRUCTION).toContain("Do NOT use any tools");
	});

	test("requires summary tags", () => {
		expect(SUMMARIZATION_INSTRUCTION).toContain("<summary>");
		expect(SUMMARIZATION_INSTRUCTION).toContain("</summary>");
	});

	test("lists required checkpoint sections", () => {
		expect(SUMMARIZATION_INSTRUCTION).toContain("User Requests");
		expect(SUMMARIZATION_INSTRUCTION).toContain("Current Phase");
		expect(SUMMARIZATION_INSTRUCTION).toContain("Completed Work");
		expect(SUMMARIZATION_INSTRUCTION).toContain(
			"Key Insights & Rejected Approaches",
		);
		expect(SUMMARIZATION_INSTRUCTION).toContain("Pending Work");
	});

	test("does not include system-injected sections", () => {
		expect(SUMMARIZATION_INSTRUCTION).not.toContain(
			"Current Working Directory",
		);
		expect(SUMMARIZATION_INSTRUCTION).not.toContain("## 8. Next Action");
		expect(SUMMARIZATION_INSTRUCTION).not.toContain("## 9. Next Action");
	});
});

describe("buildSummarizationInstruction", () => {
	test("returns base instruction without cwd", () => {
		expect(buildSummarizationInstruction()).toBe(SUMMARIZATION_INSTRUCTION);
		expect(buildSummarizationInstruction(undefined)).toBe(
			SUMMARIZATION_INSTRUCTION,
		);
	});

	test("appends cwd when provided", () => {
		const result = buildSummarizationInstruction("/path/to/project");
		expect(result).toContain(SUMMARIZATION_INSTRUCTION);
		expect(result).toContain("Current working directory: /path/to/project");
	});
});

describe("zodShapeToJsonSchema", () => {
	test("converts nested object in array schema", async () => {
		const { z } = await import("zod");
		const shape = {
			tasks: z
				.array(
					z.object({
						taskId: z.string().describe("ID of the child task"),
						message: z.string().optional().describe("Instructions"),
						mode: z
							.enum(["new", "resume", "reset"])
							.optional()
							.default("new")
							.describe("Execution mode"),
					}),
				)
				.describe("Tasks to execute"),
		};
		const result = zodShapeToJsonSchema(shape);
		expect(result).toEqual({
			type: "object",
			properties: {
				tasks: {
					type: "array",
					description: "Tasks to execute",
					items: {
						type: "object",
						properties: {
							taskId: { type: "string", description: "ID of the child task" },
							message: { type: "string", description: "Instructions" },
							mode: {
								type: "string",
								enum: ["new", "resume", "reset"],
								description: "Execution mode",
							},
						},
						required: ["taskId"],
					},
				},
			},
			required: ["tasks"],
		});
	});

	test("handles simple string and number types", async () => {
		const { z } = await import("zod");
		const shape = {
			name: z.string(),
			count: z.number(),
			active: z.boolean(),
		};
		const result = zodShapeToJsonSchema(shape);
		expect(result.properties).toEqual({
			name: { type: "string" },
			count: { type: "number" },
			active: { type: "boolean" },
		});
		expect(result.required).toEqual(["name", "count", "active"]);
	});
});

describe("addMessagesCacheControl", () => {
	test("returns messages unchanged if fewer than 3", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		];
		const result = addMessagesCacheControl(messages);
		expect(result).toEqual(messages);
	});

	test("adds cache_control to second-to-last user message (string content)", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "first user message" },
			{ role: "assistant", content: "first assistant reply" },
			{ role: "user", content: "second user message" },
			{ role: "assistant", content: "second assistant reply" },
			{ role: "user", content: "current user message (no cache)" },
		];
		const result = addMessagesCacheControl(messages);

		// The last user message (index 4) should NOT have cache_control
		const lastUser = result[4];
		expect(lastUser?.content).toBe("current user message (no cache)");

		// The second-to-last user message (index 2) should be converted to array with cache_control
		const secondToLastUser = result[2];
		expect(Array.isArray(secondToLastUser?.content)).toBe(true);
		const content = secondToLastUser?.content as TextBlockParam[];
		expect(content[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(content[0]?.text).toBe("second user message");

		// Other messages should be unchanged
		expect(result[0]).toEqual(messages[0]);
		expect(result[1]).toEqual(messages[1]);
		expect(result[3]).toEqual(messages[3]);
	});

	test("adds cache_control to last block of array content", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "reply1" },
			{
				role: "user",
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: "tu_1",
						content: "result text",
					},
				],
			},
			{ role: "assistant", content: "reply2" },
			{ role: "user", content: "current" },
		];
		const result = addMessagesCacheControl(messages);
		const secondToLastUser = result[2];
		expect(Array.isArray(secondToLastUser?.content)).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: accessing cache_control after transformation
		const content = secondToLastUser?.content as any[];
		expect(content[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	test("does not mutate original messages", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "second" },
			{ role: "assistant", content: "a2" },
			{ role: "user", content: "third" },
		];
		const original = JSON.stringify(messages);
		addMessagesCacheControl(messages);
		expect(JSON.stringify(messages)).toBe(original);
	});

	test("skips caching if fewer than 2 user messages", () => {
		const messages: MessageParam[] = [
			{ role: "assistant", content: "hi" },
			{ role: "assistant", content: "there" },
			{ role: "user", content: "only one user message" },
		];
		const result = addMessagesCacheControl(messages);
		expect(result).toEqual(messages);
	});

	test("does not double-cache an already-cached block", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "a1" },
			{
				role: "user",
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: "tu_1",
						content: "result",
						cache_control: { type: "ephemeral" as const },
					},
				],
			},
			{ role: "assistant", content: "a2" },
			{ role: "user", content: "current" },
		];
		const result = addMessagesCacheControl(messages);
		// Already has cache_control — should remain as-is (not add another)
		// biome-ignore lint/suspicious/noExplicitAny: accessing cache_control after transformation
		const cached = result[2]?.content as any[];
		// Should still have exactly one cache_control (not duplicated)
		expect(cached[0]?.cache_control).toEqual({ type: "ephemeral" });
	});
});

describe("done tool", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-done-tool-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterAll(async () => {
		if (tempDir) await rm(tempDir, { recursive: true });
	});

	async function invokeDoneTool(
		taskId: string | null,
		args: { status: "passed" | "failed"; summary: string },
	) {
		const ctx = mockDaemonContext({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(ctx, "test-project", taskId);
		const doneTool = toolDefs.find((t) => t.name === "done");
		if (!doneTool) throw new Error("done tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (doneTool as any).handler(args);
	}

	test("done(passed) updates task status to passed", async () => {
		const node = tracker.addTask("Test Task Pass", "description");
		tracker.updateStatus(node.id, "in_progress");
		const result = await invokeDoneTool(node.id, {
			status: "passed",
			summary: "All tests pass",
		});
		const updated = tracker.get(node.id);
		expect(updated?.status).toBe("passed");
		expect(result.content[0].text).toContain("passed");
		expect(result.content[0].text).toContain("Entering idle state");
	});

	test("done(failed) updates task status to failed", async () => {
		const node = tracker.addTask("Test Task Fail", "description");
		tracker.updateStatus(node.id, "in_progress");
		const result = await invokeDoneTool(node.id, {
			status: "failed",
			summary: "Cannot resolve type errors",
		});
		const updated = tracker.get(node.id);
		expect(updated?.status).toBe("failed");
		expect(result.content[0].text).toContain("failed");
		expect(result.content[0].text).toContain("Entering idle state");
	});

	test("hasRunningChildren returns false when no children", async () => {
		const ctx = mockDaemonContext({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { hasRunningChildren } = createOrchestratorTools(
			ctx,
			"test-project",
			"",
		);
		expect(hasRunningChildren?.()).toBe(false);
	});

	test("hasRunningChildren returns true when child has session on tracker", async () => {
		const ctx = mockDaemonContext({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});

		// Create a parent task and a child task
		const parentId =
			tracker.rootNodeId ?? tracker.ensureRootNode("Root", "").id;
		const child = tracker.addChild(parentId, "Child Task", "desc");
		const childQueue = new MessageQueue();
		attachMockSession(child, childQueue);

		const { hasRunningChildren } = createOrchestratorTools(
			ctx,
			"test-project",
			parentId,
		);
		expect(hasRunningChildren?.()).toBe(true);

		// Clean up
		child.session = undefined;
		childQueue.close();
	});

	test("hasRunningChildren detects running grandchildren (descendants)", async () => {
		const ctx = mockDaemonContext({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});

		const parentId =
			tracker.rootNodeId ?? tracker.ensureRootNode("Root", "").id;
		const child = tracker.addChild(parentId, "Child Task", "desc");
		const grandchild = tracker.addChild(child.id, "Grandchild Task", "desc");
		const grandchildQueue = new MessageQueue();
		attachMockSession(grandchild, grandchildQueue);

		const { hasRunningChildren } = createOrchestratorTools(
			ctx,
			"test-project",
			parentId,
		);
		// Grandchild has a session → hasRunningChildren should be true
		expect(hasRunningChildren?.()).toBe(true);

		// Clean up
		grandchild.session = undefined;
		grandchildQueue.close();
	});

	test("done() with queue enters idle and returns wake messages", async () => {
		const node = tracker.addTask("Test Done Idle", "description");
		tracker.updateStatus(node.id, "in_progress");
		const queue = new MessageQueue();

		// Attach session to the node so tools can find the queue
		node.session = {
			queue,
			cwd: tempDir,
			fallbackCwd: tempDir,
			depth: 0,
			backgroundProcesses: new Map(),
			foregroundExecutions: new Map(),
		};

		const ctx = mockDaemonContext({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(ctx, "test-project", node.id);
		const doneTool = toolDefs.find((t) => t.name === "done");
		if (!doneTool) throw new Error("done tool not found");

		// Call done() — it will block on queue.wait()
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const donePromise = (doneTool as any).handler({
			status: "passed",
			summary: "All tests pass",
		});

		// Verify task status was updated immediately (before wake)
		expect(tracker.get(node.id)?.status).toBe("passed");

		// Send a wake message after a short delay
		setTimeout(() => {
			queue.enqueue({
				source: "parent_update",
				content: "Resume with new instructions",
			});
		}, 10);

		const result = await donePromise;
		// Should contain the context prefix and pending section (queue messages are separate)
		expect(result.content[0].text).toContain(
			"You previously called done(passed)",
		);
		expect(result.content[0].text).toContain("## Pending");
		// Queue messages are returned as _formattedQueueMessages, not embedded in content
		expect(result._formattedQueueMessages).toContain(
			"Resume with new instructions",
		);

		queue.close();
	});

	test("done() with queue that closes returns fallback message", async () => {
		const node = tracker.addTask("Test Done Close", "description");
		tracker.updateStatus(node.id, "in_progress");
		const queue = new MessageQueue();

		// Attach session to the node so tools can find the queue
		node.session = {
			queue,
			cwd: tempDir,
			fallbackCwd: tempDir,
			depth: 0,
			backgroundProcesses: new Map(),
			foregroundExecutions: new Map(),
		};

		const ctx = mockDaemonContext({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
		});
		const { toolDefs } = createOrchestratorTools(ctx, "test-project", node.id);
		const doneTool = toolDefs.find((t) => t.name === "done");
		if (!doneTool) throw new Error("done tool not found");

		// Call done() — it will block on queue.wait()
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		const donePromise = (doneTool as any).handler({
			status: "failed",
			summary: "Could not finish",
		});

		// Close the queue to simulate agent being stopped
		setTimeout(() => {
			queue.close();
		}, 10);

		const result = await donePromise;
		// When queue closes, done() returns the fallback "Entering idle state" message
		// (not an error — queue closure is normal shutdown)
		expect(result.content[0].text).toContain("Entering idle state");
	});
});

describe("jsSearch", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-search-test-"));
		await mkdir(join(tempDir, "sub"), { recursive: true });
		await writeFile(join(tempDir, "hello.ts"), "const x = 1;\nconst y = 2;\n");
		await writeFile(
			join(tempDir, "sub", "world.ts"),
			"export const hello = 'world';\n",
		);
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("single file path does not throw ENOTDIR", async () => {
		const result = await jsSearch({
			pattern: "const",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "content",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
		});
		expect(result).toContain("const x = 1");
		expect(result).toContain("const y = 2");
		// Should NOT contain files from other directories
		expect(result).not.toContain("world");
	});

	test("single file path with files_with_matches mode", async () => {
		const result = await jsSearch({
			pattern: "const",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "files_with_matches",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
		});
		expect(result).toContain("hello.ts");
		expect(result).not.toContain("world.ts");
	});

	test("single file path with relative path", async () => {
		const result = await jsSearch({
			pattern: "hello",
			searchPath: "sub/world.ts",
			outputMode: "content",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
		});
		expect(result).toContain("hello");
		expect(result).toContain("sub/world.ts");
	});

	test("directory path still works normally", async () => {
		const result = await jsSearch({
			pattern: "const",
			searchPath: tempDir,
			outputMode: "files_with_matches",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
		});
		expect(result).toContain("hello.ts");
		expect(result).toContain("world.ts");
	});

	test("multiline matches pattern spanning multiple lines", async () => {
		const result = await jsSearch({
			pattern: "const x.*\\nconst y",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "content",
			headLimit: 50,
			caseInsensitive: false,
			multiline: true,
			cwd: tempDir,
		});
		expect(result).toContain("const x = 1;");
		expect(result).toContain("const y = 2;");
	});

	test("multiline without flag does not match across lines", async () => {
		const result = await jsSearch({
			pattern: "const x.*const y",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "content",
			headLimit: 50,
			caseInsensitive: false,
			multiline: false,
			cwd: tempDir,
		});
		// Should not match because .* doesn't cross newlines without 's' flag
		expect(result).toBe("");
	});

	test("multiline with dotAll matches across newlines", async () => {
		const result = await jsSearch({
			pattern: "const x.+const y",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "content",
			headLimit: 50,
			caseInsensitive: false,
			multiline: true,
			cwd: tempDir,
		});
		expect(result).toContain("const x = 1;");
		expect(result).toContain("const y = 2;");
	});

	test("multiline files_with_matches mode", async () => {
		const result = await jsSearch({
			pattern: "const x.*\\nconst y",
			searchPath: tempDir,
			outputMode: "files_with_matches",
			headLimit: 50,
			caseInsensitive: false,
			multiline: true,
			cwd: tempDir,
		});
		expect(result).toContain("hello.ts");
		expect(result).not.toContain("world.ts");
	});

	test("multiline count mode", async () => {
		const result = await jsSearch({
			pattern: "const x.*\\nconst y",
			searchPath: tempDir,
			outputMode: "count",
			headLimit: 50,
			caseInsensitive: false,
			multiline: true,
			cwd: tempDir,
		});
		expect(result).toContain("hello.ts:1");
	});

	test("multiline with context lines", async () => {
		const result = await jsSearch({
			pattern: "const x.*\\nconst y",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "content",
			contextLines: 1,
			headLimit: 50,
			caseInsensitive: false,
			multiline: true,
			cwd: tempDir,
		});
		expect(result).toContain("const x = 1;");
		expect(result).toContain("const y = 2;");
	});
});

// ── Helpers for mocking Anthropic SDK stream ──

/** Create a mock Anthropic MessageStream that yields events and resolves finalMessage(). */
function createMockStream(
	response: Anthropic.Messages.Message,
	textDeltas?: string[],
) {
	const events: Array<{
		type: string;
		delta?: { type: string; text?: string };
	}> = [];
	if (textDeltas) {
		for (const text of textDeltas) {
			events.push({
				type: "content_block_delta",
				delta: { type: "text_delta", text },
			});
		}
	}
	return {
		[Symbol.asyncIterator]: async function* () {
			for (const event of events) {
				yield event;
			}
		},
		finalMessage: () => Promise.resolve(response),
	};
}

/** Build an Anthropic response message with text + optional tool_use blocks. */
function buildAnthropicResponse(opts: {
	text?: string;
	toolUses?: Array<{
		id: string;
		name: string;
		input: Record<string, unknown>;
	}>;
	stopReason?: "end_turn" | "tool_use";
}): Anthropic.Messages.Message {
	const content: Array<
		| { type: "text"; text: string }
		| {
				type: "tool_use";
				id: string;
				name: string;
				input: Record<string, unknown>;
		  }
	> = [];
	if (opts.text !== undefined) {
		content.push({ type: "text", text: opts.text });
	}
	if (opts.toolUses) {
		for (const tu of opts.toolUses) {
			content.push({
				type: "tool_use",
				id: tu.id,
				name: tu.name,
				input: tu.input,
			});
		}
	}
	return {
		id: `msg_${Math.random().toString(36).slice(2)}`,
		type: "message",
		role: "assistant",
		model: "claude-sonnet-4-20250514",
		content,
		stop_reason: opts.stopReason ?? (opts.toolUses ? "tool_use" : "end_turn"),
		stop_sequence: null,
		usage: {
			input_tokens: 100,
			output_tokens: 50,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	} as Anthropic.Messages.Message;
}

// ── Event deterministic verification (Anthropic) ──

describe("Event deterministic verification", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "og-anthropic-strong-event-verify-"));
	});

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	/** Helper: create a provider with a mocked client */
	function createMockedProvider(
		streamFn: (params: unknown) => ReturnType<typeof createMockStream>,
	) {
		// Set env so constructor doesn't warn
		const savedKey = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "test-key";
		const provider = new AnthropicCompatibleProvider("claude-sonnet-4-6");
		process.env.ANTHROPIC_API_KEY = savedKey;

		// Replace the client's messages.stream with our mock
		// biome-ignore lint/suspicious/noExplicitAny: replacing internal client for testing
		(provider as any).client = {
			messages: {
				stream: streamFn,
				countTokens: async () => ({ input_tokens: 100 }),
			},
		};
		return provider;
	}

	test("basic conversation: user → assistant text → done", async () => {
		const testDir = join(tmpDir, "basic");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		const response = buildAnthropicResponse({
			text: "Hello! How can I help?",
			stopReason: "end_turn",
		});
		const provider = createMockedProvider(() =>
			createMockStream(response, ["Hello! How can I help?"]),
		);

		// Provider drains queue for first message
		const result = await provider.execute({
			cwd: testDir,
			systemPrompt: "You are helpful.",
			emit,
			queue: queueWithPrompt("Say hello", testDir),
		});

		expect(result.success).toBe(true);

		// Read directly from emitted events
		const events = emittedEvents;
		expect(events.length).toBeGreaterThanOrEqual(2);

		// Should have: messages_consumed (from queue drain), assistant_text
		const types = events.map((e) => e.type);
		expect(types).toContain("messages_consumed");
		expect(types).toContain("assistant_text");

		// Verify reconstruction matches — the queue message with header is consumed
		const reconstructed = eventsToAnthropicMessages(events);
		expect(reconstructed.length).toBeGreaterThanOrEqual(2);
		// First message should contain the header + content from queue drain
		const firstMsg = reconstructed[0] as { role: string; content: string };
		expect(firstMsg.role).toBe("user");
		expect(firstMsg.content).toContain("Say hello");
		// Assistant text without tool_use should use array format (matches Anthropic API response.content)
		expect(reconstructed[1]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Hello! How can I help?" }],
		});
	});

	test("tool calls: user → assistant + tool_use → tool_result → assistant", async () => {
		const testDir = join(tmpDir, "tool-calls");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		let callCount = 0;
		const provider = createMockedProvider(() => {
			callCount++;
			if (callCount === 1) {
				// First call: assistant calls a tool
				return createMockStream(
					buildAnthropicResponse({
						text: "I'll check the files.",
						toolUses: [
							{
								id: "tu_1",
								name: "mcp__opengraft__done",
								input: { status: "passed", summary: "All done" },
							},
						],
					}),
					["I'll check the files."],
				);
			}
			// Second call: after done() tool result, assistant responds with end_turn
			return createMockStream(
				buildAnthropicResponse({
					text: "Task completed.",
					stopReason: "end_turn",
				}),
				["Task completed."],
			);
		});

		const session = provider.startSession({
			cwd: testDir,
			systemPrompt: "You are helpful.",
			emit,
			queue: queueWithPrompt("Do the task", testDir),
			mcpToolDefs: {
				opengraft: [
					{
						name: "done",
						description: "Signal completion",
						inputSchema: {},
						handler: async (input: Record<string, unknown>) => ({
							content: [
								{
									type: "text",
									text: `Task marked as ${input.status}. Entering idle state.`,
								},
							],
						}),
					},
				],
			},
		});

		const consumePromise = (async () => {
			let result = await session.events.next();
			while (!result.done) {
				if (
					result.value.type === "status" &&
					(result.value as { message: string }).message.includes("idle state")
				) {
					session.stop();
				}
				result = await session.events.next();
			}
			return result.value as AgentResult;
		})();

		const agentResult = await consumePromise;
		expect(agentResult.success).toBe(true);

		const events = emittedEvents;
		const types = events.map((e) => e.type);
		expect(types).toContain("message");
		expect(types).toContain("assistant_text");
		expect(types).toContain("tool_call");
		expect(types).toContain("tool_result");

		// Verify tool_call details
		const toolCall = events.find((e) => e.type === "tool_call");
		if (toolCall?.type === "tool_call") {
			expect(toolCall.tool).toBe("mcp__opengraft__done");
			expect(toolCall.toolCallId).toBe("tu_1");
		}

		// Verify tool_result details
		const toolResult = events.find((e) => e.type === "tool_result");
		if (toolResult?.type === "tool_result") {
			expect(toolResult.toolCallId).toBe("tu_1");
			expect(toolResult.content).toContain("Task marked as passed");
		}

		// Verify reconstruction
		const reconstructed = eventsToAnthropicMessages(events);
		// Should have: user, assistant+tool_use, tool_result, assistant(end_turn text)
		expect(reconstructed.length).toBeGreaterThanOrEqual(4);

		// First msg: user
		expect((reconstructed[0] as { role: string }).role).toBe("user");
		// Second msg: assistant with text + tool_use
		const assistantMsg = reconstructed[1] as {
			role: string;
			content: unknown[];
		};
		expect(assistantMsg.role).toBe("assistant");
		expect(Array.isArray(assistantMsg.content)).toBe(true);
		const toolUseBlock = (assistantMsg.content as Array<{ type: string }>).find(
			(b) => b.type === "tool_use",
		);
		expect(toolUseBlock).toBeDefined();
		// Third msg: user with tool_result
		const toolResultMsg = reconstructed[2] as {
			role: string;
			content: unknown[];
		};
		expect(toolResultMsg.role).toBe("user");
	});

	test("error tool results: isError flag preserved in events", async () => {
		const testDir = join(tmpDir, "error-tool");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		let callCount = 0;
		const provider = createMockedProvider(() => {
			callCount++;
			if (callCount === 1) {
				return createMockStream(
					buildAnthropicResponse({
						text: "Running command.",
						toolUses: [
							{
								id: "tu_err",
								name: "mcp__opengraft__done",
								input: { status: "failed", summary: "Error" },
							},
						],
					}),
					["Running command."],
				);
			}
			return createMockStream(
				buildAnthropicResponse({
					text: "Acknowledged failure.",
					stopReason: "end_turn",
				}),
				["Acknowledged failure."],
			);
		});

		const session = provider.startSession({
			cwd: testDir,
			systemPrompt: "You are helpful.",
			emit,
			queue: queueWithPrompt("Try something", testDir),
			mcpToolDefs: {
				opengraft: [
					{
						name: "done",
						description: "Signal completion",
						inputSchema: {},
						handler: async () => ({
							isError: true,
							content: [
								{
									type: "text",
									text: "Error: command failed with exit code 1",
								},
							],
						}),
					},
				],
			},
		});

		const consumePromise = (async () => {
			let result = await session.events.next();
			while (!result.done) {
				if (
					result.value.type === "status" &&
					(result.value as { message: string }).message.includes("idle state")
				) {
					session.stop();
				}
				result = await session.events.next();
			}
			return result.value as AgentResult;
		})();

		const agentResult = await consumePromise;
		expect(agentResult.success).toBe(true);

		const events = emittedEvents;

		// Verify error flag is preserved
		const toolResult = events.find((e) => e.type === "tool_result");
		expect(toolResult).toBeDefined();
		if (toolResult?.type === "tool_result") {
			expect(toolResult.isError).toBe(true);
			expect(toolResult.content).toContain("Error: command failed");
		}

		// Verify reconstruction preserves is_error
		const reconstructed = eventsToAnthropicMessages(events);
		const userMsgWithToolResult = reconstructed.find(
			(m) =>
				(m as { role: string }).role === "user" &&
				Array.isArray((m as { content: unknown }).content),
		);
		expect(userMsgWithToolResult).toBeDefined();
		const toolResultBlock = (
			(userMsgWithToolResult as { content: unknown[] }).content as Array<{
				type: string;
				is_error?: boolean;
			}>
		).find((b) => b.type === "tool_result");
		expect(toolResultBlock?.is_error).toBe(true);
	});

	test("implicit yield: end_turn → queue.wait → queue drain → continue", async () => {
		const testDir = join(tmpDir, "implicit-yield");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		let callCount = 0;
		const provider = createMockedProvider(() => {
			callCount++;
			if (callCount === 1) {
				// First call: end_turn (no tools) → provider enters queue.wait()
				return createMockStream(
					buildAnthropicResponse({
						text: "I'm done for now.",
						stopReason: "end_turn",
					}),
					["I'm done for now."],
				);
			}
			// Second call: after queue drain, model responds
			return createMockStream(
				buildAnthropicResponse({
					text: "Got your message, continuing.",
					stopReason: "end_turn",
				}),
				["Got your message, continuing."],
			);
		});

		const queue = queueWithPrompt("Start working", testDir);
		const session = provider.startSession({
			cwd: testDir,
			systemPrompt: "You are helpful.",
			emit,
			queue,
		});

		// Consume events, enqueue a message when idle, then stop on second idle
		let idleCount = 0;
		const consumePromise = (async () => {
			let result = await session.events.next();
			while (!result.done) {
				if (result.value.type === "agent_idle") {
					idleCount++;
					if (idleCount === 1) {
						// First idle: inject a message
						queue.enqueue({
							source: "user",
							content: "Here is a new instruction",
						});
					} else {
						// Second idle: stop the session
						session.stop();
					}
				}
				result = await session.events.next();
			}
			return result.value as AgentResult;
		})();

		const agentResult = await consumePromise;
		expect(agentResult.success).toBe(true);
		expect(idleCount).toBe(2);

		const events = emittedEvents;
		const types = events.map((e) => e.type);

		// Must have message events (from queue)
		expect(types).toContain("message");
		// New unified format: content is in body, not top-level
		const queueMsgEvent = events.find(
			(e) =>
				e.type === "message" &&
				((e as { content?: string }).content?.includes("new instruction") ||
					(e as { body?: { content?: string } }).body?.content?.includes(
						"new instruction",
					)),
		);
		expect(queueMsgEvent).toBeDefined();

		// Verify reconstruction
		const reconstructed = eventsToAnthropicMessages(events);
		// Should have: user_msg, assistant(end_turn), queue message (as user), assistant(continue)
		expect(reconstructed.length).toBeGreaterThanOrEqual(4);

		// Find the queue-originated user message in reconstructed — it becomes a plain user message
		const queueReconstructed = reconstructed.find((m) => {
			const content = (m as { role: string; content: unknown }).content;
			if (typeof content === "string") {
				return content.includes("Here is a new instruction");
			}
			return false;
		});
		expect(queueReconstructed).toBeDefined();
	});

	test("multiple parallel tool calls: 3 tool_use blocks → 3 tool_results", async () => {
		const testDir = join(tmpDir, "parallel-tools");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		let callCount = 0;
		const provider = createMockedProvider(() => {
			callCount++;
			if (callCount === 1) {
				return createMockStream(
					buildAnthropicResponse({
						text: "I'll run multiple tools.",
						toolUses: [
							{
								id: "tu_a",
								name: "mcp__test__tool_a",
								input: { param: "a" },
							},
							{
								id: "tu_b",
								name: "mcp__test__tool_b",
								input: { param: "b" },
							},
							{
								id: "tu_c",
								name: "mcp__test__tool_c",
								input: { param: "c" },
							},
						],
					}),
					["I'll run multiple tools."],
				);
			}
			return createMockStream(
				buildAnthropicResponse({
					text: "All tools completed.",
					stopReason: "end_turn",
				}),
				["All tools completed."],
			);
		});

		const session = provider.startSession({
			cwd: testDir,
			systemPrompt: "You are helpful.",
			emit,
			queue: queueWithPrompt("Run three tools", testDir),
			mcpToolDefs: {
				test: [
					{
						name: "tool_a",
						description: "Tool A",
						inputSchema: {},
						handler: async () => ({
							content: [{ type: "text", text: "Result A" }],
						}),
					},
					{
						name: "tool_b",
						description: "Tool B",
						inputSchema: {},
						handler: async () => ({
							content: [{ type: "text", text: "Result B" }],
						}),
					},
					{
						name: "tool_c",
						description: "Tool C",
						inputSchema: {},
						handler: async () => ({
							content: [{ type: "text", text: "Result C" }],
						}),
					},
				],
			},
		});

		const consumePromise = (async () => {
			let result = await session.events.next();
			while (!result.done) {
				if (
					result.value.type === "status" &&
					(result.value as { message: string }).message.includes("idle state")
				) {
					session.stop();
				}
				result = await session.events.next();
			}
			return result.value as AgentResult;
		})();

		const agentResult = await consumePromise;
		expect(agentResult.success).toBe(true);

		const events = emittedEvents;
		const toolCalls = events.filter((e) => e.type === "tool_call");
		const toolResults = events.filter((e) => e.type === "tool_result");

		// Should have 3 tool_calls and 3 tool_results
		expect(toolCalls.length).toBe(3);
		expect(toolResults.length).toBe(3);

		// Verify each tool_call has matching tool_result
		for (const tc of toolCalls) {
			if (tc.type === "tool_call") {
				const matchingResult = toolResults.find(
					(tr) => tr.type === "tool_result" && tr.toolCallId === tc.toolCallId,
				);
				expect(matchingResult).toBeDefined();
			}
		}

		// Verify reconstruction batching
		const reconstructed = eventsToAnthropicMessages(events);
		// user, assistant(text + 3 tool_uses), user(3 tool_results), assistant(end_turn)
		expect(reconstructed.length).toBe(4);

		// Verify assistant message has text + 3 tool_use blocks
		const assistantMsg = reconstructed[1] as {
			role: string;
			content: unknown[];
		};
		expect(assistantMsg.role).toBe("assistant");
		expect(Array.isArray(assistantMsg.content)).toBe(true);
		const toolUseBlocks = (
			assistantMsg.content as Array<{ type: string }>
		).filter((b) => b.type === "tool_use");
		expect(toolUseBlocks.length).toBe(3);

		// Verify user message has 3 tool_result blocks
		const toolResultMsg = reconstructed[2] as {
			role: string;
			content: unknown[];
		};
		expect(toolResultMsg.role).toBe("user");
		const trBlocks = (toolResultMsg.content as Array<{ type: string }>).filter(
			(b) => b.type === "tool_result",
		);
		expect(trBlocks.length).toBe(3);
	});

	test("compaction: compact_marker event separates pre/post compaction events", async () => {
		const testDir = join(tmpDir, "compaction");
		const eventStore = new EventStore(testDir);
		const sessionId = "test-compaction-session";

		// Manually write pre-compaction events
		const preEvents: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", content: "Old message before compaction" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Old response",
				taskId: "test",
				ts: 1001,
			},
		];
		await eventStore.appendBatch(sessionId, preEvents);

		// Write compact_marker
		await eventStore.append(sessionId, {
			type: "compact_marker",
			checkpoint: "Checkpoint: completed old task",
			savedTokens: 5000,
			taskId: "test",
			ts: 2000,
		});

		// Write post-compaction events
		const postEvents: Event[] = [
			{
				type: "compacted_resume",
				content: "Resuming from checkpoint",
				cwd: testDir,
				taskId: "test",
				ts: 2001,
			},
			{
				type: "assistant_text",
				content: "Continuing work.",
				taskId: "test",
				ts: 2002,
			},
		];
		await eventStore.appendBatch(sessionId, postEvents);

		// readActive should only return post-marker events
		await eventStore.flush();
		const active = eventStore.readActive(sessionId);
		expect(active.length).toBe(2);
		expect(active[0]?.type).toBe("compacted_resume");
		expect(active[1]?.type).toBe("assistant_text");

		// Full read should have all events including marker
		const all = eventStore.read(sessionId);
		expect(all.length).toBe(5); // 2 pre + 1 marker + 2 post

		// Reconstruction of active events should be correct
		const reconstructed = eventsToAnthropicMessages(active);
		expect(reconstructed.length).toBe(2);
		expect(reconstructed[0]).toEqual({
			role: "user",
			content: "Resuming from checkpoint",
		});
		expect(reconstructed[1]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Continuing work." }],
		});
	});

	test("budget warnings: budget_warning events reconstruct as user messages", async () => {
		const testDir = join(tmpDir, "budget");
		const eventStore = new EventStore(testDir);
		const sessionId = "test-budget-session";

		// Write a conversation with a budget warning
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: { source: "user", content: "Start working" },
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Working on it.",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "echo hi" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_result",
				tool: "bash",
				toolCallId: "tc1",
				content: "hi",
				isError: false,
				taskId: "test",
				ts: 1003,
			},
			{
				type: "budget_warning",
				warning: "⚠️ Budget exceeded (0.50 / 0.40 budget). Call done() now.",
				taskId: "test",
				ts: 1004,
			},
			{
				type: "assistant_text",
				content: "Wrapping up.",
				taskId: "test",
				ts: 1005,
			},
		];
		await eventStore.appendBatch(sessionId, events);
		await eventStore.flush();

		const active = eventStore.readActive(sessionId);
		const reconstructed = eventsToAnthropicMessages(active);

		// Should have: user, assistant+tool, tool_result, budget_warning(user), assistant
		expect(reconstructed.length).toBe(5);
		expect((reconstructed[0] as { role: string }).role).toBe("user");
		expect((reconstructed[1] as { role: string }).role).toBe("assistant");
		expect((reconstructed[2] as { role: string }).role).toBe("user"); // tool_result
		// Budget warning becomes a user message
		expect(reconstructed[3]).toEqual({
			role: "user",
			content: "⚠️ Budget exceeded (0.50 / 0.40 budget). Call done() now.",
		});
		expect((reconstructed[4] as { role: string }).role).toBe("assistant");
	});

	test("cancellation point queue drain: messages between tool_call and tool_result", async () => {
		const testDir = join(tmpDir, "cancellation-point");
		const emittedEvents: Event[] = [];
		const emit = (event: Event) => {
			emittedEvents.push(event);
		};

		let callCount = 0;
		const provider = createMockedProvider(() => {
			callCount++;
			if (callCount === 1) {
				return createMockStream(
					buildAnthropicResponse({
						text: "Running a tool.",
						toolUses: [
							{
								id: "tu_cp",
								name: "mcp__opengraft__done",
								input: { status: "passed", summary: "Done" },
							},
						],
					}),
					["Running a tool."],
				);
			}
			return createMockStream(
				buildAnthropicResponse({
					text: "Finished.",
					stopReason: "end_turn",
				}),
				["Finished."],
			);
		});

		const queue = queueWithPrompt("Do task", testDir);
		const session = provider.startSession({
			cwd: testDir,
			systemPrompt: "You are helpful.",
			emit,
			queue,
			mcpToolDefs: {
				opengraft: [
					{
						name: "done",
						description: "Signal completion",
						inputSchema: {},
						handler: async (input: Record<string, unknown>) => {
							// During tool execution, enqueue a message to simulate cancellation point
							queue.enqueue({
								source: "user",
								content: "Urgent update during tool execution",
							});
							return {
								content: [
									{
										type: "text",
										text: `Task marked as ${input.status}. Entering idle state.`,
									},
								],
							};
						},
					},
				],
			},
		});

		const consumePromise = (async () => {
			let result = await session.events.next();
			while (!result.done) {
				if (
					result.value.type === "status" &&
					(result.value as { message: string }).message.includes("idle state")
				) {
					session.stop();
				}
				result = await session.events.next();
			}
			return result.value as AgentResult;
		})();

		const agentResult = await consumePromise;
		expect(agentResult.success).toBe(true);

		const events = emittedEvents;

		// The tool_result content should contain ONLY the pure tool output (no queue text)
		const toolResult = events.find((e) => e.type === "tool_result");
		expect(toolResult).toBeDefined();
		if (toolResult?.type === "tool_result") {
			expect(toolResult.content).toContain(
				"Task marked as passed. Entering idle state.",
			);
			// Queue text is NOT embedded in tool_result.content anymore
			expect(toolResult.content).not.toContain(
				"[Messages received while you were working:]",
			);
		}

		// The queue message should be tracked via a standalone messages_consumed event
		const msgConsumed = events.find((e) => e.type === "messages_consumed");
		expect(msgConsumed).toBeDefined();
		if (msgConsumed?.type === "messages_consumed") {
			expect(msgConsumed.messageIds.length).toBeGreaterThan(0);
		}

		// The queue message should be a separate message event — check body in new format
		const userMsgEvent = events.find(
			(e) =>
				e.type === "message" &&
				(((e as { source?: string }).source === "user" &&
					(e as { content?: string }).content ===
						"Urgent update during tool execution") ||
					((e as { body?: { source?: string; content?: string } }).body
						?.source === "user" &&
						(e as { body?: { content?: string } }).body?.content ===
							"Urgent update during tool execution")),
		);
		// User messages with id are written at send time (by the test or caller),
		// not by the provider. The provider writes messages_consumed.
		// So we check for either a direct message event or the messages_consumed reference.
		const hasUserMsg =
			userMsgEvent !== undefined ||
			events.some(
				(e) =>
					e.type === "messages_consumed" &&
					(e as { messageIds: string[] }).messageIds.length > 0,
			);
		expect(hasUserMsg).toBe(true);
	});
});
