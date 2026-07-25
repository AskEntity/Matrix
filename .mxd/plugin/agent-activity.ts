/**
 * "Is this agent doing something?" — one derivation, both layers.
 *
 * Lives at the plugin root rather than under `web/` because it is no longer
 * only a rendering question. The UI asks it for spinners and tab indicators;
 * the `/edit` route asks it before rewriting a conversation the agent may be
 * reasoning from right now. Two layers answering it separately is two places
 * for it to drift.
 *
 * Zero runtime imports (the `AgentActivity` import is type-only and erased),
 * so this is safe in the browser bundle and in the worker alike.
 */

import type { AgentActivity } from "@mxd/types";

/**
 * `undefined` means the task has no agent at all — deliberately different
 * from `idle`, which means the loop is alive and parked on its queue. Neither
 * counts as working.
 */
export function isWorking(activity: AgentActivity | undefined): boolean {
	return activity !== undefined && activity !== "idle";
}
