/**
 * `updateTaskOp` must be honest about what it changed. Two ends of one defect:
 *
 *  1. It used to apply fields IN FUNCTION-BODY ORDER and throw partway, so a
 *     rejected `status` silently ate the `title` in the same call while an
 *     earlier `parentId` had ALREADY landed. The caller was told only about
 *     status, so "the whole call was refused, I'll retry" would replay a
 *     reparent that had already happened.
 *  2. A call carrying no updatable field at all returned the task and reported
 *     success, so a plausible wrong param name (`old_string` instead of
 *     `old_description` — `edit_file` next door uses exactly that) was a silent
 *     no-op and the caller moved on.
 *
 * ⚠️ EVERY test here asserts on the OTHER field — the one nobody complained
 * about. The pre-existing guards asserted "the rejected status did not change",
 * which is green under both the broken and the fixed implementation and is the
 * fixture-cannot-express-the-difference shape this repo keeps paying for.
 *
 * The disk assertions are not belt-and-braces. No tracker mutator saves; only
 * `updateTaskOp`'s trailing `tracker.save()` does. So a field that landed
 * before a throw sits in MEMORY ONLY, diverging from tree.json until some
 * UNRELATED later operation's save() commits it — measured, and reproduced by
 * "an unrelated update commits the abandoned reparent" below.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "./agent-provider.ts";
import { createOrchestratorTools } from "./orchestrator-tools.ts";
import { resetResourceRegistry } from "./resource-registry.ts";
import { updateTaskOp } from "./task-operations.ts";
import { TaskTracker } from "./task-tracker.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import { initMockResourceRegistry } from "./test-utils.ts";
import { ulid } from "./ulid.ts";

const mockProvider: AgentProvider = {
	name: "mock",
	execute: async () => ({
		exitReason: "interrupted" as const,
		output: "",
		costUsd: 0,
		turns: 0,
		sessionId: "mock-session",
	}),
	// biome-ignore lint/correctness/useYield: mock provider
	stream: async function* () {
		return {
			exitReason: "interrupted" as const,
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId: "mock-session",
		};
	},
};

let tempDir: string;
let tracker: TaskTracker;
let treePath: string;

function callbacks() {
	return {
		broadcastTree: () => {},
		projectPath: tempDir,
		dataPaths: null,
	};
}

/** Re-read tree.json from disk — the tracker's in-memory map is NOT consulted. */
async function fromDisk(id: string) {
	const disk = new TaskTracker(treePath);
	await disk.load("main");
	const node = disk.get(id);
	return {
		title: node && "title" in node ? node.title : undefined,
		parentId: node?.parentId,
		status: node && "status" in node ? node.status : undefined,
	};
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "mxd-update-atomic-"));
	treePath = join(tempDir, "tree.json");
	tracker = new TaskTracker(treePath);
	await tracker.load("main");
});

