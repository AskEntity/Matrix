/**
 * Shared test harness for event-emission invariant tests.
 * Keeps the per-test setup boilerplate in one place so individual test
 * files can focus on assertions.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ulid } from "../ulid.ts";
import { deliverMessage } from "../runtime/agent-lifecycle.ts";
import { createApp } from "../runtime.ts";
import { EventStore } from "../event-store.ts";
import type { Event } from "../events.ts";
import type { QueueMessage } from "../message-queue.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./mock-anthropic-api.ts";

export interface EmissionTestContext {
	dataDir: string;
	projectDir: string;
	app: ReturnType<typeof createApp>;
	mockAPI: ValidatingMockAPI;
	projectId: string;
}

export async function setupEmissionTestContext(): Promise<EmissionTestContext> {
	const dataDir = await mkdtemp(join(tmpdir(), "mxd-emission-data-"));
	const projectDir = await mkdtemp(join(tmpdir(), "mxd-emission-project-"));

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
	const projectId = ulid();
	appResult.pm.sync([{ id: projectId, name: basename(projectDir), path: projectDir }]);

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

export async function teardownEmissionTestContext(
	ctx: EmissionTestContext,
): Promise<void> {
	await ctx.app.shutdown();
	await new Promise((r) => setTimeout(r, 50));
	await rm(ctx.dataDir, { recursive: true, force: true });
	await rm(ctx.projectDir, { recursive: true, force: true });
}

export async function waitForDone(
	ctx: EmissionTestContext,
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

export async function waitForIdle(
	ctx: EmissionTestContext,
	timeoutMs = 10000,
): Promise<void> {
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

export async function startAgent(
	ctx: EmissionTestContext,
	prompt: string,
): Promise<Response> {
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

export async function injectMessage(
	ctx: EmissionTestContext,
	message: QueueMessage,
): Promise<void> {
	const tracker = await ctx.app.getTracker(ctx.projectId);
	const rootNodeId = tracker.rootNodeId;
	const project = ctx.app.ctx.pm.get(ctx.projectId);
	if (!project) throw new Error("project not found");
	await deliverMessage(ctx.app.ctx, project, rootNodeId, message);
}

export async function readSessionEvents(
	ctx: EmissionTestContext,
	sessionId: string,
): Promise<Event[]> {
	const daemonStore = ctx.app.ctx.eventStores.get(ctx.projectId);
	if (daemonStore) await daemonStore.flushSession(sessionId);
	const store = new EventStore(
		join(ctx.dataDir, "projects", ctx.projectId, "tasks"),
	);
	return store.read(sessionId) as Event[];
}

export function messageIdOccurrences(events: Event[], id: string): Event[] {
	return events.filter(
		(e) => e.type === "message" && (e as { id?: string }).id === id,
	);
}

export function twoTurnInstruction(summary: string): string {
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

export function singleTurnDoneInstruction(summary: string): string {
	return JSON.stringify({
		blocks: [
			{ type: "text", text: "Doing it." },
			{
				type: "tool_use",
				name: "mcp__mxd__done",
				input: { status: "passed", summary },
			},
		],
	});
}
