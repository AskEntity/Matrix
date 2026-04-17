/**
 * TDD: dataRoot determines where each plugin's data lives.
 *
 * Matrix (dataRoot: "@") → projects/<id>/tree.json, projects/<id>/tasks/
 * story1001 (default @/plugin/story1001) → projects/<id>/plugin/story1001/tree.json, projects/<id>/plugin/story1001/tasks/
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveDataRoot, resolveDataRoot } from "./plugin.ts";

describe("dataRoot path resolution", () => {
	const matrixManifest = {
		name: "matrix",
		scope: "global" as const,
		dataRoot: "@",
	};
	const storyManifest = { name: "story1001", scope: "project" as const }; // default dataRoot

	test("matrix dataRoot '@' resolves to project root", () => {
		expect(effectiveDataRoot(matrixManifest)).toBe("@");
		const resolved = resolveDataRoot(matrixManifest, "/data", "proj1");
		expect(resolved).toBe("/data/projects/proj1");
	});

	test("story1001 default dataRoot resolves to plugin subdirectory", () => {
		expect(effectiveDataRoot(storyManifest)).toBe("@/plugin/story1001");
		const resolved = resolveDataRoot(storyManifest, "/data", "proj1");
		expect(resolved).toBe("/data/projects/proj1/plugin/story1001");
	});

	test("tree.json path uses resolved dataRoot", () => {
		const matrixRoot = resolveDataRoot(matrixManifest, "/data", "proj1");
		expect(join(matrixRoot, "tree.json")).toBe(
			"/data/projects/proj1/tree.json",
		);

		const storyRoot = resolveDataRoot(storyManifest, "/data", "proj1");
		expect(join(storyRoot, "tree.json")).toBe(
			"/data/projects/proj1/plugin/story1001/tree.json",
		);
	});

	test("tasks dir uses resolved dataRoot", () => {
		const matrixRoot = resolveDataRoot(matrixManifest, "/data", "proj1");
		expect(join(matrixRoot, "tasks")).toBe("/data/projects/proj1/tasks");

		const storyRoot = resolveDataRoot(storyManifest, "/data", "proj1");
		expect(join(storyRoot, "tasks")).toBe(
			"/data/projects/proj1/plugin/story1001/tasks",
		);
	});
});

describe("dataRoot integration: two plugins write to separate directories", () => {
	let dataDir: string;
	let tempDir: string;
	const projectId = "test-proj";

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "dataroot-test-"));
		dataDir = join(tempDir, "data");
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("matrix and story1001 write tree.json and JSONL to different paths", async () => {
		const { resolveDataRoot: resolve } = await import("./plugin.ts");
		const { TaskTracker } = await import("./task-tracker.ts");
		const { EventStore } = await import("./event-store.ts");

		// Resolve data roots
		const matrixRoot = resolve(
			{ name: "matrix", scope: "global", dataRoot: "@" },
			dataDir,
			projectId,
		);
		const storyRoot = resolve(
			{ name: "story1001", scope: "project" },
			dataDir,
			projectId,
		);

		// Create directories
		await mkdir(join(matrixRoot, "tasks"), { recursive: true });
		await mkdir(join(storyRoot, "tasks"), { recursive: true });

		// Matrix: create tracker + write JSONL
		const matrixTracker = new TaskTracker(join(matrixRoot, "tree.json"));
		await matrixTracker.load();
		matrixTracker.addChild(matrixTracker.rootNodeId, "Matrix Task", "test", {
			editedBy: "user",
		});
		await matrixTracker.save();

		const matrixStore = new EventStore(join(matrixRoot, "tasks"));
		await matrixStore.append(matrixTracker.rootNodeId, {
			type: "agent_start",
			taskId: matrixTracker.rootNodeId,
			ts: Date.now(),
			resume: false,
			model: "test",
			provider: "test",
		} as import("./events.ts").Event);

		// Story: create tracker + write JSONL
		const storyTracker = new TaskTracker(join(storyRoot, "tree.json"));
		await storyTracker.load();
		storyTracker.addChild(storyTracker.rootNodeId, "Story Chapter 1", "test", {
			editedBy: "user",
		});
		await storyTracker.save();

		const storyStore = new EventStore(join(storyRoot, "tasks"));
		await storyStore.append(storyTracker.rootNodeId, {
			type: "agent_start",
			taskId: storyTracker.rootNodeId,
			ts: Date.now(),
			resume: false,
			model: "test",
			provider: "test",
		} as import("./events.ts").Event);

		// Assert: files exist at correct paths
		// Matrix
		expect(existsSync(join(dataDir, "projects", projectId, "tree.json"))).toBe(
			true,
		);
		expect(existsSync(join(dataDir, "projects", projectId, "tasks"))).toBe(
			true,
		);

		// Story — in plugin subdirectory
		expect(
			existsSync(
				join(
					dataDir,
					"projects",
					projectId,
					"plugin",
					"story1001",
					"tree.json",
				),
			),
		).toBe(true);
		expect(
			existsSync(
				join(dataDir, "projects", projectId, "plugin", "story1001", "tasks"),
			),
		).toBe(true);

		// Assert: they are DIFFERENT files (not colliding)
		const matrixTree = JSON.parse(
			await Bun.file(join(matrixRoot, "tree.json")).text(),
		);
		const storyTree = JSON.parse(
			await Bun.file(join(storyRoot, "tree.json")).text(),
		);
		expect(matrixTree.rootNodeId).not.toBe(storyTree.rootNodeId);

		// Matrix tasks dir has JSONL
		const matrixFiles = matrixStore.listSessions();
		expect(matrixFiles.length).toBeGreaterThan(0);

		// Story tasks dir has JSONL
		const storyFiles = storyStore.listSessions();
		expect(storyFiles.length).toBeGreaterThan(0);
	});
});

describe("runtime helpers use dataRoot (not hardcoded)", () => {
	test("projectTasksDir accepts dataRoot parameter", () => {
		const { projectTasksDir } =
			require("./runtime/helpers.ts") as typeof import("./runtime/helpers.ts");

		// Default (no dataRoot) → projects/<id>/tasks/
		const defaultPath = projectTasksDir("/data", "proj1");
		expect(defaultPath).toBe(join("/data", "projects", "proj1", "tasks"));

		// With dataRoot → should use the resolved path
		const storyPath = projectTasksDir("/data", "proj1", "@/plugin/story1001");
		expect(storyPath).toBe(
			join("/data", "projects", "proj1", "plugin", "story1001", "tasks"),
		);
	});
});
