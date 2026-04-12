/**
 * Drift-prevention tests for every QueueMessage source type.
 *
 * For each source variant, we verify that the live path (buildUserTurn,
 * which delegates to walker) produces BYTE-IDENTICAL output to JSONL
 * reconstruction after restart. The mock API's `enablePrefixValidation()`
 * catches any divergence at the next API call.
 *
 * Pattern:
 *   1. Start agent; it runs turn 1 and enters idle (end_turn).
 *   2. Inject the message-under-test (directly via deliverMessage).
 *   3. Agent wakes, runs turn 2, calls done().
 *   4. Restart the app (simulates daemon crash/reload).
 *   5. Wake the agent with a simple message.
 *   6. If live-path output ≠ reconstructed output, prefix validation throws.
 *
 * We exercise all three assembly paths that can drift:
 *   - `onConsumedMessages` idle branch (reached when message arrives after end_turn)
 *   - `onConsumedMessages` working branch (reached when message arrives while tool running)
 *   - `onToolResults` (reached when message arrives at cancellation point)
 *
 * The live path (buildUserTurn → buildToolResultEvents → walker) routes through
 * these callbacks; reconstruction from JSONL also routes through them. Byte-identical
 * bytes out = no drift possible.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverMessage } from "./daemon/agent-lifecycle.ts";
import { createApp } from "./daemon.ts";
import type { QueueMessage } from "./message-queue.ts";
import {
	createBackgroundComplete,
	createClarifyResponse,
	createCrossProjectMessage,
	createTaskComplete,
	createTaskMessage,
	createTreeChange,
	createUserMessage,
	createUserMessageForwarded,
} from "./queue-message-factory.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";

// createUserMessage used indirectly via deliverMessage; these factories are all
// used in the tests below.
void createUserMessage;

// ── Test infrastructure (mirrors integration.test.ts setup) ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-drift-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-drift-project-"));

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
	const provider = createMockedProviderWithMock(mockAPI);

	const appResult = createApp({ dataDir, agentProvider: provider });
	await appResult.pm.load();
	const project = await appResult.pm.init(projectDir);

	// Clean up quality task templates
	const tasksDir = join(projectDir, ".mxd", "tasks");
	if (existsSync(tasksDir)) rmSync(tasksDir, { recursive: true });

	// Activate worktree setup hook
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
		projectId: project.id,
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
				`Agent crashed (session gone, status still in_progress) — likely a prefix-validation failure.`,
			);
		}
		prevHadSession = hasSession;
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
		const queue = rootNode?.session?.queue;
		if (queue?.idle) return;
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

async function recreateApp(
	ctx: TestContext,
): Promise<ReturnType<typeof createApp>> {
	const provider = createMockedProviderWithMock(ctx.mockAPI);
	const newApp = createApp({ dataDir: ctx.dataDir, agentProvider: provider });
	await newApp.pm.load();
	newApp.markReady();
	return newApp;
}

/**
 * Inject a QueueMessage directly into the root agent's queue via deliverMessage.
 * Bypasses the HTTP layer — useful for injecting non-user source types that
 * the HTTP layer doesn't expose.
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
void injectMessage;

/**
 * A two-turn instruction that idles after turn 1 (end_turn with pure text),
 * then on turn 2 calls done(). The agent must wake up between the turns.
 * The TEXT in turn 1 is what mock API uses to drive streaming; without it
 * mock API has nothing to say (empty text → confused).
 */
function twoTurnInstruction(summary: string): string {
	return JSON.stringify({
		turns: [
			{ blocks: [{ type: "text", text: "Waiting for next message." }] },
			{
				blocks: [
					{ type: "text", text: "Got it, wrapping up." },
					{
						type: "tool_use",
						name: "mcp__mxd__done",
						input: { status: "passed", summary },
					},
				],
			},
		],
	});
}

/**
 * A one-block wake instruction used post-restart. Note: post-restart the agent
 * is fed a queue message that drives its behavior, but the mock API still needs
 * to match a conversation key. The simplest approach: a single-turn instruction
 * that calls done() directly.
 */
