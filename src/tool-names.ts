/**
 * Runtime tool name primitives.
 *
 * Only lifecycle/messaging primitives that ANY plugin needs.
 * Matrix-specific tool names live in .mxd/plugin/web/tool-names.ts
 */

/** MCP server name for builtin tools. */
export const MCP_SERVER_NAME = "mxd";

/** Prefix for all builtin MCP tool names on the wire. */
export const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__` as const;

/** Build the full wire name for a builtin tool. */
export function mcpToolName<T extends string>(base: T): `mcp__mxd__${T}` {
	return `${MCP_PREFIX}${base}` as `mcp__mxd__${T}`;
}

/** Strip the MCP prefix from a full tool name, returning the base name. */
export function stripMcpPrefix(fullName: string): string {
	return fullName.startsWith(MCP_PREFIX)
		? fullName.slice(MCP_PREFIX.length)
		: fullName;
}

/** Check if a tool name belongs to the mxd namespace. */
export function isBuiltinTool(toolName: string): boolean {
	return toolName.startsWith(MCP_PREFIX);
}

// ── Runtime lifecycle primitives ──
export const TOOL_YIELD = mcpToolName("yield");
export const TOOL_DONE = mcpToolName("done");
export const TOOL_FORK_TASK_CONTEXT = mcpToolName("fork_task_context");

// ── Runtime messaging primitives ──
export const TOOL_SEND_MESSAGE = mcpToolName("send_message");
