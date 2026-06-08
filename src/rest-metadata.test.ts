/**
 * Node metadata write-path over REST, on BOTH create and update:
 *   POST  /projects/:id/tasks            → createTaskOp → addChild({ metadata })
 *   PATCH /projects/:id/tasks/:nodeId     → updateTaskOp → tracker.setMetadata
 *
 * dchat's group-chat UI both ADDS characters (a node carrying personality
 * metadata) and EDITS an existing character's prompt/personality, which lives
 * in the character node's `metadata`. The tracker has had the metadata
 * primitives (addChild opts.metadata + setMetadata) since the node-model task,
 * but NO REST/MCP path reached them — characters could neither be born with
 * metadata nor have it edited. This is the missing write-path.
 *
 * Canonical journey (the dchat UI): create/PATCH a node's metadata → GET /tasks
 * reflects it. Replace semantics on PATCH: a key absent from the new object
 * disappears (matches tracker.setMetadata — REPLACE, never deep-merge).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import type { TaskNode } from "./types.ts";
import { ulid } from "./ulid.ts";

type NodeWithMetadata = TaskNode & { metadata?: Record<string, unknown> };

describe("REST metadata write-path (PATCH → setMetadata)", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let getTracker: ReturnType<typeof createApp>["getTracker"];
	let projectId: string;
	let rootNodeId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-restmeta-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-restmeta-data-"));
		const project = {
			id: ulid(),
			name: "rest-metadata",
			path: join(tempDir, "rest-metadata"),
		};
		const result = createApp({ dataDir, projects: [project] });
		app = result.app;
		getTracker = result.getTracker;
		projectId = project.id;
		const tracker = await getTracker(projectId);
		rootNodeId = tracker.rootNodeId;
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	function postTask(body: Record<string, unknown>) {
		return app.request(`/projects/${projectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function patchTask(nodeId: string, body: Record<string, unknown>) {
		return app.request(`/projects/${projectId}/tasks/${nodeId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function getNode(
		nodeId: string,
	): Promise<NodeWithMetadata | undefined> {
		const res = await app.request(`/projects/${projectId}/tasks`);
		const body = (await res.json()) as { nodes: NodeWithMetadata[] };
		return body.nodes.find((n) => n.id === nodeId);
	}

	test("POST with metadata creates a node carrying it (round-trips through GET /tasks)", async () => {
		const res = await postTask({
			title: "Bard",
			description: "",
			parentId: rootNodeId,
			metadata: { prompt: "You are a bard", mood: "merry" },
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as NodeWithMetadata;
		expect(created.metadata).toEqual({
			prompt: "You are a bard",
			mood: "merry",
		});

		// The dchat roster UI re-reads the tree — the new character carries it.
		const fetched = await getNode(created.id);
		expect(fetched?.metadata).toEqual({
			prompt: "You are a bard",
			mood: "merry",
		});
	});

	test("POST without metadata creates a node with no metadata field", async () => {
		const res = await postTask({
			title: "Plain",
			description: "",
			parentId: rootNodeId,
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as NodeWithMetadata;
		expect(created.metadata).toBeUndefined();
	});

	test("PATCH metadata round-trips through the response and GET /tasks", async () => {
		const tracker = await getTracker(projectId);
		const task = tracker.addChild(rootNodeId, "Character", "", {
			editedBy: "user",
		});
		await tracker.save();

		const res = await patchTask(task.id, {
			metadata: { prompt: "You are a wizard", mood: "wise" },
		});
		expect(res.status).toBe(200);
		const patched = (await res.json()) as NodeWithMetadata;
		expect(patched.metadata).toEqual({
			prompt: "You are a wizard",
			mood: "wise",
		});

		// The dchat UI re-reads the tree — it must see the new metadata.
		const fetched = await getNode(task.id);
		expect(fetched?.metadata).toEqual({
			prompt: "You are a wizard",
			mood: "wise",
		});
	});

	test("PATCH metadata REPLACES — a removed key disappears (no deep-merge)", async () => {
		const tracker = await getTracker(projectId);
		const task = tracker.addChild(rootNodeId, "Character", "", {
			editedBy: "user",
		});
		await tracker.save();

		await patchTask(task.id, {
			metadata: { prompt: "v1", legacy: "remove me" },
		});
		expect((await getNode(task.id))?.metadata).toEqual({
			prompt: "v1",
			legacy: "remove me",
		});

		// Send a new object WITHOUT `legacy` → it must be gone (replace semantics).
		await patchTask(task.id, { metadata: { prompt: "v2" } });
		const fetched = await getNode(task.id);
		expect(fetched?.metadata).toEqual({ prompt: "v2" });
		expect(fetched?.metadata?.legacy).toBeUndefined();
	});

	test("PATCH without metadata leaves existing metadata untouched", async () => {
		const tracker = await getTracker(projectId);
		const task = tracker.addChild(rootNodeId, "Character", "", {
			editedBy: "user",
		});
		await tracker.save();
		await patchTask(task.id, { metadata: { prompt: "keep" } });

		// A title-only PATCH must NOT wipe metadata (absent field = no change).
		const res = await patchTask(task.id, { title: "Renamed" });
		expect(res.status).toBe(200);
		const fetched = await getNode(task.id);
		expect(fetched?.title).toBe("Renamed");
		expect(fetched?.metadata).toEqual({ prompt: "keep" });
	});
});
