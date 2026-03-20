import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventStore } from "./event-store.ts";
import type { Event } from "./events.ts";

const TEST_DIR = join(import.meta.dir, "..", ".test-event-store");

describe("EventStore", () => {
	let store: EventStore;

	beforeEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		store = new EventStore(TEST_DIR);
	});

	afterEach(() => {
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	test("creates directory if it does not exist", () => {
		const dir = join(TEST_DIR, "sub", "dir");
		new EventStore(dir);
		expect(existsSync(dir)).toBe(true);
	});

	test("has returns false for non-existent session", () => {
		expect(store.has("no-such-session")).toBe(false);
	});

	test("append + read single event", async () => {
		const event: Event = {
			type: "user_message",
			content: "hello",
			ts: 1000,
		};
		await store.append("s1", event);
		expect(store.has("s1")).toBe(true);
		expect(store.read("s1")).toEqual([event]);
	});

	test("append multiple events sequentially", async () => {
		const e1: Event = {
			type: "user_message",
			content: "hello",
			ts: 1000,
		};
		const e2: Event = {
			type: "assistant_text",
			content: "hi there",
			ts: 1001,
		};
		await store.append("s1", e1);
		await store.append("s1", e2);
		expect(store.read("s1")).toEqual([e1, e2]);
	});

	test("appendBatch writes multiple events", async () => {
		const events: Event[] = [
			{ type: "user_message", content: "hello", ts: 1000 },
			{ type: "assistant_text", content: "hi", ts: 1001 },
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "ls" },
				ts: 1002,
			},
		];
		await store.appendBatch("s1", events);
		expect(store.read("s1")).toEqual(events);
	});

	test("appendBatch with empty array is a no-op", async () => {
		await store.appendBatch("s1", []);
		expect(store.has("s1")).toBe(false);
	});

	test("read returns empty array for non-existent session", () => {
		expect(store.read("missing")).toEqual([]);
	});

	test("clear removes the file", async () => {
		await store.append("s1", {
			type: "user_message",
			content: "hello",
			ts: 1000,
		});
		expect(store.has("s1")).toBe(true);
		store.clear("s1");
		expect(store.has("s1")).toBe(false);
		expect(store.read("s1")).toEqual([]);
	});

	test("clear on non-existent session is a no-op", () => {
		// Should not throw
		store.clear("missing");
	});

	test("readActive returns all events when no compact_marker", async () => {
		const events: Event[] = [
			{ type: "user_message", content: "hello", ts: 1000 },
			{ type: "assistant_text", content: "hi", ts: 1001 },
		];
		await store.appendBatch("s1", events);
		expect(store.readActive("s1")).toEqual(events);
	});

	test("readActive returns events after last compact_marker", async () => {
		const events: Event[] = [
			{ type: "user_message", content: "old msg", ts: 1000 },
			{ type: "assistant_text", content: "old response", ts: 1001 },
			{
				type: "compact_marker",
				checkpoint: "checkpoint text",
				savedTokens: 5000,
				ts: 2000,
			},
			{ type: "compacted_resume", content: "checkpoint text", ts: 2001 },
			{ type: "assistant_text", content: "new response", ts: 2002 },
		];
		await store.appendBatch("s1", events);

		const active = store.readActive("s1");
		expect(active).toEqual([
			{ type: "compacted_resume", content: "checkpoint text", ts: 2001 },
			{ type: "assistant_text", content: "new response", ts: 2002 },
		]);
	});

	test("readActive with multiple compact_markers uses the last one", async () => {
		const events: Event[] = [
			{ type: "user_message", content: "very old", ts: 1000 },
			{
				type: "compact_marker",
				checkpoint: "first",
				savedTokens: 1000,
				ts: 2000,
			},
			{ type: "user_message", content: "somewhat old", ts: 2001 },
			{
				type: "compact_marker",
				checkpoint: "second",
				savedTokens: 2000,
				ts: 3000,
			},
			{ type: "compacted_resume", content: "second checkpoint", ts: 3001 },
		];
		await store.appendBatch("s1", events);

		const active = store.readActive("s1");
		expect(active).toEqual([
			{ type: "compacted_resume", content: "second checkpoint", ts: 3001 },
		]);
	});

	test("readActive returns empty when file does not exist", () => {
		expect(store.readActive("missing")).toEqual([]);
	});

	test("preserves all event fields through round-trip", async () => {
		const event: Event = {
			type: "tool_result",
			toolCallId: "tc1",
			content: 'result with "quotes" and\nnewlines',
			isError: false,
			images: [{ base64: "abc123", mediaType: "image/png" }],
			ts: 1234,
		};
		await store.append("s1", event);
		expect(store.read("s1")).toEqual([event]);
	});

	test("separate sessions do not interfere", async () => {
		const e1: Event = {
			type: "user_message",
			content: "session 1",
			ts: 1000,
		};
		const e2: Event = {
			type: "user_message",
			content: "session 2",
			ts: 2000,
		};
		await store.append("s1", e1);
		await store.append("s2", e2);
		expect(store.read("s1")).toEqual([e1]);
		expect(store.read("s2")).toEqual([e2]);
		store.clear("s1");
		expect(store.has("s1")).toBe(false);
		expect(store.has("s2")).toBe(true);
	});
});
