/**
 * Matrix plugin types — re-exports from the shared @mxd/types module.
 *
 * Single source of truth lives in src/types.ts (exposed to plugins via
 * web/runtime-types.ts → @mxd/types importmap entry). Re-exporting here
 * keeps the plugin's existing import surface (`from "./types.ts"`) while
 * eliminating structural drift between src and plugin type definitions.
 *
 * `isFolder` is matrix-plugin-local: "folder" is one flavor of
 * `GeneralNode` used by matrix for visual grouping. Runtime has no
 * opinion on it; another plugin would define its own predicates.
 */

import type { GeneralNode } from "@mxd/types";
import { isGeneral, type TreeNode } from "@mxd/types";

export {
	type BaseTaskNode,
	type Event,
	type GeneralNode,
	isGeneral,
	isTask,
	type QueueMessage,
	type TaskNode,
	type TaskStatus,
	type TreeNode,
} from "@mxd/types";

/** Matrix-plugin type guard: is this a folder (GeneralNode with type="folder")? */
export function isFolder(
	node: TreeNode,
): node is GeneralNode & { type: "folder" } {
	return isGeneral(node) && node.type === "folder";
}
