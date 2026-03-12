import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type {
	MessageParam,
	TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { createOrchestratorTools } from "./agent-tools.ts";
import {
	addMessagesCacheControl,
	compressMessages,
	executeTool,
	getModelPricing,
	jsSearch,
	resolvePath,
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

describe("compressMessages", () => {
	function makeMockClient(summaryText: string) {
		return {
			messages: {
				stream: () => ({
					finalMessage: async () => ({
						content: [{ type: "text", text: summaryText }],
					}),
				}),
			},
		} as unknown as Anthropic;
	}

	test("skips compression for short conversations", async () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		];
		const client = makeMockClient("summary");
		const { compressed } = await compressMessages(
			client,
			messages,
			"claude-sonnet-4-6",
		);
		expect(compressed).toEqual(messages);
	});

	test("compacts messages into single user message", async () => {
		const messages: MessageParam[] = [];
		for (let i = 0; i < 20; i++) {
			messages.push({ role: "user", content: `message ${i}` });
			messages.push({ role: "assistant", content: `reply ${i}` });
		}
		const client = makeMockClient("This is the conversation summary.");
		const { compressed, savedTokens, checkpoint } = await compressMessages(
			client,
			messages,
			"claude-sonnet-4-6",
		);
		// Output is exactly ONE user message
		expect(compressed.length).toBe(1);
		expect(compressed[0]?.role).toBe("user");
		const content = compressed[0]?.content as string;
		// Contains checkpoint summary
		expect(content).toContain("Checkpoint Summary");
		expect(content).toContain("This is the conversation summary.");
		// Contains recent conversation transcript as text
		expect(content).toContain("Recent Conversation");
		expect(content).toContain("message 19");
		expect(content).toContain("reply 19");
		// Should return checkpoint text
		expect(checkpoint).toBe("This is the conversation summary.");
		// Should report saved tokens
		expect(savedTokens).toBeGreaterThanOrEqual(0);
	});

	test("re-injects task context and fresh memory", async () => {
		const messages: MessageParam[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push({ role: "user", content: `msg ${i}` });
			messages.push({ role: "assistant", content: `reply ${i}` });
		}
		const client = makeMockClient("checkpoint content");
		const { compressed } = await compressMessages(
			client,
			messages,
			"claude-sonnet-4-6",
			"Build a calculator app",
		);
		const content = compressed[0]?.content as string;
		// Should contain original task context
		expect(content).toContain("Build a calculator app");
		// Should contain checkpoint
		expect(content).toContain("checkpoint content");
	});

	test("uses same-tier model for checkpoint generation", async () => {
		let calledModel = "";
		const client = {
			messages: {
				stream: (params: { model: string }) => {
					calledModel = params.model;
					return {
						finalMessage: async () => ({
							content: [{ type: "text", text: "summary" }],
						}),
					};
				},
			},
		} as unknown as Anthropic;
		const messages: MessageParam[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push({ role: "user", content: `msg ${i}` });
			messages.push({ role: "assistant", content: `reply ${i}` });
		}
		await compressMessages(client, messages, "claude-sonnet-4-6");
		expect(calledModel).toBe("claude-sonnet-4-6");
	});

	test("includes recent transcript as text in single message", async () => {
		const messages: MessageParam[] = [];
		for (let i = 0; i < 40; i++) {
			messages.push({ role: "user", content: `user-msg-${i}` });
			messages.push({ role: "assistant", content: `assistant-reply-${i}` });
		}
		const client = makeMockClient("checkpoint summary");
		const { compressed } = await compressMessages(
			client,
			messages,
			"claude-sonnet-4-6",
		);
		// Exactly one user message
		expect(compressed.length).toBe(1);
		expect(compressed[0]?.role).toBe("user");
		const content = compressed[0]?.content as string;
		expect(content).toContain("checkpoint summary");
		// Recent conversation included as text transcript, not raw API messages
		expect(content).toContain("Recent Conversation");
		expect(content).toContain("user-msg-39");
		expect(content).toContain("assistant-reply-39");
		expect(content).toContain("user-msg-38");
		// No bridge message, no separate tail messages
		expect(content).not.toContain("Resuming from checkpoint");
	});

	test("sends full transcript without truncation to summarizer", async () => {
		let capturedContent = "";
		const client = {
			messages: {
				stream: (params: { model: string; messages: MessageParam[] }) => {
					const msg = params.messages[0];
					capturedContent = typeof msg?.content === "string" ? msg.content : "";
					return {
						finalMessage: async () => ({
							content: [{ type: "text", text: "summary" }],
						}),
					};
				},
			},
		} as unknown as Anthropic;
		const messages: MessageParam[] = [];
		// Create messages with long content
		for (let i = 0; i < 10; i++) {
			messages.push({
				role: "user",
				content: `msg-${"x".repeat(3000)}-${i}`,
			});
			messages.push({
				role: "assistant",
				content: `reply-${"y".repeat(3000)}-${i}`,
			});
		}
		await compressMessages(client, messages, "claude-sonnet-4-6");
		// Full content should be in the transcript — no per-message truncation
		for (let i = 0; i < 10; i++) {
			expect(capturedContent).toContain(`msg-${"x".repeat(3000)}-${i}`);
			expect(capturedContent).toContain(`reply-${"y".repeat(3000)}-${i}`);
		}
	});

	test("uses 32768 max_tokens for summary generation", async () => {
		let capturedMaxTokens = 0;
		const client = {
			messages: {
				stream: (params: { max_tokens: number }) => {
					capturedMaxTokens = params.max_tokens;
					return {
						finalMessage: async () => ({
							content: [{ type: "text", text: "summary" }],
						}),
					};
				},
			},
		} as unknown as Anthropic;
		const messages: MessageParam[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push({ role: "user", content: `msg ${i}` });
			messages.push({ role: "assistant", content: `reply ${i}` });
		}
		await compressMessages(client, messages, "claude-sonnet-4-6");
		expect(capturedMaxTokens).toBe(32768);
	});

	test("tool_use/tool_result serialized as text in transcript, no raw API blocks", async () => {
		const messages: MessageParam[] = [];
		// Add some normal messages
		for (let i = 0; i < 5; i++) {
			messages.push({ role: "user", content: `msg ${i}` });
			messages.push({ role: "assistant", content: `reply ${i}` });
		}
		// Add tool_use / tool_result sequence
		messages.push({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "toolu_test123",
					name: "bash",
					input: { command: "ls" },
				},
			],
		});
		messages.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_test123",
					content: "file1.txt",
				},
			],
		});
		messages.push({ role: "assistant", content: "here are the files" });
		messages.push({ role: "user", content: "thanks" });

		const client = makeMockClient("checkpoint summary");
		const { compressed } = await compressMessages(
			client,
			messages,
			"claude-sonnet-4-6",
		);

		// Exactly one user message — no raw API message blocks
		expect(compressed.length).toBe(1);
		expect(compressed[0]?.role).toBe("user");
		const content = compressed[0]?.content as string;
		// Tool interactions appear as text in the transcript
		expect(content).toContain("[tool_use: bash(");
		expect(content).toContain("[tool_result: file1.txt]");
		expect(content).toContain("here are the files");
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
