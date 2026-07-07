/**
 * Audit FU3 [CRITICAL]: SSE catch-up correctness across daemon/worker restarts.
 *
 * Three findings, one class of bug — the UI silently diverges from server
 * state after a restart:
 *
 * Finding 1 (epoch confusion — the LIVE "blank until F5" bug):
 *   Each daemon incarnation restarts its per-lens seq counters at 0. A
 *   browser reconnecting with a pre-restart `Last-Event-ID` whose seq falls
 *   INSIDE the new epoch's buffered range gets a wrong-epoch slice as
 *   "catch-up" → `catchUpDone = true` → full initial state skipped → stale
 *   UI until manual refresh. (The simpler "cursor beyond the new tail" case
 *   was already fixed by Audit R7 P2.9's stale-ahead check; the in-range
 *   collision is why P2.9's own comment called epoch ids "the proper fix".)
 *   Fix: SSE ids are `<epoch>-<seq>`; a cursor from a foreign epoch (or a
 *   legacy bare-numeric id) always triggers the full-initial-state path.
 *
 * Finding 2 (worker init window drops sse_event):
 *   The temporary `worker.onmessage` used during init only understood
 *   loaded/ready/error; the real handler was installed after `ready`. Events
 *   the worker emits DURING init (autoResumeProjects crash recovery) were
 *   silently dropped — neither buffered nor fanned out. Harmless on first
 *   boot (no clients yet), high impact on worker auto-restart (SSE clients
 *   are still connected on the daemon side).
 *   Fix: one unified handler installed at Worker construction.
 *
 * Finding 3 (reconnect during worker-restart gap → empty stream):
 *   A client connecting while the worker is dead/mid-restart fell through to
 *   initial-state forwarding, got a silent 503/undefined worker, and ended up
 *   with a live stream but no tree until the next unrelated event.
 *   Fix: the initial-state path polls worker readiness (200ms × 15 = 3s —
 *   covers the 2s first-restart backoff + worker init) before giving up.
 *
 * All tests drive a REAL daemon + worker (in-process `daemon.fetch`, real
 * Worker threads) — per the "canonical user journey" rule. The test plugin
 * emits a probe event at module import time (inside the worker's init
 * sequence, before `ready`) to model autoResumeProjects-time emission, and
 * exposes routes to emit lens events / crash the worker on demand.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";
import { createTestToken } from "./test-utils/auth-helper.ts";

const PLUGIN = "sse-probe";
const PROJECT_ID = "sse-catchup-proj";

/**
 * Test plugin. Three capabilities:
 * - top-level `postMessage({type:"sse_event"...})` — fires while the worker
 *   is importing the plugin module, i.e. INSIDE the init sequence, BEFORE
 *   `ready` is posted. Same daemon-side timing as autoResumeProjects
 *   emissions (Finding 2's window).
 * - POST /test-emit — emit an arbitrary event through ctx.onBroadcast (the
 *   production relay path: onBroadcast → postMessage sse_event → daemon
 *   ring buffer + fanout).
 * - POST /test-crash — schedule an unhandled throw; Bun fires onerror on
 *   the parent and terminates the worker → daemon auto-restarts it with
 *   2s backoff (worker-lifecycle FIX-6 technique).
 */
const PLUGIN_RUNTIME = `
export function buildScopeOpts() {
	return {
		buildTools: () => ({ tools: [] }),
		buildPrompt: () => ({ stable: "", variable: "" }),
	};
}
export function registerRoutes(app, ctx) {
	app.post("/test-emit", async (c) => {
		const { projectId, event } = await c.req.json();
		ctx.onBroadcast?.(projectId, event);
		return c.json({ ok: true });
	});
	app.post("/test-crash", (c) => {
		setTimeout(() => { throw new Error("deliberate crash (sse-catchup test)"); }, 30);
		return c.json({ ok: true });
	});
}
// Finding-2 probe: emitted during worker INIT (module import happens inside
// the init message handler, before "ready" is posted).
globalThis.postMessage({
	type: "sse_event",
	projectId: "${PROJECT_ID}",
	event: { type: "init_probe" },
});
`;

