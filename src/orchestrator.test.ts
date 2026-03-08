import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import { Orchestrator } from "./orchestrator.ts";
import { TaskTracker } from "./task-tracker.ts";
import type { AgentResult } from "./types.ts";

function createMockProvider(
	handler: (request: AgentRequest) => Promise<AgentResult>,
): AgentProvider {
	return {
		name: "mock",
		execute: handler,
		// biome-ignore lint/correctness/useYield: mock provider
		stream: async function* () {
			return { success: true, output: "" };
		},
	};
}

describe("Orchestrator", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-orch-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("step returns null when no pending tasks", async () => {
		const provider = createMockProvider(async () => ({
			success: true,
			output: "done",
		}));
		const orch = new Orchestrator(tracker, provider, tempDir);

		const result = await orch.step();
		expect(result).toBeNull();
	});

	test("step picks pending task, executes, and marks passed", async () => {
		const root = tracker.createRoot("Build app", "desc");
		const child = tracker.addChild(root.id, "Add login", "Login feature");

		const prompts: string[] = [];
		const provider = createMockProvider(async (req) => {
			prompts.push(req.prompt);
			return { success: true, output: "Login implemented" };
		});

		const orch = new Orchestrator(tracker, provider, tempDir);
		const result = await orch.step();

		expect(result).not.toBeNull();
		expect(result?.node.id).toBe(child.id);
		expect(result?.node.status).toBe("passed");
		expect(result?.agentResult.success).toBe(true);

		// Verify the prompt includes the task title
		expect(prompts[0]).toContain("Add login");
	});

	test("step marks task as failed on unsuccessful result", async () => {
		tracker.createRoot("App", "desc");

		const provider = createMockProvider(async () => ({
			success: false,
			output: "Tests failed",
		}));

		const orch = new Orchestrator(tracker, provider, tempDir);
		const result = await orch.step();

		expect(result?.node.status).toBe("failed");
		expect(result?.agentResult.success).toBe(false);
	});

	test("step marks task as stuck on exception", async () => {
		tracker.createRoot("App", "desc");

		const provider = createMockProvider(async () => {
			throw new Error("Connection lost");
		});

		const orch = new Orchestrator(tracker, provider, tempDir);
		const result = await orch.step();

		expect(result?.node.status).toBe("stuck");
		expect(result?.agentResult.output).toContain("Connection lost");
	});

	test("step prefers leaf tasks (children before parents)", async () => {
		const root = tracker.createRoot("App", "desc");
		const child = tracker.addChild(root.id, "Feature A", "desc");
		tracker.addChild(child.id, "Sub-task A1", "desc");

		const executed: string[] = [];
		const provider = createMockProvider(async (req) => {
			executed.push(req.prompt);
			return { success: true, output: "done" };
		});

		const orch = new Orchestrator(tracker, provider, tempDir);
		await orch.step();

		// Should execute the deepest leaf first
		expect(executed[0]).toContain("Sub-task A1");
	});

	test("run executes multiple tasks in sequence", async () => {
		const root = tracker.createRoot("App", "desc");
		tracker.addChild(root.id, "Task A", "first");
		tracker.addChild(root.id, "Task B", "second");

		let callCount = 0;
		const provider = createMockProvider(async () => {
			callCount++;
			return { success: true, output: `done ${callCount}` };
		});

		const orch = new Orchestrator(tracker, provider, tempDir);
		const results = await orch.run();

		// Should execute A, B, then root (3 pending tasks)
		expect(results.length).toBe(3);
		expect(results.every((r) => r.agentResult.success)).toBe(true);
	});

	test("run stops on failure", async () => {
		const root = tracker.createRoot("App", "desc");
		tracker.addChild(root.id, "Task A", "first");
		tracker.addChild(root.id, "Task B", "second");

		let callCount = 0;
		const provider = createMockProvider(async () => {
			callCount++;
			if (callCount === 2) return { success: false, output: "failed" };
			return { success: true, output: "done" };
		});

		const orch = new Orchestrator(tracker, provider, tempDir);
		const results = await orch.run();

		// Stops after second task fails
		expect(results.length).toBe(2);
		expect(results[1]?.agentResult.success).toBe(false);
	});

	test("prompt includes completed sibling context", async () => {
		const root = tracker.createRoot("App", "desc");
		const a = tracker.addChild(root.id, "Task A", "first");
		tracker.addChild(root.id, "Task B", "second");

		// Manually mark A as passed
		tracker.updateStatus(a.id, "passed");

		const prompts: string[] = [];
		const provider = createMockProvider(async (req) => {
			prompts.push(req.prompt);
			return { success: true, output: "done" };
		});

		const orch = new Orchestrator(tracker, provider, tempDir);
		await orch.step();

		// Task B's prompt should mention Task A as completed
		expect(prompts[0]).toContain("Task A");
		expect(prompts[0]).toContain("passed");
	});

	test("prompt includes project memory when .ai/memory.md exists", async () => {
		// Create .ai/memory.md in the project directory
		mkdirSync(join(tempDir, ".ai"), { recursive: true });
		writeFileSync(
			join(tempDir, ".ai", "memory.md"),
			"# Project Notes\nUse bun for all commands.\nDatabase is SQLite.",
		);

		tracker.createRoot("App", "desc");

		const prompts: string[] = [];
		const provider = createMockProvider(async (req) => {
			prompts.push(req.prompt);
			return { success: true, output: "done" };
		});

		const orch = new Orchestrator(tracker, provider, tempDir);
		await orch.step();

		expect(prompts[0]).toContain("Project Memory");
		expect(prompts[0]).toContain("Use bun for all commands");
		expect(prompts[0]).toContain("Database is SQLite");
	});

	test("prompt works without .ai/memory.md", async () => {
		tracker.createRoot("App", "desc");

		const prompts: string[] = [];
		const provider = createMockProvider(async (req) => {
			prompts.push(req.prompt);
			return { success: true, output: "done" };
		});

		const orch = new Orchestrator(tracker, provider, tempDir);
		await orch.step();

		// Should not contain memory section
		expect(prompts[0]).not.toContain("Project Memory");
		// But should still contain the task
		expect(prompts[0]).toContain("App");
	});

	test("prompt includes methodology instructions", async () => {
		tracker.createRoot("App", "desc");

		const prompts: string[] = [];
		const provider = createMockProvider(async (req) => {
			prompts.push(req.systemPrompt ?? "");
			return { success: true, output: "done" };
		});

		const orch = new Orchestrator(tracker, provider, tempDir);
		await orch.step();

		expect(prompts[0]).toContain("autonomous programming system");
		expect(prompts[0]).toContain("Prohibitions");
	});
});
