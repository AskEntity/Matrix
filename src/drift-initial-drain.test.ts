/**
 * Drift tests targeting the THIRD codepath: initial queue drain in runProviderLoop.
 *
 * Matrix has three places that construct user messages from queue:
 *   1. `buildUserTurn` (delegates to walker — no independent logic)
 *   2. `onConsumedMessages` (walker callback — the unified path)
 *   3. Initial drain in runProviderLoop (agent fresh-start / resume-without-yield)
 *
 * Path 3 USED to bypass the walker and construct text-only user messages —
 * images and captions were silently dropped. On restart the walker
 * reconstructed [text, image, caption] from JSONL while the pre-restart live
 * path had produced just [text], and the next API call's prefix validation
 * caught the divergence.
 *
 * That divergence is FIXED (commit 39e420b): initial drain now delegates to
 * `adapter.appendQueueMessagesToMessages`, which routes through the same
 * `applyXxxQueueContent` helpers the walker uses. One function, two call
 * sites, zero drift possible.
 *
 * These tests are therefore drift-PREVENTION guards, not repros: each drives a
 * fresh-start scenario (text, image+caption, etc.) across a restart with
 * prefix validation enabled, and asserts the live path matches reconstruction.
 * If anyone re-introduces an independent initial-drain construction path, they
 * fail.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { QueueMessage } from "./message-queue.ts";
import {
	createCrossProjectMessage,
	createUserMessage,
} from "./queue-message-factory.ts";
import { deliverMessage } from "./runtime/agent-lifecycle.ts";
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
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-drift3-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-drift3-project-"));

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

async function waitForDone(
	ctx: TestContext,
	timeoutMs = 15000,
): Promise<string> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	let prevHadSession = false;

	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const rootNode = tracker.getTask(rootNodeId);
		if (rootNode?.status === "verify" || rootNode?.status === "failed") {
			return rootNode.status;
		}
		const hasSession = !!rootNode?.session;
		if (prevHadSession && !hasSession && rootNode?.status === "in_progress") {
			throw new Error(
				`Agent crashed (session gone, status still in_progress) — likely a prefix-validation failure (drift).`,
			);
		}
		prevHadSession = hasSession;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Agent did not call done() within ${timeoutMs}ms`);
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

async function recreateApp(
	ctx: TestContext,
): Promise<ReturnType<typeof createApp>> {
	const provider = createMockedProviderWithMock(ctx.mockAPI);
	const newApp = createApp({
		dataDir: ctx.dataDir,
		agentProvider: provider,
		projects: [
			{
				id: ctx.projectId,
				name: basename(ctx.projectDir),
				path: ctx.projectDir,
			},
		],
	});
	newApp.markReady();
	return newApp;
}

/**
 * Inject a non-user message directly via deliverMessage.
 * Needed because the POST endpoint only builds `user`-source messages.
 */
async function injectMessage(
	ctx: TestContext,
	message: QueueMessage,
): Promise<void> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	const project = ctx.app.ctx.pm.get(ctx.projectId);
	if (!project) throw new Error("project not found");
	await deliverMessage(ctx.app.ctx, project, rootNodeId, message);
}

/**
 * Pre-inject messages to the queue BEFORE the agent launches.
 * This is how fresh-start initial drain gets exercised: messages sit in
 * the queue, then agent starts and drains them as its first action.
 *
 * Note: deliverMessage auto-launches the agent if none is running. So
 * the first deliverMessage call triggers launch + drain.
 */
async function startAgentWithMessage(
	ctx: TestContext,
	firstMessage: string,
	images?: Array<{ base64: string; mediaType: string }>,
): Promise<void> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	await ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${rootNodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: firstMessage, images }),
		},
	);
}

// A tiny 1×1 valid PNG
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("Drift exposure: initial queue drain (third codepath)", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	// ── Control: fresh-start text-only initial message (should pass) ──

	test("fresh-start with plain text: live matches reconstruction", async () => {
		// Baseline: no images, no special sources. Initial drain and walker
		// both produce string content (single text message). Should pass.
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Hello, starting." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "plain text ok" },
				},
			],
		});

		await startAgentWithMessage(ctx, instruction);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		// Restart and wake to trigger reconstruction + prefix validation
		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);

		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "After restart." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "restart ok" },
				},
			],
		});
		await sendMessage(ctx, wakeInstruction);
		const status2 = await waitForDone(ctx);
		expect(status2).toBe("verify");
	}, 30000);

	// ── Drift prevention: fresh-start with IMAGES ──

	// Regression guard for the commit-39e420b fix. Pre-fix, initial drain
	// dropped images + captions, so this diverged on restart and failed.
	// Post-fix it passes: initial drain delegates to the walker's helpers.
	test("fresh-start initial message with image preserves image & caption across restart", async () => {
		// Initial drain now delegates to `adapter.appendQueueMessagesToMessages`,
		// so user QueueMessage.images ARE extracted into content blocks. On
		// restart the walker reconstructs the SAME message from JSONL via the
		// onConsumedMessages idle-context path — identical [text, image,
		// caption]. Prefix validation passes (no drift).
		ctx = await setupTestContext();
		ctx.mockAPI.enablePrefixValidation();

		const instruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "Got image." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "image initial ok" },
				},
			],
		});

		// Fresh-start message WITH image — exercises the unified drain path
		await startAgentWithMessage(ctx, instruction, [
			{ base64: TINY_PNG, mediaType: "image/png" },
		]);
		const status = await waitForDone(ctx);
		expect(status).toBe("verify");

		await ctx.app.shutdown();
		await new Promise((r) => setTimeout(r, 100));
		ctx.app = await recreateApp(ctx);

		const wakeInstruction = JSON.stringify({
			blocks: [
				{ type: "text", text: "After restart." },
				{
					type: "tool_use",
					name: "mcp__mxd__done",
					input: { status: "passed", summary: "image restart ok" },
				},
			],
		});
		await sendMessage(ctx, wakeInstruction);
		const status2 = await waitForDone(ctx);
		// No drift: live path and walker both produce [text, image, caption] at
		// message index 0 — prefix validation passes.
		expect(status2).toBe("verify");
	}, 30000);

	// ── Other drift scenarios ──

	// ── Fresh-start with task_message via direct inject (non-user source) ──
	// These paths exercise non-user source as the initial queue message. They
	// CAN'T be driven cleanly because the first message is wrapped in XML tags
	// (<task_message>...</task_message>) and mock-API instruction extraction
	// may not find the JSON payload reliably. Mark as todo — would be useful
	// coverage if infra was extended.

	test.todo("fresh-start with task_message source as initial message", () => {
		// See block comment above for blocker.
	});
	test.todo("fresh-start with cross_project source as initial message", () => {
		// See block comment above for blocker.
	});

	// Keep imports referenced
	void createCrossProjectMessage;
	void createUserMessage;
	void injectMessage;
});
