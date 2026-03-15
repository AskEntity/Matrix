import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape, z } from "zod";

/** Infer the output type of a Zod raw shape (object of Zod types). */
type InferShape<T extends ZodRawShape> = z.infer<z.ZodObject<T>>;

/**
 * Definition for an MCP tool. Replaces SdkMcpToolDefinition from the removed
 * @anthropic-ai/claude-agent-sdk package.
 */
export interface ToolDefinition<Schema extends ZodRawShape = ZodRawShape> {
	name: string;
	description: string;
	inputSchema: Schema;
	handler: (
		args: InferShape<Schema>,
		extra: unknown,
	) => Promise<CallToolResult>;
	/**
	 * Pre-computed JSON Schema for the tool's input. When present, providers
	 * use this directly instead of converting inputSchema via zodShapeToJsonSchema.
	 * Used by external MCP server tools where the schema is already JSON Schema.
	 */
	jsonSchema?: Record<string, unknown>;
}

/**
 * Create a tool definition. Simple factory that replaces the SDK's `tool()` function.
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
	return { name, description, inputSchema, handler };
}
