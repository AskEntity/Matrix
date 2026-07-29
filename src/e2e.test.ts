/**
 * E2E tests: real agent execution through the daemon API.
 *
 * Run with EITHER credential — whichever you have:
 *   ANTHROPIC_API_KEY=sk-… bun test src/e2e.test.ts
 *   CLAUDE_CODE_OAUTH_TOKEN=… bun test src/e2e.test.ts
 *
 * The model is a literal below, not an env read — no variable chooses it.
 *
 * Skipped by default. This entry point is the ONLY place here that reads the
 * environment: it opens the gate and hands the credential and model to the
 * constructor explicitly. The provider itself reads no environment variable, so
 * exporting one it used to consume cannot change which model or key is used.
 *
 * ⚠️ The gate keyed on ANTHROPIC_API_KEY while the instructions above said to
 * export CLAUDE_CODE_OAUTH_TOKEN — written four hours apart on 2026-03-08 — so
 * anyone following them got the whole suite skipped, silently, for 4.7 months.
 * Gate and credential resolution must name the same variables or this recurs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicCompatibleProvider } from "./anthropic-compatible-provider.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";

/**
 * The suite's credential, read once here. Either form works — the provider
 * accepts both slots and picks OAuth when only the token is present, so the gate
 * has to admit both or it refuses a setup the provider would have served.
 */
const E2E_API_KEY = process.env.ANTHROPIC_API_KEY;
const E2E_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const hasCredential = Boolean(E2E_API_KEY || E2E_OAUTH_TOKEN);
/** Explicit: nothing infers this from the environment or from a constant. */
const E2E_MODEL = "claude-sonnet-4-6";

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

describe.skipIf(!hasCredential)("E2E: AnthropicCompatibleProvider", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-e2e-direct-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-e2e-direct-data-"));
		const result = createApp({
			dataDir,
			// Both are passed explicitly; the gate above is what guarantees one of
			// them is present. Each slot is omitted when empty rather than passed as
			// undefined, because the provider picks OAuth on `oauthToken && !apiKey`.
			agentProvider: new AnthropicCompatibleProvider(E2E_MODEL, {
				...(E2E_API_KEY ? { apiKey: E2E_API_KEY } : {}),
				...(E2E_OAUTH_TOKEN ? { oauthToken: E2E_OAUTH_TOKEN } : {}),
			}),
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