function wakeInstruction(summary: string): string {
	return JSON.stringify({
		blocks: [
			{ type: "text", text: "After restart." },
			{
				type: "tool_use",
				name: "mcp__mxd__done",
				input: { status: "passed", summary },
			},
		],
	});
}

/**
 * Run the full drift-test lifecycle:
 * 1. start agent (enters idle after turn 1)
 * 2. inject the message under test
 * 3. wait for done (turn 2 fires)
 * 4. restart app
 * 5. send wake message → done after restart
 * If prefix validation fails anywhere, waitForDone throws.
 */
async function runDriftCycle(
	ctx: TestContext,
	summary: string,
	injector: (ctx: TestContext) => Promise<void>,
): Promise<void> {
	ctx.mockAPI.enablePrefixValidation();
	await startAgent(ctx, twoTurnInstruction(summary));
	await waitForIdle(ctx);
	await injector(ctx);
	const status = await waitForDone(ctx);
	expect(status).toBe("verify");

	// Restart
	await ctx.app.shutdown();
	await new Promise((r) => setTimeout(r, 100));
	ctx.app = await recreateApp(ctx);

	// Wake again
	await sendMessage(ctx, wakeInstruction(`${summary} restart ok`));
	const status2 = await waitForDone(ctx);
	expect(status2).toBe("verify");
}

// ── Tests: each QueueMessage source type ──

