/**
 * Tests for the narrowed plugin messaging API: `deliverToNode` + `listNodes`
 * (src/resource-registry.ts).
 *
 * These are the stable, named primitives a plugin's tools compose for
 * intra-project peer messaging (dchat's group-chat tools, etc.) WITHOUT
 * importing the internal resource-registry singleton accessors
 * (`getTracker` / `deliverMessage`) directly.
 *
 * ⭐ SINGLETON — the headline guarantee: `deliverToNode` / `listNodes` operate
 * on the SAME in-process tracker the agent loop uses. A delivered message must
 * actually ARRIVE (auto-launch an idle peer, or enqueue to a live one) — never
 * be silently dropped against a different tracker instance. The tests run a
 * real agent loop (mock provider) so the registry is wired exactly as in
 * production, then prove the message reaches the same tracker + eventStore the
 * app uses.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Event } from "./events.ts";
// The dummy plugin below consumes matrix's PUBLIC SDK surface (the realistic
// out-of-tree shape): deliverToNode / listNodes / createUserMessage / defineTool
// / toToolDefinition / createYieldTool / createDoneTool / z all come from
// "./plugin-sdk.ts" — the very module the bare specifier `mxd/plugin-sdk`
// resolves to. So these real-agent-loop tests double as the literal proof that
// the SDK's deliverToNode actually delivers + wakes an idle peer on the shared
// tracker. `registryGetTracker` stays the INTERNAL accessor (intentionally NOT
// on the SDK surface), used only to ASSERT singleton identity.
import {
	createDoneTool,
	createUserMessage,
	createYieldTool,
	defineTool,
	deliverToNode,
	listNodes,
	toToolDefinition,
	z,
} from "./plugin-sdk.ts";
import { getTracker as registryGetTracker } from "./resource-registry.ts";
import type { ScopeOpts } from "./runtime/context.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import type { BaseTaskNode, TaskNode } from "./types.ts";
import { ulid } from "./ulid.ts";

// ── Test infrastructure ──

interface TestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

async function setupTestContext(): Promise<TestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-plugin-msg-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-plugin-msg-project-"));

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
	});
	appResult.markReady();

	// Lightweight, non-Matrix "peer" scope: no worktrees (no beforeChildLaunch),
	// so an auto-launched peer runs in the project root — keeps the test focused
	// on the messaging primitive, not git plumbing.
	appResult.ctx.scopeOpts.set(projectId, buildPeerScopeOpts());

	return { dataDir, projectDir, app: appResult, mockAPI, projectId };
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

/** POST a message (mock instruction) to a node via REST, asserting accepted. */
async function postMessage(
	ctx: TestContext,
	nodeId: string,
	instruction: string,
): Promise<void> {
	const resp = await ctx.app.app.request(
		`/projects/${ctx.projectId}/tasks/${nodeId}/message`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: instruction }),
		},
	);
	expect(resp.status).toBe(200);
}

/** Poll a node's status until it reaches a terminal state (or timeout). */
async function waitForStatus(
	ctx: TestContext,
	nodeId: string,
	timeoutMs = 20000,
): Promise<string | undefined> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const node = tracker.getTask(nodeId);
		if (node?.status === "verify" || node?.status === "failed")
			return node.status;
		await new Promise((r) => setTimeout(r, 50));
	}
	return tracker.getTask(nodeId)?.status;
}

/** A single-turn mock instruction: say something, then done("passed"). */
function doneInstruction(marker: string): string {
	return JSON.stringify({
		blocks: [
			{ type: "text", text: marker },
			{
				type: "tool_use",
				name: "mcp__mxd__done",
				input: { status: "passed", summary: marker },
			},
		],
	});
}

