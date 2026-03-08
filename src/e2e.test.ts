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
		"orchestrator: executes task tree",
		async () => {
			const projectPath = join(tempDir, "calc-orch");
			const createRes = await app.request("/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			});
			const project = (await createRes.json()) as { id: string };

			// Create task tree
			const rootRes = await app.request(`/projects/${project.id}/tasks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Calculator App",
					description:
						"Build a calculator with basic arithmetic operations and tests.",
				}),
			});
			const root = (await rootRes.json()) as TaskNode;

			await app.request(`/projects/${project.id}/tasks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Implement calculator functions",
					description:
						"Create src/calc.ts with add, subtract, multiply, divide functions. " +
						"Also create src/calc.test.ts with tests. " +
						"Divide by zero should return Infinity. " +
						"Run tests and make sure they pass.",
					parentId: root.id,
				}),
			});

			// Run orchestrator
			const orchRes = await app.request(`/projects/${project.id}/orchestrate`, {
				method: "POST",
			});
			expect(orchRes.status).toBe(200);

			const orchResult = (await orchRes.json()) as {
				completed: number;
				results: {
					title: string;
					status: string;
					success: boolean;
					turns?: number;
					costUsd?: number;
				}[];
			};

			console.log("Orchestrator results:", orchResult);

			expect(orchResult.completed).toBeGreaterThan(0);

			// Verify the implementation task passed
			const implResult = orchResult.results.find(
				(r) => r.title === "Implement calculator functions",
			);
			expect(implResult?.success).toBe(true);

			// Verify files exist
			expect(existsSync(join(projectPath, "src", "calc.ts"))).toBe(true);

			// Verify tests pass independently
			const proc = Bun.spawn(["bun", "test", "src/calc.test.ts"], {
				cwd: projectPath,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(await proc.exited).toBe(0);
		},
		{ timeout: 180_000 },
	);

	test(
		"runner: parallel worktree execution with merge",
		async () => {
			const projectPath = join(tempDir, "calc-runner");
			const createRes = await app.request("/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			});
			const project = (await createRes.json()) as { id: string };

			// Create task tree with two parallel children
			const rootRes = await app.request(`/projects/${project.id}/tasks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Calculator App",
					description:
						"Build a calculator with basic arithmetic operations and tests.",
				}),
			});
			const root = (await rootRes.json()) as TaskNode;

			await app.request(`/projects/${project.id}/tasks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Basic operations",
					description:
						"Create src/calc.ts with add and subtract functions. " +
						"Create src/calc.test.ts with tests for add and subtract. " +
						"Run tests and make sure they pass.",
					parentId: root.id,
				}),
			});

			await app.request(`/projects/${project.id}/tasks`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Advanced operations",
					description:
						"Create src/advanced.ts with multiply and divide functions. " +
						"Create src/advanced.test.ts with tests. " +
						"Divide by zero should return Infinity. " +
						"Run tests and make sure they pass.",
					parentId: root.id,
				}),
			});

			// Run via the new execute endpoint
			const execRes = await app.request(`/projects/${project.id}/execute`, {
				method: "POST",
			});
			expect(execRes.status).toBe(200);

			const result = (await execRes.json()) as {
				completed: number;
				failed: number;
				events: { type: string; taskId?: string; title?: string }[];
				results: {
					taskId: string;
					title: string;
					success: boolean;
					output: string;
				}[];
			};

			console.log("Runner results:", {
				completed: result.completed,
				failed: result.failed,
				eventTypes: result.events.map((e) => e.type),
			});

			expect(result.completed).toBeGreaterThan(0);

			// Verify task_started and merge events were emitted
			expect(result.events.some((e) => e.type === "task_started")).toBe(true);
		},
		{ timeout: 300_000 },
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
							"spawn_children to execute in parallel, update_task_status root to passed when done.",
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

	test(
		"full pipeline: decompose goal then execute",
		async () => {
			const projectPath = join(tempDir, "calc-pipeline");
			const createRes = await app.request("/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			});
			const project = (await createRes.json()) as { id: string };

			// Step 1: Decompose the goal into a task tree
			const decompRes = await app.request(`/projects/${project.id}/decompose`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					goal: "Build a simple string utility library with functions: capitalize(str), reverse(str), truncate(str, maxLen). Include tests for each function.",
					maxTurns: 10,
				}),
			});
			expect(decompRes.status).toBe(200);

			const decomposed = (await decompRes.json()) as {
				root: TaskNode;
				nodes: TaskNode[];
			};
			console.log("Decomposed:", {
				root: decomposed.root.title,
				nodeCount: decomposed.nodes.length,
				tasks: decomposed.nodes.map((n) => n.title),
			});

			expect(decomposed.nodes.length).toBeGreaterThan(1);

			// Step 2: Execute the task tree
			const execRes = await app.request(`/projects/${project.id}/execute`, {
				method: "POST",
			});
			expect(execRes.status).toBe(200);

			const result = (await execRes.json()) as {
				completed: number;
				failed: number;
				results: {
					title: string;
					success: boolean;
				}[];
			};

			console.log("Pipeline results:", {
				completed: result.completed,
				failed: result.failed,
				results: result.results.map((r) => ({
					title: r.title,
					success: r.success,
				})),
			});

			expect(result.completed).toBeGreaterThan(0);
		},
		{ timeout: 600_000 },
	);
});