afterEach(async () => {
	resetResourceRegistry();
	await rm(tempDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// All fields land, or none do
// ═══════════════════════════════════════════════════════════════════════════

describe("updateTaskOp applies every field or none", () => {
	// ⚠️ READ THIS BEFORE TRUSTING THIS TEST. It pins the STATUS QUO, not this
	// fix. `title` is applied after the status check in the old body too, so it
	// was already unchanged — this test is GREEN AGAINST THE BROKEN CODE, and it
	// is green against any future implementation that drops title on the floor
	// for a different reason. It earns its place only as documentation of the
	// reported symptom.
	//
	// MEASURED, so nobody has to guess how much this test is worth: against the
	// real pre-fix implementation it was GREEN, and against a mutation that
	// moves the status check to the END of the function it goes red. So it
	// catches "the check drifted downward" and is blind to the bug that was
	// actually reported. The tests that catch BOTH are the ones about a field
	// applied BEFORE the throw: `parentId` here, `branch` at the REST door.
	//
	// The task description asked for exactly this assertion. It is not enough,
	// and the reason is the fixture-cannot-express-the-difference shape: a
	// fixture where both implementations produce the same state cannot testify
	// about which one is running. For the reported {title, status:"closed"}
	// combination the ONLY user-visible change is the error message — pinned
	// separately by "the refusal says what happened to the OTHER fields".
	test("a rejected status leaves the title in the SAME call untouched", async () => {
		const node = tracker.addChild(tracker.rootNodeId, "ORIGINAL", "d");
		tracker.updateStatus(node.id, "verify");
		await tracker.save();

		await expect(
			updateTaskOp(
				tracker,
				node.id,
				{ title: "NEW", status: "closed" },
				"agent",
				callbacks(),
			),
		).rejects.toThrow();

		expect(tracker.getTask(node.id)?.title).toBe("ORIGINAL");
		expect((await fromDisk(node.id)).title).toBe("ORIGINAL");
	});

	test("a rejected status leaves a parentId in the SAME call unapplied", async () => {
		const oldParent = tracker.addChild(tracker.rootNodeId, "old parent", "d");
		const newParent = tracker.addChild(tracker.rootNodeId, "new parent", "d");
		const node = tracker.addChild(oldParent.id, "victim", "d");
		await tracker.save();

		await expect(
			updateTaskOp(
				tracker,
				node.id,
				{ parentId: newParent.id, status: "closed" },
				"agent",
				callbacks(),
			),
		).rejects.toThrow();

		// parentId is the ONLY field that used to be applied before the throw.
		expect(tracker.get(node.id)?.parentId).toBe(oldParent.id);
		expect((await fromDisk(node.id)).parentId).toBe(oldParent.id);
		// Reparent rewrites BOTH parents' children arrays — check them too, or a
		// half-moved node passes the parentId assertion while the tree is torn.
		expect(tracker.get(oldParent.id)?.children).toContain(node.id);
		expect(tracker.get(newParent.id)?.children).not.toContain(node.id);
	});

	test("an unrelated later update must not commit an abandoned reparent", async () => {
		const oldParent = tracker.addChild(tracker.rootNodeId, "old parent", "d");
		const newParent = tracker.addChild(tracker.rootNodeId, "new parent", "d");
		const node = tracker.addChild(oldParent.id, "victim", "d");
		await tracker.save();

		await expect(
			updateTaskOp(
				tracker,
				node.id,
				{ parentId: newParent.id, status: "failed" },
				"agent",
				callbacks(),
			),
		).rejects.toThrow();

		// Someone else, elsewhere in the tree, does something completely unrelated.
		// Its save() is what used to publish the abandoned reparent to disk.
		await updateTaskOp(
			tracker,
			tracker.rootNodeId,
			{ title: "unrelated rename" },
			"agent",
			callbacks(),
		);

		expect((await fromDisk(node.id)).parentId).toBe(oldParent.id);
	});

	test("an illegal parentId leaves the title in the SAME call untouched", async () => {
		const parent = tracker.addChild(tracker.rootNodeId, "parent", "d");
		const child = tracker.addChild(parent.id, "child", "d");
		await tracker.save();

		// Reparenting `parent` under its own descendant is a cycle.
		await expect(
			updateTaskOp(
				tracker,
				parent.id,
				{ title: "NEW", parentId: child.id },
				"agent",
				callbacks(),
			),
		).rejects.toThrow(/cycle|descendant/i);

		expect(tracker.getTask(parent.id)?.title).toBe("parent");
		expect(tracker.get(parent.id)?.parentId).toBe(tracker.rootNodeId);
	});

	test("memory and tree.json never disagree after a refused update", async () => {
		const oldParent = tracker.addChild(tracker.rootNodeId, "old parent", "d");
		const newParent = tracker.addChild(tracker.rootNodeId, "new parent", "d");
		const node = tracker.addChild(oldParent.id, "victim", "d");
		tracker.updateStatus(node.id, "verify");
		await tracker.save();

		await expect(
			updateTaskOp(
				tracker,
				node.id,
				{ parentId: newParent.id, title: "NEW", status: "closed" },
				"agent",
				callbacks(),
			),
		).rejects.toThrow();

		const disk = await fromDisk(node.id);
		expect({
			title: tracker.getTask(node.id)?.title,
			parentId: tracker.get(node.id)?.parentId,
			status: tracker.getTask(node.id)?.status,
		}).toEqual(disk);
	});

	// ⚠️ For `{title, status:"closed"}` — the combination actually observed —
	// the TITLE IS UNCHANGED EITHER WAY, because it sat after the throw in the
	// old body too. So no state assertion can tell the two implementations
	// apart, and the entire user-visible fix for the reported case is that the
	// error stops pretending status was the only thing that did not happen.
	test("the refusal says what happened to the OTHER fields in the call", async () => {
		const node = tracker.addChild(tracker.rootNodeId, "ORIGINAL", "d");
		const other = tracker.addChild(tracker.rootNodeId, "other parent", "d");
		await tracker.save();

		const err = await updateTaskOp(
			tracker,
			node.id,
			{ title: "NEW", parentId: other.id, status: "closed" },
			"agent",
			callbacks(),
		).catch((e: Error) => e);

		const message = (err as Error).message;
		// Named because they were SUPPLIED — not a fixed sentence.
		expect(message).toContain("title");
		expect(message).toContain("parentId");
		// Not named, because they were not supplied.
		expect(message).not.toContain("color");
		expect(message).not.toContain("metadata");
	});

	test("a single-field refusal does not invent other fields", async () => {
		const node = tracker.addChild(tracker.rootNodeId, "t", "d");
		const err = await updateTaskOp(
			tracker,
			node.id,
			{ status: "closed" },
			"agent",
			callbacks(),
		).catch((e: Error) => e);
		expect((err as Error).message).not.toMatch(/unchanged too/);
	});

	// POSITIVE CONTROL — over-strict is how a guard like this actually fails,
	// and over-strict reddens nothing on its own.
	test("a legal multi-field update still applies every one of them", async () => {
		const oldParent = tracker.addChild(tracker.rootNodeId, "old parent", "d");
		const newParent = tracker.addChild(tracker.rootNodeId, "new parent", "d");
		const node = tracker.addChild(oldParent.id, "victim", "d");
		await tracker.save();

		const result = await updateTaskOp(
			tracker,
			node.id,
			{
				parentId: newParent.id,
				title: "NEW",
				description: "new description",
				status: "in_progress",
				color: "red",
			},
			"agent",
			callbacks(),
		);

		expect(result.title).toBe("NEW");
		expect(result.description).toBe("new description");
		expect(result.status).toBe("in_progress");
		expect(result.parentId).toBe(newParent.id);
		expect(result.color).toBeTruthy();
		expect((await fromDisk(node.id)).title).toBe("NEW");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// A call that cannot change anything is an error, not a success
// ═══════════════════════════════════════════════════════════════════════════

describe("updateTaskOp refuses a call with nothing to change", () => {
	test("no updatable field at all is refused", async () => {
		const node = tracker.addChild(tracker.rootNodeId, "t", "d");
		await expect(
			updateTaskOp(tracker, node.id, {}, "agent", callbacks()),
		).rejects.toThrow();
	});

	test("a single real field is still accepted", async () => {
		const node = tracker.addChild(tracker.rootNodeId, "t", "d");
		const r = await updateTaskOp(
			tracker,
			node.id,
			{ title: "renamed" },
			"agent",
			callbacks(),
		);
		expect(r.title).toBe("renamed");
	});

	test("a falsy-but-present value still counts as a field to change", async () => {
		const node = tracker.addChild(tracker.rootNodeId, "t", "d");
		tracker.updateColor(node.id, "#ff0000");
		// color:null CLEARS the color — `undefined` is the only "not asked for".
		const r = await updateTaskOp(
			tracker,
			node.id,
			{ color: null },
			"agent",
			callbacks(),
		);
		expect(r.color).toBeFalsy();

		const r2 = await updateTaskOp(
			tracker,
			node.id,
			{ title: "" },
			"agent",
			callbacks(),
		);
		expect(r2.title).toBe("");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// The MCP door — where the wrong-param-name slip actually happens
// ═══════════════════════════════════════════════════════════════════════════

describe("update_task tool refuses a call that changes nothing", () => {
	async function invoke(taskId: string, args: Record<string, unknown>) {
		resetResourceRegistry();
		const { auth } = initMockResourceRegistry({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
			taskId: tracker.rootNodeId,
		});
		const { toolDefs } = createOrchestratorTools(
			auth,
			"test-project",
			tracker.rootNodeId,
		);
		const tool = toolDefs.find((t) => t.name === "update_task");
		if (!tool) throw new Error("update_task tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper signature
		return (tool as any).handler({ taskId, ...args });
	}

	test("the observed slip — edit_file's param names — is refused, not silently dropped", async () => {
		const node = tracker.addChild(tracker.rootNodeId, "t", "ORIGINAL DESC");
		// Zod strips unknown keys before the handler runs, so by the time anyone
		// can look, `old_string` is already gone — which is exactly why this
		// used to report success.
		const r = await invoke(node.id, {
			old_string: "ORIGINAL",
			new_string: "REPLACED",
		});

		expect(r.isError).toBe(true);
		expect(tracker.getTask(node.id)?.description).toBe("ORIGINAL DESC");
	});

	test("the refusal names the parameters that DO work", async () => {
		const node = tracker.addChild(tracker.rootNodeId, "t", "d");
		const r = await invoke(node.id, {});
		const text = r.content[0].text as string;

		// Never offer a remedy that will not work: the message has to name the
		// parameters this DOOR accepts. `branch`/`metadata` exist on the shared
		// op and are not reachable from here, and `old_description` is reachable
		// and is the one the observed slip was reaching for.
		expect(text).toContain("old_description");
		expect(text).toContain("new_description");
		expect(text).toContain("title");
		expect(text).toContain("description");
		expect(text).toContain("status");
		expect(text).toContain("parentId");
		expect(text).toContain("color");
		expect(text).toContain("draft");
		expect(text).not.toContain("metadata");
		expect(text).not.toContain("branch");
	});

	test("a real update through the tool still works", async () => {
		const node = tracker.addChild(tracker.rootNodeId, "t", "d");
		const r = await invoke(node.id, { title: "renamed" });
		expect(r.isError).toBeFalsy();
		expect(tracker.getTask(node.id)?.title).toBe("renamed");
	});

	// ⚠️ `branch` and `metadata` exist on the shared UpdateTaskOpts and must NOT
	// be reachable from here. A branch is worktree lifecycle — created by
	// beforeChildLaunch, deleted by close_task — so an agent editing another
	// task's branch desynchronizes the tree from the worktrees on disk, and
	// NOTHING goes red until some later close deletes a branch that is wrong or
	// still in use.
	//
	// This is pinned because it is currently true by COINCIDENCE OF TWO
	// SEPARATE FACTS — the tool does not declare the param, and the handler does
	// not forward it — neither of which is stated anywhere near UpdateTaskOpts.
	// Widening the internal opts is exactly the change that would break it, and
	// it would break silently.
	test("the tool does not expose op fields an agent must not set", async () => {
		const { toolDefs } = (() => {
			resetResourceRegistry();
			const { auth } = initMockResourceRegistry({
				tracker,
				projectId: "test-project",
				projectPath: tempDir,
				taskId: tracker.rootNodeId,
			});
			return createOrchestratorTools(auth, "test-project", tracker.rootNodeId);
		})();
		const tool = toolDefs.find((t) => t.name === "update_task");
		const schema = tool?.jsonSchema as { properties: Record<string, unknown> };
		const props = Object.keys(schema.properties);

		expect(props).not.toContain("branch");
		expect(props).not.toContain("metadata");
		// Positive control: an absent key means absent, not "cannot see keys".
		expect(props).toContain("title");
		expect(props).toContain("parentId");
	});

	test("branch is refused even if it reaches the handler past the schema", async () => {
		const node = tracker.addChild(tracker.rootNodeId, "t", "d");
		// Zod strips it in production; this asks what happens if it ever does not.
		// It is refused because the settable list is DERIVED from the declared
		// params, so an undeclared field can never count as something to change.
		const r = await invoke(node.id, { branch: "mxd/evil" });
		expect(r.isError).toBe(true);
		expect(tracker.getTask(node.id)?.branch).toBeNull();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// The REST door — same op, so it inherits the guarantee. `branch` is the one
// field only this door has, and it used to be applied BEFORE the op ran.
// ═══════════════════════════════════════════════════════════════════════════

describe("REST PATCH inherits the same all-or-nothing update", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-update-atomic-rest-"));
	});
	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	async function harness() {
		const project = { id: ulid(), name: "atomic", path: join(tempDir, "p") };
		const result = createApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [project],
		});
		result.markReady();
		const t = await result.getTracker(project.id);
		return { project, app: result.app, t };
	}

	function patch(
		app: { fetch: (r: Request) => Response | Promise<Response> },
		projectId: string,
		nodeId: string,
		body: unknown,
	) {
		return app.fetch(
			new Request(`http://localhost/projects/${projectId}/tasks/${nodeId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	}

	test("a rejected status leaves `branch` from the same request unapplied", async () => {
		const { project, app, t } = await harness();
		const node = t.addChild(t.rootNodeId, "task", "desc");
		t.updateStatus(node.id, "in_progress");
		t.updateStatus(node.id, "verify");
		await t.save();

		const res = await patch(app, project.id, node.id, {
			branch: "mxd/should-not-land",
			status: "closed",
		});

		expect(res.status).toBe(400);
		expect(t.getTask(node.id)?.branch).toBeNull();
	});

	test("a PATCH that asks for nothing is refused, not answered with 200", async () => {
		const { project, app, t } = await harness();
		const node = t.addChild(t.rootNodeId, "task", "desc");
		await t.save();

		const res = await patch(app, project.id, node.id, {});
		expect(res.status).toBe(400);
	});

	test("a PATCH carrying only unknown keys is refused too", async () => {
		const { project, app, t } = await harness();
		const node = t.addChild(t.rootNodeId, "task", "desc");
		await t.save();

		// REST destructures a known shape, so unknown keys vanish exactly the
		// way Zod drops them on the MCP side.
		const res = await patch(app, project.id, node.id, {
			old_string: "a",
			new_string: "b",
		});
		expect(res.status).toBe(400);
		expect(t.getTask(node.id)?.description).toBe("desc");
	});

	test("a normal PATCH still works, branch included", async () => {
		const { project, app, t } = await harness();
		const node = t.addChild(t.rootNodeId, "task", "desc");
		await t.save();

		const res = await patch(app, project.id, node.id, {
			title: "renamed",
			branch: "mxd/real",
			status: "in_progress",
		});
		expect(res.status).toBe(200);
		expect(t.getTask(node.id)?.title).toBe("renamed");
		expect(t.getTask(node.id)?.branch).toBe("mxd/real");
		expect(t.getTask(node.id)?.status).toBe("in_progress");
	});
});
