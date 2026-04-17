/**
 * Tests verifying the plugin hook architecture works correctly.
 * Focus on behavioral changes from the refactor:
 * - cwd persistence on node (survives restart)
 * - buildSystemPrompt hook (provider loop owns resume/frozen logic)
 * - done_notified spread pattern (plugin fields on event, not in bag)
 * - lifecycle hooks (shouldResume, onLaunch, onDone)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Event } from "./events.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import { ulid } from "./ulid.ts";

// ── Test infrastructure (same as integration.test.ts) ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-hooks-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-hooks-project-"));

	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
	await Bun.write(
		join(projectDir, ".gitignore"),
		"*\n!/.gitignore\n!/README.md\n!/.mxd/\n!/.mxd/**\n",
	);
	await Bun.write(join(projectDir, "README.md"), "# Test Project\n");
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: projectDir });

	const mockAPI = new ValidatingMockAPI();
	const provider = createMockedProviderWithMock(mockAPI);

	const projectId = ulid();
	const appResult = createApp({
		dataDir,
		agentProvider: provider,
		projects: [{ id: projectId, name: basename(projectDir), path: projectDir }],
	});

	// Activate setup hook if exists
	const { renameSync } = await import("node:fs");
	const hookExample = join(
		projectDir,
		".mxd",
		"hooks",
		"setup_worktree.sh.example",
	);
	const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
	if (existsSync(hookExample)) renameSync(hookExample, hookActive);
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "activate setup hook"], {
		cwd: projectDir,
	});

	appResult.markReady();

	return {
		dataDir,
		projectDir,
		app: appResult,
		mockAPI,
		projectId,
	};
}

async function teardownTestContext(ctx: TestContext): Promise<void> {
	await ctx.app.shutdown();
	await new Promise((r) => setTimeout(r, 50));
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

async function getRootNodeId(ctx: TestContext): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	return tracker.rootNodeId;
}

async function startAgent(ctx: TestContext, prompt: string): Promise<Response> {
	const rootNodeId = await getRootNodeId(ctx);
	return ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: prompt }),
		},
	);
}

async function waitForDone(
	ctx: TestContext,
	timeoutMs = 15000,
): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.getTask(rootNodeId);
		if (rootNode?.status === "verify" || rootNode?.status === "failed") {
			return rootNode.status;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Agent did not call done() within ${timeoutMs}ms`);
}

async function readSessionEvents(
	ctx: TestContext,
	sessionId: string,
): Promise<Event[]> {
	const store = ctx.app.ctx.eventStores.get(ctx.projectId);
	if (store) await store.flushSession(sessionId);
	if (!store?.has(sessionId)) return [];
	return store.readActive(sessionId);
}

// ── Tests ──

describe("Plugin hooks: cwd persistence", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("bash cd updates node.cwd (persisted on tracker)", async () => {
		ctx = await setupTestContext();
		const rootNodeId = await getRootNodeId(ctx);

		// Agent runs bash cd, then done
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "cd /tmp && pwd" },
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "cd test" },
						},
					],
				},
			],
		});
		await startAgent(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Check node.cwd was updated
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.getTask(rootNodeId);
		expect(rootNode?.cwd).toBe("/tmp");
	}, 15000);

	test("node.cwd survives daemon restart (persisted in tree.json)", async () => {
		ctx = await setupTestContext();
		const rootNodeId = await getRootNodeId(ctx);

		// Agent cd's to /tmp then yields
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__bash",
							input: { command: "cd /tmp && pwd" },
						},
					],
				},
				{
					blocks: [
						{
							type: "tool_use",
							name: "mcp__mxd__yield",
							input: {},
						},
					],
				},
			],
		});
		await startAgent(ctx, instruction);

		// Wait for agent to reach yield
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const start = Date.now();
		while (Date.now() - start < 10000) {
			const node = tracker.getTask(rootNodeId);
			if (node?.session?.queue?.idle) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		// Verify cwd was set to /tmp
		const node = tracker.getTask(rootNodeId);
		expect(node?.cwd).toBe("/tmp");

		// Save tracker to persist tree.json
		await tracker.save();

		// Verify tree.json has cwd
		const { readFileSync } = await import("node:fs");
		const treePath = join(ctx.dataDir, "projects", ctx.projectId, "tree.json");
		const treeData = JSON.parse(readFileSync(treePath, "utf-8"));
		const rootInTree =
			treeData.nodes?.find?.(
				(n: Record<string, unknown>) => n.id === rootNodeId,
			) ??
			Object.values(treeData.nodes ?? {}).find(
				(n: unknown) =>
					(n as unknown as Record<string, unknown>).id === rootNodeId,
			);
		expect((rootInTree as unknown as Record<string, unknown>)?.cwd).toBe(
			"/tmp",
		);
	}, 15000);
});

describe("Plugin hooks: done_notified spread", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("done_notified event has status and summary as top-level fields", async () => {
		ctx = await setupTestContext();
		const rootNodeId = await getRootNodeId(ctx);

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "spread test" },
				},
			],
		});
		await startAgent(ctx, instruction);
		await waitForDone(ctx);

		const events = await readSessionEvents(ctx, rootNodeId);
		const doneNotified = events.find((e) => e.type === "done_notified");
		expect(doneNotified).toBeDefined();

		// Fields should be directly on event (spread), not in a doneData bag
		const dn = doneNotified as unknown as Record<string, unknown>;
		expect(dn.status).toBe("verify");
		expect(dn.summary).toBe("spread test");
		expect(dn.doneData).toBeUndefined(); // no bag
	}, 15000);
});

describe("Plugin hooks: buildSystemPrompt", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("fresh start uses buildSystemPrompt from scope opts", async () => {
		ctx = await setupTestContext();
		const rootNodeId = await getRootNodeId(ctx);

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Hello." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "prompt test" },
				},
			],
		});
		await startAgent(ctx, instruction);
		await waitForDone(ctx);

		// Verify session_config was emitted with a system prompt
		const events = await readSessionEvents(ctx, rootNodeId);
		const sessionConfig = events.find((e) => e.type === "session_config");
		expect(sessionConfig).toBeDefined();
		const sc = sessionConfig as unknown as Record<string, unknown>;
		expect(sc.systemStable).toBeDefined();
		expect(typeof sc.systemStable).toBe("string");
		expect((sc.systemStable as string).length).toBeGreaterThan(0);
	}, 15000);
});

describe("Plugin hooks: root worktreePath backfill", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("root node has worktreePath set to project path", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNode = tracker.getTask(tracker.rootNodeId);
		expect(rootNode?.worktreePath).toBe(ctx.projectDir);
	});
});
