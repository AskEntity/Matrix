/**
 * Test helper: createApp with Matrix scope opts pre-wired.
 * Use this instead of createApp() in tests — ensures runtime doesn't
 * fall back to hardcoded Matrix import.
 *
 * ## structuredClone wrapper
 *
 * In production, `ctx.onBroadcast` is wired to `self.postMessage({...event})`
 * (worker → daemon over the Worker thread boundary). `postMessage` performs
 * `structuredClone` on its payload — it throws `DataCloneError` on anything
 * non-cloneable (functions, `AbortController`, live class instances with
 * method refs, etc.).
 *
 * In tests, `ctx.onBroadcast` is unset by default, so the in-process
 * `broadcast(...)` path never exercises the clone boundary. This means tests
 * silently accept payloads production would reject — e.g. `tree_updated`
 * events that contain live `TaskSession` objects (queue, abortController).
 *
 * The regression bug that triggered this: FU8 removed the old triple-JSON-
 * serialize path in the SSE relay, so `broadcastTreeUpdate` in
 * `event-system.ts` started passing `tracker.allNodes()` without stripping
 * sessions. Production threw `DataCloneError` on first tree broadcast after
 * daemon restart; no integration test caught it because none exercised
 * `structuredClone`.
 *
 * Fix: always wire an `onBroadcast` that runs `structuredClone({projectId,
 * event})` first, then delegates to whatever the caller set (if anything).
 * On any non-cloneable payload, the test fails with the raw `DataCloneError`
 * so the broken broadcast site is visible in the stack trace.
 *
 * Cost: `structuredClone` of a tree_updated payload (a few dozen plain
 * objects) is sub-millisecond; trivial overhead per test.
 */

import type { RuntimeConfig } from "../runtime/context.ts";
import { createApp } from "../runtime.ts";
import { matrixBuildScopeOpts } from "./matrix-scope.ts";

export function createMatrixApp(config: RuntimeConfig) {
	const app = createApp({
		...config,
		buildScopeOpts: config.buildScopeOpts ?? matrixBuildScopeOpts,
	});

	// Enforce broadcast-payload cloneability as a test-only invariant.
	// See the block comment above for why this exists.
	const origOnBroadcast = app.ctx.onBroadcast;
	app.ctx.onBroadcast = (projectId, event) => {
		// Throw on non-cloneable payloads at the site of the broadcast.
		// If this throws, a broadcast site is leaking a live object
		// (AbortController, function, class instance with methods, etc.).
		structuredClone({ projectId, event });
		origOnBroadcast?.(projectId, event);
	};

	return app;
}
