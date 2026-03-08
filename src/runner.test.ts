import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider, AgentRequest } from "./agent-provider.ts";
import { Runner } from "./runner.ts";
import { TaskTracker } from "./task-tracker.ts";
import type { AgentResult } from "./types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

/** Clean git env for test isolation. */
const cleanGitEnv: Record<string, string | undefined> = {
	...process.env,
	GIT_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
	GIT_OBJECT_DIRECTORY: undefined,
	GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
};

async function exec(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: cleanGitEnv,
	});
	await proc.exited;
	return new Response(proc.stdout).text();
}

async function initRepo(dir: string): Promise<void> {
	await exec(["git", "init"], dir);
	await exec(["git", "config", "user.email", "test@test.com"], dir);
	await exec(["git", "config", "user.name", "Test"], dir);
	await writeFile(join(dir, "README.md"), "# Test\n");
	await exec(["git", "add", "-A"], dir);
	await exec(["git", "commit", "-m", "init"], dir);
}

function createMockProvider(
	handler?: (request: AgentRequest) => Promise<AgentResult>,
): AgentProvider {
	const execute = handler ?? (async () => ({ success: true, output: "done" }));
	return {
		name: "mock",
		execute,
		// biome-ignore lint/correctness/useYield: mock provider
		stream: async function* () {
			return { success: true, output: "" };
		},
	};
}

