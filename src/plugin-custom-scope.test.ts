/**
 * Tests proving the ScopeOpts architecture works for NON-Matrix agents.
 * Custom tools + custom prompt + custom hooks running on the Matrix runtime.
 * Verifies the runtime is truly generic — not hardcoded to Matrix behavior.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createApp } from "./daemon.ts";
import type { Event } from "./events.ts";
import type { ScopeOpts } from "./daemon/context.ts";
import { createAgentAuth } from "./tool-auth.ts";
import { toToolDefinition } from "./tool-def.ts";
import type { ToolDef } from "./tool-def.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import type { TaskNode } from "./types.ts";

// ── Test infrastructure ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
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
	const provider = createMockedProviderWithMock(mockAPI);

	const appResult = createApp({ dataDir, agentProvider: provider });
	await appResult.pm.load();
	const project = await appResult.pm.init(projectDir);

	appResult.markReady();

	return {
		dataDir,
		projectDir,
		app: appResult,
		mockAPI,
		projectId: project.id,
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

function buildStoryScopeOpts(projectId: string): ScopeOpts<any> {
	return {
		buildTools: (auth, _taskId) => {
			// ONE custom tool — "write_paragraph"
			const storyTool: ToolDef = {
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
							{ type: "text" as const, text: `Paragraph written: ${args.text}` },
						],
						isError: false,
					};
				},
			};
			return {
				tools: [toToolDefinition(storyTool, auth)],
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
		// Should have only the custom tool (done/yield are runtime primitives, not in tool list)
		expect(toolNames).toContain("mcp__mxd__write_paragraph");
		expect(toolNames.length).toBe(1); // ONLY write_paragraph

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

	test.todo("custom onDone: done_notified has plugin fields — needs child agent (root doesn't produce done_notified)");
	test.skip("custom onDone: done_notified has plugin fields (status=published, wordCount)", async () => {
		ctx = await setupTestContext();

		const storyOpts = buildStoryScopeOpts(ctx.projectId);
		ctx.app.ctx.scopeOpts.set(ctx.projectId, storyOpts);

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Story complete." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "done test" },
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

		// Wait for done_notified event (Phase 2 is async)
		let events: Event[] = [];
		const start = Date.now();
		while (Date.now() - start < 15000) {
			events = await readSessionEvents(ctx, rootNodeId);
			if (events.some((e) => e.type === "done_notified")) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const doneNotified = events.find((e) => e.type === "done_notified") as
			| (Event & { status?: string; wordCount?: number })
			| undefined;
		expect(doneNotified).toBeDefined();
		// Story plugin returns { status: "published", wordCount: 42 }
		expect(doneNotified?.status).toBe("published");
		expect(doneNotified?.wordCount).toBe(42);
	}, 20000);
});
