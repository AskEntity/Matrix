import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { QueueMessage } from "./message-queue.ts";
import {
	clearPersistedMessages,
	loadPersistedMessages,
	persistMessage,
} from "./persistent-queue.ts";

const TEST_DATA_DIR = join(import.meta.dir, "../.test-persistent-queue");

describe("persistent-queue", () => {
	beforeEach(async () => {
		await rm(TEST_DATA_DIR, { recursive: true, force: true });
		await mkdir(TEST_DATA_DIR, { recursive: true });
	});

	afterEach(async () => {
		await rm(TEST_DATA_DIR, { recursive: true, force: true });
	});

	test("persistMessage creates file and appends messages", async () => {
		const msg1: QueueMessage = { source: "user", content: "hello" };
		const msg2: QueueMessage = {
			source: "parent_update",
			content: "update",
		};

		await persistMessage(TEST_DATA_DIR, "proj-1", "task-1", msg1);
		await persistMessage(TEST_DATA_DIR, "proj-1", "task-1", msg2);

		const loaded = await loadPersistedMessages(
			TEST_DATA_DIR,
			"proj-1",
			"task-1",
		);
		expect(loaded).toHaveLength(2);
		expect(loaded[0]).toEqual(msg1);
		expect(loaded[1]).toEqual(msg2);
	});

	test("loadPersistedMessages returns empty array when no file exists", async () => {
		const loaded = await loadPersistedMessages(
			TEST_DATA_DIR,
			"proj-1",
			"nonexistent-task",
		);
		expect(loaded).toEqual([]);
	});

	test("clearPersistedMessages deletes the file", async () => {
		const msg: QueueMessage = { source: "user", content: "hello" };
		await persistMessage(TEST_DATA_DIR, "proj-1", "task-1", msg);

		const filePath = join(TEST_DATA_DIR, "messages", "proj-1", "task-1.json");
		expect(existsSync(filePath)).toBe(true);

		await clearPersistedMessages(TEST_DATA_DIR, "proj-1", "task-1");
		expect(existsSync(filePath)).toBe(false);
	});

	test("clearPersistedMessages is a no-op when file does not exist", async () => {
		// Should not throw
		await clearPersistedMessages(TEST_DATA_DIR, "proj-1", "nonexistent-task");
	});

	test("different projects and tasks are stored separately", async () => {
		await persistMessage(TEST_DATA_DIR, "proj-1", "task-1", {
			source: "user",
			content: "p1t1",
		});
		await persistMessage(TEST_DATA_DIR, "proj-1", "task-2", {
			source: "user",
			content: "p1t2",
		});
		await persistMessage(TEST_DATA_DIR, "proj-2", "task-1", {
			source: "user",
			content: "p2t1",
		});

		const p1t1 = await loadPersistedMessages(TEST_DATA_DIR, "proj-1", "task-1");
		const p1t2 = await loadPersistedMessages(TEST_DATA_DIR, "proj-1", "task-2");
		const p2t1 = await loadPersistedMessages(TEST_DATA_DIR, "proj-2", "task-1");

		expect(p1t1).toHaveLength(1);
		expect(p1t1[0]?.source === "user" && p1t1[0].content).toBe("p1t1");
		expect(p1t2).toHaveLength(1);
		expect(p1t2[0]?.source === "user" && p1t2[0].content).toBe("p1t2");
		expect(p2t1).toHaveLength(1);
		expect(p2t1[0]?.source === "user" && p2t1[0].content).toBe("p2t1");
	});

	test("persists various message types correctly", async () => {
		const messages: QueueMessage[] = [
			{ source: "user", content: "hello" },
			{
				source: "child_complete",
				taskId: "c1",
				title: "Auth",
				success: true,
				output: "done",
			},
			{ source: "clarify_response", answer: "yes" },
			{
				source: "cross_project",
				fromProjectId: "other",
				fromProjectName: "Other",
				content: "hi",
			},
			{
				source: "background_complete",
				commandId: "bg1",
				command: "ls",
				exitCode: 0,
				durationMs: 100,
			},
			{
				source: "tree_change",
				action: "created",
				nodeId: "node-1",
				title: "New Task",
			},
		];

		for (const msg of messages) {
			await persistMessage(TEST_DATA_DIR, "proj-1", "task-1", msg);
		}

		const loaded = await loadPersistedMessages(
			TEST_DATA_DIR,
			"proj-1",
			"task-1",
		);
		expect(loaded).toHaveLength(messages.length);
		for (let i = 0; i < messages.length; i++) {
			expect(loaded[i]).toEqual(messages[i]);
		}
	});
});
