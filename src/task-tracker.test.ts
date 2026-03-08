import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskTracker } from "./task-tracker.ts";

describe("TaskTracker", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-tracker-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
	});

	test("createRoot creates a root task", () => {
		const root = tracker.createRoot("Chat App", "Build a multi-user chat");
		expect(root.title).toBe("Chat App");
		expect(root.status).toBe("pending");
		expect(root.parentId).toBeNull();
		expect(tracker.getRoot()).toBeDefined();
		expect(tracker.getRoot()?.id).toBe(root.id);
	});

	test("createRoot fails if root already exists", () => {
		tracker.createRoot("App", "desc");
		expect(() => tracker.createRoot("App2", "desc2")).toThrow(
			"Root task already exists",
		);
	});

	test("addChild creates child under parent", () => {
		const root = tracker.createRoot("App", "desc");
		const child = tracker.addChild(root.id, "Auth", "User authentication");

		expect(child.parentId).toBe(root.id);
		expect(child.status).toBe("pending");

		const children = tracker.getChildren(root.id);
		expect(children).toHaveLength(1);
		expect(children[0]?.id).toBe(child.id);
	});

	test("addChild fails for unknown parent", () => {
		expect(() => tracker.addChild("nonexistent", "Task", "desc")).toThrow(
			"Parent node not found",
		);
	});

	test("updateStatus changes node status", () => {
		const root = tracker.createRoot("App", "desc");
		tracker.updateStatus(root.id, "in_progress");
		expect(tracker.get(root.id)?.status).toBe("in_progress");
	});

	test("assignBranch sets branch name", () => {
		const root = tracker.createRoot("App", "desc");
		const child = tracker.addChild(root.id, "Auth", "desc");
		tracker.assignBranch(child.id, "feat/auth");
		expect(tracker.get(child.id)?.branch).toBe("feat/auth");
	});

	test("byStatus filters nodes", () => {
		const root = tracker.createRoot("App", "desc");
		const c1 = tracker.addChild(root.id, "A", "a");
		const c2 = tracker.addChild(root.id, "B", "b");
		tracker.updateStatus(c1.id, "passed");
		tracker.updateStatus(c2.id, "in_progress");

		expect(tracker.byStatus("passed")).toHaveLength(1);
		expect(tracker.byStatus("in_progress")).toHaveLength(1);
		expect(tracker.byStatus("pending")).toHaveLength(1); // root
	});

	test("remove deletes node and descendants", () => {
		const root = tracker.createRoot("App", "desc");
		const c1 = tracker.addChild(root.id, "A", "a");
		const c1a = tracker.addChild(c1.id, "A1", "a1");

		tracker.remove(c1.id);

		expect(tracker.get(c1.id)).toBeUndefined();
		expect(tracker.get(c1a.id)).toBeUndefined();
		expect(tracker.getChildren(root.id)).toHaveLength(0);
		expect(tracker.allNodes()).toHaveLength(1); // only root
	});

	test("remove root clears everything", () => {
		const root = tracker.createRoot("App", "desc");
		tracker.addChild(root.id, "A", "a");

		tracker.remove(root.id);

		expect(tracker.getRoot()).toBeUndefined();
		expect(tracker.allNodes()).toHaveLength(0);
	});

	test("persists and reloads", async () => {
		const root = tracker.createRoot("App", "desc");
		tracker.addChild(root.id, "Auth", "auth desc");
		tracker.updateStatus(root.id, "in_progress");
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();

		expect(tracker2.getRoot()?.title).toBe("App");
		expect(tracker2.getRoot()?.status).toBe("in_progress");
		expect(tracker2.getChildren(root.id)).toHaveLength(1);
	});

	test("allNodes returns flat list", () => {
		const root = tracker.createRoot("App", "desc");
		tracker.addChild(root.id, "A", "a");
		tracker.addChild(root.id, "B", "b");

		expect(tracker.allNodes()).toHaveLength(3);
	});

	test("orchestratorSessionId persists across save/load", async () => {
		tracker.createRoot("App", "desc");
		tracker.orchestratorSessionId = "session-abc-123";
		await tracker.save();

		const tracker2 = new TaskTracker(join(tempDir, "tree.json"));
		await tracker2.load();

		expect(tracker2.orchestratorSessionId).toBe("session-abc-123");
	});

	test("orchestratorSessionId defaults to null", () => {
		expect(tracker.orchestratorSessionId).toBeNull();
	});
});