// ── A dummy plugin tool that calls deliverToNode ──
//
// This is the realistic dchat shape: a plugin tool, invoked from inside an
// agent loop, routes a message to a peer node via the named API. Because the
// tool runs in the same worker module graph, deliverToNode hits the singleton
// registry — the SAME tracker the loop uses.
const sendToPeerTool = defineTool({
	name: "send_to_peer",
	description: "Deliver a message to a peer node (plugin messaging primitive).",
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
		peerId: {
			schema: z.string().describe("target node id"),
			decl: { kind: "explicit" },
		},
		text: {
			schema: z.string().describe("message content (a mock instruction)"),
			decl: { kind: "explicit" },
		},
	},
	handler: async (args) => {
		await deliverToNode(
			args.projectId,
			args.peerId,
			createUserMessage(args.text),
		);
		return {
			content: [{ type: "text" as const, text: `delivered to ${args.peerId}` }],
			isError: false,
		};
	},
});

// biome-ignore lint/suspicious/noExplicitAny: test scope, generic erased
function buildPeerScopeOpts(): ScopeOpts<any> {
	return {
		buildTools: (auth, _taskId) => ({
			tools: [
				sendToPeerTool,
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
		buildPrompt: () => ({
			stable: "You are a peer agent.",
			variable: "",
		}),
		buildWorkContext: () => "Peer context.",
		buildSummarizationPrompt: () => "Summarize.",
		shouldResume: (node: TaskNode) => node.status === "in_progress",
		onLaunch: (node: TaskNode, tracker) => {
			tracker.updateStatus(node.id, "in_progress");
		},
		onDone: (node: TaskNode, tracker, doneArgs) => {
			tracker.updateStatus(
				node.id,
				doneArgs.status === "passed" ? "verify" : "failed",
			);
			return {};
		},
	};
}

// ── Tests ──

describe("Plugin messaging API: deliverToNode + listNodes", () => {
	let ctx: TestContext;

	afterEach(async () => {
		if (ctx) await teardownTestContext(ctx);
	});

	test("deliverToNode from a plugin tool wakes an idle peer (auto-launch) on the SAME tracker", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		// Seed an idle peer child — pending, no session, no worktree.
		const peer = tracker.addChild(rootId, "Peer", "a peer node");
		await tracker.save();

		// The peer's instruction (it done()s when it wakes). Distinctive marker so
		// we can find the delivered message in the peer's JSONL.
		const marker = `peer-woke-${ulid()}`;
		const peerInstr = doneInstruction(marker);

		// Root (sender) invokes the dummy plugin tool; afterward it just yields
		// (the mock returns end_turn once its single turn is consumed), staying
		// alive so the peer's eventual task_complete enqueues instead of
		// relaunching root.
		const rootInstr = JSON.stringify({
			blocks: [
				{
					type: "tool_use",
					name: "mcp__mxd__send_to_peer",
					input: { peerId: peer.id, text: peerInstr },
				},
			],
		});
		await postMessage(ctx, rootId, rootInstr);

		// The peer must auto-launch and finish — proves the message ARRIVED.
		const peerStatus = await waitForStatus(ctx, peer.id);
		expect(peerStatus).toBe("verify");

		// SINGLETON: the tracker the named API reads is the very object the app
		// (and thus the agent loop) holds. If deliverToNode targeted a different
		// _ctx, the peer would never have woken above.
		expect(registryGetTracker(ctx.projectId)).toBe(
			ctx.app.ctx.trackers.get(ctx.projectId),
		);

		// The delivered user message is in the peer's JSONL — same in-process
		// eventStore the app owns.
		const peerEvents = await readSessionEvents(ctx, peer.id);
		const delivered = peerEvents.find(
			(e) =>
				e.type === "message" &&
				typeof e.body === "object" &&
				e.body !== null &&
				(e.body as { source?: string }).source === "user" &&
				typeof (e.body as { content?: string }).content === "string" &&
				(e.body as { content: string }).content.includes(marker),
		);
		expect(delivered).toBeDefined();
	}, 30000);

	test("listNodes returns a fresh read-only snapshot of launchable nodes (folders excluded)", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		const a = tracker.addChild(rootId, "Peer A", "");
		const b = tracker.addChild(rootId, "Peer B", "");
		const folder = tracker.addGeneralNode("A Folder", rootId, "folder");
		await tracker.save();

		// Launch root once so the registry singleton is wired to THIS app's ctx.
		expect(await waitForRoot(ctx, rootId)).toBe("verify");

		// Singleton sanity — named API and app share one tracker.
		expect(registryGetTracker(ctx.projectId)).toBe(
			ctx.app.ctx.trackers.get(ctx.projectId),
		);

		const snap = listNodes(ctx.projectId);
		const ids = snap.map((n) => n.id);
		expect(ids).toContain(rootId);
		expect(ids).toContain(a.id);
		expect(ids).toContain(b.id);
		// General (folder) node excluded — not launchable, not a BaseTaskNode.
		expect(ids).not.toContain(folder.id);
		expect(snap).toHaveLength(3);
		// Every returned node is launchable (type "task").
		expect(snap.every((n) => n.type === "task")).toBe(true);

		// Read-only snapshot: mutating the returned array must not affect the
		// tracker, and a later call returns a fresh array.
		const trackerCountBefore = tracker.allNodes().length; // root + a + b + folder
		(snap as BaseTaskNode[]).push({
			id: "fake",
			title: "fake",
			parentId: rootId,
			children: [],
			createdAt: "",
			updatedAt: "",
			status: "pending",
			type: "task",
		});
		const snap2 = listNodes(ctx.projectId);
		expect(snap2).toHaveLength(3); // fresh snapshot — the push did not leak in
		expect(snap2.map((n) => n.id)).not.toContain("fake");
		expect(tracker.allNodes()).toHaveLength(trackerCountBefore); // tracker untouched
	}, 30000);

	test("broadcast: loop listNodes → deliverToNode to each OTHER group member (none to self)", async () => {
		ctx = await setupTestContext();
		const tracker = await ctx.app.getTracker(ctx.projectId);
		const rootId = tracker.rootNodeId;

		// A group of three peer children. peerA is the "sender".
		const peerA = tracker.addChild(rootId, "Peer A", "");
		const peerB = tracker.addChild(rootId, "Peer B", "");
		const peerC = tracker.addChild(rootId, "Peer C", "");
		await tracker.save();

		// Launch root so the registry singleton is wired to THIS app's ctx.
		expect(await waitForRoot(ctx, rootId)).toBe("verify");

		// Simulate peerA's broadcast tool: deliver to every OTHER group member.
		// Group members = launchable children (exclude root + self). This is the
		// exact composition a plugin's broadcast tool performs.
		const senderId = peerA.id;
		const recipients = listNodes(ctx.projectId).filter(
			(n) => n.parentId !== null && n.id !== senderId,
		);
		expect(recipients.map((n) => n.id).sort()).toEqual(
			[peerB.id, peerC.id].sort(),
		);

		for (const r of recipients) {
			await deliverToNode(
				ctx.projectId,
				r.id,
				createUserMessage(doneInstruction(`broadcast-${r.id}`)),
			);
		}

		// Each OTHER member auto-launches and finishes.
		expect(await waitForStatus(ctx, peerB.id)).toBe("verify");
		expect(await waitForStatus(ctx, peerC.id)).toBe("verify");

		// None to self: peerA was never delivered to → never launched, no session.
		expect(tracker.getTask(peerA.id)?.status).toBe("pending");
		expect(
			ctx.app.ctx.eventStores.get(ctx.projectId)?.has(peerA.id),
		).toBeFalsy();
	}, 30000);
});

/**
 * Launch the root agent with a done() instruction and wait for verify. Root
 * has no parent, so its done() relaunches nobody — a clean way to wire the
 * resource-registry singleton to this app's ctx before exercising the named
 * API directly.
 */
async function waitForRoot(
	ctx: TestContext,
	rootId: string,
): Promise<string | undefined> {
	await postMessage(ctx, rootId, doneInstruction("root ready"));
	return waitForStatus(ctx, rootId);
}
