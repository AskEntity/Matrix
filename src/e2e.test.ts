/**
 * E2E tests: real agent execution through the daemon API.
 *
 * Run with:
 *   source .env && export CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_MODEL
 *   bun test src/e2e.test.ts
 *
 * Skipped by default (requires auth token).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider } from "./claude-code-provider.ts";
import { createApp } from "./daemon.ts";
import { DirectProvider } from "./direct-provider.ts";
import type { TaskNode } from "./types.ts";

const hasToken = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

/** Poll until agent finishes for a project. Returns when no agent is running. */
async function waitForAgent(
	app: ReturnType<typeof createApp>["app"],
	projectId: string,
	timeoutMs = 120_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await app.request(`/projects/${projectId}/agent`);
		const status = (await res.json()) as { running: boolean };
		if (!status.running) return;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`Agent did not finish within ${timeoutMs}ms`);
}

describe.skipIf(!hasToken)("E2E: agent execution", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-e2e-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-e2e-data-"));
		const result = createApp({
			dataDir,
			agentProvider: new ClaudeCodeProvider(),
		});
		app = result.app;
		await result.pm.load();
	});

	afterAll(async () => {
		if (tempDir) await rm(tempDir, { recursive: true });
		if (dataDir) await rm(dataDir, { recursive: true });
	});

	test(
		"direct run: agent creates calculator with tests",
		async () => {
			const projectPath = join(tempDir, "calc-direct");

			// Start agent via /agents/start (auto-creates project)
			const startRes = await app.request("/agents/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: projectPath,
					prompt:
						"Create a simple calculator module in src/calc.ts with add, subtract, multiply, divide functions. " +
						"Also create src/calc.test.ts with tests for all four operations. " +
						"Make sure divide by zero returns Infinity. " +
						"Run the tests and make sure they pass.",
					maxTurns: 20,
				}),
			});

			expect(startRes.status).toBe(200);
			const { projectId } = (await startRes.json()) as {
				projectId: string;
			};

			// Wait for agent to complete
			await waitForAgent(app, projectId);

			expect(existsSync(join(projectPath, "src", "calc.ts"))).toBe(true);

			// Verify tests pass independently
			const proc = Bun.spawn(["bun", "test", "src/calc.test.ts"], {
				cwd: projectPath,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(await proc.exited).toBe(0);
		},
		{ timeout: 120_000 },
	);

	test(
		"agent orchestrator: decompose + parallel spawn + merge",
		async () => {
			const projectPath = join(tempDir, "orch-agent");

			// Start orchestration via /agents/start
			const startRes = await app.request("/agents/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: projectPath,
					prompt:
						"Build a utility library with TWO separate modules: " +
						"1) src/strings.ts — capitalize(str) and reverse(str) functions, with src/strings.test.ts " +
						"2) src/arrays.ts — unique(arr) and flatten(arr) functions, with src/arrays.test.ts " +
						"These modules are INDEPENDENT. " +
						"Steps: create_task for root, create_task for each module as children, " +
						"spawn_children to execute in parallel, merge each passed child's branch yourself, then delete_task to clean up, " +
						"then update_task_status root to passed when done.",
					maxTurns: 50,
				}),
			});
			expect(startRes.status).toBe(200);
			const { projectId } = (await startRes.json()) as {
				projectId: string;
			};

			// Wait for agent to complete
			await waitForAgent(app, projectId, 600_000);

			// Check task tree
			const tasksRes = await app.request(`/projects/${projectId}/tasks`);
			const taskTree = (await tasksRes.json()) as {
				root: TaskNode | null;
				nodes: TaskNode[];
			};

			console.log("Agent orchestrator:", {
				nodeCount: taskTree.nodes.length,
				tasks: taskTree.nodes.map(
					(n) => `${n.title} [${n.status}] branch=${n.branch}`,
				),
			});

			// At least some tasks should have passed
			const passed = taskTree.nodes.filter((n) => n.status === "passed");
			expect(passed.length).toBeGreaterThan(0);
		},
		{ timeout: 600_000 },
	);
});

describe.skipIf(!hasApiKey)("E2E: DirectProvider", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-e2e-direct-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-e2e-direct-data-"));
		const result = createApp({
			dataDir,
			agentProvider: new DirectProvider(),
		});
		app = result.app;
		await result.pm.load();
	});

	afterAll(async () => {
		if (tempDir) await rm(tempDir, { recursive: true });
		if (dataDir) await rm(dataDir, { recursive: true });
	});

	test(
		"direct provider: agent creates calculator with tests",
		async () => {
			const projectPath = join(tempDir, "calc-direct-api");

			// Start agent via /agents/start
			const startRes = await app.request("/agents/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					path: projectPath,
					prompt:
						"Create a simple calculator module in src/calc.ts with add, subtract, multiply, divide functions. " +
						"Also create src/calc.test.ts with tests for all four operations. " +
						"Make sure divide by zero returns Infinity. " +
						"Run the tests and make sure they pass.",
					maxTurns: 20,
				}),
			});

			expect(startRes.status).toBe(200);
			const { projectId } = (await startRes.json()) as {
				projectId: string;
			};

			// Wait for agent to complete
			await waitForAgent(app, projectId);

			expect(existsSync(join(projectPath, "src", "calc.ts"))).toBe(true);

			// Verify tests pass independently
			const proc = Bun.spawn(["bun", "test", "src/calc.test.ts"], {
				cwd: projectPath,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(await proc.exited).toBe(0);
		},
		{ timeout: 120_000 },
	);
});
