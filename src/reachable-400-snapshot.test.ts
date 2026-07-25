/**
 * ══════════════════════════════════════════════════════════════════════════
 * BEHAVIOR SNAPSHOT — this pins a REAL BUG, not an invariant.
 * (Same convention as "BEHAVIOR SNAPSHOT: orphan tool_result" in
 *  jsonl-stress.test.ts: freeze the wrong behavior so the fix is a deliberate,
 *  visible inversion rather than a silent drift.)
 *
 * WHEN THE BUG IS FIXED: invert the final assertion to
 *   expect(endsWithAssistant).toBe(false)
 * and delete this banner.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Task 01KYCQ85. Reproduces a reachable real-API 400 that the mock cannot see,
 * because the mock never checked "the conversation must end with a user
 * message" — it checked a FICTIONAL role-alternation rule instead.
 *
 * Path (provider-shared.ts):
 *   fresh agent, first turn ends with end_turn (text only, no tool_use)
 *     → messages = [user, assistant], length 2
 *     → handleImplicitYield parks
 *   user requests /compact
 *     → compactOnly → `continue` (no tool_result to pair — correct)
 *     → top of loop: manualCompactRequested && messages.length <= 4
 *       → "Context is too short to compact" status, flag cleared,
 *         no pendingCompact*ToolCall to consume → `continue`
 *     → next iteration: compaction skipped (flag cleared)
 *       → API call issued with messages ENDING IN ASSISTANT
 *
 * Real API (measured 2026-07-25 against production Anthropic, probe case P):
 *   400 "This model does not support assistant message prefill.
 *        The conversation must end with a user message."
 *
 * With MXD_MOCK_EXP=B the mock enforces the real rule and the agent visibly
 * crashes here ("Request rejected by provider (format or context length)").
 * With the mock as shipped, the bad request sails through — which is exactly
 * why this bug survived: the test double was stricter than the API in one
 * place and blind in another, and only the blind spot mattered.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createCompactMessage } from "./queue-message-factory.ts";
import { deliverMessage } from "./runtime/agent-lifecycle.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import { initTestProject } from "./test-utils/init-test-project.ts";
import {
	createMockedProviderWithMock,
	ValidatingMockAPI,
} from "./test-utils/mock-anthropic-api.ts";
import { ulid } from "./ulid.ts";

describe("BEHAVIOR SNAPSHOT: reachable API 400 — request ends with assistant (not an invariant)", () => {
	test("fresh agent ends turn with text, then /compact → the next request ends in assistant", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "mxd-probe400-data-"));
		const projectDir = await mkdtemp(join(tmpdir(), "mxd-probe400-proj-"));
		Bun.spawnSync(["git", "init"], { cwd: projectDir });
		Bun.spawnSync(["git", "config", "user.email", "t@t.com"], {
			cwd: projectDir,
		});
		Bun.spawnSync(["git", "config", "user.name", "T"], { cwd: projectDir });
		await Bun.write(
			join(projectDir, ".gitignore"),
			"*\n!/.gitignore\n!/README.md\n!/.mxd/\n!/.mxd/**\n",
		);
		await Bun.write(join(projectDir, "README.md"), "# probe\n");
		Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
		Bun.spawnSync(["git", "commit", "-m", "init"], { cwd: projectDir });
		await initTestProject(projectDir);

		const mockAPI = new ValidatingMockAPI();
		const provider = createMockedProviderWithMock(mockAPI);
		const projectId = ulid();
		const app = createApp({
			dataDir,
			agentProvider: provider,
			projects: [
				{ id: projectId, name: basename(projectDir), path: projectDir },
			],
		});
		const tasksDir = join(projectDir, ".mxd", "tasks");
		if (existsSync(tasksDir)) rmSync(tasksDir, { recursive: true });
		const hookExample = join(
			projectDir,
			".mxd",
			"hooks",
			"setup_worktree.sh.example",
		);
		const hookActive = join(projectDir, ".mxd", "hooks", "setup_worktree.sh");
		if (existsSync(hookExample)) await rename(hookExample, hookActive);
		Bun.spawnSync(["git", "add", "."], { cwd: projectDir });
		Bun.spawnSync(["git", "commit", "-m", "hook"], { cwd: projectDir });
		app.markReady();

		try {
			const tracker = await app.getTracker(projectId);
			const rootNodeId = tracker.rootNodeId;

			// ONE turn, text only → end_turn → implicit yield. messages = [user, assistant].
			const instruction = JSON.stringify({
				turns: [
					{ blocks: [{ type: "text", text: "Hello, I am done talking." }] },
				],
			});
			await app.app.request(
				`/projects/${projectId}/tasks/${rootNodeId}/message`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: instruction }),
				},
			);

			// wait for idle
			const t0 = Date.now();
			while (Date.now() - t0 < 10000) {
				if (tracker.getTask(rootNodeId)?.session?.queue?.idle) break;
				await new Promise((r) => setTimeout(r, 50));
			}

			const before = mockAPI.getRequestHistory().length;

			await deliverMessage(
				app.ctx,
				{ id: projectId, path: projectDir },
				rootNodeId,
				createCompactMessage(),
			);

			// Give the loop time to take the too-short branch and issue the next call.
			await new Promise((r) => setTimeout(r, 3000));

			const after = mockAPI.getRequestHistory().slice(before);

			// /compact on a 2-message session issues exactly one further request…
			expect(after.length).toBe(1);
			// …and its last message is the assistant's end_turn text.
			expect(after[0]?.messages.map((m) => m.role)).toEqual([
				"user",
				"assistant",
			]);

			// CURRENT (BUGGY) BEHAVIOR — the real API answers this with
			// 400 "This model does not support assistant message prefill".
			// Flip to `false` when the too-short-compact branch stops issuing it.
			const endsWithAssistant =
				after[0]?.messages[after[0].messages.length - 1]?.role === "assistant";
			expect(endsWithAssistant).toBe(true);
		} finally {
			await app.shutdown();
			await new Promise((r) => setTimeout(r, 50));
			await rm(dataDir, { recursive: true, force: true });
			await rm(projectDir, { recursive: true, force: true });
		}
	}, 30000);
});
