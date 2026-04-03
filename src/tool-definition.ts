import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ZodRawShape, z } from "zod";

/** Infer the output type of a Zod raw shape (object of Zod types). */
type InferShape<T extends ZodRawShape> = z.infer<z.ZodObject<T>>;

/**
 * Strip $schema and additionalProperties from Zod's toJSONSchema output.
 * Provider APIs and MCP don't expect these in tool parameter schemas.
 */
function stripZodMeta(obj: unknown): unknown {
	if (Array.isArray(obj)) {
		return obj.map(stripZodMeta);
	}
	if (obj && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			if (key === "$schema" || key === "additionalProperties") continue;
			result[key] = stripZodMeta(value);
		}
		return result;
	}
	return obj;
}

/**
 * Definition for an MCP tool.
 */
export interface ToolDefinition<Schema extends ZodRawShape = ZodRawShape> {
	name: string;
	description: string;
	/** Zod raw shape — used for input validation in executeTool. */
	inputSchema: Schema;
	handler: (
		args: InferShape<Schema>,
		extra: unknown,
	) => Promise<CallToolResult>;
	/** JSON Schema for the tool's input. All providers use this directly. */
	jsonSchema: Record<string, unknown>;
	/**
	 * If true, the tool is registered in the handler map for execution but
	 * NOT included in the tool definitions sent to the API. The model learns
	 * about hidden tools from the system prompt, not from tool schemas.
	 */
	hidden?: boolean;
}

/** Convert a Zod raw shape to JSON Schema. */
function shapeToJsonSchema(shape: ZodRawShape): Record<string, unknown> {
	return stripZodMeta(z.toJSONSchema(z.object(shape))) as Record<
		string,
		unknown
	>;
}

/**
 * Create a built-in tool definition. Converts Zod inputSchema to JSON Schema
 * at creation time via z.toJSONSchema().
 */
export function tool<Schema extends ZodRawShape>(
	name: string,
	description: string,
	inputSchema: Schema,
	handler: (
		args: InferShape<Schema>,
		extra: unknown,
	) => Promise<CallToolResult>,
): ToolDefinition<Schema> {
	const jsonSchema = shapeToJsonSchema(inputSchema);
	return { name, description, inputSchema, handler, jsonSchema };
}

/**
 * Provider-agnostic tool definition stored in session_config.
 * The golden source of truth for tool schemas — computed once at session start,
 * frozen in JSONL, and reused byte-for-byte on resume. Each provider maps
 * JsonTool[] to its own API format (Anthropic Tool, OpenAI ResponsesTool).
 */
export interface JsonTool {
	name: string;
	description: string;
	jsonSchema: Record<string, unknown>;
}

/**
 * Build provider-agnostic JSON Schema tool definitions from MCP tool defs.
 * Iterates all tool definitions, filters out hidden tools, and returns
 * the canonical JsonTool[] that gets stored in session_config.
 *
 * Handler registration is NOT done here — that's the caller's responsibility
 * (runProviderLoop registers handlers into mcpHandlers map separately).
 */
export function buildJsonTools(
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
	mcpToolDefs: Record<string, ToolDefinition<any>[]> | undefined,
): JsonTool[] {
	const jsonTools: JsonTool[] = [];
	if (!mcpToolDefs) return jsonTools;
	for (const [serverName, defs] of Object.entries(mcpToolDefs)) {
		for (const def of defs) {
			if (def.hidden) continue;
			const toolName = `mcp__${serverName}__${def.name}`;
			jsonTools.push({
				name: toolName,
				description: def.description,
				jsonSchema: def.jsonSchema,
			});
		}
	}
	return jsonTools;
}
