import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import {
	compressMessages,
	executeTool,
	getModelPricing,
	resolvePath,
	zodShapeToJsonSchema,
} from "./direct-provider.ts";

describe("getModelPricing", () => {
	test("returns Opus pricing for opus models", () => {
		const pricing = getModelPricing("claude-opus-4-6");
		expect(pricing.inputPer1M).toBe(15);
		expect(pricing.outputPer1M).toBe(75);
	});

	test("returns Sonnet pricing for sonnet models", () => {
		const pricing = getModelPricing("claude-sonnet-4-6");
		expect(pricing.inputPer1M).toBe(3);
		expect(pricing.outputPer1M).toBe(15);
	});

	test("returns Haiku pricing for haiku models", () => {
		const pricing = getModelPricing("claude-haiku-4-5-20251001");
		expect(pricing.inputPer1M).toBe(0.8);
		expect(pricing.outputPer1M).toBe(4);
	});

	test("defaults to Sonnet for unknown models", () => {
		const pricing = getModelPricing("gpt-4");
		expect(pricing.inputPer1M).toBe(3);
		expect(pricing.outputPer1M).toBe(15);
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

	test("unknown tool: returns error", async () => {
		const result = await executeTool("unknown_tool", {}, tempDir);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown tool");
	});
});

describe("compressMessages", () => {
	function makeMockClient(summaryText: string) {
		return {
			messages: {
				create: async () => ({
					content: [{ type: "text", text: summaryText }],
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

	test("compacts all messages into checkpoint + ack", async () => {
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
		// Should be exactly 2 messages: user (context+checkpoint) + assistant ack
		expect(compressed.length).toBe(2);
		expect(compressed[0]?.role).toBe("user");
		expect(compressed[1]?.role).toBe("assistant");
		// First message should contain the checkpoint
		expect(
			typeof compressed[0]?.content === "string" && compressed[0].content,
		).toContain("Checkpoint");
		// Should return checkpoint text
		expect(checkpoint).toBe("This is the conversation summary.");
		// Should report saved tokens
		expect(savedTokens).toBeGreaterThan(0);
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
				create: async (params: { model: string }) => {
					calledModel = params.model;
					return { content: [{ type: "text", text: "summary" }] };
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