async function setupSseProject(tempDir: string): Promise<{
	dataDir: string;
	authPath: string;
}> {
	const dataDir = join(tempDir, ".mxd");
	const projectPath = join(tempDir, "test-project");

	await mkdir(join(projectPath, ".mxd", "plugin"), { recursive: true });
	await writeFile(
		join(projectPath, ".mxd", "plugin", "index.ts"),
		`export default { name: "${PLUGIN}", scope: "global", runtime: "./runtime.ts" };`,
		"utf-8",
	);
	await writeFile(
		join(projectPath, ".mxd", "plugin", "runtime.ts"),
		PLUGIN_RUNTIME,
		"utf-8",
	);
	await mkdir(join(dataDir, "projects"), { recursive: true });
	await writeFile(
		join(dataDir, "projects.json"),
		JSON.stringify([
			{
				id: PROJECT_ID,
				name: PROJECT_ID,
				path: projectPath,
				createdAt: new Date().toISOString(),
			},
		]),
		"utf-8",
	);
	await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
	return { dataDir, authPath: join(dataDir, "auth.json") };
}

// ── SSE frame reader ──

interface SseFrame {
	id?: string;
	event?: string;
	data?: string;
}

interface SseReader {
	frames: SseFrame[];
	/** Wait until a frame matching `pred` arrives (scans history first). */
	waitFor(
		pred: (f: SseFrame) => boolean,
		timeoutMs: number,
	): Promise<SseFrame | null>;
	close(): Promise<void>;
}

function parseSseFrame(raw: string): SseFrame {
	const frame: SseFrame = {};
	for (const line of raw.split("\n")) {
		if (line.startsWith("id: ")) frame.id = line.slice(4);
		else if (line.startsWith("event: ")) frame.event = line.slice(7);
		else if (line.startsWith("data: ")) {
			frame.data = frame.data
				? `${frame.data}\n${line.slice(6)}`
				: line.slice(6);
		}
	}
	return frame;
}

/** JSON-parse a frame's data payload; null for non-JSON/absent. */
function frameData(f: SseFrame): Record<string, unknown> | null {
	if (!f.data) return null;
	try {
		return JSON.parse(f.data) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function frameType(f: SseFrame): string | undefined {
	return frameData(f)?.type as string | undefined;
}

function createSseReader(res: Response, ac: AbortController): SseReader {
	if (!res.body) throw new Error("SSE response has no body");
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const frames: SseFrame[] = [];
	let streamDone = false;
	let buf = "";

	(async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let idx = buf.indexOf("\n\n");
				while (idx !== -1) {
					frames.push(parseSseFrame(buf.slice(0, idx)));
					buf = buf.slice(idx + 2);
					idx = buf.indexOf("\n\n");
				}
			}
		} catch {
			/* aborted/cancelled */
		} finally {
			streamDone = true;
		}
	})();

	return {
		frames,
		async waitFor(pred, timeoutMs) {
			const deadline = Date.now() + timeoutMs;
			let scanned = 0;
			while (true) {
				for (; scanned < frames.length; scanned++) {
					const f = frames[scanned];
					if (f && pred(f)) return f;
				}
				if (streamDone || Date.now() >= deadline) return null;
				await new Promise((r) => setTimeout(r, 25));
			}
		},
		async close() {
			ac.abort();
			try {
				await reader.cancel();
			} catch {
				/* already done */
			}
		},
	};
}

