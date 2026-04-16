/**
 * Runtime types shared with plugins via @mxd/types importmap.
 * Re-exports from src/ — single source of truth.
 */
export type { Event } from "../src/events.ts";
export type { QueueMessage } from "../src/message-queue.ts";
export { isFolder, isTask, type TreeNode, type TaskNode, type FolderNode, type BaseTaskNode, type TaskStatus } from "../src/types.ts";
