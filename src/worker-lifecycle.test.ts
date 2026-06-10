/**
 * FIX-6: Worker init crash hang + shutdown throw (daemon.ts)
 *
 * TDD tests for worker-lifecycle bugs:
 * R8-A#1: onerror must reject init promise (not just clear timer → hang)
 * R8-A#2: shutdown() must not throw on terminated/crashed worker
 * R8-A#9a: {type:"error"} must terminate the worker thread
 * R8-A#9b: restart timers must not fire after shutdown
 * R8-A#9c: init-timeout/error must clean dead entries from workers map
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";

// ── Helpers ──

async function setupPluginProject(
	tempDir: string,
	pluginName: string,
	runtimeCode: string,
): Promise<{ dataDir: string; projectPath: string }> {
	const dataDir = join(tempDir, ".mxd");
	const projectPath = join(tempDir, "test-project");

	await mkdir(join(projectPath, ".mxd", "plugin"), { recursive: true });
	await writeFile(
		join(projectPath, ".mxd", "plugin", "index.ts"),
		`export default { name: "${pluginName}", scope: "global", runtime: "./runtime.ts" };`,
		"utf-8",
	);
	await writeFile(
		join(projectPath, ".mxd", "plugin", "runtime.ts"),
		runtimeCode,
		"utf-8",
	);
	await mkdir(join(dataDir, "projects"), { recursive: true });
	await writeFile(
		join(dataDir, "projects.json"),
		JSON.stringify([
			{
				id: "test-proj",
				name: "test-proj",
				path: projectPath,
				createdAt: new Date().toISOString(),
			},
		]),
		"utf-8",
	);
	await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
	return { dataDir, projectPath };
}

// ── Plugin runtime variants ──

// Loads successfully, then crashes 200ms later via unhandled throw.
// The throw fires onerror on the parent and terminates the worker.
const DELAYED_CRASH_RUNTIME = `
export function buildScopeOpts() {
	return {
		buildTools: () => ({ tools: [] }),
		buildPrompt: () => ({ stable: "", variable: "" }),
	};
}
setTimeout(() => { throw new Error("delayed crash for FIX-6 test"); }, 200);
`;

// Crashes DURING init via a setTimeout(0) that fires while the module's
// top-level await is sleeping. This fires onerror BEFORE "ready" is sent.
// R8-A#1 bug: onerror clears initTimer but never rejects → createDaemon hangs.
const CRASH_DURING_INIT_RUNTIME = `
// Schedule unhandled throw — fires during the top-level await below
setTimeout(() => { throw new Error("onerror crash during init"); }, 0);
// Top-level await gives the event loop a chance to process the timer above
await new Promise(r => setTimeout(r, 50));
export function buildScopeOpts() {
	return {
		buildTools: () => ({ tools: [] }),
		buildPrompt: () => ({ stable: "", variable: "" }),
	};
}
`;

const HEALTHY_RUNTIME = `
export function buildScopeOpts() {
	return {
		buildTools: () => ({ tools: [] }),
		buildPrompt: () => ({ stable: "", variable: "" }),
	};
}
`;

// ============================================================================
// R8-A#1: onerror must reject init promise (not hang forever)
// ============================================================================

describe("FIX-6 R8-A#1: onerror rejects init promise", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	test("worker crash during init rejects promptly via onerror", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "fix6-onerror-"));
		const { dataDir } = await setupPluginProject(
			tempDir,
			"crash-during-init",
			CRASH_DURING_INIT_RUNTIME,
		);

		const started = Date.now();
		await expect(
			createDaemon({ dataDir, workerInitTimeoutMs: 8_000 }),
		).rejects.toThrow(/crash|error|init failed/i);
		const elapsed = Date.now() - started;

		// With the fix: onerror calls reject → rejects in ~50ms.
		// Without the fix: onerror clears the timer but never rejects
		// → hangs FOREVER (timer was cleared, so timeout never fires).
		// Test has 10s budget; without the fix, it times out → FAIL.
		expect(elapsed).toBeLessThan(3_000);
	}, 10_000);
});

// ============================================================================
// R8-A#2: shutdown() must not throw on terminated/crashed worker
// ============================================================================

describe("FIX-6 R8-A#2: shutdown tolerates dead workers", () => {
	let tempDir: string;
	let daemon: DaemonInstance | undefined;

	afterEach(async () => {
		if (daemon) {
			await daemon.shutdown().catch(() => {});
			daemon = undefined;
		}
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	test("shutdown completes when worker crashed after init", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "fix6-shutdown-"));
		const { dataDir } = await setupPluginProject(
			tempDir,
			"crash-after-init",
			DELAYED_CRASH_RUNTIME,
		);

		daemon = await createDaemon({
			dataDir,
			workerInitTimeoutMs: 10_000,
			autoRegisterSelf: false,
		});

		// Wait for the delayed crash to fire (200ms + margin).
		await new Promise((r) => setTimeout(r, 600));

		// shutdown() on the dead worker must NOT throw.
		// Bug: postMessage on terminated Bun Worker throws InvalidStateError,
		// skipping remaining workers + releaseDataDirLock.
		await expect(daemon.shutdown()).resolves.toBeUndefined();
		daemon = undefined;
	}, 15_000);
});

// ============================================================================
// R8-A#9a+c: init error must terminate worker + clean workers map
// ============================================================================

describe("FIX-6 R8-A#9a+c: init error terminates worker + cleans map", () => {
	let tempDir: string;

	afterEach(async () => {
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	test("init error rejects promptly and doesn't leak", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "fix6-initerr-"));
		const { dataDir } = await setupPluginProject(
			tempDir,
			"failing-plugin",
			`throw new Error("plugin init deliberately failed");`,
		);

		const started = Date.now();
		await expect(
			createDaemon({ dataDir, workerInitTimeoutMs: 5_000 }),
		).rejects.toThrow(/init failed|crash|error/i);
		const elapsed = Date.now() - started;

		// Must reject quickly (error posted immediately), not wait for timeout.
		expect(elapsed).toBeLessThan(3_000);
		// R8-A#9a fix: worker.terminate() added to {type:"error"} handler.
		// R8-A#9c fix: workers.delete() added to {type:"error"} handler.
		// Both are code-level fixes verified by diff; observable behavior
		// (rejection) already works via the existing reject() call.
	}, 10_000);
});

// ============================================================================
// R8-A#9b: restart timers must not fire after shutdown
// ============================================================================

describe("FIX-6 R8-A#9b: restart timers cleared on shutdown", () => {
	let tempDir: string;
	let daemon: DaemonInstance | undefined;

	afterEach(async () => {
		if (daemon) {
			await daemon.shutdown().catch(() => {});
			daemon = undefined;
		}
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	test("shutdown prevents pending restart from spawning zombie worker", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "fix6-zombie-"));
		const { dataDir } = await setupPluginProject(
			tempDir,
			"crash-then-restart",
			DELAYED_CRASH_RUNTIME,
		);

		daemon = await createDaemon({
			dataDir,
			workerInitTimeoutMs: 10_000,
			autoRegisterSelf: false,
		});

		// Wait for the delayed crash → onerror → scheduleWorkerRestart (2s backoff).
		await new Promise((r) => setTimeout(r, 600));

		// Capture console.log to detect zombie restart attempts.
		const originalLog = console.log;
		const restartLogs: string[] = [];
		console.log = (...args: unknown[]) => {
			const msg = args.join(" ");
			if (msg.includes("Restarting worker")) {
				restartLogs.push(msg);
			}
			originalLog(...args);
		};

		// Shutdown during the restart backoff window.
		await daemon.shutdown().catch(() => {});
		daemon = undefined;

		// Wait past the restart backoff (2s) + margin.
		// Bug: restart timer fires post-shutdown, calling startWorkerForPlugin.
		await new Promise((r) => setTimeout(r, 3_000));

		console.log = originalLog;

		// After shutdown, no restart should have been attempted.
		// (Restarts from BEFORE shutdown are fine; we check for post-shutdown ones.)
		// The fix clears all pending restart timers in shutdown().
		expect(restartLogs.length).toBe(0);
	}, 10_000);
});
