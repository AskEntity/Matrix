import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionStore } from "./session-store.ts";

const TEST_DIR = join(import.meta.dir, "../.test-sessions");

let store: SessionStore;

beforeEach(async () => {
	await rm(TEST_DIR, { recursive: true, force: true });
	await mkdir(TEST_DIR, { recursive: true });
	store = new SessionStore(TEST_DIR);
});

afterEach(async () => {
	await rm(TEST_DIR, { recursive: true, force: true });
});

describe("SessionStore", () => {
	describe("get/set roundtrip", () => {
		test("set then get returns the same data", async () => {
			const messages = [{ role: "user", content: "hello" }];
			await store.set("session1", messages);
			const result = await store.get("session1");
			expect(result).toEqual(messages);
		});

		test("set then get with suffix returns the same data", async () => {
			const messages = [{ role: "assistant", content: "hi" }];
			await store.set("session1", messages, "openai");
			const result = await store.get("session1", "openai");
			expect(result).toEqual(messages);
		});

		test("get returns null for missing session", async () => {
			const result = await store.get("nonexistent");
			expect(result).toBeNull();
		});

		test("get returns null for missing suffix", async () => {
			await store.set("session1", [{ a: 1 }]);
			const result = await store.get("session1", "openai");
			expect(result).toBeNull();
		});
	});

	describe("disk persistence", () => {
		test("get loads from disk when not in cache", async () => {
			const messages = [{ role: "user", content: "from disk" }];
			// Write directly to disk, bypassing cache
			await writeFile(
				join(TEST_DIR, "session1.json"),
				JSON.stringify(messages),
				"utf-8",
			);

			const result = await store.get("session1");
			expect(result).toEqual(messages);
		});

		test("get loads suffixed file from disk", async () => {
			const messages = [{ role: "user", content: "openai disk" }];
			await writeFile(
				join(TEST_DIR, "session1.openai.json"),
				JSON.stringify(messages),
				"utf-8",
			);

			const result = await store.get("session1", "openai");
			expect(result).toEqual(messages);
		});

		test("set writes to disk", async () => {
			const messages = [{ data: "test" }];
			await store.set("session1", messages);

			const raw = await readFile(join(TEST_DIR, "session1.json"), "utf-8");
			expect(JSON.parse(raw)).toEqual(messages);
		});

		test("set with suffix writes correct filename", async () => {
			const messages = [{ data: "openai" }];
			await store.set("session1", messages, "openai");

			const raw = await readFile(
				join(TEST_DIR, "session1.openai.json"),
				"utf-8",
			);
			expect(JSON.parse(raw)).toEqual(messages);
		});
	});

	describe("setSync", () => {
		test("updates cache immediately", () => {
			const messages = [{ role: "user", content: "sync" }];
			store.setSync("session1", messages);

			// Cache should be updated synchronously
			expect(store.has("session1")).toBe(true);
		});

		test("writes to disk eventually", async () => {
			const messages = [{ role: "user", content: "async disk" }];
			store.setSync("session1", messages);

			// Wait for async write to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			const raw = await readFile(join(TEST_DIR, "session1.json"), "utf-8");
			expect(JSON.parse(raw)).toEqual(messages);
		});

		test("setSync with suffix", async () => {
			const messages = [{ role: "assistant", content: "openai sync" }];
			store.setSync("session1", messages, "openai");

			expect(store.has("session1", "openai")).toBe(true);

			await new Promise((resolve) => setTimeout(resolve, 100));
			const raw = await readFile(
				join(TEST_DIR, "session1.openai.json"),
				"utf-8",
			);
			expect(JSON.parse(raw)).toEqual(messages);
		});
	});

	describe("clear", () => {
		test("removes all variants from cache and disk", async () => {
			await store.set("session1", [{ a: 1 }]);
			await store.set("session1", [{ b: 2 }], "openai");

			await store.clear("session1");

			expect(await store.get("session1")).toBeNull();
			expect(await store.get("session1", "openai")).toBeNull();
			expect(existsSync(join(TEST_DIR, "session1.json"))).toBe(false);
			expect(existsSync(join(TEST_DIR, "session1.openai.json"))).toBe(false);
		});

		test("does not affect other sessions", async () => {
			await store.set("session1", [{ a: 1 }]);
			await store.set("session2", [{ b: 2 }]);

			await store.clear("session1");

			expect(await store.get("session1")).toBeNull();
			expect(await store.get("session2")).toEqual([{ b: 2 }]);
		});

		test("handles non-existent session gracefully", async () => {
			// Should not throw
			await store.clear("nonexistent");
		});
	});

	describe("clearAll", () => {
		test("empties cache and disk", async () => {
			await store.set("s1", [{ a: 1 }]);
			await store.set("s2", [{ b: 2 }], "openai");
			await store.set("s3", [{ c: 3 }]);

			await store.clearAll();

			expect(await store.get("s1")).toBeNull();
			expect(await store.get("s2", "openai")).toBeNull();
			expect(await store.get("s3")).toBeNull();
			// Directory should still exist but be empty
			expect(existsSync(TEST_DIR)).toBe(true);
		});
	});

	describe("has", () => {
		test("returns true when session is in cache", async () => {
			await store.set("session1", [{ a: 1 }]);
			expect(store.has("session1")).toBe(true);
		});

		test("returns false for missing session", () => {
			expect(store.has("nonexistent")).toBe(false);
		});

		test("returns true for specific suffix", async () => {
			await store.set("session1", [{ a: 1 }], "openai");
			expect(store.has("session1", "openai")).toBe(true);
			expect(store.has("session1")).toBe(false);
		});

		test("detects session on disk but not in cache", async () => {
			await writeFile(
				join(TEST_DIR, "session1.json"),
				JSON.stringify([]),
				"utf-8",
			);
			// Not in cache, but file exists
			expect(store.has("session1")).toBe(true);
		});
	});

	describe("hasAny", () => {
		test("returns true when default variant exists", async () => {
			await store.set("session1", [{ a: 1 }]);
			expect(store.hasAny("session1")).toBe(true);
		});

		test("returns true when openai variant exists", async () => {
			await store.set("session1", [{ a: 1 }], "openai");
			expect(store.hasAny("session1")).toBe(true);
		});

		test("returns true when any variant is in cache", () => {
			store.setSync("session1", [{ a: 1 }], "openai");
			expect(store.hasAny("session1")).toBe(true);
		});

		test("returns false when no variant exists", () => {
			expect(store.hasAny("nonexistent")).toBe(false);
		});

		test("detects disk-only variants", async () => {
			await writeFile(
				join(TEST_DIR, "session1.openai.json"),
				JSON.stringify([]),
				"utf-8",
			);
			expect(store.hasAny("session1")).toBe(true);
		});
	});

	describe("multiple suffixes independence", () => {
		test("different suffixes store different data", async () => {
			const anthropicMsgs = [{ type: "anthropic" }];
			const openaiMsgs = [{ type: "openai" }];

			await store.set("session1", anthropicMsgs);
			await store.set("session1", openaiMsgs, "openai");

			expect(await store.get("session1")).toEqual(anthropicMsgs);
			expect(await store.get("session1", "openai")).toEqual(openaiMsgs);
		});

		test("clearing one suffix does not exist as targeted clear", async () => {
			// clear() removes ALL variants, so both should be gone
			await store.set("session1", [{ a: 1 }]);
			await store.set("session1", [{ b: 2 }], "openai");

			await store.clear("session1");

			expect(store.has("session1")).toBe(false);
			expect(store.has("session1", "openai")).toBe(false);
		});
	});

	describe("concurrent operations", () => {
		test("multiple sets to different sessions in parallel", async () => {
			await Promise.all([
				store.set("s1", [{ a: 1 }]),
				store.set("s2", [{ b: 2 }]),
				store.set("s3", [{ c: 3 }]),
			]);

			expect(await store.get("s1")).toEqual([{ a: 1 }]);
			expect(await store.get("s2")).toEqual([{ b: 2 }]);
			expect(await store.get("s3")).toEqual([{ c: 3 }]);
		});

		test("multiple sets to same session with different suffixes", async () => {
			await Promise.all([
				store.set("session1", [{ a: 1 }]),
				store.set("session1", [{ b: 2 }], "openai"),
			]);

			expect(await store.get("session1")).toEqual([{ a: 1 }]);
			expect(await store.get("session1", "openai")).toEqual([{ b: 2 }]);
		});
	});

	describe("edge cases", () => {
		test("empty array", async () => {
			await store.set("session1", []);
			expect(await store.get("session1")).toEqual([]);
		});

		test("large payload", async () => {
			const large = Array.from({ length: 1000 }, (_, i) => ({
				id: i,
				content: "x".repeat(100),
			}));
			await store.set("session1", large);
			expect(await store.get("session1")).toEqual(large);
		});

		test("creates sessionsDir if it does not exist", async () => {
			const nestedDir = join(TEST_DIR, "nested", "deep");
			const nestedStore = new SessionStore(nestedDir);

			await nestedStore.set("session1", [{ a: 1 }]);
			expect(await nestedStore.get("session1")).toEqual([{ a: 1 }]);
		});
	});
});
