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
import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";

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

describe.skipIf(!hasApiKey)("E2E: AnthropicCompatibleProvider", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-e2e-direct-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-e2e-direct-data-"));
		const result = createApp({
			dataDir,
			agentProvider: new AnthropicCompatibleProvider(),
		});
		app = result.app;

	});

	afterAll(async () => {
		if (tempDir) await rm(tempDir, { recursive: true });
		if (dataDir) await rm(dataDir, { recursive: true });
	});

	test(
		"direct provider: agent creates calculator with tests",
		async () => {
			const projectPath = join(tempDir, "calc-direct-api");

			// Create project first, then send message via unified endpoint
			const projRes = await app.request("/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			});
			const proj = (await projRes.json()) as { id: string };
			const tasksRes = await app.request(`/projects/${proj.id}/tasks`);
			const { rootNodeId } = (await tasksRes.json()) as { rootNodeId: string };
			const startRes = await app.request(
				`/projects/${proj.id}/tasks/${rootNodeId}/message`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						content:
							"Create a simple calculator module in src/calc.ts with add, subtract, multiply, divide functions. " +
							"Also create src/calc.test.ts with tests for all four operations. " +
							"Make sure divide by zero returns Infinity. " +
							"Run the tests and make sure they pass.",
					}),
				},
			);

			expect(startRes.status).toBe(200);

			// Wait for agent to complete
			await waitForAgent(app, proj.id);

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
