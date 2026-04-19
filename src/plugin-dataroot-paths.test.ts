/**
 * TDD: dataRoot determines where each plugin's data lives.
 *
 * Matrix (dataRoot: "@/plugin/matrix") →
 *   projects/<id>/plugin/matrix/tree.json, projects/<id>/plugin/matrix/tasks/
 * story1001 (default @/plugin/story1001) →
 *   projects/<id>/plugin/story1001/tree.json, projects/<id>/plugin/story1001/tasks/
 *
 * Matrix's historical top-level layout (dataRoot: "@") was migrated into the
 * plugin namespace in P4 (2026-04-19). Pre-existing data is moved once at
 * daemon startup — see `src/migrations/plugin-namespace-migration.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	projectTasksDir,
	resolveDataRoot as resolveLowLevel,
} from "./data-paths.ts";
import { effectiveDataRoot } from "./plugin.ts";

// Convenience wrapper for manifest-oriented tests.
type ManifestLike = {
	name: string;
	scope?: "global";
	dataRoot?: string;
};
function resolveFromManifest(
	manifest: ManifestLike,
	dataDir: string,
	projectId: string,
): string {
	return resolveLowLevel(
		dataDir,
		projectId,
		effectiveDataRoot({ scope: "global", ...manifest }),
	);
}

describe("dataRoot path resolution", () => {
	const matrixManifest = {
		name: "matrix",
		scope: "global" as const,
		dataRoot: "@/plugin/matrix",
	};
	const storyManifest = { name: "story1001", scope: "global" as const }; // default dataRoot

	test("matrix dataRoot '@/plugin/matrix' resolves to its plugin subdir", () => {
		expect(effectiveDataRoot(matrixManifest)).toBe("@/plugin/matrix");
		const resolved = resolveFromManifest(matrixManifest, "/data", "proj1");
		expect(resolved).toBe("/data/projects/proj1/plugin/matrix");
	});

	test("story1001 default dataRoot resolves to plugin subdirectory", () => {
		expect(effectiveDataRoot(storyManifest)).toBe("@/plugin/story1001");
		const resolved = resolveFromManifest(storyManifest, "/data", "proj1");
		expect(resolved).toBe("/data/projects/proj1/plugin/story1001");
	});

	test("tree.json path uses resolved dataRoot", () => {
		const matrixRoot = resolveFromManifest(matrixManifest, "/data", "proj1");
		expect(join(matrixRoot, "tree.json")).toBe(
			"/data/projects/proj1/plugin/matrix/tree.json",
		);

		const storyRoot = resolveFromManifest(storyManifest, "/data", "proj1");
		expect(join(storyRoot, "tree.json")).toBe(
			"/data/projects/proj1/plugin/story1001/tree.json",
		);
	});

	test("tasks dir uses resolved dataRoot", () => {
		const matrixRoot = resolveFromManifest(matrixManifest, "/data", "proj1");
		expect(join(matrixRoot, "tasks")).toBe(
			"/data/projects/proj1/plugin/matrix/tasks",
		);

		const storyRoot = resolveFromManifest(storyManifest, "/data", "proj1");
		expect(join(storyRoot, "tasks")).toBe(
			"/data/projects/proj1/plugin/story1001/tasks",
		);
	});

	test("matrix and story1001 resolve to distinct, non-colliding paths", () => {
		// Regression guard for P4: after moving matrix under plugin/matrix/,
		// make sure it still doesn't collide with another plugin.
		const matrixPath = resolveFromManifest(matrixManifest, "/data", "proj1");
		const storyPath = resolveFromManifest(storyManifest, "/data", "proj1");
		expect(matrixPath).not.toBe(storyPath);
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
		const { TaskTracker } = await import("./task-tracker.ts");
		const { EventStore } = await import("./event-store.ts");

		// Resolve data roots
		const matrixRoot = resolveFromManifest(
			{ name: "matrix", scope: "global", dataRoot: "@/plugin/matrix" },
			dataDir,
			projectId,
		);
		const storyRoot = resolveFromManifest(
			{ name: "story1001", scope: "global" },
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
		// Matrix — in its own plugin subdirectory (P4 layout)
		expect(
			existsSync(
				join(dataDir, "projects", projectId, "plugin", "matrix", "tree.json"),
			),
		).toBe(true);
		expect(
			existsSync(
				join(dataDir, "projects", projectId, "plugin", "matrix", "tasks"),
			),
		).toBe(true);

		// Old top-level layout must NOT be used by Matrix anymore.
		expect(existsSync(join(dataDir, "projects", projectId, "tree.json"))).toBe(
			false,
		);
		expect(existsSync(join(dataDir, "projects", projectId, "tasks"))).toBe(
			false,
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
