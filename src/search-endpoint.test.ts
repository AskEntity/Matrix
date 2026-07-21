/**
 * Tests for the matrix plugin's REST search endpoint:
 * GET /projects/:id/search?q=...&limit=N
 *
 * Uses registerRoutes from the plugin's runtime.ts directly on an
 * isolated Hono app, same pattern as daemon-bootstrap.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { projectIndexDbPath } from "./data-paths.ts";
import {
	_clearDbCache,
	_setEmbeddingPipeline,
	indexTask,
	reconcileIndex,
} from "./task-index.ts";
import { TaskTracker } from "./task-tracker.ts";

describe("REST search endpoint", () => {
	let tempDir: string;
	let tracker: TaskTracker;
	let app: Hono;
	const projectId = "test-project";

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-search-rest-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
		_setEmbeddingPipeline(null);

		const { registerRoutes } = await import("../.mxd/plugin/runtime.ts");

		const ctx = {
			config: { dataDir: tempDir, dataRoot: undefined },
			pm: {
				get: (id: string) =>
					id === projectId
						? { id: projectId, name: "test", path: tempDir }
						: null,
			},
			globalConfig: {},
			globalContext: null,
			trackers: new Map([[projectId, tracker]]),
		};

		app = new Hono();
		// biome-ignore lint/suspicious/noExplicitAny: test harness sufficient shape
		registerRoutes(app, ctx as any);
	});

	afterEach(async () => {
		_clearDbCache();
		_setEmbeddingPipeline(null);
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns search hits with enriched titles", async () => {
		const child = tracker.addChild(
			tracker.rootNodeId,
			"Auth rewrite sprint",
			"migrate the loginflow to passkeys",
		);
		await tracker.save();
		const dbPath = projectIndexDbPath(tempDir, projectId);
		await reconcileIndex(dbPath, tracker);

		const res = await app.request(
			`/projects/${projectId}/search?q=loginflow&limit=5`,
		);
		expect(res.status).toBe(200);
		const hits = (await res.json()) as Array<{
			taskId: string;
			title: string;
			field: string;
			snippet: string;
		}>;
		expect(hits.length).toBeGreaterThanOrEqual(1);
		const match = hits.find((h) => h.taskId === child.id);
		expect(match).toBeDefined();
		expect(match?.title).toBe("Auth rewrite sprint");
		expect(match?.snippet).toContain("loginflow");
	});

	test("returns [] for empty query", async () => {
		const res = await app.request(`/projects/${projectId}/search?q=`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("returns [] for whitespace-only query", async () => {
		const res = await app.request(
			`/projects/${projectId}/search?q=${encodeURIComponent("   ")}`,
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("excludes deleted tasks (tracker has no node for them)", async () => {
		const child = tracker.addChild(
			tracker.rootNodeId,
			"Ephemeral task",
			"will be removed",
		);
		await tracker.save();
		const dbPath = projectIndexDbPath(tempDir, projectId);
		await indexTask(dbPath, child);

		// Remove the task from the tracker AFTER indexing.
		tracker.remove(child.id);
		await tracker.save();

		const res = await app.request(`/projects/${projectId}/search?q=Ephemeral`);
		expect(res.status).toBe(200);
		const hits = (await res.json()) as Array<{ taskId: string }>;
		// The hit should be filtered out since the task no longer exists.
		expect(hits.find((h) => h.taskId === child.id)).toBeUndefined();
	});

	test("respects limit parameter", async () => {
		// Create several tasks
		for (let i = 0; i < 5; i++) {
			const t = tracker.addChild(
				tracker.rootNodeId,
				`Recovery task ${i}`,
				"session recovery related",
			);
			await indexTask(projectIndexDbPath(tempDir, projectId), t);
		}
		await tracker.save();

		const res = await app.request(
			`/projects/${projectId}/search?q=recovery&limit=2`,
		);
		expect(res.status).toBe(200);
		const hits = (await res.json()) as Array<{ taskId: string }>;
		expect(hits.length).toBeLessThanOrEqual(2);
	});
});