describe("Runner", () => {
	let repoDir: string;
	let wtRoot: string;
	let tracker: TaskTracker;
	let worktrees: WorktreeManager;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), "og-runner-"));
		wtRoot = join(repoDir, ".worktrees");
		await initRepo(repoDir);
		tracker = new TaskTracker(join(repoDir, ".task-tree.json"));
		await tracker.load();
		worktrees = new WorktreeManager(repoDir, wtRoot);
	});

	afterEach(async () => {
		await worktrees.cleanup();
		await rm(repoDir, { recursive: true });
	});

	test("executeTask creates worktree and runs agent", async () => {
		const root = tracker.createRoot("Build app", "desc");
		const provider = createMockProvider(async () => ({
			success: true,
			output: "done",
			sessionId: "session-123",
		}));

		const runner = new Runner(tracker, provider, worktrees, repoDir);
		const result = await runner.executeTask(root);

		expect(result.success).toBe(true);
		expect(tracker.get(root.id)?.status).toBe("passed");
		expect(tracker.get(root.id)?.branch).toContain("og/");
		expect(tracker.get(root.id)?.worktreePath).not.toBeNull();
		expect(tracker.get(root.id)?.sessionId).toBe("session-123");

		// Check events
		const events = runner.getEvents();
		expect(events).toHaveLength(2);
		expect(events[0]?.type).toBe("task_started");
		expect(events[1]?.type).toBe("task_completed");
	});

	test("executeTask marks as stuck on exception", async () => {
		const root = tracker.createRoot("Crash", "desc");
		const provider = createMockProvider(async () => {
			throw new Error("boom");
		});

		const runner = new Runner(tracker, provider, worktrees, repoDir);
		const result = await runner.executeTask(root);

		expect(result.success).toBe(false);
		expect(tracker.get(root.id)?.status).toBe("stuck");
	});

	test("executeChildren runs siblings in parallel", async () => {
		const root = tracker.createRoot("App", "desc");
		tracker.addChild(root.id, "Task A", "first");
		tracker.addChild(root.id, "Task B", "second");

		// Create worktree for root first so children can branch from it
		const rootSlug = "app";
		const rootWt = await worktrees.create(root.id, rootSlug);
		tracker.assignWorktree(root.id, rootWt.branch, rootWt.path);

		const executionOrder: string[] = [];
		const provider = createMockProvider(async (req) => {
			const title = req.prompt.match(/# Task: (.+)/)?.[1] ?? "";
			executionOrder.push(title);
			return { success: true, output: `done: ${title}` };
		});

		const runner = new Runner(tracker, provider, worktrees, repoDir);
		const results = await runner.executeChildren(root.id);

		expect(results).toHaveLength(2);
		expect(results.every((r) => r.success)).toBe(true);
		// Both tasks were executed (order may vary due to parallel execution)
		expect(executionOrder.sort()).toEqual(["Task A", "Task B"]);
	});

	test("run executes leaf tasks then parent", async () => {
		const root = tracker.createRoot("App", "desc");
		tracker.addChild(root.id, "Feature A", "first");

		const executed: string[] = [];
		const provider = createMockProvider(async (req) => {
			const title = req.prompt.match(/# Task: (.+)/)?.[1] ?? "";
			executed.push(title);
			return { success: true, output: "done" };
		});

		const runner = new Runner(tracker, provider, worktrees, repoDir);
		const result = await runner.run();

		expect(result.completed).toBe(2);
		expect(result.failed).toBe(0);
		// Feature A should execute before App (leaf first)
		expect(executed[0]).toBe("Feature A");
	});

	test("run returns empty for no tasks", async () => {
		const provider = createMockProvider();
		const runner = new Runner(tracker, provider, worktrees, repoDir);
		const result = await runner.run();

		expect(result.completed).toBe(0);
		expect(result.results).toHaveLength(0);
	});

	test("run handles failure in child task", async () => {
		const root = tracker.createRoot("App", "desc");
		tracker.addChild(root.id, "Bad Task", "fails");

		const provider = createMockProvider(async (req) => {
			if (req.prompt.includes("Bad Task")) {
				return { success: false, output: "failed" };
			}
			return { success: true, output: "done" };
		});

		const runner = new Runner(tracker, provider, worktrees, repoDir);
		const result = await runner.run();

		expect(result.failed).toBeGreaterThan(0);
	});

	test("executeTask includes memory in prompt", async () => {
		await exec(["mkdir", "-p", join(repoDir, ".ai")], repoDir);
		writeFileSync(join(repoDir, ".ai", "memory.md"), "Use bun.");

		const root = tracker.createRoot("App", "desc");
		const prompts: string[] = [];
		const provider = createMockProvider(async (req) => {
			prompts.push(req.prompt);
			return { success: true, output: "done" };
		});

		const runner = new Runner(tracker, provider, worktrees, repoDir);
		await runner.executeTask(root);

		expect(prompts[0]).toContain("Use bun");
	});

	test("run resumes parent after children complete", async () => {
		const root = tracker.createRoot("App", "desc");
		tracker.addChild(root.id, "Child A", "first");
		tracker.addChild(root.id, "Child B", "second");

		const prompts: string[] = [];
		const provider = createMockProvider(async (req) => {
			prompts.push(req.prompt);
			return { success: true, output: "done" };
		});

		const runner = new Runner(tracker, provider, worktrees, repoDir);
		const result = await runner.run();

		// 2 children + 1 parent merge = 3 results
		expect(result.completed).toBe(3);

		// The last prompt should be a merge prompt for the parent
		const mergePrompt = prompts[prompts.length - 1];
		expect(mergePrompt).toContain("Merge: App");
		expect(mergePrompt).toContain("Child A");
		expect(mergePrompt).toContain("Child B");

		// Parent should have events: merge_started, merge_completed
		const events = runner.getEvents();
		const mergeEvents = events.filter((e) => e.type === "merge_started");
		expect(mergeEvents.length).toBeGreaterThan(0);
	});

	test("run marks parent as failed when child fails", async () => {
		const root = tracker.createRoot("App", "desc");
		tracker.addChild(root.id, "Good", "passes");
		tracker.addChild(root.id, "Bad", "fails");

		const provider = createMockProvider(async (req) => {
			if (req.prompt.includes("Bad")) {
				return { success: false, output: "error" };
			}
			return { success: true, output: "ok" };
		});

		const runner = new Runner(tracker, provider, worktrees, repoDir);
		const result = await runner.run();

		// Parent should be marked as failed
		const parentResult = result.results.find((r) => r.title === "App");
		expect(parentResult?.success).toBe(false);
		expect(tracker.get(root.id)?.status).toBe("failed");
	});
});
