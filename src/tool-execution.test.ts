import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { tool } from "./tool-definition.ts";
import { executeTool } from "./tool-execution.ts";

describe("executeTool Zod validation", () => {
	test("rejects string 'false' for z.literal(false) field", async () => {
		const handlers = new Map();
		handlers.set(
			"create_task",
			tool(
				"create_task",
				"Create a task",
				{
					title: z.string(),
					persistent: z.boolean().optional(),
				},
				async () => ({
					content: [{ type: "text" as const, text: "ok" }],
				}),
			),
		);

		const result = await executeTool(
			"create_task",
			{ title: "test", persistent: "false" },
			handlers,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("validation error");
		expect(result.content).toContain("persistent");
	});

	test("accepts boolean false for z.literal(false) field", async () => {
		const handlers = new Map();
		handlers.set(
			"create_task",
			tool(
				"create_task",
				"Create a task",
				{
					title: z.string(),
					persistent: z.boolean().optional(),
				},
				async () => ({
					content: [{ type: "text" as const, text: "ok" }],
				}),
			),
		);

		const result = await executeTool(
			"create_task",
			{ title: "test", persistent: false },
			handlers,
		);
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe("ok");
	});

	test("accepts boolean true for persistent field", async () => {
		const handlers = new Map();
		handlers.set(
			"create_task",
			tool(
				"create_task",
				"Create a task",
				{
					title: z.string(),
					persistent: z.boolean().optional(),
				},
				async () => ({
					content: [{ type: "text" as const, text: "ok" }],
				}),
			),
		);

		const result = await executeTool(
			"create_task",
			{ title: "test", persistent: true },
			handlers,
		);
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe("ok");
	});

	test("accepts omitted optional field", async () => {
		const handlers = new Map();
		handlers.set(
			"create_task",
			tool(
				"create_task",
				"Create a task",
				{
					title: z.string(),
					persistent: z.boolean().optional(),
				},
				async () => ({
					content: [{ type: "text" as const, text: "ok" }],
				}),
			),
		);

		const result = await executeTool(
			"create_task",
			{ title: "test" },
			handlers,
		);
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe("ok");
	});

	test("rejects wrong type for required field", async () => {
		const handlers = new Map();
		handlers.set(
			"test_tool",
			tool(
				"test_tool",
				"Test",
				{
					count: z.number(),
				},
				async () => ({
					content: [{ type: "text" as const, text: "ok" }],
				}),
			),
		);

		const result = await executeTool(
			"test_tool",
			{ count: "not a number" },
			handlers,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("validation error");
	});

	test("strips extra/unknown keys from built-in tool input (Zod default behavior)", async () => {
		let capturedArgs: Record<string, unknown> | null = null;
		const handlers = new Map();
		handlers.set(
			"test_tool",
			tool(
				"test_tool",
				"Test",
				{
					title: z.string(),
				},
				async (args: Record<string, unknown>) => {
					capturedArgs = args;
					return {
						content: [{ type: "text" as const, text: "ok" }],
					};
				},
			),
		);

		const result = await executeTool(
			"test_tool",
			{ title: "test", unknownField: "should be stripped", extra: 42 },
			handlers,
		);
		expect(result.isError).toBeFalsy();
		expect(result.content).toBe("ok");
		// Zod strips unknown keys by default — handler should only receive schema-defined keys
		expect(capturedArgs).not.toBeNull();
		const args = capturedArgs as unknown as Record<string, unknown>;
		expect(args).toEqual({ title: "test" });
		expect(args).not.toHaveProperty("unknownField");
		expect(args).not.toHaveProperty("extra");
	});

	test("skips validation for external MCP tools with empty inputSchema", async () => {
		const handlers = new Map();
		const externalTool = {
			name: "mcp__external__search",
			description: "External search",
			inputSchema: {} as Record<string, never>,
			jsonSchema: { type: "object", properties: { query: { type: "string" } } },
			handler: async (args: Record<string, unknown>) => ({
				content: [{ type: "text" as const, text: `searched: ${args.query}` }],
			}),
		};
		handlers.set("mcp__external__search", externalTool);

		// Pass anything — no validation since jsonSchema is set
		const result = await executeTool(
			"mcp__external__search",
			{ query: 123, extra_field: true },
			handlers,
		);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("searched");
	});
});
