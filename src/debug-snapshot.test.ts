/**
 * Unit tests for debug-snapshot.ts — the pre-API-call evidence writer.
 */

import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DebugSnapshot } from "./debug-snapshot.ts";
import {
	debugResponsePath,
	rollOldTraceIdDirs,
	writeDebugResponse,
	writeDebugSnapshot,
} from "./debug-snapshot.ts";
import { ulid } from "./ulid.ts";

function makeTmpDir(): string {
	const dir = join(
		tmpdir(),
		`mxd-debug-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("writeDebugSnapshot", () => {
	test("writes snapshot to disk at the given path", () => {
		const dir = makeTmpDir();
		try {
			const path = join(dir, "task-001.last-messages.json");
			writeDebugSnapshot(path, {
				sessionId: "task-001",
				provider: "anthropic",
				body: {
					model: "claude-opus-4-6",
					messages: [{ role: "user", content: "hi" }],
				},
			});
			expect(existsSync(path)).toBe(true);
			const data = JSON.parse(readFileSync(path, "utf-8")) as DebugSnapshot;
			expect(data.sessionId).toBe("task-001");
			expect(data.body.model).toBe("claude-opus-4-6");
			expect(data.provider).toBe("anthropic");
			expect(data.body.messages).toEqual([{ role: "user", content: "hi" }]);
			expect(typeof data.ts).toBe("number");
			expect(data.ts).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("overwrites existing snapshot on subsequent calls", () => {
		const dir = makeTmpDir();
		try {
			const path = join(dir, "task-002.last-messages.json");
			writeDebugSnapshot(path, {
				sessionId: "task-002",
				provider: "anthropic",
				body: {
					model: "claude-sonnet-4-6",
					messages: [{ role: "user", content: "first" }],
				},
			});
			const firstTs = (JSON.parse(readFileSync(path, "utf-8")) as DebugSnapshot)
				.ts;

			// Wait a tick so ts differs
			const start = Date.now();
			while (Date.now() === start) {
				// spin
			}

			writeDebugSnapshot(path, {
				sessionId: "task-002",
				provider: "anthropic",
				body: {
					model: "claude-sonnet-4-6",
					messages: [{ role: "user", content: "second" }],
				},
			});
			const after = JSON.parse(readFileSync(path, "utf-8")) as DebugSnapshot;
			expect(after.body.messages).toEqual([
				{ role: "user", content: "second" },
			]);
			expect(after.ts).toBeGreaterThan(firstTs);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("creates parent directory if missing", () => {
		const dir = makeTmpDir();
		try {
			// Nested path whose parent doesn't exist yet
			const path = join(dir, "deep", "nested", "task-003.last-messages.json");
			expect(existsSync(join(dir, "deep"))).toBe(false);
			writeDebugSnapshot(path, {
				sessionId: "task-003",
				provider: "anthropic",
				body: { model: "m", messages: [] },
			});
			expect(existsSync(path)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("includes all fields when provided", () => {
		const dir = makeTmpDir();
		try {
			const path = join(dir, "task-004.last-messages.json");
			const systemBlocks = [{ type: "text", text: "you are helpful" }];
			const tools = [{ name: "bash", description: "run shell" }];
			writeDebugSnapshot(path, {
				sessionId: "task-004",
				provider: "anthropic",
				body: {
					model: "claude-opus-4-6",
					system: systemBlocks,
					tools,
					cacheTtl: "1h",
					messages: [{ role: "user", content: "hi" }],
				},
			});
			const data = JSON.parse(readFileSync(path, "utf-8")) as DebugSnapshot;
			expect(data.body.system).toEqual(systemBlocks);
			expect(data.body.tools).toEqual(tools);
			expect(data.body.cacheTtl).toBe("1h");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("is no-op when filePath is undefined", () => {
		// Should not throw — used as a safety rail in providers.
		expect(() =>
			writeDebugSnapshot(undefined, {
				sessionId: "x",
				provider: "anthropic",
				body: { model: "m", messages: [] },
			}),
		).not.toThrow();
	});

	test("non-fatal on write failure: logs warning but does not throw", () => {
		// Target a path that cannot exist (parent is a regular file, not a dir).
		const dir = makeTmpDir();
		try {
			const blocker = join(dir, "blocker");
			// Create a file at the path that would need to be a directory.
			Bun.write(blocker, "I am a file");
			// Wait for sync write via Bun
			const fs = require("node:fs");
			fs.writeFileSync(blocker, "I am a file");
			const badPath = join(blocker, "child", "task.json");

			// Should not throw even though mkdir will fail because `blocker` is a file
			expect(() =>
				writeDebugSnapshot(badPath, {
					sessionId: "x",
					provider: "anthropic",
					body: { model: "m", messages: [] },
				}),
			).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("preserves complex nested message structures", () => {
		const dir = makeTmpDir();
		try {
			const path = join(dir, "task-005.last-messages.json");
			const messages = [
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_123",
							content: "result text",
							is_error: false,
							cache_control: { type: "ephemeral", ttl: "1h" },
						},
						{ type: "text", text: "some queue message" },
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I see" },
						{
							type: "tool_use",
							id: "toolu_456",
							name: "bash",
							input: { command: "ls" },
						},
					],
				},
			];
			writeDebugSnapshot(path, {
				sessionId: "task-005",
				provider: "anthropic",
				body: { model: "claude-opus-4-6", messages },
			});
			const data = JSON.parse(readFileSync(path, "utf-8")) as DebugSnapshot;
			expect(data.body.messages).toEqual(messages);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("writeDebugSnapshot v2: per-traceId nested layout", () => {
	test("writes last.json inside <traceId>/ subdirectory, creating nested dirs", () => {
		const dir = makeTmpDir();
		try {
			const traceId = ulid();
			const path = join(dir, "task-abc", traceId, "last.json");
			expect(existsSync(join(dir, "task-abc"))).toBe(false);

			writeDebugSnapshot(path, {
				sessionId: "task-abc",
				provider: "anthropic",
				body: {
					model: "claude-opus-4-6",
					messages: [{ role: "user", content: "hi" }],
				},
			});

			expect(existsSync(path)).toBe(true);
			const data = JSON.parse(readFileSync(path, "utf-8")) as DebugSnapshot;
			expect(data.sessionId).toBe("task-abc");

			// Dir layout: task-abc/<traceId>/last.json
			const taskDir = join(dir, "task-abc");
			expect(readdirSync(taskDir)).toEqual([traceId]);
			expect(readdirSync(join(taskDir, traceId))).toEqual(["last.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("two runs of the same task produce two parallel traceId dirs", () => {
		const dir = makeTmpDir();
		try {
			const taskDir = join(dir, "task-xyz");
			const traceA = ulid();
			const traceB = ulid();

			writeDebugSnapshot(join(taskDir, traceA, "last.json"), {
				sessionId: "task-xyz",
				provider: "anthropic",
				body: { model: "m", messages: [{ run: 1 }] },
			});
			writeDebugSnapshot(join(taskDir, traceB, "last.json"), {
				sessionId: "task-xyz",
				provider: "anthropic",
				body: { model: "m", messages: [{ run: 2 }] },
			});

			const subdirs = readdirSync(taskDir).sort();
			expect(subdirs).toEqual([traceA, traceB].sort());
			const a = JSON.parse(
				readFileSync(join(taskDir, traceA, "last.json"), "utf-8"),
			) as DebugSnapshot;
			const b = JSON.parse(
				readFileSync(join(taskDir, traceB, "last.json"), "utf-8"),
			) as DebugSnapshot;
			expect(a.body.messages).toEqual([{ run: 1 }]);
			expect(b.body.messages).toEqual([{ run: 2 }]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("rollOldTraceIdDirs", () => {
	/**
	 * Create a traceId dir with a controlled mtime.
	 * mtimeSecondsAgo: bigger = older.
	 */
	function mkTraceDir(taskDir: string, mtimeSecondsAgo: number): string {
		const traceId = ulid();
		const sub = join(taskDir, traceId);
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(sub, "last.json"), "{}");
		const now = Date.now() / 1000;
		const mtime = now - mtimeSecondsAgo;
		utimesSync(sub, mtime, mtime);
		return traceId;
	}

	test("no-op when dir does not exist", () => {
		const dir = makeTmpDir();
		try {
			const taskDir = join(dir, "nope");
			expect(() => rollOldTraceIdDirs(taskDir, 5)).not.toThrow();
			expect(existsSync(taskDir)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("no-op when count <= keepCount", () => {
		const dir = makeTmpDir();
		try {
			const taskDir = join(dir, "task");
			mkdirSync(taskDir, { recursive: true });
			const t1 = mkTraceDir(taskDir, 10);
			const t2 = mkTraceDir(taskDir, 5);

			rollOldTraceIdDirs(taskDir, 10);

			const entries = readdirSync(taskDir).sort();
			expect(entries).toEqual([t1, t2].sort());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keeps N most recent (by mtime), removes the rest", () => {
		const dir = makeTmpDir();
		try {
			const taskDir = join(dir, "task");
			mkdirSync(taskDir, { recursive: true });
			// Create 5 dirs; ages 50,40,30,20,10 seconds ago (t5 is newest).
			const tOldest = mkTraceDir(taskDir, 50);
			const t4 = mkTraceDir(taskDir, 40);
			const t3 = mkTraceDir(taskDir, 30);
			const t2 = mkTraceDir(taskDir, 20);
			const tNewest = mkTraceDir(taskDir, 10);

			rollOldTraceIdDirs(taskDir, 3);

			const remaining = readdirSync(taskDir).sort();
			// Should keep the 3 newest: t3, t2, tNewest
			expect(remaining).toEqual([t3, t2, tNewest].sort());
			// Oldest two removed
			expect(remaining).not.toContain(tOldest);
			expect(remaining).not.toContain(t4);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("11 dirs with keepCount=10 → oldest one removed", () => {
		const dir = makeTmpDir();
		try {
			const taskDir = join(dir, "task");
			mkdirSync(taskDir, { recursive: true });
			const created: string[] = [];
			// Oldest first. t[0] is oldest (should be removed).
			for (let i = 11; i > 0; i--) {
				created.push(mkTraceDir(taskDir, i * 5));
			}
			const oldest = created[0];

			rollOldTraceIdDirs(taskDir, 10);

			const remaining = readdirSync(taskDir);
			expect(remaining.length).toBe(10);
			expect(remaining).not.toContain(oldest);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ignores non-ULID entries (doesn't count them, doesn't delete them)", () => {
		const dir = makeTmpDir();
		try {
			const taskDir = join(dir, "task");
			mkdirSync(taskDir, { recursive: true });
			// Real traceId dirs
			const t1 = mkTraceDir(taskDir, 50);
			const t2 = mkTraceDir(taskDir, 40);
			const t3 = mkTraceDir(taskDir, 30);
			// Unrelated file + non-ULID dir
			writeFileSync(join(taskDir, "README.md"), "notes");
			mkdirSync(join(taskDir, "stray-dir"));

			rollOldTraceIdDirs(taskDir, 2);

			const remaining = readdirSync(taskDir).sort();
			// Stray entries untouched, 2 newest traceId dirs kept, oldest removed.
			expect(remaining).toContain("README.md");
			expect(remaining).toContain("stray-dir");
			expect(remaining).toContain(t2);
			expect(remaining).toContain(t3);
			expect(remaining).not.toContain(t1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keepCount of 0 removes all traceId dirs", () => {
		const dir = makeTmpDir();
		try {
			const taskDir = join(dir, "task");
			mkdirSync(taskDir, { recursive: true });
			mkTraceDir(taskDir, 20);
			mkTraceDir(taskDir, 10);

			rollOldTraceIdDirs(taskDir, 0);

			expect(readdirSync(taskDir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("negative keepCount is a no-op (defensive)", () => {
		const dir = makeTmpDir();
		try {
			const taskDir = join(dir, "task");
			mkdirSync(taskDir, { recursive: true });
			const t1 = mkTraceDir(taskDir, 20);
			const t2 = mkTraceDir(taskDir, 10);

			rollOldTraceIdDirs(taskDir, -1);

			expect(readdirSync(taskDir).sort()).toEqual([t1, t2].sort());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("debugResponsePath", () => {
	test("derives last-response.json from last.json path", () => {
		const p = debugResponsePath("/data/debug/task-abc/TRACE123/last.json");
		expect(p).toBe("/data/debug/task-abc/TRACE123/last-response.json");
	});

	test("returns undefined when input is undefined", () => {
		expect(debugResponsePath(undefined)).toBeUndefined();
	});

	test("works with any filename (replaces basename, not just 'last.json')", () => {
		const p = debugResponsePath("/some/path/foo.json");
		expect(p).toBe("/some/path/last-response.json");
	});
});

describe("writeDebugResponse", () => {
	test("writes response JSON to disk with pretty print", () => {
		const dir = makeTmpDir();
		try {
			const path = join(dir, "last-response.json");
			const response = {
				id: "msg_abc123",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "Hello" }],
				model: "claude-opus-4-6",
				stop_reason: "end_turn",
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 80,
					cache_read_input_tokens: 20,
				},
			};
			writeDebugResponse(path, response);
			expect(existsSync(path)).toBe(true);
			const data = JSON.parse(readFileSync(path, "utf-8"));
			expect(data.id).toBe("msg_abc123");
			expect(data.model).toBe("claude-opus-4-6");
			expect(data.usage.input_tokens).toBe(100);
			expect(data.content).toEqual([{ type: "text", text: "Hello" }]);
			// Verify pretty-printed (indented)
			const raw = readFileSync(path, "utf-8");
			expect(raw).toContain("\n ");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("overwrites on subsequent calls", () => {
		const dir = makeTmpDir();
		try {
			const path = join(dir, "last-response.json");
			writeDebugResponse(path, { id: "first" });
			writeDebugResponse(path, { id: "second" });
			const data = JSON.parse(readFileSync(path, "utf-8"));
			expect(data.id).toBe("second");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("creates parent directory if missing", () => {
		const dir = makeTmpDir();
		try {
			const path = join(dir, "deep", "nested", "last-response.json");
			expect(existsSync(join(dir, "deep"))).toBe(false);
			writeDebugResponse(path, { ok: true });
			expect(existsSync(path)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("is no-op when filePath is undefined", () => {
		expect(() => writeDebugResponse(undefined, { id: "x" })).not.toThrow();
	});

	test("non-fatal on write failure", () => {
		const dir = makeTmpDir();
		try {
			const blocker = join(dir, "blocker");
			const fs = require("node:fs");
			fs.writeFileSync(blocker, "I am a file");
			const badPath = join(blocker, "child", "last-response.json");
			expect(() => writeDebugResponse(badPath, { id: "x" })).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
