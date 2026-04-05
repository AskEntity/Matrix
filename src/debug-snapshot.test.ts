/**
 * Unit tests for debug-snapshot.ts — the pre-API-call evidence writer.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DebugSnapshot } from "./debug-snapshot.ts";
import { writeDebugSnapshot } from "./debug-snapshot.ts";

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
				model: "claude-opus-4-6",
				messages: [{ role: "user", content: "hi" }],
				provider: "anthropic",
			});
			expect(existsSync(path)).toBe(true);
			const data = JSON.parse(readFileSync(path, "utf-8")) as DebugSnapshot;
			expect(data.sessionId).toBe("task-001");
			expect(data.model).toBe("claude-opus-4-6");
			expect(data.provider).toBe("anthropic");
			expect(data.messages).toEqual([{ role: "user", content: "hi" }]);
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
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "first" }],
				provider: "anthropic",
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
				model: "claude-sonnet-4-6",
				messages: [{ role: "user", content: "second" }],
				provider: "anthropic",
			});
			const after = JSON.parse(readFileSync(path, "utf-8")) as DebugSnapshot;
			expect(after.messages).toEqual([{ role: "user", content: "second" }]);
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
				model: "m",
				messages: [],
				provider: "anthropic",
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
				model: "claude-opus-4-6",
				system: systemBlocks,
				tools,
				cacheTtl: "1h",
				messages: [{ role: "user", content: "hi" }],
				provider: "anthropic",
			});
			const data = JSON.parse(readFileSync(path, "utf-8")) as DebugSnapshot;
			expect(data.system).toEqual(systemBlocks);
			expect(data.tools).toEqual(tools);
			expect(data.cacheTtl).toBe("1h");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("is no-op when filePath is undefined", () => {
		// Should not throw — used as a safety rail in providers.
		expect(() =>
			writeDebugSnapshot(undefined, {
				sessionId: "x",
				model: "m",
				messages: [],
				provider: "anthropic",
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
					model: "m",
					messages: [],
					provider: "anthropic",
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
				model: "claude-opus-4-6",
				messages,
				provider: "anthropic",
			});
			const data = JSON.parse(readFileSync(path, "utf-8")) as DebugSnapshot;
			expect(data.messages).toEqual(messages);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
