/**
 * Integration test for debug snapshot: verify that the Anthropic provider
 * writes the pre-API-call snapshot to disk during a real agent run.
 *
 * Uses the same ValidatingMockAPI pattern as drift-lifecycle.test.ts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DebugSnapshot } from "./debug-snapshot.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import { ulid } from "./ulid.ts";

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-debug-snapshot-data-"));
	const projectDir = await mkdtemp(
		join(tmpdir(), "mxd-debug-snapshot-project-"),
	);

	Bun.spawnSync(["git", "init"], { cwd: projectDir });
	Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
		cwd: projectDir,
	});
	Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: projectDir });
	// Test gitignore: agent scenarios write scratch files but don't commit;
	// done() now rejects dirty worktrees. Ignore all but explicitly tracked files.
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
	});

	const hookExample = join(
		projectDir,
		".mxd",
		"hooks",
		"setup_worktree.sh.example",
	);
	const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
	if (existsSync(hookExample)) await rename(hookExample, hookActive);
	Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
	Bun.spawnSync(["git", "commit", "-m", "activate hook"], { cwd: projectDir });

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
	throw new Error(`Agent did not finish within ${timeoutMs}ms`);
}

async function startAgent(ctx: TestContext, prompt: string): Promise<void> {
	const tasksRes = await ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks`,
	);
	const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
	await ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: prompt }),
		},
	);
}

describe("Debug snapshot: pre-API-call messages[] persisted to debug/", () => {
	let ctx: TestContext | undefined;

	afterEach(async () => {
		if (ctx) {
			await teardownTestContext(ctx);
			ctx = undefined;
		}
	});

	test("snapshot written after each API call, located at debug/<taskId>/<traceId>/last.json", async () => {
		ctx = await setupTestContext();

		// Single-turn agent: call done() immediately.
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Starting." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "ok" },
				},
			],
			stop_reason: "tool_use",
		});

		await startAgent(ctx, instruction);
		await waitForDone(ctx);

		// v2 layout: snapshot should exist at
		// projects/<id>/debug/<taskId>/<traceId>/last.json
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const taskDebugDir = join(
			ctx.dataDir,
			"projects",
			ctx.projectId,
			"debug",
			rootNodeId,
		);
		expect(existsSync(taskDebugDir)).toBe(true);
		const traceDirs = readdirSync(taskDebugDir);
		expect(traceDirs.length).toBe(1);
		const traceId = traceDirs[0] as string;
		// traceId is a ULID (26 chars)
		expect(traceId.length).toBe(26);
		const snapshotPath = join(taskDebugDir, traceId, "last.json");

		expect(existsSync(snapshotPath)).toBe(true);
		const snapshot = JSON.parse(
			readFileSync(snapshotPath, "utf-8"),
		) as DebugSnapshot;
		expect(snapshot.sessionId).toBe(rootNodeId);
		expect(snapshot.provider).toBe("anthropic");
		expect(typeof snapshot.body.model).toBe("string");
		expect(Array.isArray(snapshot.body.messages)).toBe(true);
		expect((snapshot.body.messages as unknown[]).length).toBeGreaterThan(0);
		expect(typeof snapshot.ts).toBe("number");
		expect(snapshot.ts).toBeGreaterThan(0);
	}, 15000);

	test("snapshot is overwritten on each API call (not appended)", async () => {
		ctx = await setupTestContext();

		// 3-turn conversation: agent yields twice then done.
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Turn 1." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Turn 2." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Done." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		// Wait until agent is idle (first yield)
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const taskDebugDir = join(
			ctx.dataDir,
			"projects",
			ctx.projectId,
			"debug",
			rootNodeId,
		);

		// Wait for first snapshot (traceId dir + last.json)
		let snapshotPath = "";
		for (let i = 0; i < 60; i++) {
			if (existsSync(taskDebugDir)) {
				const traceDirs = readdirSync(taskDebugDir);
				if (traceDirs.length > 0) {
					const candidate = join(
						taskDebugDir,
						traceDirs[0] as string,
						"last.json",
					);
					if (existsSync(candidate)) {
						snapshotPath = candidate;
						break;
					}
				}
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(snapshotPath).not.toBe("");
		expect(existsSync(snapshotPath)).toBe(true);

		// Read first snapshot
		const first = JSON.parse(
			readFileSync(snapshotPath, "utf-8"),
		) as DebugSnapshot;
		const firstTs = first.ts;
		const firstMsgCount = (first.body.messages as unknown[]).length;

		// Send wake message to advance
		await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "wake" }),
			},
		);

		// Wait until snapshot is updated (ts changes or msg count grows)
		for (let i = 0; i < 120; i++) {
			const s = JSON.parse(
				readFileSync(snapshotPath, "utf-8"),
			) as DebugSnapshot;
			if (
				s.ts > firstTs ||
				(s.body.messages as unknown[]).length > firstMsgCount
			) {
				// Updated — only ONE file exists (not appended)
				const after = JSON.parse(
					readFileSync(snapshotPath, "utf-8"),
				) as DebugSnapshot;
				expect(after.ts).toBeGreaterThanOrEqual(firstTs);
				// Messages grew (prior assistant/user turns added)
				expect(
					(after.body.messages as unknown[]).length,
				).toBeGreaterThanOrEqual(firstMsgCount);
				return;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error("Snapshot was never updated after second API call");
	}, 30000);

	test("snapshot messages match the final API request (prefix from live[])", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "ok" },
				},
			],
			stop_reason: "tool_use",
		});

		await startAgent(ctx, instruction);
		await waitForDone(ctx);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const taskDebugDir = join(
			ctx.dataDir,
			"projects",
			ctx.projectId,
			"debug",
			rootNodeId,
		);
		const traceDirs = readdirSync(taskDebugDir);
		expect(traceDirs.length).toBe(1);
		const snapshotPath = join(
			taskDebugDir,
			traceDirs[0] as string,
			"last.json",
		);

		const snapshot = JSON.parse(
			readFileSync(snapshotPath, "utf-8"),
		) as DebugSnapshot;

		// The snapshot should have role="user" first message (the initial prompt)
		const messages = snapshot.body.messages as Array<{
			role: string;
			content: unknown;
		}>;
		expect(messages[0]?.role).toBe("user");

		// System prompt and tools are also captured
		expect(snapshot.body.system).toBeDefined();
		expect(snapshot.body.tools).toBeDefined();
	}, 15000);

	test("two runs on the same task produce two traceId dirs, both preserved", async () => {
		ctx = await setupTestContext();

		// Run 1: agent does a single turn + done.
		const instruction1 = JSON.stringify({
			blocks: [
				{ type: "text", text: "run 1" },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "run 1 ok" },
				},
			],
			stop_reason: "tool_use",
		});
		await startAgent(ctx, instruction1);
		await waitForDone(ctx);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const taskDebugDir = join(
			ctx.dataDir,
			"projects",
			ctx.projectId,
			"debug",
			rootNodeId,
		);

		const traceDirsAfterRun1 = readdirSync(taskDebugDir);
		expect(traceDirsAfterRun1.length).toBe(1);
		const trace1 = traceDirsAfterRun1[0] as string;
		const snap1Path = join(taskDebugDir, trace1, "last.json");
		expect(existsSync(snap1Path)).toBe(true);

		// Run 2: wake the root with a new message → new loop, new traceId.
		const instruction2 = JSON.stringify({
			blocks: [
				{ type: "text", text: "run 2" },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "run 2 ok" },
				},
			],
			stop_reason: "tool_use",
		});
		await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: instruction2 }),
			},
		);
		await waitForDone(ctx);

		const traceDirsAfterRun2 = readdirSync(taskDebugDir);
		// Both runs' traceId dirs are preserved — pre-restart state available.
		expect(traceDirsAfterRun2.length).toBe(2);
		expect(traceDirsAfterRun2).toContain(trace1);
		const trace2 = traceDirsAfterRun2.find((d) => d !== trace1) as string;
		expect(trace2).toBeDefined();
		expect(trace2).not.toBe(trace1);

		// Both snapshot files exist.
		expect(existsSync(snap1Path)).toBe(true);
		expect(existsSync(join(taskDebugDir, trace2, "last.json"))).toBe(true);

		// They are DIFFERENT snapshots — run 2 has more messages than run 1.
		const s1 = JSON.parse(readFileSync(snap1Path, "utf-8")) as DebugSnapshot;
		const s2 = JSON.parse(
			readFileSync(join(taskDebugDir, trace2, "last.json"), "utf-8"),
		) as DebugSnapshot;
		expect((s2.body.messages as unknown[]).length).toBeGreaterThan(
			(s1.body.messages as unknown[]).length,
		);
	}, 30000);

	test("last-response.json written alongside last.json after API call", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Done." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "ok" },
				},
			],
			stop_reason: "tool_use",
		});

		await startAgent(ctx, instruction);
		await waitForDone(ctx);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const taskDebugDir = join(
			ctx.dataDir,
			"projects",
			ctx.projectId,
			"debug",
			rootNodeId,
		);
		const traceDirs = readdirSync(taskDebugDir);
		expect(traceDirs.length).toBe(1);
		const traceDir = join(taskDebugDir, traceDirs[0] as string);

		// Both files should exist in the same traceId directory
		expect(existsSync(join(traceDir, "last.json"))).toBe(true);
		expect(existsSync(join(traceDir, "last-response.json"))).toBe(true);

		// Response should be a valid Anthropic message object
		const response = JSON.parse(
			readFileSync(join(traceDir, "last-response.json"), "utf-8"),
		);
		expect(response.role).toBe("assistant");
		expect(response.type).toBe("message");
		expect(Array.isArray(response.content)).toBe(true);
		expect(response.content.length).toBeGreaterThan(0);
		expect(response.stop_reason).toBeDefined();
		expect(response.usage).toBeDefined();
		expect(typeof response.usage.input_tokens).toBe("number");
		expect(typeof response.usage.output_tokens).toBe("number");

		// Verify pretty-printed
		const raw = readFileSync(join(traceDir, "last-response.json"), "utf-8");
		expect(raw).toContain("\n ");
	}, 15000);

	test("last-response.json is overwritten on each API call (multi-turn)", async () => {
		ctx = await setupTestContext();

		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Turn 1." },
						{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
					],
				},
				{
					blocks: [
						{ type: "text", text: "Final." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "ok" },
						},
					],
				},
			],
		});

		await startAgent(ctx, instruction);

		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootNodeId = tracker.rootNodeId;
		const taskDebugDir = join(
			ctx.dataDir,
			"projects",
			ctx.projectId,
			"debug",
			rootNodeId,
		);

		// Wait for first response snapshot
		let responsePath = "";
		for (let i = 0; i < 60; i++) {
			if (existsSync(taskDebugDir)) {
				const traceDirs = readdirSync(taskDebugDir);
				if (traceDirs.length > 0) {
					const candidate = join(
						taskDebugDir,
						traceDirs[0] as string,
						"last-response.json",
					);
					if (existsSync(candidate)) {
						responsePath = candidate;
						break;
					}
				}
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(responsePath).not.toBe("");

		const firstResponse = JSON.parse(readFileSync(responsePath, "utf-8"));
		// First turn should have "Turn 1." text
		const firstText = firstResponse.content?.find(
			(b: { type: string }) => b.type === "text",
		)?.text;
		expect(firstText).toContain("Turn 1");

		// Wake agent for second turn
		await ctx.app.app.request(
			`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "wake" }),
			},
		);
		await waitForDone(ctx);

		// Response should now be the second turn's response
		const secondResponse = JSON.parse(readFileSync(responsePath, "utf-8"));
		const secondText = secondResponse.content?.find(
			(b: { type: string }) => b.type === "text",
		)?.text;
		expect(secondText).toContain("Final");
	}, 30000);
});
