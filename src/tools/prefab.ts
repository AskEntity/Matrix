/**
 * Prefabricated runtime tools — yield + done.
 * Every plugin needs these. Import and include in your scope's buildTools.
 *
 * yield: standard, no configuration. "Pause and wait for messages."
 * done: configurable params. Plugin decides what done() accepts.
 */
import { z } from "zod";
import * as R from "../resource-registry.ts";
import { defineTool, type InferParams, type ParamDefs, type ToolDef } from "../tool-def.ts";

/**
 * Standard yield tool. No configuration needed.
 * Every plugin includes this in its tool set.
 */
export function createYieldTool() {
	return defineTool({
		name: "yield",
		availability: "internal",
		description:
			"Suspend execution and wait for messages. " +
			"Returns all accumulated messages. Zero token burn while waiting.",
		params: {},
		handler: async () => ({
			content: [],
			isError: false,
			_isYield: true,
		}),
	});
}

/**
 * Configurable done tool factory.
 * Plugin specifies extra params + optional pre-done validation hook.
 *
 * @param opts.extraParams — Additional params (e.g., Matrix adds status + summary)
 * @param opts.description — Custom description (optional)
 * @param opts.beforeDone — Pre-done validation hook. Return error string to reject, null to proceed.
 *   Matrix uses this for: check running children, check git clean.
 *
 * Runtime always handles: queue.close(), loop exit, Phase 2.
 * Plugin's onDone hook (on ScopeOpts) handles node state updates.
 */
const doneBaseParams = {
	projectId: {
		schema: z.string(),
		decl: { kind: "bind", from: "projectId" } as const,
	},
	taskId: {
		schema: z.string(),
		decl: { kind: "bind", from: "taskId" } as const,
	},
};

export function createDoneTool<E extends ParamDefs = Record<string, never>>(opts?: {
	extraParams?: E;
	description?: string;
	beforeDone?: (args: InferParams<typeof doneBaseParams & E>) => Promise<string | null>;
}) {
	type P = typeof doneBaseParams & E;
	const params = { ...doneBaseParams, ...(opts?.extraParams ?? {}) } as P;
	const def: ToolDef<P> = {
		name: "done",
		availability: "internal",
		description:
			opts?.description ??
			"Signal that you have finished. Call this when done.",
		params,
		handler: async (args) => {
			const projectId = args.projectId;
			const taskId = args.taskId;

			// Runtime guard: reject if descendants have active sessions
			const tracker = R.getTracker(projectId);
			if (taskId && tracker) {
				const allNodes = tracker.allNodes();
				const descendants: string[] = [];
				const collectDescendants = (parentId: string) => {
					for (const n of allNodes) {
						if (n.parentId === parentId) {
							descendants.push(n.id);
							collectDescendants(n.id);
						}
					}
				};
				collectDescendants(taskId);
				const running = descendants
					.filter((id) => tracker.getTask(id)?.session != null)
					.map((id) => tracker.get(id)?.title ?? id);
				if (running.length > 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Cannot call done() while child tasks are still running:\n${running.map((r) => `  - ${r}`).join("\n")}\nWait for them to complete or stop them first.`,
							},
						],
						isError: true,
					};
				}
			}

			// Plugin hook: extra validation (Matrix: git clean check)
			if (opts?.beforeDone) {
				const error = await opts.beforeDone(args);
				if (error) {
					return {
						content: [{ type: "text" as const, text: error }],
						isError: true,
					};
				}
			}

			// Runtime: close queue → loop exits. No response — done is intended orphan.
			const session = R.getSession(projectId, taskId);
			if (session?.queue) session.queue.close();
			return { content: [], isError: false };
		},
	};
	return def;
}
