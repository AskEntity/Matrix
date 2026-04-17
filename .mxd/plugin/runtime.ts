/**
 * Matrix plugin runtime — builds ScopeOpts for the worker.
 *
 * Generic interface: (projectId, ctx) → ScopeOpts.
 * Matrix-specific args (selfBootstrap) read from ctx.globalConfig.
 */
import { buildMatrixScopeOpts } from "../../src/runtime/agent-lifecycle.ts";
import type { RuntimeContext } from "../../src/runtime/context.ts";

export function buildScopeOpts(projectId: string, ctx: RuntimeContext) {
	return buildMatrixScopeOpts(
		projectId,
		ctx.globalConfig.selfBootstrap ?? false,
		ctx,
	);
}
