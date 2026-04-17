import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import {
	createMockedResponsesProviderWithMock,
	restoreMockedResponsesFetch,
	ValidatingMockResponsesAPI,
} from "./test-utils/mock-openai-responses-api.ts";
import { ulid } from "./ulid.ts";

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockResponsesAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-responses-integ-data-"));
	const projectDir = await mkdtemp(
		join(tmpdir(), "mxd-responses-integ-project-"),
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

	const mockAPI = new ValidatingMockResponsesAPI();
	const provider = createMockedResponsesProviderWithMock(mockAPI);
	const projectId = ulid();
	const appResult = createApp({
		dataDir,
		agentProvider: provider,
		initialConfig: { ...DEFAULT_CONFIG, model: "gpt-4.1-mini" },
		projects: [{ id: projectId, name: basename(projectDir), path: projectDir }],
	});

	const hookExample = join(
		projectDir,
		".mxd",
		"hooks",
		"setup_worktree.sh.example",
	);
	const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
	if (existsSync(hookExample)) {
		await rename(hookExample, hookActive);
	}
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
	restoreMockedResponsesFetch();
	await new Promise((r) => setTimeout(r, 50));
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

async function recreateApp(
	ctx: TestContext,
): Promise<ReturnType<typeof createApp>> {
	const provider = createMockedResponsesProviderWithMock(ctx.mockAPI);
	const newApp = createApp({
		dataDir: ctx.dataDir,
		agentProvider: provider,
		initialConfig: { ...DEFAULT_CONFIG, model: "gpt-4.1-mini" },
		projects: ctx.app.pm.list(),
	});
	newApp.markReady();
	return newApp;
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

async function waitForIdle(ctx: TestContext, timeoutMs = 10000): Promise<void> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.getTask(rootNodeId);
		if (rootNode?.session?.queue?.idle) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Agent did not enter idle state within ${timeoutMs}ms`);
}

async function startAgent(ctx: TestContext, prompt: string): Promise<Response> {
	const tasksRes = await ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks`,
	);
	const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
	return ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: prompt }),
		},
	);
}

async function sendMessage(
	ctx: TestContext,
	message: string,
): Promise<Response> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	return ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: message }),
		},
	);
}

describe("Responses integration: isolated harness", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("runs end-to-end through tool execution and records the round-trip in /responses payloads", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();
		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Let me inspect the repo." },
				{
					type: "tool_use",
					name: "mcp__mxd__bash",
					input: { command: "printf responses-hi" },
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);

		const start = Date.now();
		while (Date.now() - start < 5000 && ctx.mockAPI.getRequestCount() < 2) {
			await new Promise((r) => setTimeout(r, 25));
		}
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(2);
		const request =
			ctx.mockAPI.getRequestHistory()[1] ?? ctx.mockAPI.getRequestHistory()[0];
		expect(request).toBeDefined();
		const input = request?.body.input as Array<Record<string, unknown>>;
		expect(Array.isArray(input)).toBe(true);
		expect(
			input.some(
				(item) => item.type === "message" && item.role === "assistant",
			),
		).toBe(true);
		expect(
			input.some(
				(item) =>
					item.type === "function_call" &&
					item.name === "mcp__mxd__bash" &&
					typeof item.arguments === "string" &&
					item.arguments.includes("responses-hi"),
			),
		).toBe(true);
		expect(
			input.some(
				(item) =>
					item.type === "function_call_output" &&
					typeof item.output === "string" &&
					item.output.includes("responses-hi"),
			),
		).toBe(true);
	});

	test("validates /responses request shape and tool/result round-trip", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();
		const instruction = JSON.stringify({
			turns: [
				{
					blocks: [
						{ type: "text", text: "Checking request shape." },
						{
							type: "tool_use",
							name: "mcp__mxd__done",
							input: { status: "passed", summary: "shape ok" },
						},
					],
				},
			],
		});

		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		expect(await waitForDone(ctx)).toBe("verify");

		const request = ctx.mockAPI.getRequestHistory()[0];
		expect(request).toBeDefined();
		expect(request?.body.model).toBe("gpt-4.1-mini");
		expect(request?.body.stream).toBe(true);
		expect(request?.body.store).toBe(false);
		expect(Array.isArray(request?.body.input)).toBe(true);
		expect(Array.isArray(request?.body.tools)).toBe(true);
		expect(request?.headers.authorization).toBe("Bearer test-key");
	});

	test("restart after yield preserves prefix-stable /responses history", async () => {
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Waiting for input." },
				{ type: "tool_use", name: "mcp__mxd__yield", input: {} },
			],
		});
		const resp = await startAgent(ctx, instruction);
		expect(resp.status).toBe(200);
		await waitForIdle(ctx);
		const preRestartRequests = ctx.mockAPI.getRequestCount();
		expect(preRestartRequests).toBe(1);

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);
		await ctx.app.autoResumeProjects();
		expect(ctx.mockAPI.getRequestCount()).toBe(preRestartRequests);

		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Finished after restart." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "responses restart ok" },
				},
			],
		});
		const wakeResp = await sendMessage(ctx, wakeInstruction);
		expect(wakeResp.status).toBe(200);
		expect(await waitForDone(ctx)).toBe("verify");
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThan(preRestartRequests);
	});
});
