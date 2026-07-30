/**
 * `/compact` on a SHORT conversation — the canonical journey, and the two
 * bricks that a second, shorter compaction path produced.
 *
 * There is one compaction path: `compact_started` → summarize → `compact_marker`
 * → `session_config` → `compacted_resume`. A two-message session goes down it
 * like any other. It costs one API call and produces a near-useless summary,
 * and that is the price of the user asking for it.
 *
 * ⚠️ This file exists because that was NOT always true, and both attempts at a
 * cheaper short path bricked sessions:
 *
 *   v1 (pre FIX-5) emitted `compact_started` + `compact_marker` WITHOUT
 *   rebuilding context. On restart `readActive()` returns only post-marker
 *   events, so the session began on an ASSISTANT turn → 400 "first message
 *   must use the 'user' role" on every launch → permanent brick, recoverable
 *   only by reset_task.
 *
 *   v2 (FIX-5 R8-B#1, what this file used to pin as a BEHAVIOR SNAPSHOT)
 *   emitted a status, cleared the flag and `continue`d with nothing pushed —
 *   so the very next request went out ending on the assistant message the
 *   agent had parked on → 400 "This model does not support assistant message
 *   prefill. The conversation must end with a user message" (measured 2026-07-25
 *   against production Anthropic, probe case P). Reachable by a fresh agent
 *   whose first turn ends with `end_turn`, with no other setup.
 *
 * Shortness caused neither. Being a SECOND PATH did. So the two assertions
 * here are the two bricks, stated as properties rather than as bug reports:
 *
 *   1. Every request that goes out is SENDABLE — it ends with a user message.
 *   2. The `compact_marker` is never BARE: `session_config` and a
 *      `compacted_resume` message follow it, so a restart resumes from the
 *      summary on a user turn.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";
import { createCompactMessage } from "./queue-message-factory.ts";
import { deliverMessage } from "./runtime/agent-lifecycle.ts";
import {
	type ApiMessage,
	sendableRequestViolations,
} from "./test-utils/api-message-rules.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import { initTestProject } from "./test-utils/init-test-project.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import { TEST_CONFIG } from "./test-utils.ts";
import { ulid } from "./ulid.ts";

interface Ctx {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setup(): Promise<Ctx> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-shortcompact-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-shortcompact-proj-"));
	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "t@t.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: projectDir });
	await Bun.write(
		join(projectDir, ".gitignore"),
		"*\n!/.gitignore\n!/README.md\n!/.mxd/\n!/.mxd/**\n",
	);
	await Bun.write(join(projectDir, "README.md"), "# probe\n");
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: projectDir });
	await initTestProject(projectDir);

	const mockAPI = new ValidatingMockAPI();
	const provider = createMockedProviderWithMock(mockAPI);
	const projectId = ulid();
	const app = createApp({
		initialConfig: TEST_CONFIG,
		dataDir,
		agentProvider: provider,
		projects: [{ id: projectId, name: basename(projectDir), path: projectDir }],
	});
	const tasksDir = join(projectDir, ".mxd", "tasks");
	if (existsSync(tasksDir)) rmSync(tasksDir, { recursive: true });
	const hookExample = join(
		projectDir,
		".mxd",
		"hooks",
		"setup_worktree.sh.example",
	);
	const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
	if (existsSync(hookExample)) await rename(hookExample, hookActive);
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "hook"], { cwd: projectDir });
	app.markReady();

	return { dataDir, projectDir, app, mockAPI, projectId };
}

async function teardown(ctx: Ctx): Promise<void> {
	await ctx.app.shutdown();
	await new Promise((r) => setTimeout(r, 50));
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

async function readSessionEvents(
	ctx: Ctx,
	sessionId: string,
): Promise<Event[]> {
	const daemonStore = ctx.app.ctx.eventStores.get(ctx.projectId);
	if (daemonStore) await daemonStore.flushSession(sessionId);
	const store = new EventStore(
		join(ctx.dataDir, "projects", ctx.projectId, "tasks"),
	);
	return store.read(sessionId);
}

async function sendMessage(ctx: Ctx, nodeId: string, content: string) {
	return ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${nodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content }),
		},
	);
}

async function waitForIdle(ctx: Ctx, nodeId: string, timeoutMs = 10000) {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (tracker.getTask(nodeId)?.session?.queue?.idle) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`agent did not go idle within ${timeoutMs}ms`);
}

/** One turn, text only → end_turn → implicit yield. messages = [user, assistant]. */
const ONE_TURN_THEN_END = JSON.stringify({
	turns: [{ blocks: [{ type: "text", text: "Hello, I am done talking." }] }],
});

/** The mock's canned checkpoint body — present iff the summary reached the context. */
const MOCK_SUMMARY_MARKER = "Mock compaction summary";

