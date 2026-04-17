/**
 * Matrix plugin types — re-exports from the shared @mxd/types module.
 *
 * Single source of truth lives in src/types.ts (exposed to plugins via
 * web/runtime-types.ts → @mxd/types importmap entry). Re-exporting here
 * keeps the plugin's existing import surface (`from "./types.ts"`) while
 * eliminating structural drift between src and plugin type definitions.
 */
export {
	type BaseTaskNode,
	type Event,
	type FolderNode,
	isFolder,
	isTask,
	type QueueMessage,
	type TaskNode,
	type TaskStatus,
	type TreeNode,
} from "@mxd/types";
