/**
 * E2E test: creates a project, sends a task to the real Claude Code agent,
 * verifies the agent produces working code.
 *
 * Run with: CLAUDE_CODE_OAUTH_TOKEN=... bun test src/e2e.test.ts
 * Skipped by default in CI (requires auth token).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider } from "./claude-code-provider.ts";
import { createApp } from "./daemon.ts";

const hasToken = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);

describe.skipIf(!hasToken)("E2E: agent execution", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let pm: ReturnType<typeof createApp>["pm"];

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-e2e-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-e2e-data-"));
		const result = createApp({
			dataDir,
			agentProvider: new ClaudeCodeProvider(),
		});
		app = result.app;
		pm = result.pm;
		await pm.load();
	});

	afterAll(async () => {
		if (tempDir) await rm(tempDir, { recursive: true });
		if (dataDir) await rm(dataDir, { recursive: true });
	});

	test(
		"agent creates a calculator module with tests",
		async () => {
			// 1. Create project
			const projectPath = join(tempDir, "calc-app");
			const createRes = await app.request("/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			});
			expect(createRes.status).toBe(201);
			const project = (await createRes.json()) as { id: string };

			// 2. Run agent task
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
			const runBody = await runRes.json();
			console.log("Run response status:", runRes.status);
			console.log("Run response body:", JSON.stringify(runBody, null, 2));
			expect(runRes.status).toBe(200);
			const result = runBody as {
				success: boolean;
				output: string;
			};

			console.log("Agent result:", {
				success: result.success,
				outputLength: result.output.length,
			});

			// 3. Verify output
			expect(result.success).toBe(true);

			// 4. Verify files were created
			expect(existsSync(join(projectPath, "src", "calc.ts"))).toBe(true);
			expect(existsSync(join(projectPath, "src", "calc.test.ts"))).toBe(true);

			// 5. Actually run the tests ourselves to verify
			const proc = Bun.spawn(["bun", "test", "src/calc.test.ts"], {
				cwd: projectPath,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(proc.stdout).text();
			const exitCode = await proc.exited;

			console.log("Test output:", stdout);
			expect(exitCode).toBe(0);
		},
		{ timeout: 120_000 },
	);
});