describe("Drift prevention: QueueMessage source types", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	// ── Meta: verify test infrastructure actually runs prefix validation ──

	test("meta: runDriftCycle hits the prefix-validation path (≥3 API calls)", async () => {
		// Sanity check that our test harness actually triggers reconstruction + re-send.
		// After restart, the wake message causes the agent to re-send ALL history →
		// prefix validation compares against pre-restart request → THIS is what
		// catches drift. If we never make a post-restart request, the tests are fake.
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "meta ok", async (c) => {
			await sendMessage(c, "Meta wake");
		});
		// Expected: 2 pre-restart calls (turn 1 + turn 2) + 1 post-restart wake = 3
		expect(ctx.mockAPI.getRequestCount()).toBeGreaterThanOrEqual(3);

		// Verify the post-restart call has the pre-restart history as its prefix.
		// If reconstruction differs in ANY byte, validatePrefix would have thrown
		// inside the mock (fail mode). That case is covered by the other tests;
		// here we assert the positive: the sequence grew monotonically.
		const reqs = ctx.mockAPI.getRequestHistory();
		expect(reqs.length).toBeGreaterThanOrEqual(3);
		// Post-restart request (index 2+) must be longer than pre-restart (index 1)
		const preRestart = reqs[1];
		const postRestart = reqs[reqs.length - 1];
		expect(preRestart).toBeTruthy();
		expect(postRestart).toBeTruthy();
		if (preRestart && postRestart) {
			expect(postRestart.messages.length).toBeGreaterThanOrEqual(
				preRestart.messages.length,
			);
		}
	}, 30000);

	// ── user source ──

	test("user message with text only (via POST endpoint)", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "user text ok", async (c) => {
			await sendMessage(c, "Plain text wake");
		});
	}, 30000);

	test("user message with text only (via injectMessage, no header)", async () => {
		// Differs from above: POST adds no header on warm-path, but let's verify
		// direct-inject user messages (no header, no images) also round-trip.
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "user inject ok", async (c) => {
			await injectMessage(c, createUserMessage("Injected user message"));
		});
	}, 30000);

	test("user message with images", async () => {
		ctx = await setupTestContext();
		const tinyPng =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		await runDriftCycle(ctx, "user image ok", async (c) => {
			await injectMessage(
				c,
				createUserMessage("Here is a screenshot", {
					images: [{ base64: tinyPng, mediaType: "image/png" }],
				}),
			);
		});
	}, 30000);

	test("user message with header (cold-start)", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "user header ok", async (c) => {
			await injectMessage(
				c,
				createUserMessage("Main content here", {
				}),
			);
		});
	}, 30000);

	test("user message with header AND images", async () => {
		ctx = await setupTestContext();
		const tinyPng =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		await runDriftCycle(ctx, "user header+image ok", async (c) => {
			await injectMessage(
				c,
				createUserMessage("Main content with image", {
					images: [{ base64: tinyPng, mediaType: "image/png" }],
				}),
			);
		});
	}, 30000);

	// ── task_message source ──

	test("task_message without title, without requestReply, without header", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "task_message minimal ok", async (c) => {
			await injectMessage(
				c,
				createTaskMessage("01SIBLING01", "Sibling Task", "Hello from sibling"),
			);
		});
	}, 30000);

	test("task_message with title and requestReply", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "task_message full ok", async (c) => {
			await injectMessage(
				c,
				createTaskMessage(
					"01SIBLING02",
					"Sibling With Title",
					"Please review this",
					{ title: "Review request", requestReply: true },
				),
			);
		});
	}, 30000);

	test("task_message with header (cold-start downward)", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "task_message header ok", async (c) => {
			await injectMessage(
				c,
				createTaskMessage("01PARENT001", "Parent Task", "Do this work, child", {
					title: "Start work",
				}),
			);
		});
	}, 30000);

	// ── task_complete source ──

	test("task_complete with success=true", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "task_complete success ok", async (c) => {
			await injectMessage(
				c,
				createTaskComplete(
					"01CHILDDONE1",
					"Finished Child",
					true,
					"All good, done",
				),
			);
		});
	}, 30000);

	test("task_complete with success=false", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "task_complete failure ok", async (c) => {
			await injectMessage(
				c,
				createTaskComplete(
					"01CHILDFAIL1",
					"Failed Child",
					false,
					"Something went wrong",
				),
			);
		});
	}, 30000);

	// ── clarify_response source ──

	test("clarify_response", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "clarify_response ok", async (c) => {
			await injectMessage(c, createClarifyResponse("Yes, proceed with plan B"));
		});
	}, 30000);

	// ── user_message_forwarded source ──

	test("user_message_forwarded without resumed flag", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "forwarded ok", async (c) => {
			await injectMessage(
				c,
				createUserMessageForwarded(
					"01CHILDFWD01",
					"Child Task",
					"User said: please hurry",
				),
			);
		});
	}, 30000);

	test("user_message_forwarded with resumed=true", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "forwarded resumed ok", async (c) => {
			await injectMessage(
				c,
				createUserMessageForwarded(
					"01CHILDFWD02",
					"Resumed Child",
					"User message on reopen",
					{ resumed: true },
				),
			);
		});
	}, 30000);

	// ── cross_project source ──

	test("cross_project", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "cross_project ok", async (c) => {
			await injectMessage(
				c,
				createCrossProjectMessage(
					"other-project-id",
					"Other Project",
					"Hi from another project's agent",
				),
			);
		});
	}, 30000);

	// ── tree_change source ──

	test("tree_change with title (created)", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "tree_change created ok", async (c) => {
			await injectMessage(
				c,
				createTreeChange("created", "01NEWNODE001", "New Task Title"),
			);
		});
	}, 30000);

	test("tree_change without title (deleted)", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "tree_change deleted ok", async (c) => {
			await injectMessage(c, createTreeChange("deleted", "01GONENODE01"));
		});
	}, 30000);

	test("tree_change: updated and reordered actions", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "tree_change variants ok", async (c) => {
			await injectMessage(
				c,
				createTreeChange("updated", "01UPDNODE001", "Updated Task"),
			);
		});
	}, 30000);

	// ── background_complete source ──

	test("background_complete with stdout+stderr", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "bg_complete full ok", async (c) => {
			await injectMessage(
				c,
				createBackgroundComplete({
					commandId: "bg-01TEST0001",
					command: "echo hi; echo err >&2",
					exitCode: 0,
					durationMs: 123,
					content: "exit code: 0\nstdout:\nhi\nstderr:\nerr\n",
				}),
			);
		});
	}, 30000);

	test("background_complete with stdout only", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "bg_complete stdout ok", async (c) => {
			await injectMessage(
				c,
				createBackgroundComplete({
					commandId: "bg-01TEST0002",
					command: "echo hi",
					exitCode: 0,
					durationMs: 50,
					content: "exit code: 0\nstdout:\nhi\n",
				}),
			);
		});
	}, 30000);

	test("background_complete with no output (empty)", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "bg_complete empty ok", async (c) => {
			await injectMessage(
				c,
				createBackgroundComplete({
					commandId: "bg-01TEST0003",
					command: "true",
					exitCode: 0,
					durationMs: 10,
					content: "exit code: 0",
				}),
			);
		});
	}, 30000);

	test("background_complete with non-zero exit code", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "bg_complete error ok", async (c) => {
			await injectMessage(
				c,
				createBackgroundComplete({
					commandId: "bg-01TEST0004",
					command: "false",
					exitCode: 1,
					durationMs: 5,
					content: "exit code: 1\nstderr:\ncommand failed\n",
				}),
			);
		});
	}, 30000);

	test("background_complete with null exit code (killed)", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "bg_complete killed ok", async (c) => {
			await injectMessage(
				c,
				createBackgroundComplete({
					commandId: "bg-01TEST0005",
					command: "sleep 999",
					exitCode: null,
					durationMs: 2000,
					content: "Process killed",
				}),
			);
		});
	}, 30000);

	// ── Adversarial: mixed source batches ──

	test("mixed batch: three different source types in quick succession", async () => {
		// All three messages arrive before agent is scheduled to wake, so they
		// go into a single messages_consumed batch. Each must become its own
		// text block in the user message. Order must be preserved.
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "mixed batch ok", async (c) => {
			await injectMessage(
				c,
				createTaskComplete("01CHILD0001", "Child A", true, "done A"),
			);
			await injectMessage(
				c,
				createTaskMessage("01PEER00001", "Peer Task", "Hi peer msg"),
			);
			await injectMessage(
				c,
				createTreeChange("created", "01NEW000001", "New Child"),
			);
		});
	}, 30000);

	test("multiple same-source batch: 5 task_messages", async () => {
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "multi task_message ok", async (c) => {
			for (let i = 0; i < 5; i++) {
				await injectMessage(
					c,
					createTaskMessage(
						`01TASK${String(i).padStart(5, "0")}`,
						`Task ${i}`,
						`Message number ${i}`,
					),
				);
			}
		});
	}, 45000);

	test("mixed batch including user message with images", async () => {
		// Images on a user message IN a batch with other non-image sources.
		// Caption block must appear and be consistent.
		ctx = await setupTestContext();
		const tinyPng =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		await runDriftCycle(ctx, "mixed batch w/ image ok", async (c) => {
			await injectMessage(
				c,
				createTaskComplete("01CHILD0002", "Child B", true, "done B"),
			);
			await injectMessage(
				c,
				createUserMessage("User with image", {
					images: [{ base64: tinyPng, mediaType: "image/png" }],
				}),
			);
			await injectMessage(
				c,
				createTreeChange("updated", "01NODE000001", "Updated"),
			);
		});
	}, 30000);

	test("task_message with special characters (XML-unsafe)", async () => {
		// formatBodyForAI interpolates fields directly into XML tags. Any drift
		// caused by escaping differences would show up here.
		ctx = await setupTestContext();
		await runDriftCycle(ctx, "special chars ok", async (c) => {
			await injectMessage(
				c,
				createTaskMessage(
					"01SIBLING03",
					'Task "quoted" & <weird>',
					'Content with <tag> and "quotes" and & ampersand',
					{ title: 'Subject with "quotes"' },
				),
			);
		});
	}, 30000);
});
