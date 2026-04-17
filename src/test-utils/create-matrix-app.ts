/**
 * Test helper: createApp with Matrix scope opts pre-wired.
 * Use this instead of createApp() in tests — ensures runtime doesn't
 * fall back to hardcoded Matrix import.
 */

import type { DaemonConfig } from "../runtime/context.ts";
import { createApp } from "../runtime.ts";
import { matrixBuildScopeOpts } from "./matrix-scope.ts";

export function createMatrixApp(config: DaemonConfig) {
	return createApp({
		...config,
		buildScopeOpts: config.buildScopeOpts ?? matrixBuildScopeOpts,
	});
}
