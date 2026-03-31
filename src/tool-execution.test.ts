import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { executeTool } from "./tool-execution.ts";
import { tool } from "./tool-definition.ts";

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
					persistent: z
						.union([
							z.literal(false),
							z.literal("reset"),
							z.literal("continue"),
						])
						.optional(),
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
					persistent: z
						.union([
							z.literal(false),
							z.literal("reset"),
							z.literal("continue"),
						])
						.optional(),
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

	test("accepts valid string enum value 'reset'", async () => {
		const handlers = new Map();
		handlers.set(
			"create_task",
			tool(
				"create_task",
				"Create a task",
				{
					title: z.string(),
					persistent: z
						.union([
							z.literal(false),
							z.literal("reset"),
							z.literal("continue"),
						])
						.optional(),
				},
				async () => ({
					content: [{ type: "text" as const, text: "ok" }],
				}),
			),
		);

		const result = await executeTool(
			"create_task",
			{ title: "test", persistent: "reset" },
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
					persistent: z
						.union([
							z.literal(false),
							z.literal("reset"),
							z.literal("continue"),
						])
						.optional(),
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

	test("skips validation for external MCP tools with jsonSchema", async () => {
		const handlers = new Map();
		const externalTool = {
			name: "mcp__external__search",
			description: "External search",
			inputSchema: {} as Record<string, never>,
			jsonSchema: { type: "object", properties: { query: { type: "string" } } },
			handler: async (args: Record<string, unknown>) => ({
				content: [
					{ type: "text" as const, text: `searched: ${args.query}` },
				],
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
