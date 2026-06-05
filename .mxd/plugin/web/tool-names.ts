/**
 * Matrix tool name constants — plugin-local copy.
 * These are Matrix-specific (mcp__mxd__*). Other plugins have their own tool names.
 */

const MCP_PREFIX = "mcp__mxd__";

function mcpToolName<T extends string>(base: T): `mcp__mxd__${T}` {
	return `${MCP_PREFIX}${base}` as `mcp__mxd__${T}`;
}

export function stripMcpPrefix(fullName: string): string {
	return fullName.startsWith(MCP_PREFIX)
		? fullName.slice(MCP_PREFIX.length)
		: fullName;
}

export const TOOL_BASH = mcpToolName("bash");
export const TOOL_BACKGROUND = mcpToolName("background");
export const TOOL_READ_FILE = mcpToolName("read_file");
export const TOOL_WRITE_FILE = mcpToolName("write_file");
export const TOOL_EDIT_FILE = mcpToolName("edit_file");
export const TOOL_LIST_FILES = mcpToolName("list_files");
export const TOOL_SEARCH = mcpToolName("search");
export const TOOL_GET_TREE = mcpToolName("get_tree");
export const TOOL_GET_TASK = mcpToolName("get_task");
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
export const TOOL_SEND_MESSAGE_TO_CHILD = mcpToolName("send_message_to_child");
export const TOOL_REPORT_TO_PARENT = mcpToolName("report_to_parent");
export const TOOL_CLARIFY = mcpToolName("clarify");
export const TOOL_YIELD = mcpToolName("yield");
export const TOOL_DONE = mcpToolName("done");
export const TOOL_FORK_TASK_CONTEXT = mcpToolName("fork_task_context");
export const TOOL_CREATE_FOLDER = mcpToolName("create_folder");
export const TOOL_DELETE_FOLDER = mcpToolName("delete_folder");
export const TOOL_RENAME_FOLDER = mcpToolName("rename_folder");
export const TOOL_GET_LOGS = mcpToolName("get_logs");
export const TOOL_LIST_PROJECTS = mcpToolName("list_projects");
export const TOOL_EVALUATE_SCRIPT = mcpToolName("evaluate_script");

export function isBuiltinTool(toolName: string): boolean {
	return toolName.startsWith(MCP_PREFIX);
}
