/**
 * MCP tool name constants.
 *
 * All builtin tools are registered under the "mxd" MCP server namespace.
 * The full wire name is `mcp__<server>__<tool>`, e.g. `mcp__mxd__bash`.
 *
 * Use these constants instead of hardcoded strings so renaming is a one-place change.
 */

/** MCP server name for builtin tools. Used as key in mcpToolDefs. */
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

// ── Builtin tool name constants ──────────────────────────────────────────────
// Only tools that are referenced by name in production code need constants.
// Tools only referenced in definitions or tests can use mcpToolName("foo").

export const TOOL_BASH = mcpToolName("bash");
export const TOOL_BACKGROUND = mcpToolName("background");
export const TOOL_READ_FILE = mcpToolName("read_file");
export const TOOL_WRITE_FILE = mcpToolName("write_file");
export const TOOL_EDIT_FILE = mcpToolName("edit_file");
export const TOOL_LIST_FILES = mcpToolName("list_files");
export const TOOL_SEARCH = mcpToolName("search");

export const TOOL_GET_TREE = mcpToolName("get_tree");
export const TOOL_CREATE_TASK = mcpToolName("create_task");
export const TOOL_UPDATE_TASK = mcpToolName("update_task");
export const TOOL_DELETE_TASK = mcpToolName("delete_task");
export const TOOL_CLOSE_TASK = mcpToolName("close_task");
export const TOOL_RESET_TASK = mcpToolName("reset_task");
export const TOOL_EXECUTE_TASKS = mcpToolName("execute_tasks");
export const TOOL_REORDER_TASKS = mcpToolName("reorder_tasks");

export const TOOL_SEND_MESSAGE = mcpToolName("send_message");
export const TOOL_SEND_MESSAGE_TO_PROJECT = mcpToolName(
	"send_message_to_project",
);
export const TOOL_CLARIFY = mcpToolName("clarify");

export const TOOL_YIELD = mcpToolName("yield");
export const TOOL_DONE = mcpToolName("done");
export const TOOL_FORK_TASK_CONTEXT = mcpToolName("fork_task_context");

export const TOOL_LIST_PROJECTS = mcpToolName("list_projects");

// Legacy aliases (backward compat in JSONL)
export const TOOL_SEND_MESSAGE_TO_CHILD = mcpToolName("send_message_to_child");
export const TOOL_REPORT_TO_PARENT = mcpToolName("report_to_parent");
