/**
 * Tests for the one-shot P3 tree-type normalization migration.
 *
 * Pre-P3: `TaskNode.type` was optional (`type?: "task"`). Existing tree.json
 * files have TaskNode entries with NO `type` field. Folder entries already
 * have `type: "folder"`.
 *
 * Post-P3: `TaskNode.type` is required. The migration injects `type: "task"`
 * on any node missing it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateTreeNodeTypes } from "./tree-type-migration.ts";

const MATRIX_PLUGIN_PATH = "plugin/matrix";

async function writeTreeJson(
	dataDir: string,
	projectId: string,
	data: unknown,
): Promise<string> {
	const dir = join(dataDir, "projects", projectId, MATRIX_PLUGIN_PATH);
	await mkdir(dir, { recursive: true });
	const path = join(dir, "tree.json");
	await writeFile(path, JSON.stringify(data, null, "\t"), "utf-8");
	return path;
}

async function readTree(path: string): Promise<{
	rootNodeId: string;
	nodes: Array<Record<string, unknown>>;
}> {
	return JSON.parse(await readFile(path, "utf-8"));
}

describe("migrateTreeNodeTypes", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-tree-type-migration-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	test("no projects directory → returns zero-summary", async () => {
		const summary = await migrateTreeNodeTypes(dataDir);
		expect(summary.projectsScanned).toBe(0);
		expect(summary.projectsModified).toBe(0);
		expect(summary.nodesFixed).toBe(0);
	});

	test("empty projects directory → returns zero-summary", async () => {
		await mkdir(join(dataDir, "projects"), { recursive: true });
		const summary = await migrateTreeNodeTypes(dataDir);
		expect(summary.projectsScanned).toBe(0);
	});

	test("injects type='task' on pre-P3 TaskNode entries", async () => {
		const path = await writeTreeJson(dataDir, "proj1", {
			rootNodeId: "root-1",
			nodes: [
				{
					id: "root-1",
					title: "Orchestrator",
					description: "",
					status: "in_progress",
					parentId: null,
					children: ["task-a"],
					branch: "main",
					worktreePath: null,
					cwd: null,
					costUsd: 0,
					editedBy: "agent",
					createdAt: "2026-04-01T00:00:00Z",
					updatedAt: "2026-04-01T00:00:00Z",
					// NO type field — pre-P3 TaskNode shape
				},
				{
					id: "task-a",
					title: "Task A",
					description: "",
					status: "pending",
					parentId: "root-1",
					children: [],
					branch: null,
					worktreePath: null,
					cwd: null,
					costUsd: 0,
					editedBy: "agent",
					createdAt: "2026-04-01T00:00:00Z",
					updatedAt: "2026-04-01T00:00:00Z",
					// NO type field
				},
			],
		});

		const summary = await migrateTreeNodeTypes(dataDir);
		expect(summary.projectsScanned).toBe(1);
		expect(summary.projectsModified).toBe(1);
		expect(summary.nodesFixed).toBe(2);

		const after = await readTree(path);
		for (const node of after.nodes) {
			expect(node.type).toBe("task");
		}
	});

	test("leaves folder entries untouched (type already 'folder')", async () => {
		const path = await writeTreeJson(dataDir, "proj1", {
			rootNodeId: "root-1",
			nodes: [
				{
					id: "root-1",
					title: "Orchestrator",
					description: "",
					status: "in_progress",
					parentId: null,
					children: ["folder-x"],
					branch: "main",
					worktreePath: null,
					cwd: null,
					costUsd: 0,
					editedBy: "agent",
					createdAt: "2026-04-01T00:00:00Z",
					updatedAt: "2026-04-01T00:00:00Z",
					// NO type → will be injected
				},
				{
					id: "folder-x",
					title: "Completed Work",
					parentId: "root-1",
					children: [],
					type: "folder", // already has type
				},
			],
		});

		const summary = await migrateTreeNodeTypes(dataDir);
		expect(summary.nodesFixed).toBe(1); // only root

		const after = await readTree(path);
		const root = after.nodes.find((n) => n.id === "root-1");
		const folder = after.nodes.find((n) => n.id === "folder-x");
		expect(root?.type).toBe("task");
		expect(folder?.type).toBe("folder");
	});

	test("idempotent: second run is a no-op", async () => {
		await writeTreeJson(dataDir, "proj1", {
			rootNodeId: "root-1",
			nodes: [
				{
					id: "root-1",
					title: "Orchestrator",
					parentId: null,
					children: [],
					status: "in_progress",
					description: "",
					branch: "main",
					worktreePath: null,
					cwd: null,
					costUsd: 0,
					editedBy: "agent",
					createdAt: "2026-04-01T00:00:00Z",
					updatedAt: "2026-04-01T00:00:00Z",
				},
			],
		});

		const first = await migrateTreeNodeTypes(dataDir);
		expect(first.nodesFixed).toBe(1);

		const second = await migrateTreeNodeTypes(dataDir);
		expect(second.projectsScanned).toBe(1);
		expect(second.projectsModified).toBe(0);
		expect(second.nodesFixed).toBe(0);
	});

	test("handles multiple projects", async () => {
		await writeTreeJson(dataDir, "proj1", {
			rootNodeId: "r1",
			nodes: [{ id: "r1", title: "P1", parentId: null, children: [] }],
		});
		await writeTreeJson(dataDir, "proj2", {
			rootNodeId: "r2",
			nodes: [{ id: "r2", title: "P2", parentId: null, children: [] }],
		});

		const summary = await migrateTreeNodeTypes(dataDir);
		expect(summary.projectsScanned).toBe(2);
		expect(summary.projectsModified).toBe(2);
		expect(summary.nodesFixed).toBe(2);
	});

	test("skips projects without tree.json (no plugin/matrix dir)", async () => {
		// Project dir exists but no tree.json at plugin/matrix
		await mkdir(join(dataDir, "projects", "barren"), { recursive: true });
		// And another with a tree.json at plugin/matrix — should be touched
		await writeTreeJson(dataDir, "proj1", {
			rootNodeId: "r1",
			nodes: [{ id: "r1", title: "P1", parentId: null, children: [] }],
		});

		const summary = await migrateTreeNodeTypes(dataDir);
		expect(summary.projectsScanned).toBe(1);
		expect(summary.projectsModified).toBe(1);
	});

	test("unparseable tree.json is skipped without throwing", async () => {
		const dir = join(dataDir, "projects", "bad", MATRIX_PLUGIN_PATH);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "tree.json"), "{ not json", "utf-8");

		const summary = await migrateTreeNodeTypes(dataDir);
		// Counted as scanned (the file exists), but not modified
		expect(summary.projectsScanned).toBe(1);
		expect(summary.projectsModified).toBe(0);
		expect(summary.nodesFixed).toBe(0);
	});

	test("skips dotfile entries in projects/ (e.g. locks)", async () => {
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(join(dataDir, "projects", ".lock"), "", "utf-8");

		const summary = await migrateTreeNodeTypes(dataDir);
		expect(summary.projectsScanned).toBe(0);
	});

	test("mixed nodes: old TaskNodes, new TaskNodes, folders", async () => {
		const path = await writeTreeJson(dataDir, "proj1", {
			rootNodeId: "root-1",
			nodes: [
				{
					id: "root-1",
					title: "Old root",
					description: "",
					status: "in_progress",
					parentId: null,
					children: ["new-task", "folder-a"],
					branch: "main",
					worktreePath: null,
					cwd: null,
					costUsd: 0,
					editedBy: "agent",
					createdAt: "2026-04-01T00:00:00Z",
					updatedAt: "2026-04-01T00:00:00Z",
					// no type
				},
				{
					id: "new-task",
					title: "New task (already migrated)",
					description: "",
					status: "pending",
					parentId: "root-1",
					children: [],
					branch: null,
					worktreePath: null,
					cwd: null,
					costUsd: 0,
					editedBy: "agent",
					createdAt: "2026-04-01T00:00:00Z",
					updatedAt: "2026-04-01T00:00:00Z",
					type: "task", // already has type
				},
				{
					id: "folder-a",
					title: "Folder",
					parentId: "root-1",
					children: [],
					type: "folder",
				},
			],
		});

		const summary = await migrateTreeNodeTypes(dataDir);
		expect(summary.nodesFixed).toBe(1); // only root

		const after = await readTree(path);
		expect(after.nodes.find((n) => n.id === "root-1")?.type).toBe("task");
		expect(after.nodes.find((n) => n.id === "new-task")?.type).toBe("task");
		expect(after.nodes.find((n) => n.id === "folder-a")?.type).toBe("folder");
	});
});