describe("/compact on a short session", () => {
	let ctx: Ctx;
	afterEach(async () => {
		if (ctx) await teardown(ctx);
	});

	test("takes the ordinary compaction path, and every request is sendable", async () => {
		ctx = await setup();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		await sendMessage(ctx, rootNodeId, ONE_TURN_THEN_END);
		await waitForIdle(ctx, rootNodeId);

		const before = ctx.mockAPI.getRequestHistory().length;

		await deliverMessage(
			ctx.app.ctx,
			{ id: ctx.projectId, path: ctx.projectDir },
			rootNodeId,
			createCompactMessage(),
		);

		// Wait for the compaction to land in JSONL.
		const start = Date.now();
		let events: Event[] = [];
		while (Date.now() - start < 15000) {
			events = await readSessionEvents(ctx, rootNodeId);
			if (events.some((e) => e.type === "compact_marker")) break;
			await new Promise((r) => setTimeout(r, 100));
		}

		// Nothing errored on the way. Mapped to the message so a failure says
		// WHY rather than printing an event object.
		const errors = events.filter((e) => e.type === "error");
		expect(errors.map((e) => e.message)).toEqual([]);

		// ── Brick 1: the request shape ──
		// The summarization request is [user, assistant, user(instruction)].
		// v2 issued [user, assistant] instead — a 400.
		const after = ctx.mockAPI.getRequestHistory().slice(before);
		expect(after.length).toBeGreaterThanOrEqual(1);
		expect(after[0]?.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		for (const rec of ctx.mockAPI.getRequestHistory()) {
			expect(
				sendableRequestViolations(rec.messages as unknown as ApiMessage[]),
			).toEqual([]);
		}

		// ── Brick 2: the marker is not bare ──
		// A compact_marker with no session_config + compacted_resume after it is
		// the v1 brick: readActive() then hands the next launch an assistant-first
		// conversation and every request 400s.
		const markerIdx = events.findIndex((e) => e.type === "compact_marker");
		expect(markerIdx).toBeGreaterThanOrEqual(0);
		const afterMarker = events.slice(markerIdx + 1);
		expect(afterMarker.some((e) => e.type === "session_config")).toBe(true);
		expect(
			afterMarker.some(
				(e) => e.type === "message" && e.body.source === "compacted_resume",
			),
		).toBe(true);

		// The summary actually reached the model on the next call.
		const postCompact = ctx.mockAPI
			.getRequestHistory()
			.slice(before + 1)
			.find((rec) =>
				JSON.stringify(rec.messages).includes(MOCK_SUMMARY_MARKER),
			);
		expect(postCompact).toBeDefined();
		expect(postCompact?.messages[0]?.role).toBe("user");
	}, 30000);

	test("survives a restart — resumes from the summary, not on an assistant turn", async () => {
		ctx = await setup();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		await sendMessage(ctx, rootNodeId, ONE_TURN_THEN_END);
		await waitForIdle(ctx, rootNodeId);
		await deliverMessage(
			ctx.app.ctx,
			{ id: ctx.projectId, path: ctx.projectDir },
			rootNodeId,
			createCompactMessage(),
		);

		const start = Date.now();
		while (Date.now() - start < 15000) {
			const events = await readSessionEvents(ctx, rootNodeId);
			if (events.some((e) => e.type === "compact_marker")) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		await waitForIdle(ctx, rootNodeId);

		// Restart the daemon on the same data dir.
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = createApp({
			initialConfig: TEST_CONFIG,
			dataDir: ctx.dataDir,
			agentProvider: createMockedProviderWithMock(ctx.mockAPI),
			projects: [
				{
					id: ctx.projectId,
					name: basename(ctx.projectDir),
					path: ctx.projectDir,
				},
			],
		});
		ctx.app.markReady();

		const before = ctx.mockAPI.getRequestHistory().length;
		await sendMessage(ctx, rootNodeId, "still there?");

		const t0 = Date.now();
		while (Date.now() - t0 < 15000) {
			if (ctx.mockAPI.getRequestHistory().length > before) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		const resumed = ctx.mockAPI.getRequestHistory().slice(before);
		expect(resumed.length).toBeGreaterThanOrEqual(1);

		// THE brick assertion: the rebuilt conversation starts on a USER turn and
		// carries the summary. A bare compact_marker gives an assistant-first
		// array here, which the API rejects on every launch forever.
		const first = resumed[0];
		expect(first?.messages[0]?.role).toBe("user");
		expect(JSON.stringify(first?.messages)).toContain(MOCK_SUMMARY_MARKER);
		expect(
			sendableRequestViolations(first?.messages as unknown as ApiMessage[]),
		).toEqual([]);

		const events = await readSessionEvents(ctx, rootNodeId);
		expect(events.filter((e) => e.type === "error")).toEqual([]);
	}, 30000);
});
