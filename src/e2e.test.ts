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
});