async function openEvents(
	daemon: DaemonInstance,
	streamToken: string,
	opts: { lastEventId?: string } = {},
): Promise<SseReader> {
	const ac = new AbortController();
	const headers: Record<string, string> = {};
	if (opts.lastEventId) headers["Last-Event-ID"] = opts.lastEventId;
	const res = await daemon.fetch(
		new Request(
			`http://localhost/events?projectId=${PROJECT_ID}&scope=${PLUGIN}&token=${encodeURIComponent(streamToken)}`,
			{ headers, signal: ac.signal },
		),
	);
	expect(res.status).toBe(200);
	return createSseReader(res, ac);
}

async function emitProbe(
	daemon: DaemonInstance,
	sessionToken: string,
	marker: string,
): Promise<void> {
	const res = await daemon.fetch(
		new Request(`http://localhost/api/${PLUGIN}/test-emit`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${sessionToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				projectId: PROJECT_ID,
				event: { type: "probe", marker },
			}),
		}),
	);
	expect(res.ok).toBe(true);
}

async function crashWorker(
	daemon: DaemonInstance,
	sessionToken: string,
): Promise<void> {
	const res = await daemon.fetch(
		new Request(`http://localhost/api/${PLUGIN}/test-crash`, {
			method: "POST",
			headers: { Authorization: `Bearer ${sessionToken}` },
		}),
	);
	expect(res.ok).toBe(true);
}

// ── Tests ──

