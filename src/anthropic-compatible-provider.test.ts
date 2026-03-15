import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	MessageParam,
	TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { createOrchestratorTools } from "./agent-tools.ts";
import {
	addMessagesCacheControl,
	backgroundProcesses,
	buildCompactedContext,
	cleanupSessionBackgroundProcesses,
	executeBashWithTimeout,
	executeTool,
	extractCheckpoint,
	getBackgroundStatus,
	getCompactionThresholds,
	getContextWindow,
	getModelPricing,
	getRunningBackgroundCount,
	jsSearch,
	killBackgroundProcess,
	resolvePath,
	SUMMARIZATION_INSTRUCTION,
	truncateSearchOutput,
	zodShapeToJsonSchema,
} from "./anthropic-compatible-provider.ts";
import { MessageQueue } from "./message-queue.ts";
import { TaskTracker } from "./task-tracker.ts";
import type { AgentResult } from "./types.ts";

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

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "bash-timeout-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
		// Clean up any background processes
		backgroundProcesses.clear();
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
		const result = await executeBashWithTimeout(
			"echo bg-test",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
		);
		expect(result.content).toContain("backgrounded immediately");
		expect(result.content).toContain("Background ID: bg-");
		expect(result.isError).toBe(false);

		// Wait for background process to complete and notify
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.exitCode).toBe(0);
			expect(msg.stdout).toContain("bg-test");
		}

		cleanupSessionBackgroundProcesses(sessionId);
	});

	test("foreground timeout triggers backgrounding for slow command", async () => {
		const sessionId = "test-bg-slow";
		const queue = new MessageQueue();
		const result = await executeBashWithTimeout(
			"sleep 5 && echo done-slow",
			tempDir,
			undefined,
			100, // 100ms foreground timeout — will trigger background
			sessionId,
			queue,
		);
		expect(result.content).toContain("moved to background");
		expect(result.content).toContain("Background ID: bg-");
		expect(result.isError).toBe(false);

		// Verify it's tracked as running
		expect(getRunningBackgroundCount(sessionId)).toBe(1);

		// Wait for completion notification — this takes ~5s
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.exitCode).toBe(0);
			expect(msg.stdout).toContain("done-slow");
			expect(msg.durationMs).toBeGreaterThan(100);
		}

		// Should no longer be running
		expect(getRunningBackgroundCount(sessionId)).toBe(0);
		cleanupSessionBackgroundProcesses(sessionId);
	}, 10000);

	test("foreground command that finishes before timeout returns normally", async () => {
		const result = await executeBashWithTimeout(
			"echo fast",
			tempDir,
			undefined,
			5000,
			"test-fast",
			undefined,
		);
		expect(result.content).toContain("fast");
		expect(result.content).toContain("exit code: 0");
		expect(result.isError).toBe(false);
		// Should NOT be backgrounded
		expect(result.content).not.toContain("Background ID");
		cleanupSessionBackgroundProcesses("test-fast");
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

	test("background warning shown when background commands running", async () => {
		const sessionId = "test-bg-warn";
		const queue = new MessageQueue();

		// Start a slow background command
		await executeBashWithTimeout(
			"sleep 10",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
		);
		expect(getRunningBackgroundCount(sessionId)).toBe(1);

		// Run another command — should show warning
		const result = await executeTool(
			"bash",
			{ command: "echo hello", foreground_timeout: 5000 },
			tempDir,
			undefined,
			sessionId,
		);
		expect(result.content).toContain("background command(s) still running");

		cleanupSessionBackgroundProcesses(sessionId);
	});

	test("cleanup removes all background processes for session", () => {
		const sessionId = "test-cleanup";
		backgroundProcesses.set(
			sessionId,
			new Map([
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
			]),
		);
		expect(backgroundProcesses.has(sessionId)).toBe(true);
		cleanupSessionBackgroundProcesses(sessionId);
		expect(backgroundProcesses.has(sessionId)).toBe(false);
	});

	test("killBackgroundProcess kills a running process", async () => {
		const sessionId = "test-kill";
		const queue = new MessageQueue();
		const result = await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
		);
		const bgId = result.content.match(/bg-[a-f0-9]+/)?.[0] ?? "";
		expect(bgId).toBeTruthy();

		expect(getRunningBackgroundCount(sessionId)).toBe(1);

		const killResult = killBackgroundProcess(sessionId, bgId);
		expect(killResult).toContain("killed");
		expect(killResult).toContain(bgId);

		// Wait for background completion notification
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");

		expect(getRunningBackgroundCount(sessionId)).toBe(0);
		cleanupSessionBackgroundProcesses(sessionId);
	});

	test("killBackgroundProcess returns not-running message for completed process", () => {
		const sessionId = "test-kill-completed";
		backgroundProcesses.set(
			sessionId,
			new Map([
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
			]),
		);

		const result = killBackgroundProcess(sessionId, "bg-done");
		expect(result).toContain("not running");
		expect(result).toContain("completed");
		cleanupSessionBackgroundProcesses(sessionId);
	});

	test("killBackgroundProcess returns null for unknown process", () => {
		const result = killBackgroundProcess("nonexistent", "bg-nope");
		expect(result).toBeNull();
	});

	test("getBackgroundStatus returns status for running process", async () => {
		const sessionId = "test-status-running";
		const queue = new MessageQueue();
		await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
		);

		const map = backgroundProcesses.get(sessionId);
		const bgId = map?.keys().next().value ?? "";
		expect(bgId).toBeTruthy();

		const status = getBackgroundStatus(sessionId, bgId);
		expect(status).toContain("running");
		expect(status).toContain("sleep 30");
		expect(status).toContain("stdout file:");
		expect(status).toContain("read_file");

		// Clean up: kill the process
		killBackgroundProcess(sessionId, bgId);
		await queue.wait();
		cleanupSessionBackgroundProcesses(sessionId);
	});

	test("getBackgroundStatus returns output for completed process", () => {
		const sessionId = "test-status-done";
		backgroundProcesses.set(
			sessionId,
			new Map([
				[
					"bg-fin",
					{
						id: "bg-fin",
						command: "echo hello",
						startTime: Date.now() - 2000,
						stdout: "hello\n",
						stderr: "",
						exitCode: 0,
						status: "completed",
						kill: null,
						stdoutPath: null,
						stderrPath: null,
					},
				],
			]),
		);

		const status = getBackgroundStatus(sessionId, "bg-fin");
		expect(status).toContain("completed");
		expect(status).toContain("Exit code: 0");
		expect(status).toContain("hello");
		expect(status).not.toContain("still running");
		cleanupSessionBackgroundProcesses(sessionId);
	});

	test("getBackgroundStatus returns null for unknown process", () => {
		const result = getBackgroundStatus("nonexistent", "bg-nope");
		expect(result).toBeNull();
	});

	test("executeTool routes bg_action=kill", async () => {
		const sessionId = "test-tool-kill";
		const queue = new MessageQueue();
		await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
		);

		const map = backgroundProcesses.get(sessionId);
		const bgId = map?.keys().next().value;
		expect(bgId).toBeDefined();

		const result = await executeTool(
			"bash",
			{ command: "", bg_action: "kill", background_id: bgId },
			tempDir,
			undefined,
			sessionId,
			queue,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("killed");

		await queue.wait();
		cleanupSessionBackgroundProcesses(sessionId);
	});

	test("executeTool routes bg_action=status", async () => {
		const sessionId = "test-tool-status";
		backgroundProcesses.set(
			sessionId,
			new Map([
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
			]),
		);

		const result = await executeTool(
			"bash",
			{ command: "", bg_action: "status", background_id: "bg-st" },
			tempDir,
			undefined,
			sessionId,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("completed");
		expect(result.content).toContain("test");
		cleanupSessionBackgroundProcesses(sessionId);
	});

	test("executeTool bg_action without background_id returns error", async () => {
		const result = await executeTool(
			"bash",
			{ command: "", bg_action: "kill" },
			tempDir,
			undefined,
			"test-session",
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("background_id is required");
	});

	test("executeTool bg_action without session returns error", async () => {
		const result = await executeTool(
			"bash",
			{ command: "", bg_action: "kill", background_id: "bg-123" },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("no session context");
	});

	test("executeTool bg_action=status for unknown process returns error", async () => {
		const result = await executeTool(
			"bash",
			{ command: "", bg_action: "status", background_id: "bg-unknown" },
			tempDir,
			undefined,
			"test-session",
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
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
});

describe("buildCompactedContext", () => {
	test("includes task context and checkpoint", async () => {
		const result = await buildCompactedContext(
			"Build a calculator app",
			"## Current Phase\nimplementation",
		);
		expect(result).toContain("Build a calculator app");
		expect(result).toContain("Checkpoint Summary");
		expect(result).toContain("## Current Phase");
		expect(result).toContain("Resume from this checkpoint");
	});

	test("includes fresh memory when cwd has memory file", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-compact-test-"));
		try {
			await mkdir(join(tempDir, ".opengraft"), { recursive: true });
			await writeFile(
				join(tempDir, ".opengraft", "memory.md"),
				"# Project Memory\n- important note",
			);

			const result = await buildCompactedContext(
				"Some task",
				"checkpoint content",
				tempDir,
			);
			expect(result).toContain("Project Memory (fresh)");
			expect(result).toContain("important note");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("works without task context", async () => {
		const result = await buildCompactedContext(undefined, "checkpoint text");
		expect(result).toContain("Checkpoint Summary");
		expect(result).toContain("checkpoint text");
		expect(result).not.toContain("Original Task");
	});

	test("works when memory file does not exist", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "og-nomem-test-"));
		try {
			const result = await buildCompactedContext("task", "checkpoint", tempDir);
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
		expect(SUMMARIZATION_INSTRUCTION).toContain("Rejected Approaches");
		expect(SUMMARIZATION_INSTRUCTION).toContain("Next Action");
	});
});

describe("zodShapeToJsonSchema", () => {
	test("converts nested object in array (execute_tasks schema)", async () => {
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
		doneRef: {
			done: null | { status: "passed" | "failed"; summary: string };
		},
		args: { status: "passed" | "failed"; summary: string },
	) {
		const mockProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" } as AgentResult;
			},
			startSession: () => {
				throw new Error("not used");
			},
		};

		const { toolDefs } = createOrchestratorTools({
			tracker,
			provider: mockProvider,
			worktrees: {} as never,
			projectPath: tempDir,
			repoPath: tempDir,
			doneRef,
		});
		const doneTool = toolDefs.find((t) => t.name === "done");
		if (!doneTool) throw new Error("done tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (doneTool as any).handler(args);
	}

	test("done(passed) sets doneRef to passed", async () => {
		const doneRef: {
			done: null | { status: "passed" | "failed"; summary: string };
		} = { done: null };
		const result = await invokeDoneTool(doneRef, {
			status: "passed",
			summary: "All tests pass",
		});
		expect(doneRef.done).toEqual({
			status: "passed",
			summary: "All tests pass",
		});
		expect(result.content[0].text).toContain("passed");
		expect(result.content[0].text).toContain("Good work!");
	});

	test("done(failed) sets doneRef to failed", async () => {
		const doneRef: {
			done: null | { status: "passed" | "failed"; summary: string };
		} = { done: null };
		const result = await invokeDoneTool(doneRef, {
			status: "failed",
			summary: "Cannot resolve type errors",
		});
		expect(doneRef.done).toEqual({
			status: "failed",
			summary: "Cannot resolve type errors",
		});
		expect(result.content[0].text).toContain("failed");
		expect(result.content[0].text).toContain("Returning to parent");
	});

	test("hasRunningChildren returns false when no children", async () => {
		const mockProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" } as AgentResult;
			},
			startSession: () => {
				throw new Error("not used");
			},
		};

		const { hasRunningChildren } = createOrchestratorTools({
			tracker,
			provider: mockProvider,
			worktrees: {} as never,
			projectPath: tempDir,
			repoPath: tempDir,
		});
		expect(hasRunningChildren?.()).toBe(false);
	});

	test("hasRunningChildren returns true when childQueues has entries", async () => {
		const mockProvider = {
			name: "mock",
			execute: async () => ({ success: true, output: "" }),
			// biome-ignore lint/correctness/useYield: mock provider never streams
			stream: async function* () {
				return { success: true, output: "" } as AgentResult;
			},
			startSession: () => {
				throw new Error("not used");
			},
		};

		const childQueues = new Map<string, MessageQueue>();
		childQueues.set("child-1", new MessageQueue());

		const { hasRunningChildren } = createOrchestratorTools({
			tracker,
			provider: mockProvider,
			worktrees: {} as never,
			projectPath: tempDir,
			repoPath: tempDir,
			childQueues,
		});
		expect(hasRunningChildren?.()).toBe(true);

		// Clean up
		for (const q of childQueues.values()) q.close();
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
});
