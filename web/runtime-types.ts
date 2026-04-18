/**
 * Runtime types shared with plugins via @mxd/types importmap.
 * Re-exports from src/ — single source of truth.
 */
export type { Event } from "../src/events.ts";
export type { QueueMessage } from "../src/message-queue.ts";
export { pluginApiPrefix } from "../src/plugin.ts";
export {
	type BaseTaskNode,
	type FolderNode,
	isFolder,
	isTask,
	type TaskNode,
	type TaskStatus,
	type TreeNode,
} from "../src/types.ts";