describe("SSE catch-up across restarts (Audit FU3)", () => {
	let tempDir: string;
	const daemons: DaemonInstance[] = [];
	const readers: SseReader[] = [];

	afterEach(async () => {
		for (const r of readers) await r.close().catch(() => {});
		readers.length = 0;
		for (const d of daemons) await d.shutdown().catch(() => {});
		daemons.length = 0;
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	async function boot(dataDir: string): Promise<DaemonInstance> {
		const daemon = await createDaemon({ dataDir, autoRegisterSelf: false });
		daemons.push(daemon);
		return daemon;
	}

	function track(reader: SseReader): SseReader {
		readers.push(reader);
		return reader;
	}

	// ── Finding 1 ──

	test("spec Test 2: same-epoch cursor AHEAD of the buffer forces initial state, not silent catch-up", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sse-fu3-ahead-"));
		const { dataDir, authPath } = await setupSseProject(tempDir);
		const sessionToken = await createTestToken(authPath);
		const streamToken = await createTestToken(authPath, { sub: "stream" });
		const daemon = await boot(dataDir);

		// Client 1: observe a live event to learn the current epoch's id shape.
		const client1 = track(await openEvents(daemon, streamToken));
		await emitProbe(daemon, sessionToken, "m1");
		const m1 = await client1.waitFor(
			(f) => frameData(f)?.marker === "m1",
			5_000,
		);
		expect(m1).not.toBeNull();
		expect(m1?.id).toBeTruthy();
		await client1.close();

		// Client 2 reconnects claiming a seq far beyond anything buffered
		// (bogus/corrupt cursor, same epoch). Must get the full initial
		// state — returning "up to date" would leave the UI empty forever.
		const observedId = m1?.id ?? "";
		const dash = observedId.lastIndexOf("-");
		const aheadId = `${observedId.slice(0, dash + 1)}9999`;
		const client2 = track(
			await openEvents(daemon, streamToken, { lastEventId: aheadId }),
		);
		const tree = await client2.waitFor(
			(f) => frameType(f) === "tree_updated",
			5_000,
		);
		expect(tree).not.toBeNull();
	}, 40_000);

	test("spec Test 1: daemon restart — old-epoch cursor beyond the new counter gets full initial state", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sse-fu3-restart-"));
		const { dataDir, authPath } = await setupSseProject(tempDir);
		const sessionToken = await createTestToken(authPath);
		const streamToken = await createTestToken(authPath, { sub: "stream" });

		// Daemon A: client accumulates a cursor from epoch A.
		const daemonA = await boot(dataDir);
		const client1 = track(await openEvents(daemonA, streamToken));
		await emitProbe(daemonA, sessionToken, "a1");
		await emitProbe(daemonA, sessionToken, "a2");
		const a2 = await client1.waitFor(
			(f) => frameData(f)?.marker === "a2",
			5_000,
		);
		expect(a2?.id).toBeTruthy();
		const oldCursor = a2?.id ?? "";
		await client1.close();
		await daemonA.shutdown();

		// Daemon B (same dataDir): fresh epoch, fresh counters. The old cursor's
		// seq exceeds everything B has buffered.
		const daemonB = await boot(dataDir);
		const client2 = track(
			await openEvents(daemonB, streamToken, { lastEventId: oldCursor }),
		);
		const tree = await client2.waitFor(
			(f) => frameType(f) === "tree_updated",
			5_000,
		);
		expect(tree).not.toBeNull();
	}, 60_000);

	test("LIVE BUG regression: old-epoch cursor INSIDE the new epoch's range must get initial state, not a wrong-epoch slice", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sse-fu3-collision-"));
		const { dataDir, authPath } = await setupSseProject(tempDir);
		const sessionToken = await createTestToken(authPath);
		const streamToken = await createTestToken(authPath, { sub: "stream" });

		// Daemon A: cursor lands at seq ≈ 6 (init probe + 5 markers).
		const daemonA = await boot(dataDir);
		const client1 = track(await openEvents(daemonA, streamToken));
		for (let i = 1; i <= 5; i++)
			await emitProbe(daemonA, sessionToken, `a${i}`);
		const a5 = await client1.waitFor(
			(f) => frameData(f)?.marker === "a5",
			5_000,
		);
		expect(a5?.id).toBeTruthy();
		const oldCursor = a5?.id ?? "";
		await client1.close();
		await daemonA.shutdown();

		// Daemon B: buffer refills PAST the old cursor's seq BEFORE the client
		// reconnects (exactly what agent auto-resume + streaming does after a
		// real restart — the live "blank until F5" shape).
		const daemonB = await boot(dataDir);
		for (let i = 1; i <= 8; i++)
			await emitProbe(daemonB, sessionToken, `b${i}`);

		const client2 = track(
			await openEvents(daemonB, streamToken, { lastEventId: oldCursor }),
		);
		// The cursor is from a previous incarnation: the server must NOT serve
		// new-epoch buffer entries as catch-up. Full initial state instead.
		const tree = await client2.waitFor(
			(f) => frameType(f) === "tree_updated",
			5_000,
		);
		expect(tree).not.toBeNull();
		// And no wrong-epoch "catch-up" slice may precede it.
		const treeIdx = client2.frames.indexOf(tree as SseFrame);
		const before = client2.frames.slice(0, treeIdx);
		expect(before.filter((f) => frameType(f) === "probe")).toEqual([]);
	}, 60_000);

	test("same-epoch reconnect replays exactly the missed tail (catch-up still works with epoch ids)", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sse-fu3-replay-"));
		const { dataDir, authPath } = await setupSseProject(tempDir);
		const sessionToken = await createTestToken(authPath);
		const streamToken = await createTestToken(authPath, { sub: "stream" });
		const daemon = await boot(dataDir);

		const client1 = track(await openEvents(daemon, streamToken));
		await emitProbe(daemon, sessionToken, "m1");
		await emitProbe(daemon, sessionToken, "m2");
		await emitProbe(daemon, sessionToken, "m3");
		const m1 = await client1.waitFor(
			(f) => frameData(f)?.marker === "m1",
			5_000,
		);
		expect(m1?.id).toBeTruthy();
		await client1.waitFor((f) => frameData(f)?.marker === "m3", 5_000);
		await client1.close();

		// Reconnect from m1's cursor: replay must deliver m2+m3, NOT m1, and
		// NOT fall back to initial state (this is the genuine catch-up path).
		const client2 = track(
			await openEvents(daemon, streamToken, { lastEventId: m1?.id }),
		);
		const m2 = await client2.waitFor(
			(f) => frameData(f)?.marker === "m2",
			5_000,
		);
		const m3 = await client2.waitFor(
			(f) => frameData(f)?.marker === "m3",
			5_000,
		);
		expect(m2).not.toBeNull();
		expect(m3).not.toBeNull();
		// Replayed frames must carry epoch-prefixed ids too — a bare seq here
		// would poison the client's NEXT reconnect cursor (bare numeric =
		// foreign = full refresh instead of catch-up).
		const epochOf = (id: string) => id.slice(0, id.lastIndexOf("-"));
		expect(m2?.id).toBeTruthy();
		expect(epochOf(m2?.id ?? "")).toBe(epochOf(m1?.id ?? ""));
		expect(epochOf(m2?.id ?? "")).not.toBe("");
		// Bounded observation: no initial-state fallback, no m1 duplicate.
		await new Promise((r) => setTimeout(r, 400));
		expect(
			client2.frames.filter((f) => frameType(f) === "tree_updated"),
		).toEqual([]);
		expect(client2.frames.filter((f) => frameData(f)?.marker === "m1")).toEqual(
			[],
		);
	}, 40_000);

	// ── Finding 2 ──

	test("spec Test 3: sse_event emitted during worker init (auto-restart) reaches connected clients", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sse-fu3-initwin-"));
		const { dataDir, authPath } = await setupSseProject(tempDir);
		const sessionToken = await createTestToken(authPath);
		const streamToken = await createTestToken(authPath, { sub: "stream" });
		const daemon = await boot(dataDir);

		// Client subscribed BEFORE the crash — it survives on the daemon side
		// while the worker dies and auto-restarts. It has never seen an
		// init_probe: the first boot's probe fired before it connected, and a
		// fresh connect (no Last-Event-ID) does not replay the ring buffer.
		const client = track(await openEvents(daemon, streamToken));
		await client.waitFor((f) => frameType(f) === "tree_updated", 5_000);
		expect(client.frames.filter((f) => frameType(f) === "init_probe")).toEqual(
			[],
		);

		await crashWorker(daemon, sessionToken);

		// Crash → onerror → 2s backoff → new worker init → plugin module
		// re-imported → init_probe posted BEFORE "ready". The daemon must
		// relay it to the still-connected client (the old temp handler
		// silently dropped every pre-ready sse_event).
		const probe = await client.waitFor(
			(f) => frameType(f) === "init_probe",
			15_000,
		);
		expect(probe).not.toBeNull();
	}, 40_000);

	// ── Finding 3 ──

	test("spec Test 4: client connecting during the worker-restart gap still receives the initial tree", async () => {
		tempDir = await mkdtemp(join(tmpdir(), "sse-fu3-gap-"));
		const { dataDir, authPath } = await setupSseProject(tempDir);
		const sessionToken = await createTestToken(authPath);
		const streamToken = await createTestToken(authPath, { sub: "stream" });
		const daemon = await boot(dataDir);

		// Sanity: with a healthy worker, initial state arrives immediately.
		const clientA = track(await openEvents(daemon, streamToken));
		const treeA = await clientA.waitFor(
			(f) => frameType(f) === "tree_updated",
			5_000,
		);
		expect(treeA).not.toBeNull();
		await clientA.close();

		await crashWorker(daemon, sessionToken);
		// Enter the restart gap: worker dead + removed from the map, restart
		// pending at 2s backoff.
		await new Promise((r) => setTimeout(r, 500));

		// Fresh client (no Last-Event-ID) connects INSIDE the gap. The
		// initial-state path must poll for worker readiness (not silently
		// give up) and deliver the tree once the worker is back.
		const clientB = track(await openEvents(daemon, streamToken));
		const treeB = await clientB.waitFor(
			(f) => frameType(f) === "tree_updated",
			10_000,
		);
		expect(treeB).not.toBeNull();
	}, 40_000);
});
