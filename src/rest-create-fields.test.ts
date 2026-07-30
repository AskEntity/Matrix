/**
 * `POST /projects/:id/tasks` must honour every field the shared create op
 * accepts — and the sharp one is `draft`.
 *
 * The route's body type listed `{title, description, parentId, budgetUsd,
 * folder, metadata}`. `CreateTaskOpts` also has `draft` and `color`, and
 * `PATCH` forwards both. So a client asking for a draft got **201 plus a
 * `pending` task**, which is to say: something that can be dispatched. draft
 * vs pending is the "can this execute" bit, and the answer came back inverted
 * with a success code on it. MCP's `create_task` has always had the parameter;
 * this is one rule missing one of its N doors.
 *
 * ⚠️ The value of this file is the COMPILER PIN below, not the cases. A field
 * added to `CreateTaskOpts` later and not wired into the route is exactly the
 * bug this file documents, and it reddens nothing — the route keeps compiling,
 * because dropping a field of a body type you never declared is not a type
 * error anywhere. `COVERED_CREATE_FIELDS` makes it a type error HERE.
 *
 * Known limit, stated so nobody reads more into it: the pin ties the list to
 * the interface, not the list to the test bodies. It cannot know a field is
 * merely NAMED here. It does guarantee that whoever adds a field lands in this
 * file, next to this sentence.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateTaskOpts } from "./task-operations.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import type { GeneralNode, TaskNode } from "./types.ts";
import { ulid } from "./ulid.ts";

/**
 * Every field of `CreateTaskOpts`, with where its case lives. `title`,
 * `description` and `parentId` ride along in every case below; `metadata`'s
 * round-trip is `rest-metadata.test.ts`, which owns that field and is not
 * duplicated here.
 */
const COVERED_CREATE_FIELDS = [
	"title",
	"description",
	"parentId",
	"draft",
	"color",
	"budgetUsd",
	"metadata",
] as const satisfies readonly (keyof CreateTaskOpts)[];

type _CoveredFieldsAreExhaustive =
	Exclude<
		keyof CreateTaskOpts,
		(typeof COVERED_CREATE_FIELDS)[number]
	> extends never
		? true
		: [
				"A field of CreateTaskOpts is not covered here. The REST create route is the door that drops it silently — wire it in src/runtime/routes/tasks.ts and add a case below.",
			];
const _coveredFieldsExhaustive: _CoveredFieldsAreExhaustive = true;
void _coveredFieldsExhaustive;

describe("POST /tasks honours every field of CreateTaskOpts", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createApp>["app"];
	let getTracker: ReturnType<typeof createApp>["getTracker"];
	let shutdown: ReturnType<typeof createApp>["shutdown"];
	let projectId: string;
	let rootNodeId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-createfields-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-createfields-data-"));
		const project = {
			id: ulid(),
			name: "create-fields",
			path: join(tempDir, "create-fields"),
		};
		const result = createApp({ dataDir, projects: [project] });
		app = result.app;
		getTracker = result.getTracker;
		shutdown = result.shutdown;
		// `POST .../message` answers 503 until the runtime reports ready, which
		// would make the draft assertion below pass for the wrong reason.
		result.markReady();
		projectId = project.id;
		const tracker = await getTracker(projectId);
		rootNodeId = tracker.rootNodeId;
	});

	afterEach(async () => {
		await shutdown();
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

	// ── draft ──

	test("POST with draft:true creates a task that CANNOT be sent a message", async () => {
		const res = await postTask({
			title: "Idea, not yet",
			description: "captured while the user was still talking",
			parentId: rootNodeId,
			draft: true,
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as TaskNode;
		expect(created.status).toBe("draft");

		// The user-visible consequence, which is what the 201 was lying about:
		// a draft is refused delivery, so it cannot be dispatched. Asserting the
		// status alone would pass against a route that stored the string and
		// meant nothing by it.
		const msg = await app.request(
			`/projects/${projectId}/tasks/${created.id}/message`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: "go" }),
			},
		);
		expect(msg.status).toBe(400);
		expect(((await msg.json()) as { error: string }).error).toContain("draft");
	});

	test("POST without draft creates a startable pending task", async () => {
		// The control. Without it, the draft case above could pass against a
		// route that made EVERY task a draft.
		const res = await postTask({
			title: "Do it now",
			description: "",
			parentId: rootNodeId,
		});
		expect(res.status).toBe(201);
		expect(((await res.json()) as TaskNode).status).toBe("pending");
	});

	test("POST with draft:false is a startable pending task, not a draft", async () => {
		const res = await postTask({
			title: "Explicitly not a draft",
			description: "",
			parentId: rootNodeId,
			draft: false,
		});
		expect(res.status).toBe(201);
		expect(((await res.json()) as TaskNode).status).toBe("pending");
	});

	// ── color ──

	test("POST with a NAMED color stores the resolved hex", async () => {
		// `red` → `#f85149` is `resolveColor`'s doing, inside the op. Asserting
		// the hex proves the value went THROUGH the op rather than being echoed
		// into the node by the route.
		const res = await postTask({
			title: "Bug",
			description: "",
			parentId: rootNodeId,
			color: "red",
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as TaskNode;
		expect(created.color).toBe("#f85149");

		const tracker = await getTracker(projectId);
		expect(tracker.getTask(created.id)?.color).toBe("#f85149");
	});

	// ── budgetUsd ──

	test("POST with budgetUsd stores it", async () => {
		const res = await postTask({
			title: "Bounded",
			description: "",
			parentId: rootNodeId,
			budgetUsd: 2.5,
		});
		expect(res.status).toBe(201);
		expect(((await res.json()) as TaskNode).budgetUsd).toBe(2.5);
	});

	// ── the folder branch of the same route ──

	test("POST with folder:true forwards metadata, which addGeneralNode accepts", async () => {
		// Same handler, other branch, same class of bug: `metadata` is declared
		// in the route's own body type and `addGeneralNode` takes it, and the
		// folder branch passed neither.
		const res = await postTask({
			title: "Grouping",
			folder: true,
			parentId: rootNodeId,
			metadata: { icon: "box" },
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as GeneralNode;
		expect(created.type).toBe("folder");
		expect(created.metadata).toEqual({ icon: "box" });

		const tree = await app.request(`/projects/${projectId}/tasks`);
		const nodes = ((await tree.json()) as { nodes: GeneralNode[] }).nodes;
		expect(nodes.find((n) => n.id === created.id)?.metadata).toEqual({
			icon: "box",
		});
	});
});
