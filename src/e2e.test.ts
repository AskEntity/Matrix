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
import type { TaskNode } from "./types.ts";

const hasToken = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);

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
			const createRes = await app.request("/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			});
			expect(createRes.status).toBe(201);
			const project = (await createRes.json()) as { id: string };

			const runRes = await app.request(`/projects/${project.id}/run`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt:
						"Create a simple calculator module in src/calc.ts with add, subtract, multiply, divide functions. " +
						"Also create src/calc.test.ts with tests for all four operations. " +
						"Make sure divide by zero returns Infinity. " +
						"Run the tests and make sure they pass.",
					maxTurns: 20,
				}),
			});

			expect(runRes.status).toBe(200);
			const result = (await runRes.json()) as {
				success: boolean;
				output: string;
				turns?: number;
				costUsd?: number;
			};

			console.log("Direct run:", {
				success: result.success,
				turns: result.turns,
				costUsd: result.costUsd,
			});

			expect(result.success).toBe(true);
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
			const createRes = await app.request("/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			});
			const project = (await createRes.json()) as { id: string };

			// Use the agent-driven orchestration endpoint with a task that requires
			// parallel decomposition into separate modules
			const orchRes = await app.request(
				`/projects/${project.id}/orchestrate/agent`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
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
				},
			);
			expect(orchRes.status).toBe(200);

			const result = (await orchRes.json()) as {
				success: boolean;
				output: string;
				costUsd?: number;
				turns?: number;
				tree: {
					root: TaskNode | null;
					nodes: TaskNode[];
				};
			};

			console.log("Agent orchestrator:", {
				success: result.success,
				turns: result.turns,
				costUsd: result.costUsd,
				nodeCount: result.tree.nodes.length,
				tasks: result.tree.nodes.map(
					(n) => `${n.title} [${n.status}] branch=${n.branch}`,
				),
			});

			expect(result.success).toBe(true);
			// Should have root + 2 children minimum
			expect(result.tree.nodes.length).toBeGreaterThanOrEqual(3);
			// At least some tasks should have passed
			const passed = result.tree.nodes.filter((n) => n.status === "passed");
			expect(passed.length).toBeGreaterThan(0);
		},
		{ timeout: 600_000 },
	);
});
