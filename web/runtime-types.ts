/**
 * Runtime types shared with plugins via @mxd/types importmap.
 * Re-exports from src/ — single source of truth.
 *
 * This module is built for the browser; imports here pull their transitive
 * dependencies into the plugin's first-load bundle. Every addition must come
 * from a file whose import graph is browser-safe — no `node:*` modules, no
 * server-only dependencies. `pluginApiPrefix` imports from `../src/plugin-url.ts`
 * (zero-import sibling of plugin.ts) precisely to avoid dragging `node:path`
 * in through plugin.ts → data-paths.ts.
 */
export type { Event } from "../src/events.ts";
export type { QueueMessage } from "../src/message-queue.ts";
export { pluginApiPrefix } from "../src/plugin-url.ts";
export {
	type BaseTaskNode,
	type FolderNode,
	isFolder,
	isTask,
	type TaskNode,
	type TaskStatus,
	type TreeNode,
} from "../src/types.ts";
