/**
 * Tests proving the ScopeOpts architecture works for NON-Matrix agents.
 * Custom tools + custom prompt + custom hooks running on the Matrix runtime.
 * Verifies the runtime is truly generic — not hardcoded to Matrix behavior.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Event } from "./events.ts";
import type { ScopeOpts } from "./runtime/context.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import { defineTool, toToolDefinition } from "./tool-def.ts";
import { createDoneTool, createYieldTool } from "./tools/prefab.ts";
import type { TaskNode } from "./types.ts";
import { ulid } from "./ulid.ts";

// ── Test infrastructure ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(opts?: {
	// biome-ignore lint/suspicious/noExplicitAny: erased plugin generic, as elsewhere
	buildScopeOpts?: (projectId: string, ctx: any) => ScopeOpts<any>;
}): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-custom-scope-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-custom-scope-project-"));

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
	// Strict tool-error mode: fail on unexpected is_error tool_results.
	mockAPI.enableStrictToolErrors();
	const provider = createMockedProviderWithMock(mockAPI);

	const projectId = ulid();
	const appResult = createApp({
		dataDir,
		agentProvider: provider,
		projects: [{ id: projectId, name: basename(projectDir), path: projectDir }],
		...(opts?.buildScopeOpts ? { buildScopeOpts: opts.buildScopeOpts } : {}),
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

async function readSessionEvents(
	ctx: TestContext,
	sessionId: string,
): Promise<Event[]> {
	const store = ctx.app.ctx.eventStores.get(ctx.projectId);
	if (!store) return [];
	await store.flushSession(sessionId);
	return store.has(sessionId) ? store.readActive(sessionId) : [];
}

// ── Custom "story" scope — minimal, non-Matrix ──

function buildStoryScopeOpts(_projectId: string): ScopeOpts<any> {
	return {
		buildTools: (auth, _taskId) => {
			// Custom tool + runtime primitives (done/yield)
			const storyTool = defineTool({
				name: "write_paragraph",
				description: "Write a paragraph of the story",
				availability: "internal",
				params: {
					projectId: {
						schema: z.string(),
						decl: { kind: "bind", from: "projectId" },
					},
					taskId: {
						schema: z.string(),
						decl: { kind: "bind", from: "taskId" },
					},
					text: {
						schema: z.string().describe("The paragraph text"),
						decl: { kind: "explicit" },
					},
				},
				handler: async (args) => {
					return {
						content: [
							{
								type: "text" as const,
								text: `Paragraph written: ${args.text}`,
							},
						],
						isError: false,
					};
				},
			});
			return {
				tools: [
					storyTool,
					createYieldTool(),
					createDoneTool({
						extraParams: {
							status: {
								schema: z.enum(["passed", "failed"]),
								decl: { kind: "explicit" },
							},
							summary: { schema: z.string(), decl: { kind: "explicit" } },
						},
					}),
				].map((def) => toToolDefinition(def, auth)),
			};
		},
		buildPrompt: () => ({
			stable: "You are a storyteller. Write creative stories.",
			variable: "Today is story time.",
		}),
		// No connectMcp — no MCP servers
		// No beforeChildLaunch — no worktrees
		buildWorkContext: (_node, _projectPath) =>
			"You are writing a story. Be creative.",
		buildSummarizationPrompt: () =>
			"Summarize the story so far. Preserve character names and plot points.",
		shouldResume: (node: TaskNode) => node.status === "in_progress",
		onLaunch: (node: TaskNode, tracker) => {
			tracker.updateStatus(node.id, "in_progress");
		},
		onDone: (node: TaskNode, tracker, doneArgs) => {
			tracker.updateStatus(
				node.id,
				doneArgs.status === "passed" ? "verify" : "failed",
			);
			return { status: "published", wordCount: 42 };
		},
	};
}

// ── Tests ──

describe("Custom scope: non-Matrix agent on Matrix runtime", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("custom prompt: session_config contains story prompt, not Matrix prompt", async () => {
		ctx = await setupTestContext();

		// Override scope opts with story scope
		const storyOpts = buildStoryScopeOpts(ctx.projectId);
		ctx.app.ctx.scopeOpts.set(ctx.projectId, storyOpts);

		// Agent instruction: just acknowledge and done
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Story started." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "story complete" },
				},
			],
		});

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		// Send message to start agent
		const resp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: instruction }),
			},
		);
		expect(resp.status).toBe(200);

		// Wait for agent to complete
		const start = Date.now();
		while (Date.now() - start < 15000) {
			const node = tracker.getTask(rootNodeId);
			if (node?.status === "verify" || node?.status === "failed") break;
			await new Promise((r) => setTimeout(r, 50));
		}

		// Check session_config has story prompt
		const events = await readSessionEvents(ctx, rootNodeId);
		const sessionConfig = events.find((e) => e.type === "session_config");
		expect(sessionConfig).toBeDefined();

		const sc = sessionConfig as Event & {
			systemStable?: string;
			systemVariable?: string;
		};
		expect(sc.systemStable).toBe(
			"You are a storyteller. Write creative stories.",
		);
		expect(sc.systemVariable).toBe("Today is story time.");
	}, 20000);

	test("custom tools: agent sees write_paragraph + done/yield, not Matrix's 32 tools", async () => {
		ctx = await setupTestContext();

		const storyOpts = buildStoryScopeOpts(ctx.projectId);
		ctx.app.ctx.scopeOpts.set(ctx.projectId, storyOpts);

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "tool check" },
				},
			],
		});

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: instruction }),
			},
		);

		const start = Date.now();
		while (Date.now() - start < 15000) {
			const node = tracker.getTask(rootNodeId);
			if (node?.status === "verify" || node?.status === "failed") break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const events = await readSessionEvents(ctx, rootNodeId);
		const sessionConfig = events.find((e) => e.type === "session_config") as
			| (Event & { tools?: Array<{ name: string }> })
			| undefined;
		expect(sessionConfig).toBeDefined();

		const toolNames = sessionConfig?.tools?.map((t) => t.name) ?? [];
		// Should have custom tool + runtime primitives
		expect(toolNames).toContain("mcp__mxd__write_paragraph");
		expect(toolNames).toContain("mcp__mxd__done");
		expect(toolNames).toContain("mcp__mxd__yield");
		expect(toolNames.length).toBe(3);

		// Should NOT have Matrix tools
		expect(toolNames).not.toContain("mcp__mxd__bash");
		expect(toolNames).not.toContain("mcp__mxd__create_task");
		expect(toolNames).not.toContain("mcp__mxd__read_file");
	}, 20000);

	test("custom work_context: agent receives story context, not Matrix context", async () => {
		ctx = await setupTestContext();

		const storyOpts = buildStoryScopeOpts(ctx.projectId);
		ctx.app.ctx.scopeOpts.set(ctx.projectId, storyOpts);

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "work ctx check" },
				},
			],
		});

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: instruction }),
			},
		);

		const start = Date.now();
		while (Date.now() - start < 15000) {
			const node = tracker.getTask(rootNodeId);
			if (node?.status === "verify" || node?.status === "failed") break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const events = await readSessionEvents(ctx, rootNodeId);
		const workCtxEvent = events.find(
			(e) =>
				e.type === "message" &&
				typeof e.body === "object" &&
				e.body !== null &&
				"source" in e.body &&
				(e.body as { source: string }).source === "work_context",
		) as (Event & { body?: { content?: string } }) | undefined;

		expect(workCtxEvent).toBeDefined();
		expect(workCtxEvent?.body?.content).toContain(
			"You are writing a story. Be creative.",
		);
	}, 20000);

	test("custom onDone: child done_notified has plugin fields (no worktree, runs in project root)", async () => {
		ctx = await setupTestContext();

		const storyOpts = buildStoryScopeOpts(ctx.projectId);
		ctx.app.ctx.scopeOpts.set(ctx.projectId, storyOpts);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;

		// Create child directly (story scope has no create_task tool)
		const child = tracker.addChild(rootNodeId, "Chapter 1", "First chapter");
		// No cwd, no worktreePath — story agents don't need filesystem
		await tracker.save();

		// Child instruction: done immediately
		const childInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Chapter done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "chapter complete" },
				},
			],
		});

		// Send message to child via REST
		const resp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${child.id}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: childInstruction }),
			},
		);
		expect(resp.status).toBe(200);

		// Wait for done_notified on child
		let events: Event[] = [];
		const start = Date.now();
		while (Date.now() - start < 15000) {
			events = await readSessionEvents(ctx, child.id);
			if (events.some((e) => e.type === "done_notified")) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const doneNotified = events.find((e) => e.type === "done_notified") as
			| (Event & { status?: string; wordCount?: number })
			| undefined;

		expect(doneNotified).toBeDefined();
		// Story plugin onDone returns { status: "published", wordCount: 42 }
		expect(doneNotified?.status).toBe("published");
		expect(doneNotified?.wordCount).toBe(42);
	}, 30000);
});

// ── Node-model generalization (plugin integration) ──
// Proves a plugin with launchable nodes can: attach per-node metadata at
// creation, update it via setMetadata, read it from a lifecycle hook that
// also receives projectId, seed a fresh tree, and round-trip metadata+status.

function findWorkContext(events: Event[]): string | undefined {
	const e = events.find(
		(ev) =>
			ev.type === "message" &&
			typeof ev.body === "object" &&
			ev.body !== null &&
			"source" in ev.body &&
			(ev.body as { source: string }).source === "work_context",
	) as (Event & { body?: { content?: string } }) | undefined;
	return e?.body?.content;
}

describe("Node-model generalization (plugin integration)", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("buildWorkContext receives projectId + reads node.metadata (addChild + setMetadata + round-trip)", async () => {
		ctx = await setupTestContext();

		// Work context DERIVED from the node's plugin metadata + the projectId
		// passed to the hook — the exact thing dchat needs and couldn't do before.
		const scope: ScopeOpts<any> = {
			buildTools: (auth) => ({
				tools: [
					createYieldTool(),
					createDoneTool({
						extraParams: {
							status: {
								schema: z.enum(["passed", "failed"]),
								decl: { kind: "explicit" },
							},
							summary: { schema: z.string(), decl: { kind: "explicit" } },
						},
					}),
				].map((def) => toToolDefinition(def, auth)),
			}),
			buildPrompt: () => ({ stable: "You are a character.", variable: "" }),
			buildWorkContext: (node: TaskNode, _projectPath, projectId) => {
				const character = node.metadata?.character as
					| { displayName?: string }
					| undefined;
				return `project=${projectId} character=${character?.displayName ?? "none"}`;
			},
			buildSummarizationPrompt: () => "summarize",
			shouldResume: (node: TaskNode) => node.status === "in_progress",
			onLaunch: (node: TaskNode, tracker) =>
				tracker.updateStatus(node.id, "in_progress"),
			onDone: (node: TaskNode, tracker, doneArgs) => {
				tracker.updateStatus(
					node.id,
					doneArgs.status === "passed" ? "verify" : "failed",
				);
				return { status: "done" };
			},
		};
		ctx.app.ctx.scopeOpts.set(ctx.projectId, scope);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		// Launchable node created WITH metadata...
		const child = tracker.addChild(tracker.rootNodeId, "Aria", "a character", {
			metadata: { character: { displayName: "Aria" } },
		});
		// ...then updated via the plugin-safe SET path (replaces).
		tracker.setMetadata(child.id, {
			character: { displayName: "Aria-Updated" },
		});
		await tracker.save();

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "ok" },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "done" },
				},
			],
		});
		const resp = await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${child.id}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: instruction }),
			},
		);
		expect(resp.status).toBe(200);

		const start = Date.now();
		while (Date.now() - start < 15000) {
			const node = tracker.getTask(child.id);
			if (node?.status === "verify" || node?.status === "failed") break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const content = findWorkContext(await readSessionEvents(ctx, child.id));
		expect(content).toBeDefined();
		// projectId reached the hook...
		expect(content).toContain(`project=${ctx.projectId}`);
		// ...and the hook read the LATEST metadata (setMetadata value, NOT the
		// addChild value) — proves both the SET path and metadata read end-to-end.
		expect(content).toContain("character=Aria-Updated");

		// Round-trip: reload from disk; metadata + status survived save/load.
		ctx.app.ctx.trackers.delete(ctx.projectId);
		const reloaded = await ctx.app.getTracker(ctx.projectId);
		const loaded = reloaded.getTask(child.id);
		expect(loaded?.metadata).toEqual({
			character: { displayName: "Aria-Updated" },
		});
		expect(loaded?.status === "verify" || loaded?.status === "failed").toBe(
			true,
		);
	}, 20000);

	test("seedTree seeds initial nodes with metadata on a fresh tree, exactly once", async () => {
		let seedCalls = 0;
		let capturedProjectId: string | undefined;

		const buildScopeOpts = (_projectId: string): ScopeOpts<any> => ({
			buildTools: (auth) => ({
				tools: [createYieldTool()].map((def) => toToolDefinition(def, auth)),
			}),
			buildPrompt: () => ({ stable: "s", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "summarize",
			seedTree: (tracker, seedProjectId) => {
				seedCalls++;
				capturedProjectId = seedProjectId;
				tracker.addChild(tracker.rootNodeId, "Alice", "character", {
					metadata: { character: { displayName: "Alice" } },
				});
				tracker.addChild(tracker.rootNodeId, "Bob", "character", {
					metadata: { character: { displayName: "Bob" } },
				});
			},
		});

		ctx = await setupTestContext({ buildScopeOpts });

		// First access creates the fresh tree → seedTree fires once.
		const tracker = await ctx.app.getTracker(ctx.projectId);
		expect(seedCalls).toBe(1);
		expect(capturedProjectId).toBe(ctx.projectId);

		const below = tracker.getTasksBelow(tracker.rootNodeId);
		expect(below.map((n) => n.title).sort()).toEqual(["Alice", "Bob"]);
		const alice = below.find((n) => n.title === "Alice");
		expect(
			(alice?.metadata?.character as { displayName?: string } | undefined)
				?.displayName,
		).toBe("Alice");

		// Reload from disk: seed persisted AND does not re-run (tree.json exists).
		ctx.app.ctx.trackers.delete(ctx.projectId);
		const reloaded = await ctx.app.getTracker(ctx.projectId);
		expect(seedCalls).toBe(1);
		expect(reloaded.getTasksBelow(reloaded.rootNodeId)).toHaveLength(2);
		const reAlice = reloaded
			.getTasksBelow(reloaded.rootNodeId)
			.find((n) => n.title === "Alice");
		expect(
			(reAlice?.metadata?.character as { displayName?: string } | undefined)
				?.displayName,
		).toBe("Alice");
	}, 20000);
});
