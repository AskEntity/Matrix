/**
 * Matrix scope opts helper for tests.
 * Wraps buildMatrixScopeOpts to match DaemonConfig.buildScopeOpts signature.
 *
 * Tests that call createApp() should include this:
 *   createApp({ ..., buildScopeOpts: matrixBuildScopeOpts })
 */
import { buildMatrixScopeOpts } from "../runtime/agent-lifecycle.ts";
import type { RuntimeContext, ScopeOpts } from "../runtime/context.ts";

// biome-ignore lint/suspicious/noExplicitAny: ScopeOpts generic varies
export function matrixBuildScopeOpts(
	projectId: string,
	ctx: RuntimeContext,
): ScopeOpts<any> {
	return buildMatrixScopeOpts(projectId, ctx.globalConfig.selfBootstrap, ctx);
}
