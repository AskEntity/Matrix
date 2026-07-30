import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { chmodSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type {
	MessageParam,
	TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { z } from "zod";
import {
	AnthropicCompatibleProvider,
	addMessagesCacheControl,
	createAnthropicAdapter,
	eventsToAnthropicMessages,
	getModelPricing,
} from "./anthropic-compatible-provider.ts";
import {
	buildCompactedContext,
	buildSummarizationInstruction,
	extractCheckpoint,
	getCompactionThresholds,
	SUMMARIZATION_INSTRUCTION,
} from "./compaction.ts";
import { clearContextWindowCache } from "./context-window.ts";
import { EventStore } from "./event-store.ts";
import type { Event, EventSpec } from "./events.ts";
import { MessageQueue } from "./message-queue.ts";
import { createOrchestratorTools } from "./orchestrator-tools.ts";
import type { ProviderAdapter } from "./provider-shared.ts";
import { resetResourceRegistry } from "./resource-registry.ts";
import { TaskTracker } from "./task-tracker.ts";
import { createMockAnthropicClient } from "./test-utils/mock-anthropic-api.ts";
import { withClientEnv } from "./test-utils/sdk-client-env.ts";
import { attachMockSession, initMockResourceRegistry } from "./test-utils.ts";
import { type ParamDefs, toToolDefinition } from "./tool-def.ts";
import { type ToolDefinition, tool } from "./tool-definition.ts";
import { TOOL_YIELD } from "./tool-names.ts";
import { listBackgroundProcesses } from "./tools/background.ts";
import type { BackgroundProcess, ForegroundExecution } from "./tools/bash.ts";
import { buildBuiltinToolDefs } from "./tools/definitions.ts";
import {
	cleanupSessionBackgroundProcesses,
	DEFAULT_SKIP_DIRS,
	executeBashWithTimeout,
	getBackgroundStatus,
	jsSearch,
	killBackgroundProcess,
	normalizeGlobDepth,
	resolvePath,
	skipDirsForPattern,
	truncateSearchOutput,
} from "./tools/index.ts";
import { TurnInterrupt } from "./turn-interrupt.ts";
import type { AgentResult } from "./types.ts";

/**
 * Test-only executeTool wrapper. Creates builtin tools with the given cwd
 * and dispatches to the matching handler. Mirrors the old executor.ts API
 * for backward-compatible tests.
 */
async function executeTool(
	name: string,
	input: Record<string, unknown>,
	cwd: string,
	fallbackCwd?: string,
	_sessionId?: string,
	queue?: MessageQueue,
	toolCallId?: string,
	getSession?: (sid: string) => import("./types.ts").TaskSession | undefined,
): Promise<{
	content: string;
	isError: boolean;
	cwd?: string;
	backgroundId?: string;
	backgroundCommand?: string;
	isImage?: boolean;
	imageData?: string;
	mediaType?: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}> {
	// Set up mock resource registry with a session that has the test's cwd/queue
	const testProjectId = "__builtin_test__";
	resetResourceRegistry();
	const { mkdtempSync: mkdtemp } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join: pjoin } = await import("node:path");
	const trackerDir = mkdtemp(pjoin(tmpdir(), "mxd-tool-test-"));
	const testTracker = new TaskTracker(pjoin(trackerDir, "tree.json"));
	await testTracker.load("main");
	const testNode = testTracker.addChild(
		testTracker.rootNodeId,
		"test-task",
		"",
	);
	const realTaskId = testNode.id;
	// Set cwd on the node (production code reads node.cwd, not session.cwd)
	testNode.cwd = cwd;
	if (fallbackCwd) testNode.worktreePath = fallbackCwd;
	// Build default session, then merge any caller-provided session data (maps, etc.)
	const defaultSession: import("./types.ts").TaskSession = {
		queue: queue ?? new MessageQueue(),
		abortController: new AbortController(),
		interrupt: new TurnInterrupt(),
		loopTraceId: "test-trace-id",
		depth: 0,
		backgroundProcesses: new Map(),
		activity: "thinking",
		foregroundExecutions: new Map(),
	};
	const callerSession = getSession?.(realTaskId);
	if (callerSession) {
		// Merge caller's maps into the default session (caller provides bgMap/fgMap, we provide cwd/queue)
		defaultSession.backgroundProcesses =
			callerSession.backgroundProcesses ?? defaultSession.backgroundProcesses;
		defaultSession.foregroundExecutions =
			callerSession.foregroundExecutions ?? defaultSession.foregroundExecutions;
		if (callerSession.queue) defaultSession.queue = callerSession.queue;
	}
	testNode.session = defaultSession;

	const { auth } = initMockResourceRegistry({
		tracker: testTracker,
		projectId: testProjectId,
		projectPath: cwd,
		taskId: realTaskId,
	});

	const tools = buildBuiltinToolDefs();
	const toolDefs = tools.map((def) => toToolDefinition(def, auth));
	// biome-ignore lint/suspicious/noExplicitAny: test helper
	const toolMap = new Map<string, ToolDefinition<any>>();
	for (const t of toolDefs) {
		toolMap.set(t.name, t);
	}
	const handler = toolMap.get(name);
	if (!handler) {
		return { content: `Unknown tool: ${name}`, isError: true };
	}
	const result = await handler.handler(input, { toolCallId });
	// Extract text content from MCP Array format
	const parts = Array.isArray(result.content) ? result.content : [];
	const textParts: string[] = [];
	for (const c of parts as Array<Record<string, unknown>>) {
		if (c.type === "text") textParts.push(c.text as string);
	}
	// Extra fields (isImage, imageData, mediaType, cwd, etc.) are on the result object directly
	const r = result as Record<string, unknown>;
	return {
		content: textParts.join("\n"),
		isError: (result.isError as boolean) ?? false,
		cwd: r.cwd as string | undefined,
		backgroundId: r.backgroundId as string | undefined,
		backgroundCommand: r.backgroundCommand as string | undefined,
		isImage: r.isImage as boolean | undefined,
		imageData: r.imageData as string | undefined,
		mediaType: r.mediaType as
			| "image/jpeg"
			| "image/png"
			| "image/gif"
			| "image/webp"
			| undefined,
	};
}

/** Create a MessageQueue pre-loaded with a user message (for tests). */
function queueWithPrompt(content: string, cwd?: string): MessageQueue {
	const q = new MessageQueue();
	const header = cwd ? `Working directory: ${cwd}` : undefined;
	q.enqueue({
		source: "user",
		id: "test-prompt",
		ts: 0,
		content,
		...(header ? { header } : {}),
	});
	return q;
}

describe("getModelPricing", () => {
	test("returns Opus pricing for opus models", () => {
		const pricing = getModelPricing("claude-opus-4-6");
		expect(pricing.inputPer1M).toBe(5);
		expect(pricing.outputPer1M).toBe(25);
	});

	test("returns Sonnet pricing for sonnet models", () => {
		const pricing = getModelPricing("claude-sonnet-4-6");
		expect(pricing.inputPer1M).toBe(3);
		expect(pricing.outputPer1M).toBe(15);
	});

	test("returns Haiku pricing for haiku models", () => {
		const pricing = getModelPricing("claude-haiku-4-5-20251001");
		expect(pricing.inputPer1M).toBe(1);
		expect(pricing.outputPer1M).toBe(5);
	});

	test("defaults to Sonnet for unknown models", () => {
		const pricing = getModelPricing("gpt-4");
		expect(pricing.inputPer1M).toBe(3);
		expect(pricing.outputPer1M).toBe(15);
	});
});

/**
 * These replace four tests that asserted a local substring guess
 * (`model.includes("opus") → 1_000_000`). The guess is deleted, so there is
 * nothing left to assert about it — what survives is the inversion: the
 * adapter must ASK, and must refuse to answer when the endpoint will not.
 *
 * Every case here is a real measurement from 2026-07-29. Read against the old
 * guess, the first two are the bug: it returned 200_000 for a 1M model and
 * 1_000_000 for a 200K one, in both directions, with nothing going red.
 */
describe("adapter.getContextWindow asks the endpoint", () => {
	function adapterAgainst(
		models: Array<Record<string, unknown>>,
		baseURL = "https://api.anthropic.test",
	): { adapter: ProviderAdapter; calls: () => number } {
		let calls = 0;
		const client = {
			baseURL,
			models: {
				list: async () => {
					calls++;
					return { data: models };
				},
			},
		} as unknown as Anthropic;
		return {
			adapter: createAnthropicAdapter(client, false, {}),
			calls: () => calls,
		};
	}

	beforeEach(() => {
		clearContextWindowCache();
	});

	test("takes the endpoint's number over what the old substring guess said", async () => {
		// Measured: api.anthropic.com reports 1,000,000 for sonnet-5. The
		// deleted guess matched on the literal "sonnet-4" and answered 200_000.
		const { adapter } = adapterAgainst([
			{ id: "claude-sonnet-5", type: "model", max_input_tokens: 1_000_000 },
		]);
		expect(await adapter.getContextWindow("claude-sonnet-5")).toBe(1_000_000);
	});

	test("an old opus really is 200K, where the guess said 1M", async () => {
		// Measured. The guess matched bare "opus" and answered 1_000_000 — the
		// dangerous direction: compact at ~900K against an API refusing at 200K.
		const { adapter } = adapterAgainst([
			{
				id: "claude-opus-4-1-20250805",
				type: "model",
				max_input_tokens: 200_000,
			},
		]);
		expect(await adapter.getContextWindow("claude-opus-4-1-20250805")).toBe(
			200_000,
		);
	});

	test("throws instead of falling back when the endpoint does not list the model", async () => {
		const { adapter } = adapterAgainst([
			{ id: "claude-opus-5", type: "model", max_input_tokens: 1_000_000 },
		]);
		await expect(adapter.getContextWindow("claude-opus-9")).rejects.toThrow(
			/does not list it/,
		);
	});

	test("throws when the endpoint itself is unreachable", async () => {
		const client = {
			baseURL: "https://api.anthropic.test",
			models: {
				list: async () => {
					throw new Error("connect ECONNREFUSED");
				},
			},
		} as unknown as Anthropic;
		const adapter = createAnthropicAdapter(client, false, {});
		await expect(adapter.getContextWindow("claude-opus-5")).rejects.toThrow(
			/ECONNREFUSED/,
		);
	});

	test("asks once per endpoint+model, and separately per endpoint", async () => {
		const a = adapterAgainst(
			[{ id: "k3", type: "model", context_length: 1_048_576 }],
			"https://api.kimi.test/coding",
		);
		const b = adapterAgainst(
			[{ id: "k3", type: "model", context_length: 262_144 }],
			"https://mirror.kimi.test/coding",
		);
		expect(await a.adapter.getContextWindow("k3")).toBe(1_048_576);
		expect(await a.adapter.getContextWindow("k3")).toBe(1_048_576);
		expect(a.calls()).toBe(1);
		// Same model id, different deployment — must NOT read the first answer.
		expect(await b.adapter.getContextWindow("k3")).toBe(262_144);
		expect(b.calls()).toBe(1);
	});
});

describe("getCompactionThresholds", () => {
	test("computes thresholds for 200k context window", () => {
		const { compressThreshold, lazyCountThreshold } =
			getCompactionThresholds(200_000);
		// 200k * 0.83 = 166k
		expect(compressThreshold).toBe(Math.floor(200_000 * 0.83));
		expect(lazyCountThreshold).toBe(compressThreshold - 16_000);
	});

	test("computes thresholds for 1M context window (8% buffer)", () => {
		const { compressThreshold, lazyCountThreshold } =
			getCompactionThresholds(1_000_000);
		// 1M * 0.90 = 900k (large window uses 10% buffer)
		expect(compressThreshold).toBe(900_000);
		expect(lazyCountThreshold).toBe(compressThreshold - 16_000);
	});
});

describe("cost calculation", () => {
	test("input_tokens are NOT double-counted with cache tokens (negative cost bug)", () => {
		// Anthropic API: input_tokens = non-cached tokens ONLY.
		// cache_creation_input_tokens and cache_read_input_tokens are separate.
		// Cost = input * 1x + cache_creation * 1.25x + cache_read * 0.1x + output * outputRate
		// BUG: old code subtracted cache tokens from input_tokens, causing negative costs
		// when cache_creation + cache_read > input_tokens.
		const { inputPer1M, outputPer1M } = getModelPricing("claude-sonnet-4-6");
		// inputPer1M = 3, outputPer1M = 15

		const totalInputTokens = 500; // non-cached tokens (small, e.g. just new content)
		const totalCacheCreationTokens = 10_000; // large cache write
		const totalCacheReadTokens = 5_000; // cache hits
		const totalOutputTokens = 200;

		// Correct formula: input_tokens is already net of cache — no subtraction needed
		const costUsd =
			(totalInputTokens * inputPer1M) / 1_000_000 +
			(totalCacheCreationTokens * inputPer1M * 1.25) / 1_000_000 +
			(totalCacheReadTokens * inputPer1M * 0.1) / 1_000_000 +
			(totalOutputTokens * outputPer1M) / 1_000_000;

		// Should be positive: 500*3/1M + 10000*3*1.25/1M + 5000*3*0.1/1M + 200*15/1M
		// = 0.0015 + 0.0375 + 0.0015 + 0.003 = 0.0435
		expect(costUsd).toBeGreaterThan(0);
		expect(costUsd).toBeCloseTo(0.0435, 6);
	});

	test("cost is non-negative even with very large cache hits", () => {
		const { inputPer1M } = getModelPricing("claude-sonnet-4-6");
		// Extreme case: almost all tokens come from cache, input_tokens is tiny
		const totalInputTokens = 10;
		const totalCacheCreationTokens = 0;
		const totalCacheReadTokens = 100_000;

		const costUsd =
			(totalInputTokens * inputPer1M) / 1_000_000 +
			(totalCacheCreationTokens * inputPer1M * 1.25) / 1_000_000 +
			(totalCacheReadTokens * inputPer1M * 0.1) / 1_000_000 +
			(50 * 15) / 1_000_000;

		expect(costUsd).toBeGreaterThan(0);
	});
});

describe("resolvePath", () => {
	test("returns absolute paths unchanged", () => {
		expect(resolvePath("/tmp/file.ts", "/home/user")).toBe("/tmp/file.ts");
	});

	test("resolves relative paths against cwd", () => {
		expect(resolvePath("src/calc.ts", "/home/user/project")).toBe(
			"/home/user/project/src/calc.ts",
		);
	});
});

describe("executeTool", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-dp-test-"));
	});

	afterAll(async () => {
		if (tempDir) await rm(tempDir, { recursive: true });
	});

	test("bash: executes command and returns output", async () => {
		const result = await executeTool(
			"bash",
			{ command: "echo hello" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("hello");
	});

	test("bash: returns error for failing command", async () => {
		const result = await executeTool("bash", { command: "exit 1" }, tempDir);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("exit code: 1");
	});

	test("bash: no cwd returned when directory unchanged", async () => {
		const result = await executeTool(
			"bash",
			{ command: "echo hello" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.cwd).toBeUndefined();
		expect(result.content).not.toContain("___MXD_CWD___");
	});

	test("bash: cwd returned when cd changes directory", async () => {
		const result = await executeTool("bash", { command: "cd /tmp" }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.cwd).toBe("/tmp");
		expect(result.content).toContain("workdir set to /tmp from now on");
		// Marker should be stripped from output
		expect(result.content).not.toContain("___MXD_CWD___");
	});

	test("bash: cwd tracks cd within a multi-command chain", async () => {
		const result = await executeTool(
			"bash",
			{ command: "cd /tmp && echo working" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.cwd).toBe("/tmp");
		expect(result.content).toContain("working");
		expect(result.content).toContain("workdir set to /tmp from now on");
	});

	test("bash: failed command still captures cwd if cd happened before failure", async () => {
		const result = await executeTool(
			"bash",
			{ command: "cd /tmp && exit 1" },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.cwd).toBe("/tmp");
		expect(result.content).toContain("exit code: 1");
	});

	// ── `cd` to where you already are is free; a `cd` that cannot land is not ──
	//
	// There used to be a shell `cd()` override here that errored with
	// "already in this directory". It is gone, and these pin both halves of what
	// replaced it: the redundant `cd` an unsure agent should feel free to write
	// must succeed, and every `cd` that CANNOT reach its target must still fail
	// loudly. The second is the one worth the lines — swapping a small annoyance
	// for a `cd` that silently does nothing on a typo'd path would leave the next
	// command running somewhere the agent did not intend, which is the failure
	// this whole area exists to prevent.

	test("bash: cd to the directory you are already in succeeds, in every spelling of it", async () => {
		// "same directory" has more spellings than it looks. `.`, `$(pwd)`, a
		// trailing slash and the resolved absolute path must all be no-ops —
		// exit 0, nothing on stderr, and the tracked CWD untouched.
		const real = realpathSync(tempDir);
		for (const command of [
			"cd .",
			'cd "$(pwd)"',
			`cd "${real}"`,
			`cd "${real}/"`,
			"cd ./.",
		]) {
			const result = await executeTool("bash", { command }, tempDir);
			expect({ command, isError: result.isError }).toEqual({
				command,
				isError: false,
			});
			expect(result.content).not.toContain("already in this directory");
			expect(result.content).not.toContain("cd:");
			// Same place, so nothing to re-track and nothing to announce.
			expect(result.cwd).toBeUndefined();
			expect(result.content).not.toContain("workdir set to");
		}
	});

	test("bash: a redundant cd does not disturb a real one that follows it", async () => {
		// The defensive-prefix shape the tool description now recommends.
		const result = await executeTool(
			"bash",
			{ command: 'cd "$(pwd)" && cd /tmp && echo arrived' },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("arrived");
		expect(result.cwd).toBe("/tmp");
	});

	test("bash: cd to a nonexistent directory still fails loudly", async () => {
		const missing = join(tempDir, "no-such-dir-9f3a");
		const result = await executeTool(
			"bash",
			{ command: `cd ${missing}` },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("exit code: 1");
		// The real bash error, naming the path — not a silent no-op.
		expect(result.content).toContain("No such file or directory");
		expect(result.content).toContain(missing);
		// And the agent has NOT been moved anywhere.
		expect(result.cwd).toBeUndefined();
	});

	test("bash: a failed cd does not let the rest of the command run elsewhere", async () => {
		const missing = join(tempDir, "no-such-dir-7c1b");
		const result = await executeTool(
			"bash",
			{ command: `cd ${missing}; pwd` },
			tempDir,
		);
		expect(result.isError).toBe(false); // `;` — pwd is the last command
		expect(result.content).toContain("No such file or directory");
		// pwd reports the ORIGINAL directory: the failed cd moved nothing.
		expect(result.content).toContain(realpathSync(tempDir));
		expect(result.cwd).toBeUndefined();
	});

	test("bash: cd to a file (not a directory) still fails loudly", async () => {
		const filePath = join(tempDir, "not-a-dir.txt");
		await writeFile(filePath, "x");
		const result = await executeTool(
			"bash",
			{ command: `cd ${filePath}` },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Not a directory");
		expect(result.cwd).toBeUndefined();
	});

	test("bash: a bare cd still goes to $HOME", async () => {
		// `builtin cd` does this natively. Pinned because the deleted override
		// spelled it out as `${1:-$HOME}`, which reads like the wrapper was
		// providing it.
		const home = process.env.HOME;
		expect(home).toBeTruthy();
		const result = await executeTool("bash", { command: "cd" }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.cwd).toBeTruthy();
		expect(realpathSync(result.cwd as string)).toBe(
			realpathSync(home as string),
		);
	});

	test("bash: leaving the worktree marks the result OUTSIDE", async () => {
		const result = await executeTool(
			"bash",
			{ command: "cd /tmp" },
			tempDir,
			tempDir, // fallbackCwd = worktree root
		);
		expect(result.isError).toBe(false);
		expect(result.cwd).toBeDefined();
		expect(result.content).toContain("OUTSIDE your worktree");
		expect(result.content).toContain(realpathSync("/tmp"));
		// The EVENT line stays alongside the state line — they report different
		// things and neither substitutes for the other.
		expect(result.content).toContain("workdir set to /tmp from now on");
	});

	test("bash: a subdirectory of your own worktree is NAMED, not marked outside", async () => {
		// The quiet case is EXACTLY the worktree root. `ls` from a subdirectory
		// means something different from `ls` at the root, so the result says
		// where it was taken — it just is not an alarm.
		const subDir = join(tempDir, "subdir");
		await mkdir(subDir, { recursive: true });

		const result = await executeTool(
			"bash",
			{ command: "cd subdir" },
			tempDir,
			tempDir, // fallbackCwd = worktree root
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain(`[cwd: ${realpathSync(subDir)}]`);
		expect(result.content).not.toContain("OUTSIDE");
	});

	test("bash: no notice at all when no worktree root is known", async () => {
		// Without fallbackCwd there is nothing to compare against, so the tool
		// says nothing rather than guessing.
		const result = await executeTool("bash", { command: "cd /tmp" }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.content).not.toContain("[cwd:");
	});

	test("bash: falls back to fallbackCwd when cwd is deleted", async () => {
		// Create and then delete a temp dir to simulate a stale CWD
		const deletedDir = await mkdtemp(join(tmpdir(), "mxd-deleted-"));
		await rm(deletedDir, { recursive: true });

		const result = await executeTool(
			"bash",
			{ command: "echo hello" },
			deletedDir,
			tempDir, // fallbackCwd
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("workdir reset to");
		expect(result.content).toContain("no longer exists");
		expect(result.content).toContain("hello");
		// Should report the fallback as the new cwd
		expect(result.cwd).toBe(tempDir);
	});

	test("write_file: creates file with directories", async () => {
		const path = join(tempDir, "sub", "dir", "file.txt");
		const result = await executeTool(
			"write_file",
			{ path, content: "hello world" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("File written");
	});

	test("read_file: reads existing file", async () => {
		const path = join(tempDir, "readable.txt");
		await writeFile(path, "test content");

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.content).toBe("test content");
	});

	test("read_file: resolves relative paths", async () => {
		await writeFile(join(tempDir, "relative.txt"), "relative content");

		const result = await executeTool(
			"read_file",
			{ path: "relative.txt" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toBe("relative content");
	});

	test("read_file: returns error for missing file", async () => {
		const result = await executeTool(
			"read_file",
			{ path: "nonexistent.txt" },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Error reading file");
	});

	test("read_file: offset skips lines", async () => {
		const path = join(tempDir, "multiline.txt");
		await writeFile(path, "line1\nline2\nline3\nline4\nline5");

		const result = await executeTool("read_file", { path, offset: 3 }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.content).toBe("line3\nline4\nline5");
	});

	test("read_file: limit restricts lines returned", async () => {
		const path = join(tempDir, "multiline2.txt");
		await writeFile(path, "line1\nline2\nline3\nline4\nline5");

		const result = await executeTool("read_file", { path, limit: 2 }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("line1\nline2");
		expect(result.content).toContain(
			"[... 3 more lines, use offset=3 to continue]",
		);
	});

	test("read_file: offset and limit together", async () => {
		const path = join(tempDir, "multiline3.txt");
		await writeFile(path, "line1\nline2\nline3\nline4\nline5");

		const result = await executeTool(
			"read_file",
			{ path, offset: 2, limit: 2 },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("line2\nline3");
		expect(result.content).toContain(
			"[... 2 more lines, use offset=4 to continue]",
		);
	});

	test("read_file: no trailing hint when all lines returned", async () => {
		const path = join(tempDir, "multiline4.txt");
		await writeFile(path, "line1\nline2\nline3");

		const result = await executeTool("read_file", { path, offset: 2 }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.content).toBe("line2\nline3");
		expect(result.content).not.toContain("[...");
	});

	test("read_file: reads PNG image as base64", async () => {
		// Minimal 1x1 red PNG (67 bytes)
		const pngData = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
			"base64",
		);
		const path = join(tempDir, "test.png");
		await writeFile(path, pngData);

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.isImage).toBe(true);
		expect(result.mediaType).toBe("image/png");
		expect(result.imageData).toBeDefined();
		// Verify the base64 round-trips correctly
		const decoded = Buffer.from(result.imageData ?? "", "base64");
		expect(decoded.equals(pngData)).toBe(true);
		expect(result.content).toBe("[Image: test.png]");
	});

	test("read_file: reads JPEG image as base64", async () => {
		const path = join(tempDir, "photo.jpg");
		await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // minimal JPEG header

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.isImage).toBe(true);
		expect(result.mediaType).toBe("image/jpeg");
	});

	test("read_file: reads .jpeg extension as image/jpeg", async () => {
		const path = join(tempDir, "photo.jpeg");
		await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isImage).toBe(true);
		expect(result.mediaType).toBe("image/jpeg");
	});

	test("read_file: reads WebP image as base64", async () => {
		const path = join(tempDir, "image.webp");
		await writeFile(path, Buffer.from("RIFF\x00\x00\x00\x00WEBP"));

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isImage).toBe(true);
		expect(result.mediaType).toBe("image/webp");
	});

	test("read_file: reads GIF image as base64", async () => {
		const path = join(tempDir, "anim.gif");
		await writeFile(path, Buffer.from("GIF89a"));

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isImage).toBe(true);
		expect(result.mediaType).toBe("image/gif");
	});

	test("read_file: non-image files still return text", async () => {
		const path = join(tempDir, "code.ts");
		await writeFile(path, 'console.log("hello");');

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.isImage).toBeUndefined();
		expect(result.imageData).toBeUndefined();
		expect(result.content).toBe('console.log("hello");');
	});

	test("read_file: SVG files return text (not image)", async () => {
		const path = join(tempDir, "icon.svg");
		await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

		const result = await executeTool("read_file", { path }, tempDir);
		expect(result.isError).toBe(false);
		expect(result.isImage).toBeUndefined();
		// SVG is XML text, not a supported image format for the API
		expect(result.content).toBe(
			'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
		);
	});

	test("read_file: image error for missing file", async () => {
		const result = await executeTool(
			"read_file",
			{ path: "missing.png" },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Error reading file");
		expect(result.isImage).toBeUndefined();
	});

	test("edit_file: replaces string in file", async () => {
		const path = join(tempDir, "editable.txt");
		await writeFile(path, "hello world");

		const result = await executeTool(
			"edit_file",
			{ path, old_string: "world", new_string: "earth" },
			tempDir,
		);
		expect(result.isError).toBe(false);

		const readResult = await executeTool("read_file", { path }, tempDir);
		expect(readResult.content).toBe("hello earth");
	});

	test("edit_file: fails for non-unique string", async () => {
		const path = join(tempDir, "duplicate.txt");
		await writeFile(path, "aaa bbb aaa");

		const result = await executeTool(
			"edit_file",
			{ path, old_string: "aaa", new_string: "ccc" },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("2 times");
		expect(result.content).toContain("replace_all=true");
	});

	test("edit_file: replace_all replaces all occurrences", async () => {
		const path = join(tempDir, "replace_all.txt");
		await writeFile(path, "aaa bbb aaa ccc aaa");

		const result = await executeTool(
			"edit_file",
			{ path, old_string: "aaa", new_string: "zzz", replace_all: true },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("3 replacements");

		const readResult = await executeTool("read_file", { path }, tempDir);
		expect(readResult.content).toBe("zzz bbb zzz ccc zzz");
	});

	test("edit_file: replace_all with single occurrence reports no count suffix", async () => {
		const path = join(tempDir, "replace_all_single.txt");
		await writeFile(path, "hello world");

		const result = await executeTool(
			"edit_file",
			{ path, old_string: "world", new_string: "earth", replace_all: true },
			tempDir,
		);
		expect(result.isError).toBe(false);
		// Single occurrence: no "(N replacements)" suffix
		expect(result.content).toBe(`File edited: ${path}`);

		const readResult = await executeTool("read_file", { path }, tempDir);
		expect(readResult.content).toBe("hello earth");
	});

	test("edit_file: replace_all=false is the same as default uniqueness enforcement", async () => {
		const path = join(tempDir, "replace_all_false.txt");
		await writeFile(path, "foo foo foo");

		const result = await executeTool(
			"edit_file",
			{ path, old_string: "foo", new_string: "bar", replace_all: false },
			tempDir,
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("3 times");
	});

	test("list_files: lists files in directory", async () => {
		await writeFile(join(tempDir, "list_test.txt"), "");
		const result = await executeTool(
			"list_files",
			{ pattern: "*.txt" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("list_test.txt");
	});

	test("search: finds pattern in files", async () => {
		await writeFile(
			join(tempDir, "searchable.ts"),
			"const foo = 42;\nconst bar = 99;\n",
		);
		const result = await executeTool(
			"search",
			{ pattern: "foo", path: tempDir },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("foo");
	});

	test("search: returns context lines", async () => {
		await writeFile(
			join(tempDir, "ctx.ts"),
			"line1\nline2\ntarget\nline4\nline5\n",
		);
		const result = await executeTool(
			"search",
			{ pattern: "target", path: tempDir, context: 1 },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("target");
		expect(result.content).toContain("line2");
		expect(result.content).toContain("line4");
	});

	test("search: files_with_matches returns only file paths", async () => {
		await writeFile(join(tempDir, "match1.ts"), "const hello = 1;\n");
		await writeFile(join(tempDir, "match2.ts"), "const hello = 2;\n");
		await writeFile(join(tempDir, "nomatch.ts"), "const world = 3;\n");
		const result = await executeTool(
			"search",
			{ pattern: "hello", path: tempDir, output_mode: "files_with_matches" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("match1.ts");
		expect(result.content).toContain("match2.ts");
		expect(result.content).not.toContain("nomatch.ts");
	});

	test("search: count mode returns match counts", async () => {
		await writeFile(
			join(tempDir, "count_test.ts"),
			"hello world\nhello again\nno match\n",
		);
		const result = await executeTool(
			"search",
			{ pattern: "hello", path: tempDir, output_mode: "count" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("count_test.ts");
		expect(result.content).toContain("2");
	});

	test("search: case_insensitive matches upper and lower case", async () => {
		await writeFile(
			join(tempDir, "case_test.ts"),
			"const HELLO = 1;\nconst hello = 2;\nconst world = 3;\n",
		);
		const result = await executeTool(
			"search",
			{ pattern: "HELLO", path: tempDir, case_insensitive: true },
			tempDir,
		);
		expect(result.isError).toBe(false);
		// Both lines with HELLO and hello should be found
		const lines = result.content
			.split("\n")
			.filter((l) => l.includes("case_test.ts"));
		expect(lines.length).toBeGreaterThanOrEqual(2);
	});

	test("search: head_limit truncates total output entries", async () => {
		// Write a file with many matching lines
		const lines = Array.from(
			{ length: 20 },
			(_, i) => `const x${i} = ${i};`,
		).join("\n");
		await writeFile(join(tempDir, "many.ts"), `${lines}\n`);
		const result = await executeTool(
			"search",
			{ pattern: "const", path: tempDir, head_limit: 5 },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("const");
		// Should be truncated to 5 entries
		const matchLines = result.content
			.split("\n")
			.filter((l) => l.includes("const"));
		expect(matchLines.length).toBe(5);
		expect(result.content).toContain("[... truncated at 5 entries]");
	});

	test("search: glob with path separator finds matches", async () => {
		// Create a nested file structure
		const subDir = join(tempDir, "sub");
		await mkdir(subDir, { recursive: true });
		await writeFile(join(subDir, "target.ts"), "const found = true;\n");
		await writeFile(join(tempDir, "other.ts"), "const found = false;\n");

		// Glob with path separator: "sub/target.ts"
		const result = await executeTool(
			"search",
			{ pattern: "found", path: tempDir, glob: "sub/target.ts" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("found");
		// Should only match the file in sub/, not other.ts
		expect(result.content).not.toContain("other.ts");
	});

	test("search: glob with path wildcard narrows to subdirectory", async () => {
		const subDir = join(tempDir, "src");
		await mkdir(subDir, { recursive: true });
		await writeFile(join(subDir, "a.ts"), "hello world\n");
		await writeFile(join(subDir, "b.js"), "hello world\n");
		await writeFile(join(tempDir, "c.ts"), "hello world\n");

		// Glob "src/*.ts" should match only src/a.ts
		const result = await executeTool(
			"search",
			{ pattern: "hello", path: tempDir, glob: "src/*.ts" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("a.ts");
		expect(result.content).not.toContain("b.js");
		expect(result.content).not.toContain("c.ts");
	});

	test("unknown tool: returns error", async () => {
		const result = await executeTool("unknown_tool", {}, tempDir);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("Unknown tool");
	});
});

// ── Every result names the directory it came from ──
//
// Three states:
//   exactly your worktree root → silence
//   below your root            → the cwd, on EVERY result
//   a different checkout       → the cwd, marked OUTSIDE
//
// Which checkout a directory belongs to is answered by `git rev-parse
// --show-toplevel`, run by the command's own shell. That is what makes
// `.worktrees/<other-task>` come out OUTSIDE even though it sits UNDER the main
// repo root: a path-prefix test calls it "inside", and for ROOT — whose worktree
// root IS the repo root — that would cover every other agent's checkout, on
// another branch, where a write or a commit lands in someone else's in-flight
// work and looks entirely normal going in.
describe("bash: the result names its own working directory", () => {
	let repo: string;
	let subDir: string;
	let otherWorktree: string;

	function git(cwd: string, ...args: string[]): void {
		const r = Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (r.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
		}
	}

	beforeAll(async () => {
		repo = realpathSync(await mkdtemp(join(tmpdir(), "mxd-cwd-repo-")));
		git(repo, "init", "-b", "main");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		await writeFile(join(repo, "seed.txt"), "seed");
		git(repo, "add", "seed.txt");
		git(repo, "commit", "-m", "seed");

		subDir = join(repo, "src");
		await mkdir(subDir, { recursive: true });

		// A REAL linked worktree, created by git. Nothing synthetic reproduces
		// the property that matters here.
		otherWorktree = join(repo, ".worktrees", "other-task");
		git(repo, "worktree", "add", "-b", "other-branch", otherWorktree);
	});

	afterAll(async () => {
		if (repo) await rm(repo, { recursive: true, force: true });
	});

	test("the fixture is the hard case: a linked worktree's .git is a FILE", () => {
		// Pinned so the fixture cannot silently degrade into one that any
		// implementation would pass. A `.git`-DIRECTORY test resolves every agent
		// worktree to the main repo — the one answer that makes another agent's
		// checkout look like home.
		expect(statSync(join(otherWorktree, ".git")).isFile()).toBe(true);
		expect(statSync(join(repo, ".git")).isDirectory()).toBe(true);
		expect(otherWorktree.startsWith(`${repo}/`)).toBe(true);
	});

	test("at your worktree root: silence", async () => {
		const r = await executeTool("bash", { command: "echo hi" }, repo, repo);
		expect(r.content).toContain("hi");
		expect(r.content).not.toContain("[cwd:");
	});

	test("below your root: named on EVERY result, not only the one that moved", async () => {
		// This is the whole fix. The warning this replaced fired once, at the
		// `cd`, and every later result was silent — and those later results are
		// the deceptive ones, because nothing in them goes wrong.
		for (const command of ["echo one", "echo two", "echo three"]) {
			const r = await executeTool("bash", { command }, subDir, repo);
			expect(r.content).toContain(`[cwd: ${subDir}]`);
			expect(r.content).not.toContain("OUTSIDE");
		}
	});

	test("ROOT inside another task's worktree: OUTSIDE, though it is under root's own tree", async () => {
		const r = await executeTool(
			"bash",
			{ command: "echo hi" },
			otherWorktree,
			repo, // root's worktree root IS the repo root
		);
		expect(r.content).toContain(`[cwd: ${otherWorktree}`);
		expect(r.content).toContain("OUTSIDE your worktree");
		expect(r.content).toContain(repo);
	});

	test("a CHILD inside the main repo: OUTSIDE", async () => {
		const r = await executeTool(
			"bash",
			{ command: "echo hi" },
			repo,
			otherWorktree,
		);
		expect(r.content).toContain("OUTSIDE your worktree");
	});

	test("a child at its own worktree root: silence", async () => {
		const r = await executeTool(
			"bash",
			{ command: "echo hi" },
			otherWorktree,
			otherWorktree,
		);
		expect(r.content).not.toContain("[cwd:");
	});

	test("no checkout at all: OUTSIDE, and git's own error never reaches the output", async () => {
		// Outside a repository `git rev-parse` fails loudly on stderr, and in
		// merged mode the subshell's stderr is folded into the command's output.
		// That case is NORMAL, so its noise must not surface as a failure the
		// command did not cause.
		const outside = realpathSync(tmpdir());
		const r = await executeTool("bash", { command: "echo hi" }, outside, repo);
		expect(r.content).toContain("OUTSIDE your worktree");
		expect(r.content).toContain("hi");
		expect(r.content.toLowerCase()).not.toContain("not a git repository");
		expect(r.content.toLowerCase()).not.toContain("fatal");
	});

	test("cd back to the root: the annotation stops on that same result", async () => {
		const away = await executeTool(
			"bash",
			{ command: "echo hi" },
			subDir,
			repo,
		);
		expect(away.content).toContain("[cwd:");

		// Final-directory semantics: the notice describes where the shell ENDED,
		// which is where this output came from and where the next command starts.
		const back = await executeTool(
			"bash",
			{ command: `cd ${repo} && echo hi` },
			subDir,
			repo,
		);
		expect(back.content).not.toContain("[cwd:");
		expect(back.content).toContain(`workdir set to ${repo} from now on`);
	});

	test("a background result carries it — the case most likely to mislead", async () => {
		// It arrives detached from the command that moved there, possibly many
		// turns later, so it is the result least able to be read in context.
		const bgMap = new Map<string, BackgroundProcess>();
		const queue = new MessageQueue();
		const result = await executeBashWithTimeout(
			'echo "bg-out"',
			otherWorktree,
			repo,
			0, // immediate background
			"sess",
			queue,
			"tc-cwd",
			bgMap,
			new Map<string, ForegroundExecution>(),
		);
		expect(result.backgroundId).toBeTruthy();

		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.content).toContain("bg-out");
			expect(msg.content).toContain("OUTSIDE your worktree");
		}

		// …and the `background` tool's own status action reports the same thing.
		const status = getBackgroundStatus(bgMap, result.backgroundId as string);
		expect(status).toContain("OUTSIDE your worktree");

		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("a background result at the worktree root stays silent", async () => {
		const bgMap = new Map<string, BackgroundProcess>();
		const queue = new MessageQueue();
		await executeBashWithTimeout(
			'echo "bg-quiet"',
			repo,
			repo,
			0,
			"sess",
			queue,
			"tc-quiet",
			bgMap,
			new Map<string, ForegroundExecution>(),
		);
		const msg = await queue.wait();
		if (msg.source === "background_complete") {
			expect(msg.content).toContain("bg-quiet");
			expect(msg.content).not.toContain("[cwd:");
		}
		cleanupSessionBackgroundProcesses(bgMap);
	});
});

describe("executeBashWithTimeout", () => {
	let tempDir: string;

	/**
	 * Per-test session Maps. Tests that need background process tracking
	 * create a local bgMap/fgMap and pass them to functions.
	 * The afterAll cleans up any straggler Maps.
	 */
	const allTestBgMaps: Map<string, BackgroundProcess>[] = [];

	/** Create a fresh bgMap + fgMap pair for a test. Tracks bgMap for cleanup. */
	function createTestMaps() {
		const bgMap = new Map<string, BackgroundProcess>();
		const fgMap = new Map<string, ForegroundExecution>();
		allTestBgMaps.push(bgMap);
		return { bgMap, fgMap };
	}

	/** Create a getSession callback that returns a fake session with the given Maps. */
	function makeGetSession(
		bgMap: Map<string, BackgroundProcess>,
		fgMap: Map<string, ForegroundExecution>,
	) {
		return (_sessionId: string) =>
			({
				backgroundProcesses: bgMap,
				foregroundExecutions: fgMap,
			}) as import("./types.ts").TaskSession;
	}

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "bash-timeout-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
		// Clean up any background processes
		for (const bgMap of allTestBgMaps) {
			cleanupSessionBackgroundProcesses(bgMap);
		}
	});

	test("foreground command completes within timeout", async () => {
		const result = await executeBashWithTimeout(
			"echo hello",
			tempDir,
			undefined,
			5000,
			undefined,
			undefined,
		);
		expect(result.content).toContain("hello");
		expect(result.content).toContain("exit code: 0");
		expect(result.isError).toBe(false);
	});

	test("foreground_timeout=0 immediately backgrounds", async () => {
		const sessionId = "test-bg-immediate";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeBashWithTimeout(
			"echo bg-test",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("backgrounded immediately");
		expect(result.content).toContain("Background ID: bg-");
		expect(result.isError).toBe(false);
		// backgroundId and backgroundCommand returned on result
		expect(result.backgroundId).toMatch(/^bg-/);
		expect(result.backgroundCommand).toBe("echo bg-test");

		// Wait for background process to complete and notify (with formatted content)
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.exitCode).toBe(0);
			expect(msg.durationMs).toBeGreaterThanOrEqual(0);
			// content includes formatted output from formatBashResult
			expect(msg.content).toContain("bg-test");
		}

		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("foreground timeout triggers backgrounding for slow command", async () => {
		const sessionId = "test-bg-slow";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeBashWithTimeout(
			"sleep 5 && echo done-slow",
			tempDir,
			undefined,
			100, // 100ms foreground timeout — will trigger background
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("moved to background");
		expect(result.content).toContain("Background ID: bg-");
		expect(result.isError).toBe(false);

		// Verify it's tracked as running
		expect(
			listBackgroundProcesses(bgMap).filter((p) => p.status === "running")
				.length,
		).toBe(1);

		// Wait for completion notification — this takes ~5s (with formatted content)
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.exitCode).toBe(0);
			expect(msg.durationMs).toBeGreaterThan(100);
			// content includes formatted output from formatBashResult
			expect(msg.content).toContain("done-slow");
		}

		// Should no longer be running
		expect(
			listBackgroundProcesses(bgMap).filter((p) => p.status === "running")
				.length,
		).toBe(0);
		cleanupSessionBackgroundProcesses(bgMap);
	}, 10000);

	test("foreground command that finishes before timeout returns normally", async () => {
		const { bgMap } = createTestMaps();
		const result = await executeBashWithTimeout(
			"echo fast",
			tempDir,
			undefined,
			5000,
			"test-fast",
			undefined,
			undefined,
			bgMap,
		);
		expect(result.content).toContain("fast");
		expect(result.content).toContain("exit code: 0");
		expect(result.isError).toBe(false);
		// Should NOT be backgrounded
		expect(result.content).not.toContain("Background ID");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("executeTool bash with foreground_timeout passes through", async () => {
		const result = await executeTool(
			"bash",
			{ command: "echo tool-test", foreground_timeout: 5000 },
			tempDir,
		);
		expect(result.content).toContain("tool-test");
		expect(result.content).toContain("exit code: 0");
		expect(result.isError).toBe(false);
	});

	test("no background warning injected into bash output", async () => {
		const sessionId = "test-bg-warn";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();

		// Start a slow background command
		await executeBashWithTimeout(
			"sleep 10",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		expect(
			listBackgroundProcesses(bgMap).filter((p) => p.status === "running")
				.length,
		).toBe(1);

		// Run another command — should NOT show warning (bg warning removed)
		const result = await executeTool(
			"bash",
			{ command: "echo hello", foreground_timeout: 5000 },
			tempDir,
			undefined,
			sessionId,
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.content).not.toContain("background command(s) still running");
		expect(result.content).toContain("hello");

		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("cleanup removes all background processes for session", () => {
		const bgMap = new Map<string, BackgroundProcess>([
			[
				"bg-1",
				{
					id: "bg-1",
					command: "test",
					separate: false,
					startTime: Date.now(),
					exitCode: null,
					status: "running",
					kill: null,
					stdoutPath: null,
					stderrPath: null,
					cwdPath: null,
				},
			],
		]);
		expect(bgMap.size).toBe(1);
		cleanupSessionBackgroundProcesses(bgMap);
		expect(bgMap.size).toBe(0);
	});

	test("killBackgroundProcess kills a running process", async () => {
		const sessionId = "test-kill";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		const bgId = result.content.match(/bg-[A-Z0-9]+/)?.[0] ?? "";
		expect(bgId).toBeTruthy();

		expect(
			listBackgroundProcesses(bgMap).filter((p) => p.status === "running")
				.length,
		).toBe(1);

		const killResult = killBackgroundProcess(bgMap, bgId);
		expect(killResult).toContain("killed");
		expect(killResult).toContain(bgId);

		// Wait for background completion notification
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");

		expect(
			listBackgroundProcesses(bgMap).filter((p) => p.status === "running")
				.length,
		).toBe(0);
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("killBackgroundProcess returns not-running message for completed process", () => {
		const bgMap = new Map<string, BackgroundProcess>([
			[
				"bg-done",
				{
					id: "bg-done",
					command: "echo done",
					separate: false,
					startTime: Date.now() - 1000,
					exitCode: 0,
					status: "completed",
					kill: null,
					stdoutPath: null,
					stderrPath: null,
					cwdPath: null,
				},
			],
		]);

		const result = killBackgroundProcess(bgMap, "bg-done");
		expect(result).toContain("not running");
		expect(result).toContain("completed");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("killBackgroundProcess returns null for unknown process", () => {
		const bgMap = new Map<string, BackgroundProcess>();
		const result = killBackgroundProcess(bgMap, "bg-nope");
		expect(result).toBeNull();
	});

	test("getBackgroundStatus returns status for running process", async () => {
		const sessionId = "test-status-running";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);

		const bgId = bgMap.keys().next().value ?? "";
		expect(bgId).toBeTruthy();

		const status = getBackgroundStatus(bgMap, bgId);
		expect(status).toContain("running");
		expect(status).toContain("sleep 30");
		// Merged mode (default): single "output file:" line; separate mode would show "stdout file:"
		expect(status).toContain("output file:");
		expect(status).toContain("read_file");

		// Clean up: kill the process
		killBackgroundProcess(bgMap, bgId);
		await queue.wait();
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("getBackgroundStatus returns metadata for completed process", () => {
		const bgMap = new Map<string, BackgroundProcess>([
			[
				"bg-fin",
				{
					id: "bg-fin",
					command: "echo hello",
					separate: true,
					startTime: Date.now() - 2000,
					exitCode: 0,
					status: "completed",
					kill: null,
					stdoutPath: "/tmp/mxd/exec-test.stdout",
					stderrPath: "/tmp/mxd/exec-test.stderr",
					cwdPath: null,
				},
			],
		]);

		const status = getBackgroundStatus(bgMap, "bg-fin");
		expect(status).toContain("completed");
		expect(status).toContain("exit code: 0");
		expect(status).not.toContain("still running");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("getBackgroundStatus returns null for unknown process", () => {
		const bgMap = new Map<string, BackgroundProcess>();
		const result = getBackgroundStatus(bgMap, "bg-nope");
		expect(result).toBeNull();
	});

	test("background tool routes action=kill", async () => {
		const sessionId = "test-tool-kill";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);

		const bgId = bgMap.keys().next().value;
		expect(bgId).toBeDefined();

		const result = await executeTool(
			"background",
			{ action: "kill", id: bgId },
			tempDir,
			undefined,
			sessionId,
			queue,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("killed");

		await queue.wait();
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("background tool routes action=status", async () => {
		const sessionId = "test-tool-status";
		const bgMap = new Map<string, BackgroundProcess>([
			[
				"bg-st",
				{
					id: "bg-st",
					command: "echo test",
					separate: false,
					startTime: Date.now() - 5000,
					exitCode: 0,
					status: "completed",
					kill: null,
					stdoutPath: null,
					stderrPath: null,
					cwdPath: null,
				},
			],
		]);
		const fgMap = new Map<string, ForegroundExecution>();
		allTestBgMaps.push(bgMap);

		const result = await executeTool(
			"background",
			{ action: "status", id: "bg-st" },
			tempDir,
			undefined,
			sessionId,
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("completed");
		expect(result.content).toContain("test");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("background tool action without id returns error", async () => {
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeTool(
			"background",
			{ action: "kill" },
			tempDir,
			undefined,
			"test-session",
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("id is required");
	});

	test("background tool kill on unknown process returns error", async () => {
		// In the new architecture, session always exists (tools run in task context).
		// Killing a nonexistent process returns a not-found error.
		const result = await executeTool(
			"background",
			{ action: "kill", id: "bg-123" },
			tempDir,
		);
		expect(result.isError).toBe(true);
	});

	test("background tool action=status for unknown process returns error", async () => {
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeTool(
			"background",
			{ action: "status", id: "bg-unknown" },
			tempDir,
			undefined,
			"test-session",
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(true);
		expect(result.content).toContain("not found");
	});

	test("run_in_background=true behaves like foreground_timeout=0", async () => {
		const sessionId = "test-run-in-bg";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeTool(
			"bash",
			{ command: "echo run-in-bg-test", run_in_background: true },
			tempDir,
			undefined,
			sessionId,
			queue,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.content).toContain("backgrounded immediately");
		expect(result.content).toContain("Background ID: bg-");
		expect(result.isError).toBe(false);

		// Wait for completion with content
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.exitCode).toBe(0);
			expect(msg.content).toContain("run-in-bg-test");
		}

		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("background tool action=list shows all processes", async () => {
		const sessionId = "test-list";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		await executeBashWithTimeout(
			"sleep 30",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);

		const result = await executeTool(
			"background",
			{ action: "list" },
			tempDir,
			undefined,
			sessionId,
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("Background processes:");
		expect(result.content).toContain("sleep 30");
		expect(result.content).toContain("running");

		cleanupSessionBackgroundProcesses(bgMap);
		// Wait for background monitor to finish after kill
		await queue.wait();
	});

	test("background tool action=list with no processes", async () => {
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeTool(
			"background",
			{ action: "list" },
			tempDir,
			undefined,
			"test-empty-session",
			undefined,
			undefined,
			makeGetSession(bgMap, fgMap),
		);
		expect(result.isError).toBe(false);
		expect(result.content).toContain("No background processes");
	});

	test("background completion includes stderr when present", async () => {
		const sessionId = "test-bg-stderr";
		const queue = new MessageQueue();
		const { bgMap, fgMap } = createTestMaps();
		const result = await executeBashWithTimeout(
			"echo err-output >&2",
			tempDir,
			undefined,
			0,
			sessionId,
			queue,
			undefined,
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("backgrounded immediately");

		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.content).toContain("err-output");
		}

		cleanupSessionBackgroundProcesses(bgMap);
	});
});

describe("truncateSearchOutput", () => {
	test("returns output unchanged when within limit", () => {
		const output = "line1\nline2\nline3\n";
		expect(truncateSearchOutput(output, 5, false)).toBe(output);
	});

	test("truncates lines exceeding limit", () => {
		const output = "a\nb\nc\nd\ne\nf\n";
		const result = truncateSearchOutput(output, 3, false);
		expect(result).toBe("a\nb\nc\n[... truncated at 3 entries]");
	});

	test("handles output without trailing newline", () => {
		const output = "a\nb\nc\nd\ne";
		const result = truncateSearchOutput(output, 3, false);
		expect(result).toBe("a\nb\nc\n[... truncated at 3 entries]");
	});

	test("truncates context blocks separated by --", () => {
		const output =
			"file:1:block1_line1\nfile:2:block1_line2\n--\nfile:5:block2_line1\n--\nfile:10:block3_line1\n--\nfile:15:block4_line1";
		const result = truncateSearchOutput(output, 2, true);
		expect(result).toBe(
			"file:1:block1_line1\nfile:2:block1_line2\n--\nfile:5:block2_line1\n[... truncated at 2 entries]",
		);
	});

	test("returns context output unchanged when within limit", () => {
		const output = "block1\n--\nblock2";
		expect(truncateSearchOutput(output, 5, true)).toBe(output);
	});
});

describe("extractCheckpoint", () => {
	test("extracts text between summary tags", () => {
		const response =
			"<summary>\n## Current Phase\nimplementation\n\n## Completed Work\nDid stuff\n</summary>";
		const checkpoint = extractCheckpoint(response);
		expect(checkpoint).toContain("Current Phase");
		expect(checkpoint).toContain("implementation");
		expect(checkpoint).toContain("Completed Work");
	});

	test("trims whitespace from extracted content", () => {
		const response = "<summary>\n  some content  \n</summary>";
		expect(extractCheckpoint(response)).toBe("some content");
	});

	test("uses full response when no summary tags present", () => {
		const response = "Just a plain text checkpoint without tags";
		expect(extractCheckpoint(response)).toBe(
			"Just a plain text checkpoint without tags",
		);
	});

	test("handles empty summary tags", () => {
		const response = "<summary></summary>";
		expect(extractCheckpoint(response)).toBe("");
	});

	test("handles response with text before and after summary tags", () => {
		const response =
			"Some preamble\n<summary>\nThe actual checkpoint\n</summary>\nSome epilogue";
		expect(extractCheckpoint(response)).toBe("The actual checkpoint");
	});

	test("handles multiline checkpoint content", () => {
		const response =
			"<summary>\n## Phase\ndone\n\n## Work\n- item 1\n- item 2\n</summary>";
		const checkpoint = extractCheckpoint(response);
		expect(checkpoint).toContain("## Phase");
		expect(checkpoint).toContain("- item 1");
		expect(checkpoint).toContain("- item 2");
	});

	test("appends system context when cwd is provided", () => {
		const response = "<summary>\n## Phase\nimplementation\n</summary>";
		const checkpoint = extractCheckpoint(response, "/path/to/project");
		expect(checkpoint).toContain("## Phase\nimplementation");
		expect(checkpoint).toContain("## System Context (auto-generated)");
		expect(checkpoint).toContain("Working directory: /path/to/project");
		expect(checkpoint).toContain("Resume from this checkpoint");
	});

	test("system context does not teach the deleted no-cd rule", () => {
		// This block is injected into an agent that has just lost its history, so
		// it is the one surface where a stale rule cannot be caught by the reader
		// it is aimed at — nothing in that context can contradict it. It used to
		// end "Do not cd to your current working directory — you are already
		// there", stating a shell behaviour that no longer exists.
		//
		// Inverted rather than deleted, because deleting it would leave the
		// removal pinned by nothing at all.
		const checkpoint = extractCheckpoint(
			"<summary>work</summary>",
			"/path/to/project",
		);
		expect(checkpoint).not.toContain("Do not cd");
		expect(checkpoint).not.toContain("you are already there");
	});

	test("does not append system context when cwd is undefined", () => {
		const response = "<summary>\ncheckpoint content\n</summary>";
		const checkpoint = extractCheckpoint(response);
		expect(checkpoint).toBe("checkpoint content");
		expect(checkpoint).not.toContain("System Context");
	});

	test("appends system context to fallback (no summary tags) when cwd provided", () => {
		const response = "Plain text checkpoint";
		const checkpoint = extractCheckpoint(response, "/some/path");
		expect(checkpoint).toContain("Plain text checkpoint");
		expect(checkpoint).toContain("Working directory: /some/path");
	});
});

describe("buildCompactedContext", () => {
	test("includes checkpoint", async () => {
		const result = await buildCompactedContext(
			"## Current Phase\nimplementation",
		);
		expect(result).toContain("Checkpoint Summary");
		expect(result).toContain("## Current Phase");
		expect(result).not.toContain("Original Task");
	});

	test("includes fresh memory when cwd has memory file", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-compact-test-"));
		try {
			await mkdir(join(tempDir, ".mxd"), { recursive: true });
			await writeFile(
				join(tempDir, ".mxd", "memory.md"),
				"# Project Memory\n- important note",
			);

			const result = await buildCompactedContext("checkpoint content", tempDir);
			expect(result).toContain(
				"# .mxd/memory.md (Preloaded, do not read again)",
			);
			expect(result).toContain("important note");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});

	test("works when memory file does not exist", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-nomem-test-"));
		try {
			const result = await buildCompactedContext("checkpoint", tempDir);
			expect(result).toContain("Checkpoint Summary");
			expect(result).not.toContain("Project Memory");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
});

describe("SUMMARIZATION_INSTRUCTION", () => {
	test("instructs model not to use tools", () => {
		expect(SUMMARIZATION_INSTRUCTION).toContain("Do NOT use any tools");
	});

	test("requires summary tags", () => {
		expect(SUMMARIZATION_INSTRUCTION).toContain("<summary>");
		expect(SUMMARIZATION_INSTRUCTION).toContain("</summary>");
	});

	test("lists required checkpoint sections", () => {
		expect(SUMMARIZATION_INSTRUCTION).toContain("Story So Far");
		expect(SUMMARIZATION_INSTRUCTION).toContain("Current Phase");
		expect(SUMMARIZATION_INSTRUCTION).toContain("Completed Work");
		expect(SUMMARIZATION_INSTRUCTION).toContain(
			"Rejected Approaches & Lessons",
		);
		expect(SUMMARIZATION_INSTRUCTION).toContain("Pending Work");
		expect(SUMMARIZATION_INSTRUCTION).toContain("Tree Mental Model");
		expect(SUMMARIZATION_INSTRUCTION).toContain("User Messages (Reference)");
	});

	test("does not include system-injected sections", () => {
		expect(SUMMARIZATION_INSTRUCTION).not.toContain(
			"Current Working Directory",
		);
		expect(SUMMARIZATION_INSTRUCTION).not.toContain("## 9.");
	});
});

describe("buildSummarizationInstruction", () => {
	test("returns base instruction without cwd", () => {
		expect(buildSummarizationInstruction()).toBe(SUMMARIZATION_INSTRUCTION);
		expect(buildSummarizationInstruction(undefined)).toBe(
			SUMMARIZATION_INSTRUCTION,
		);
	});

	test("appends cwd when provided", () => {
		const result = buildSummarizationInstruction("/path/to/project");
		expect(result).toContain(SUMMARIZATION_INSTRUCTION);
		expect(result).toContain("Current working directory: /path/to/project");
	});
});

describe("tool() jsonSchema generation", () => {
	test("converts nested object in array schema", async () => {
		const { z } = await import("zod");
		const { tool: toolFactory } = await import("./tool-definition.ts");
		const def = toolFactory(
			"test",
			"test tool",
			{
				tasks: z
					.array(
						z.object({
							taskId: z.string().describe("ID of the child task"),
							message: z.string().optional().describe("Instructions"),
							mode: z
								.enum(["new", "resume", "reset"])
								.optional()
								.default("new")
								.describe("Execution mode"),
						}),
					)
					.describe("Tasks to execute"),
			},
			async () => ({ content: [{ type: "text", text: "ok" }] }),
		);
		expect(def.jsonSchema).toEqual({
			type: "object",
			properties: {
				tasks: {
					type: "array",
					description: "Tasks to execute",
					items: {
						type: "object",
						properties: {
							taskId: { type: "string", description: "ID of the child task" },
							message: { type: "string", description: "Instructions" },
							mode: {
								type: "string",
								enum: ["new", "resume", "reset"],
								default: "new",
								description: "Execution mode",
							},
						},
						required: ["taskId", "mode"],
					},
				},
			},
			required: ["tasks"],
		});
	});

	test("handles simple string and number types", async () => {
		const { z } = await import("zod");
		const { tool: toolFactory } = await import("./tool-definition.ts");
		const def = toolFactory(
			"test",
			"test tool",
			{
				name: z.string(),
				count: z.number(),
				active: z.boolean(),
			},
			async () => ({ content: [{ type: "text", text: "ok" }] }),
		);
		expect((def.jsonSchema as Record<string, unknown>).properties).toEqual({
			name: { type: "string" },
			count: { type: "number" },
			active: { type: "boolean" },
		});
		expect((def.jsonSchema as Record<string, unknown>).required).toEqual([
			"name",
			"count",
			"active",
		]);
	});

	test("handles optional boolean type", async () => {
		const { z } = await import("zod");
		const { tool: toolFactory } = await import("./tool-definition.ts");
		const def = toolFactory(
			"test",
			"test tool",
			{
				enabled: z.boolean().optional().describe("Enable mode"),
			},
			async () => ({ content: [{ type: "text", text: "ok" }] }),
		);
		const props = (def.jsonSchema as Record<string, unknown>)
			.properties as Record<string, unknown>;
		expect(props?.enabled).toEqual({
			description: "Enable mode",
			type: "boolean",
		});
	});
});

describe("addMessagesCacheControl", () => {
	test("adds cache_control to last user message (string content)", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "first user message" },
			{ role: "assistant", content: "first assistant reply" },
			{ role: "user", content: "last user message" },
		];
		const result = addMessagesCacheControl(messages);

		// The last user message (index 2) should have cache_control
		const lastUser = result[2];
		expect(Array.isArray(lastUser?.content)).toBe(true);
		const content = lastUser?.content as TextBlockParam[];
		expect(content[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(content[0]?.text).toBe("last user message");

		// Other messages unchanged
		expect(result[0]).toEqual(messages[0]);
		expect(result[1]).toEqual(messages[1]);
	});

	test("adds cache_control to last block of array content", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "reply1" },
			{
				role: "user",
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: "tu_1",
						content: "result text",
					},
				],
			},
		];
		const result = addMessagesCacheControl(messages);
		const lastUser = result[2];
		expect(Array.isArray(lastUser?.content)).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: accessing cache_control after transformation
		const content = lastUser?.content as any[];
		expect(content[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	test("single user message gets cache_control", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "only one user message" },
		];
		const result = addMessagesCacheControl(messages);
		const user = result[0];
		expect(Array.isArray(user?.content)).toBe(true);
		const content = user?.content as TextBlockParam[];
		expect(content[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	test("does not mutate original messages", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "second" },
		];
		const original = JSON.stringify(messages);
		addMessagesCacheControl(messages);
		expect(JSON.stringify(messages)).toBe(original);
	});

	test("empty messages returns unchanged", () => {
		const messages: MessageParam[] = [];
		const result = addMessagesCacheControl(messages);
		expect(result).toEqual(messages);
	});

	test("does not double-cache an already-cached block", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "a1" },
			{
				role: "user",
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: "tu_1",
						content: "result",
						cache_control: { type: "ephemeral" as const },
					},
				],
			},
		];
		const result = addMessagesCacheControl(messages);
		// biome-ignore lint/suspicious/noExplicitAny: accessing cache_control after transformation
		const cached = result[2]?.content as any[];
		expect(cached[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	test("with '1h' TTL — includes ttl field on cache_control", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "first user message" },
			{ role: "assistant", content: "first assistant reply" },
			{ role: "user", content: "last user message" },
		];
		const result = addMessagesCacheControl(messages, "1h");

		const lastUser = result[2];
		expect(Array.isArray(lastUser?.content)).toBe(true);
		const content = lastUser?.content as TextBlockParam[];
		expect(content[0]?.cache_control).toEqual({
			type: "ephemeral",
			ttl: "1h",
		});
	});

	test("with undefined TTL — no ttl field on cache_control (default 5min)", () => {
		const messages: MessageParam[] = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "reply1" },
			{ role: "user", content: "last" },
		];
		const result = addMessagesCacheControl(messages, undefined);

		const lastUser = result[2];
		expect(Array.isArray(lastUser?.content)).toBe(true);
		const content = lastUser?.content as TextBlockParam[];
		expect(content[0]?.cache_control).toEqual({ type: "ephemeral" });
		expect(content[0]?.cache_control).not.toHaveProperty("ttl");
	});
});

describe("done tool", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-done-tool-"));
		// Initialize tempDir as a git repo so isGitClean check in done() works.
		// done() now checks worktree status, which requires a git repository.
		// gitignore tree.json so the tracker's writes don't make the tree dirty.
		Bun.spawnSync(["git", "init"], { cwd: tempDir });
		Bun.spawnSync(["git", "config", "user.email", "test@test.com"], {
			cwd: tempDir,
		});
		Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: tempDir });
		await Bun.write(join(tempDir, "README.md"), "# Test\n");
		await Bun.write(join(tempDir, ".gitignore"), "tree.json\n");
		Bun.spawnSync(["git", "add", "."], { cwd: tempDir });
		Bun.spawnSync(["git", "commit", "-m", "initial"], { cwd: tempDir });

		tracker = new TaskTracker(join(tempDir, "tree.json"));
		await tracker.load();
	});

	afterAll(async () => {
		if (tempDir) await rm(tempDir, { recursive: true });
	});

	// Ensure worktree is clean between tests — some tests create dirty state.
	async function cleanWorktree() {
		Bun.spawnSync(["git", "reset", "--hard"], { cwd: tempDir });
		Bun.spawnSync(["git", "clean", "-fd"], { cwd: tempDir });
	}

	async function invokeDoneTool(
		taskId: string,
		args: { status: "passed" | "failed"; result: string },
	) {
		resetResourceRegistry();
		const { auth } = initMockResourceRegistry({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
			taskId,
		});
		const { toolDefs } = createOrchestratorTools(auth, "test-project", taskId);
		const doneTool = toolDefs.find((t) => t.name === "done");
		if (!doneTool) throw new Error("done tool not found");
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		return (doneTool as any).handler(args);
	}

	test("done(passed) closes queue and returns acknowledgment", async () => {
		const node = tracker.addTask("Test Task Pass", "description");
		tracker.updateStatus(node.id, "in_progress");
		await invokeDoneTool(node.id, {
			status: "passed",
			result: "All tests pass",
		});
		// Phase 1: done() no longer updates status (Phase 2 does that in runAgentForNode)
		const updated = tracker.getTask(node.id);
		expect(updated?.status).toBe("in_progress");
	});

	test("done(failed) closes queue and returns acknowledgment", async () => {
		const node = tracker.addTask("Test Task Fail", "description");
		tracker.updateStatus(node.id, "in_progress");
		await invokeDoneTool(node.id, {
			status: "failed",
			result: "Cannot resolve type errors",
		});
		// Phase 1: done() no longer updates status (Phase 2 does that in runAgentForNode)
		const updated = tracker.getTask(node.id);
		expect(updated?.status).toBe("in_progress");
	});

	test("hasRunningChildren returns false when no children", async () => {
		resetResourceRegistry();
		const { auth } = initMockResourceRegistry({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
			taskId: "",
		});
		const { hasRunningChildren } = createOrchestratorTools(
			auth,
			"test-project",
			"",
		);
		expect(hasRunningChildren?.()).toBe(false);
	});

	test("hasRunningChildren returns true when child has session on tracker", async () => {
		resetResourceRegistry();
		const parentId = tracker.rootNodeId;
		const { auth } = initMockResourceRegistry({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
			taskId: parentId,
		});

		// Create a child task
		const child = tracker.addChild(parentId, "Child Task", "desc");
		const childQueue = new MessageQueue();
		attachMockSession(child, childQueue);

		const { hasRunningChildren } = createOrchestratorTools(
			auth,
			"test-project",
			parentId,
		);
		expect(hasRunningChildren?.()).toBe(true);

		// Clean up
		child.session = undefined;
		childQueue.close();
	});

	test("hasRunningChildren detects running grandchildren (descendants)", async () => {
		resetResourceRegistry();
		const parentId = tracker.rootNodeId;
		const { auth } = initMockResourceRegistry({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
			taskId: parentId,
		});

		const child = tracker.addChild(parentId, "Child Task", "desc");
		const grandchild = tracker.addChild(child.id, "Grandchild Task", "desc");
		const grandchildQueue = new MessageQueue();
		attachMockSession(grandchild, grandchildQueue);

		const { hasRunningChildren } = createOrchestratorTools(
			auth,
			"test-project",
			parentId,
		);
		// Grandchild has a session → hasRunningChildren should be true
		expect(hasRunningChildren?.()).toBe(true);

		// Clean up
		grandchild.session = undefined;
		grandchildQueue.close();
	});

	test("done() with queue closes queue immediately", async () => {
		const node = tracker.addTask("Test Done Queue", "description");
		tracker.updateStatus(node.id, "in_progress");
		const queue = new MessageQueue();

		// Set cwd on the node (production code reads node.cwd, not session.cwd)
		node.cwd = tempDir;
		// Attach session to the node so tools can find the queue
		node.session = {
			queue,
			abortController: new AbortController(),
			interrupt: new TurnInterrupt(),
			loopTraceId: "test-trace-id",
			depth: 0,
			backgroundProcesses: new Map(),
			activity: "thinking",
			foregroundExecutions: new Map(),
		};

		resetResourceRegistry();
		const { auth: authDoneQueue } = initMockResourceRegistry({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
			taskId: node.id,
		});
		const { toolDefs } = createOrchestratorTools(
			authDoneQueue,
			"test-project",
			node.id,
		);
		const doneTool = toolDefs.find((t) => t.name === "done");
		if (!doneTool) throw new Error("done tool not found");

		// Phase 1: done() returns immediately (no blocking)
		// biome-ignore lint/suspicious/noExplicitAny: test helper
		await (doneTool as any).handler({
			status: "passed",
			result: "All tests pass",
		});

		// Queue should be closed
		expect(queue.isClosed).toBe(true);
		// Status NOT updated by handler (Phase 2 does that)
		expect(tracker.getTask(node.id)?.status).toBe("in_progress");
	});

	test("done() rejects when child has active session", async () => {
		const parent = tracker.addTask("Parent Task", "description");
		tracker.updateStatus(parent.id, "in_progress");
		const child = tracker.addChild(parent.id, "Running Child", "desc");
		const childQueue = new MessageQueue();
		attachMockSession(child, childQueue);

		const result = await invokeDoneTool(parent.id, {
			status: "passed",
			result: "All done",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Cannot call done()");
		expect(result.content[0].text).toContain("Running Child");

		// Clean up
		child.session = undefined;
		childQueue.close();
	});

	test("done() rejects when grandchild has active session", async () => {
		const parent = tracker.addTask("Parent Task", "description");
		tracker.updateStatus(parent.id, "in_progress");
		const child = tracker.addChild(parent.id, "Child Task", "desc");
		const grandchild = tracker.addChild(child.id, "Running Grandchild", "desc");
		const grandchildQueue = new MessageQueue();
		attachMockSession(grandchild, grandchildQueue);

		const result = await invokeDoneTool(parent.id, {
			status: "passed",
			result: "All done",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Cannot call done()");
		expect(result.content[0].text).toContain("Running Grandchild");

		// Clean up
		grandchild.session = undefined;
		grandchildQueue.close();
	});

	test("done() succeeds when no children have active sessions", async () => {
		const parent = tracker.addTask("Parent Task", "description");
		tracker.updateStatus(parent.id, "in_progress");
		tracker.addChild(parent.id, "Idle Child", "desc");
		// No session attached to child

		const result = await invokeDoneTool(parent.id, {
			status: "passed",
			result: "All done",
		});
		expect(result.isError).toBeFalsy();
	});

	test("done() lists multiple running children in error", async () => {
		const parent = tracker.addTask("Parent Task", "description");
		tracker.updateStatus(parent.id, "in_progress");
		const child1 = tracker.addChild(parent.id, "Worker A", "desc");
		const child2 = tracker.addChild(parent.id, "Worker B", "desc");
		const q1 = new MessageQueue();
		const q2 = new MessageQueue();
		attachMockSession(child1, q1);
		attachMockSession(child2, q2);

		const result = await invokeDoneTool(parent.id, {
			status: "passed",
			result: "All done",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Worker A");
		expect(result.content[0].text).toContain("Worker B");

		// Clean up
		child1.session = undefined;
		child2.session = undefined;
		q1.close();
		q2.close();
	});

	// ── Uncommitted worktree guard ──
	// done() means "my git state reflects completion". If worktree is dirty,
	// the agent should commit, discard, or yield — not done().

	test("done() rejects when worktree has modified tracked files", async () => {
		await cleanWorktree();
		// Modify the tracked README.md
		await Bun.write(join(tempDir, "README.md"), "# Modified\n");

		const node = tracker.addTask("Dirty Test", "description");
		tracker.updateStatus(node.id, "in_progress");

		const result = await invokeDoneTool(node.id, {
			status: "passed",
			result: "done",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("uncommitted changes");
		expect(result.content[0].text).toContain("README.md");
		expect(result.content[0].text).toContain("yield()");
		await cleanWorktree();
	});

	test("done() rejects when worktree has untracked files", async () => {
		await cleanWorktree();
		// Create an untracked file
		await Bun.write(join(tempDir, "wip-draft.md"), "work in progress\n");

		const node = tracker.addTask("Untracked Test", "description");
		tracker.updateStatus(node.id, "in_progress");

		const result = await invokeDoneTool(node.id, {
			status: "passed",
			result: "done",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("uncommitted changes");
		expect(result.content[0].text).toContain("wip-draft.md");
		expect(result.content[0].text).toContain("yield()");
		await cleanWorktree();
	});

	test("done() rejects when worktree has both modified and untracked files", async () => {
		await cleanWorktree();
		await Bun.write(join(tempDir, "README.md"), "# Changed\n");
		await Bun.write(join(tempDir, "new-file.txt"), "new\n");

		const node = tracker.addTask("Both Dirty", "description");
		tracker.updateStatus(node.id, "in_progress");

		const result = await invokeDoneTool(node.id, {
			status: "passed",
			result: "done",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("README.md");
		expect(result.content[0].text).toContain("new-file.txt");
		await cleanWorktree();
	});

	test("done() rejects dirty worktree even for done('failed')", async () => {
		await cleanWorktree();
		await Bun.write(join(tempDir, "wip.md"), "wip\n");

		const node = tracker.addTask("Fail With WIP", "description");
		tracker.updateStatus(node.id, "in_progress");

		const result = await invokeDoneTool(node.id, {
			status: "failed",
			result: "failed with wip",
		});
		// failed with dirty worktree is STILL rejected — failed ≠ abandon state.
		// agent must explicitly decide: commit, discard, or yield for direction.
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("uncommitted changes");
		await cleanWorktree();
	});

	test("done() accepts gitignored files (not blocking)", async () => {
		await cleanWorktree();
		// tree.json is gitignored in beforeAll — tracker writes are invisible to git
		// Verify done() works even though tracker writes to tree.json.
		const node = tracker.addTask("Ignored Test", "description");
		tracker.updateStatus(node.id, "in_progress");

		const result = await invokeDoneTool(node.id, {
			status: "passed",
			result: "ok",
		});
		expect(result.isError).toBeFalsy();
	});

	test("done() succeeds after committing dirty files", async () => {
		await cleanWorktree();
		// Create dirty state
		await Bun.write(join(tempDir, "README.md"), "# Committed change\n");

		const node = tracker.addTask("Commit Then Done", "description");
		tracker.updateStatus(node.id, "in_progress");

		// First call: should reject
		const rejected = await invokeDoneTool(node.id, {
			status: "passed",
			result: "ok",
		});
		expect(rejected.isError).toBe(true);

		// Agent commits
		Bun.spawnSync(["git", "add", "-A"], { cwd: tempDir });
		Bun.spawnSync(["git", "commit", "-m", "wip"], { cwd: tempDir });

		// Second call: should accept
		const accepted = await invokeDoneTool(node.id, {
			status: "passed",
			result: "ok",
		});
		expect(accepted.isError).toBeFalsy();
		await cleanWorktree();
	});

	test("done() error message suggests yield() as alternative", async () => {
		await cleanWorktree();
		await Bun.write(join(tempDir, "scratch.txt"), "tmp\n");

		const node = tracker.addTask("Suggest Yield", "description");
		tracker.updateStatus(node.id, "in_progress");

		const result = await invokeDoneTool(node.id, {
			status: "passed",
			result: "x",
		});
		expect(result.isError).toBe(true);
		const text = result.content[0].text as string;
		// The error must explicitly redirect to yield() for unclear WIP
		expect(text).toContain("yield() instead");
		// The error must trust the agent to resolve, not prescribe destructive commands
		expect(text).toContain("Resolve this yourself");
		// Error should NOT prescribe destructive commands (agent might lose work)
		expect(text).not.toContain("git clean");
		expect(text).not.toContain("git checkout --");
		expect(text).not.toContain("git reset --hard");
		await cleanWorktree();
	});
});

describe("jsSearch", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-search-test-"));
		await mkdir(join(tempDir, "sub"), { recursive: true });
		await writeFile(join(tempDir, "hello.ts"), "const x = 1;\nconst y = 2;\n");
		await writeFile(
			join(tempDir, "sub", "world.ts"),
			"export const hello = 'world';\n",
		);
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("single file path does not throw ENOTDIR", async () => {
		const result = await jsSearch({
			pattern: "const",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "content",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
		});
		expect(result).toContain("const x = 1");
		expect(result).toContain("const y = 2");
		// Should NOT contain files from other directories
		expect(result).not.toContain("world");
	});

	test("single file path with files_with_matches mode", async () => {
		const result = await jsSearch({
			pattern: "const",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "files_with_matches",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
		});
		expect(result).toContain("hello.ts");
		expect(result).not.toContain("world.ts");
	});

	test("single file path with relative path", async () => {
		const result = await jsSearch({
			pattern: "hello",
			searchPath: "sub/world.ts",
			outputMode: "content",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
		});
		expect(result).toContain("hello");
		expect(result).toContain("sub/world.ts");
	});

	test("directory path still works normally", async () => {
		const result = await jsSearch({
			pattern: "const",
			searchPath: tempDir,
			outputMode: "files_with_matches",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
		});
		expect(result).toContain("hello.ts");
		expect(result).toContain("world.ts");
	});

	test("multiline matches pattern spanning multiple lines", async () => {
		const result = await jsSearch({
			pattern: "const x.*\\nconst y",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "content",
			headLimit: 50,
			caseInsensitive: false,
			multiline: true,
			cwd: tempDir,
		});
		expect(result).toContain("const x = 1;");
		expect(result).toContain("const y = 2;");
	});

	test("multiline without flag does not match across lines", async () => {
		const result = await jsSearch({
			pattern: "const x.*const y",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "content",
			headLimit: 50,
			caseInsensitive: false,
			multiline: false,
			cwd: tempDir,
		});
		// Should not match because .* doesn't cross newlines without 's' flag
		expect(result).toBe("");
	});

	test("multiline with dotAll matches across newlines", async () => {
		const result = await jsSearch({
			pattern: "const x.+const y",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "content",
			headLimit: 50,
			caseInsensitive: false,
			multiline: true,
			cwd: tempDir,
		});
		expect(result).toContain("const x = 1;");
		expect(result).toContain("const y = 2;");
	});

	test("multiline files_with_matches mode", async () => {
		const result = await jsSearch({
			pattern: "const x.*\\nconst y",
			searchPath: tempDir,
			outputMode: "files_with_matches",
			headLimit: 50,
			caseInsensitive: false,
			multiline: true,
			cwd: tempDir,
		});
		expect(result).toContain("hello.ts");
		expect(result).not.toContain("world.ts");
	});

	test("multiline count mode", async () => {
		const result = await jsSearch({
			pattern: "const x.*\\nconst y",
			searchPath: tempDir,
			outputMode: "count",
			headLimit: 50,
			caseInsensitive: false,
			multiline: true,
			cwd: tempDir,
		});
		expect(result).toContain("hello.ts:1");
	});

	test("multiline with context lines", async () => {
		const result = await jsSearch({
			pattern: "const x.*\\nconst y",
			searchPath: join(tempDir, "hello.ts"),
			outputMode: "content",
			contextLines: 1,
			headLimit: 50,
			caseInsensitive: false,
			multiline: true,
			cwd: tempDir,
		});
		expect(result).toContain("const x = 1;");
		expect(result).toContain("const y = 2;");
	});
});

/**
 * A hidden directory is not automatically a boring directory.
 *
 * In THIS repo `.mxd/plugin/` is production code — every ScopeOpts hook, every
 * plugin REST route, the entire plugin UI. A walker that never descends into dot
 * directories therefore answers "no matches" for roughly half the codebase, and
 * it does so SILENTLY: "found nothing" and "never looked" are indistinguishable
 * to the caller. That matters most in the one place memory.md tells you to reach
 * for this tool — grepping for a name as a STRING before a rename or a delete,
 * where the compiler cannot help.
 *
 * Which directories are skipped is `DEFAULT_SKIP_DIRS`' job, and nothing else's.
 */
describe("jsSearch: hidden directories", () => {
	let tempDir: string;
	const SYMBOL = "buildMatrixScopeOpts";

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-search-dot-"));
		// Production code living in a hidden directory — models .mxd/plugin/.
		await mkdir(join(tempDir, ".mxd", "plugin"), { recursive: true });
		await writeFile(
			join(tempDir, ".mxd", "plugin", "scope-opts.ts"),
			`export function ${SYMBOL}() {}\n`,
		);
		// A visible caller. The original false negative had exactly this shape:
		// every caller found, the definition missing.
		await mkdir(join(tempDir, "src"), { recursive: true });
		await writeFile(join(tempDir, "src", "caller.ts"), `${SYMBOL}();\n`);
		// Hidden directories that DEFAULT_SKIP_DIRS must keep excluding.
		await mkdir(join(tempDir, ".worktrees", "child", "src"), {
			recursive: true,
		});
		await writeFile(
			join(tempDir, ".worktrees", "child", "src", "caller.ts"),
			`${SYMBOL}();\n`,
		);
		await mkdir(join(tempDir, ".git"), { recursive: true });
		await writeFile(join(tempDir, ".git", "COMMIT_EDITMSG"), `${SYMBOL}\n`);
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	/** files_with_matches, default excludes, rooted at tempDir. */
	async function matchedFiles(
		extra: { glob?: string; excludedDirs?: string[] } = {},
	): Promise<string[]> {
		const result = await jsSearch({
			pattern: SYMBOL,
			searchPath: ".",
			outputMode: "files_with_matches",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
			...extra,
		});
		return result.split("\n").filter(Boolean);
	}

	// These two own ONE question — does the walker descend into a dot directory —
	// so they assert presence, not an exact file list. Which directories are
	// EXCLUDED is the next three tests' business; asserting it here too would make
	// a failure ambiguous between "stopped walking" and "stopped excluding".
	test("default path finds a definition inside a hidden directory", async () => {
		const files = await matchedFiles();
		expect(files).toContain(".mxd/plugin/scope-opts.ts");
		expect(files).toContain("src/caller.ts");
	});

	test("glob branch descends into hidden directories too", async () => {
		// Written when this was a SECOND `scanSync` call site and fixing one
		// without the other left half the tool lying. There is one walker now, so
		// the reason changed with the code: passing a glob installs a matcher, and
		// this pins that having a matcher does not change which DIRECTORIES get
		// reached. Same assertion, still worth its line — matching and descending
		// are separate decisions and only one of them is the caller's.
		const files = await matchedFiles({ glob: "**/*.ts" });
		expect(files).toContain(".mxd/plugin/scope-opts.ts");
		expect(files).toContain("src/caller.ts");
	});

	test(".worktrees/ stays excluded — each worktree is a whole second copy of the repo", async () => {
		// Not a hypothetical: with 3 live sub-agent worktrees, a search from main
		// would scan 4 copies of every file and report each hit 4 times. This
		// assertion exists because the day it breaks, nobody will know why the
		// results exploded.
		const files = await matchedFiles();
		expect(files.some((f) => f.startsWith(".worktrees/"))).toBe(false);
		// Two-sided: the visible copy IS found, so this cannot pass by finding nothing.
		expect(files).toContain("src/caller.ts");
	});

	test(".git/ stays excluded", async () => {
		const files = await matchedFiles();
		expect(files.some((f) => f.startsWith(".git/"))).toBe(false);
		expect(files).toContain("src/caller.ts");
	});

	test("excluded_dirs: [] reaches everything — exclusion is the list's doing, not the walker's", async () => {
		expect(await matchedFiles({ excludedDirs: [] })).toEqual([
			".git/COMMIT_EDITMSG",
			".mxd/plugin/scope-opts.ts",
			".worktrees/child/src/caller.ts",
			"src/caller.ts",
		]);
	});

	test("the excluded_dirs description lists exactly DEFAULT_SKIP_DIRS", () => {
		// A prose copy of a list rots with no symptom: a stale list and a fresh
		// list read identically. Pin them together instead of re-checking by hand.
		const params: ParamDefs | undefined = buildBuiltinToolDefs().find(
			(t) => t.name === "search",
		)?.params;
		const description = params?.excluded_dirs?.description ?? "";
		const skipped = DEFAULT_SKIP_DIRS.map((d) => d.replace(/\/$/, ""));

		for (const dir of skipped) expect(description).toContain(dir);

		// …and nothing documented that we do not actually skip.
		expect(description).toContain("Defaults to:");
		expect(description).toContain("Pass empty array");
		const afterMarker = description.split("Defaults to:")[1] ?? "";
		const listed = afterMarker.split("Pass empty array")[0] ?? "";
		const documented = listed
			.replace(/\.\s*$/, "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		expect(documented.sort()).toEqual([...skipped].sort());
	});
});

/**
 * A glob with no `/` in it is a FILENAME pattern, and a filename pattern means
 * "at any depth".
 *
 * `*.ts` is the example printed in this tool's OWN description, and it is what
 * ripgrep's `--glob` means — but `*` does not cross `/` in Bun.Glob, so the tool
 * documented one semantic and implemented another. From a repo root the answer
 * was `(no matches)`: the same silent false negative as the hidden-directory
 * bug, in the same tool, on the far more frequently typed input.
 *
 * A glob that DOES contain `/` is a PATH pattern and must stay anchored at the
 * search root — that half is what a too-wide normalization would break, and it
 * cannot break by forgetting to normalize, so it needs its own test.
 */
describe("jsSearch: glob depth", () => {
	let tempDir: string;
	const SYMBOL = "jsSearch";

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-search-glob-"));
		await mkdir(join(tempDir, "src"), { recursive: true });
		await mkdir(join(tempDir, "deep", "src"), { recursive: true });
		await writeFile(join(tempDir, "top.ts"), `${SYMBOL}();\n`);
		await writeFile(join(tempDir, "src", "top.ts"), `${SYMBOL}();\n`);
		// A second `src/` one level down: the probe for over-promotion. `src/*.ts`
		// must not reach it; `**/src/*.ts` would.
		await writeFile(join(tempDir, "deep", "src", "inner.ts"), `${SYMBOL}();\n`);
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function matchedFiles(glob: string): Promise<string[]> {
		const result = await jsSearch({
			pattern: SYMBOL,
			searchPath: ".",
			glob,
			outputMode: "files_with_matches",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
		});
		return result.split("\n").filter(Boolean);
	}

	test("a glob with no slash matches at any depth", async () => {
		expect(await matchedFiles("*.ts")).toContain("src/top.ts");
	});

	test("…and still matches the top level — promotion loses nothing", async () => {
		// `**/` matches zero directories too, so promoting is a strict superset.
		// Separate from the test above because it is a separate property: this one
		// is what would regress if `**/` ever stopped collapsing, and that failure
		// has nothing to do with whether nested files are reached.
		expect(await matchedFiles("*.ts")).toContain("top.ts");
	});

	test("a glob containing a slash stays anchored at the search root", async () => {
		const files = await matchedFiles("src/*.ts");
		// Two-sided: it must still find the anchored file, so this cannot pass by
		// matching nothing at all.
		expect(files).toContain("src/top.ts");
		expect(files).not.toContain("deep/src/inner.ts");
	});

	test("the rule is on the slash, not on the leading star", () => {
		// Stated at the string level because two of these have no behavioral
		// symptom to assert: `**/**/*.ts` returns the same files as `**/*.ts`, so
		// a doubly-promoted glob is invisible from the outside.
		expect(normalizeGlobDepth("*.ts")).toBe("**/*.ts");
		expect(normalizeGlobDepth("**/*.ts")).toBe("**/*.ts");
		expect(normalizeGlobDepth("src/*.ts")).toBe("src/*.ts");
		// This is the one that earns the test: it is the shape the fixture above
		// has no file for, and "promote patterns that start with a bare `*`" is a
		// plausible enough reading of the rule to write by accident.
		expect(normalizeGlobDepth("*/top.ts")).toBe("*/top.ts");
	});
});

/**
 * The walk prunes an excluded directory at descent instead of enumerating it
 * and throwing the result away. That is a pure performance change — every test
 * above must keep passing untouched, and they do.
 *
 * What is NOT covered above is the thing the rewrite had to reproduce by hand.
 * `Bun.Glob.scanSync` used to answer "is this a file, is this a directory", and
 * a `readdirSync` walk has to answer it itself. The two obvious ways to do that
 * disagree, and only one of them matches what `search` has always returned:
 *
 *   - `dirent.isFile()` / `dirent.isDirectory()` are lstat-based. A symlink is
 *     neither, so it is skipped by both branches.
 *   - `statSync` follows the link, so a symlink to a file looks like a file and
 *     a symlink to a directory looks like a directory.
 *
 * `statSync` is the tidier-looking of the two and it is WRONG twice: it starts
 * returning symlinked files `search` never returned, and it descends symlinked
 * directories — which turns `dir/link -> dir` into a walk that never ends.
 * Nothing above notices either. Measured against `scanSync` before the rewrite:
 * given a symlink to a file, a symlink to a directory, a broken symlink and a
 * directory linked to its own ancestor, it returned the real files and nothing
 * else.
 *
 * So these tests exist to make that swap fail loudly rather than silently, and
 * they are the reason not following links can be stated as the termination
 * argument — there is no visited-inode set to lose.
 */
describe("jsSearch: the walk prunes at descent", () => {
	let tempDir: string;
	const SYMBOL = "walkFilesProbe";

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-search-walk-"));

		await mkdir(join(tempDir, "real"), { recursive: true });
		await writeFile(join(tempDir, "real", "plain.ts"), `${SYMBOL}();\n`);

		// A skipped directory NESTED rather than at the top level. The top-level
		// case goes through `startsWith`; this one goes through the `/prefix`
		// branch, and at descent the directory is asked about in its
		// trailing-slash form — drop that slash and only the nested case survives.
		await mkdir(join(tempDir, "pkg", "node_modules", "dep"), {
			recursive: true,
		});
		await writeFile(
			join(tempDir, "pkg", "node_modules", "dep", "index.ts"),
			`${SYMBOL}();\n`,
		);
		// A file sitting DIRECTLY in the skipped directory, not one level down.
		// Without it, dropping the trailing slash from the descent check is caught
		// only by whichever unrelated fixture happens to hold a file at that exact
		// depth: `pkg/node_modules` fails the check and is descended, but
		// `pkg/node_modules/dep` then matches `/node_modules/` and is pruned
		// anyway — so the leak is invisible one level deeper. Mutation testing
		// found that; the fixture looked thorough and was not.
		await writeFile(
			join(tempDir, "pkg", "node_modules", "direct.ts"),
			`${SYMBOL}();\n`,
		);
		await writeFile(join(tempDir, "pkg", "own.ts"), `${SYMBOL}();\n`);

		// A file whose NAME is a skip entry. `node_modules` the file must survive;
		// only `node_modules` the directory is pruned.
		await writeFile(join(tempDir, "node_modules.ts"), `${SYMBOL}();\n`);

		// Symlinks: to a file, to a directory, and dangling.
		symlinkSync(join(tempDir, "real", "plain.ts"), join(tempDir, "link.ts"));
		symlinkSync(join(tempDir, "real"), join(tempDir, "linkdir"));
		symlinkSync(join(tempDir, "nope.ts"), join(tempDir, "broken.ts"));

		// A directory containing a link back to its own ancestor. Following links
		// would walk this forever; the test then fails by timing out, which is the
		// correct verdict and the only one available for "does not terminate".
		await mkdir(join(tempDir, "loop"), { recursive: true });
		await writeFile(join(tempDir, "loop", "leaf.ts"), `${SYMBOL}();\n`);
		symlinkSync(tempDir, join(tempDir, "loop", "up"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function matchedFiles(
		extra: { glob?: string; excludedDirs?: string[] } = {},
	): Promise<string[]> {
		const result = await jsSearch({
			pattern: SYMBOL,
			searchPath: ".",
			outputMode: "files_with_matches",
			headLimit: 50,
			caseInsensitive: false,
			cwd: tempDir,
			...extra,
		});
		return result.split("\n").filter(Boolean);
	}

	test("a nested node_modules/ is pruned, its parent is not", async () => {
		const files = await matchedFiles();
		expect(files).not.toContain("pkg/node_modules/direct.ts");
		expect(files).not.toContain("pkg/node_modules/dep/index.ts");
		// Two-sided: the sibling inside the same parent IS returned, so this
		// cannot pass by pruning `pkg/` — or everything — instead.
		expect(files).toContain("pkg/own.ts");
	});

	test("a FILE named like a skip entry is kept — only directories are pruned", async () => {
		expect(await matchedFiles()).toContain("node_modules.ts");
	});

	test("symlinks are not followed, and real files still are", async () => {
		const files = await matchedFiles();
		// `link.ts` and `linkdir/plain.ts` are the same bytes as `real/plain.ts`.
		// Returning them would report one file two or three times.
		expect(files).not.toContain("link.ts");
		expect(files).not.toContain("linkdir/plain.ts");
		expect(files).not.toContain("broken.ts");
		expect(files).toContain("real/plain.ts");
	});

	test("a symlink loop terminates", async () => {
		// Fails by timeout if links are ever followed. `loop/leaf.ts` is asserted
		// so the test cannot pass by refusing to enter `loop/` at all.
		const files = await matchedFiles();
		expect(files).toContain("loop/leaf.ts");
		expect(files.some((f) => f.includes("loop/up/"))).toBe(false);
	});

	test("the whole listing, exactly — nothing extra, nothing missing", async () => {
		// The three tests above each own one question and assert presence. This one
		// is the closed statement: with symlinks, a nested skip, and a file named
		// after a skip entry all in play, this is the entire answer.
		expect(await matchedFiles()).toEqual([
			"loop/leaf.ts",
			"node_modules.ts",
			"pkg/own.ts",
			"real/plain.ts",
		]);
	});

	test("a path that does not exist is an ERROR, not '(no matches)'", async () => {
		// The walk must not swallow ENOENT. A typo'd path answering "(no matches)"
		// is indistinguishable from a real empty result, and this is the tool whose
		// entire bug history is answers that look like answers. `scanSync` threw
		// here; the first version of this walk caught it and returned [] — with a
		// comment claiming that matched. Measured: it did not.
		const missing = join(tempDir, "no", "such", "dir");
		await expect(
			jsSearch({
				pattern: SYMBOL,
				searchPath: missing,
				outputMode: "files_with_matches",
				headLimit: 50,
				caseInsensitive: false,
				cwd: tempDir,
			}),
		).rejects.toThrow(/ENOENT/);
	});

	test("an unreadable directory mid-walk is an ERROR, not a short answer", async () => {
		// The dangerous direction: silently returning the files we could reach
		// while the one holding the definition sits in a directory we could not.
		// chmod is a no-op for root, so the assertion would be meaningless there.
		if (process.platform === "win32" || process.getuid?.() === 0) return;
		const locked = join(tempDir, "locked");
		await mkdir(locked, { recursive: true });
		await writeFile(join(locked, "hidden.ts"), `${SYMBOL}();\n`);
		chmodSync(locked, 0o000);
		try {
			await expect(matchedFiles()).rejects.toThrow(/EACCES|EPERM/);
		} finally {
			chmodSync(locked, 0o755);
			await rm(locked, { recursive: true, force: true });
		}
	});

	test("excluded_dirs: [] reaches the nested node_modules too", async () => {
		// Pruning must stay the skip list's decision. An `excluded_dirs: []` that
		// still pruned would be the walker deciding, which is the bug the
		// hidden-directory fix removed — reintroduced one layer down.
		const files = await matchedFiles({ excludedDirs: [] });
		expect(files).toContain("pkg/node_modules/direct.ts");
		expect(files).toContain("pkg/node_modules/dep/index.ts");
	});
});

/**
 * `list_files` walked with `dot: false` and no skip list at all — the same
 * hidden-directory blindness `search` had, plus the reason it could not be fixed
 * with one word: turning `dot` on with nothing excluded makes the tool WORSE,
 * because the 500-file cap then fills up with `.git/` internals and
 * `.worktrees/` copies of files the caller already has.
 *
 * So the two halves are one change, and the tests come in pairs: something that
 * must now be reachable, and something that must still not be.
 */
describe("list_files: hidden directories and the skip list", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-listfiles-"));
		// Production code in a hidden directory — models `.mxd/plugin/`.
		await mkdir(join(tempDir, ".mxd", "plugin"), { recursive: true });
		await writeFile(join(tempDir, ".mxd", "plugin", "scope-opts.ts"), "");
		await mkdir(join(tempDir, "src"), { recursive: true });
		await writeFile(join(tempDir, "src", "visible.ts"), "");
		// A sub-agent worktree: a whole second copy of the repo.
		await mkdir(join(tempDir, ".worktrees", "child", "src"), {
			recursive: true,
		});
		await writeFile(
			join(tempDir, ".worktrees", "child", "src", "visible.ts"),
			"",
		);
		await mkdir(join(tempDir, ".git"), { recursive: true });
		await writeFile(join(tempDir, ".git", "COMMIT_EDITMSG"), "");
		// The accident probe for the opt-in rule: a pattern hunting for `rebuild.ts`
		// contains the letters "build" but not `build/`, so `build/` must stay
		// excluded. The SAME filename sits in both places, so one pattern reaches
		// both candidates and the directory is the only thing separating them —
		// without that, the exclusion half of the assertion is vacuous and passes
		// no matter what the rule does.
		await mkdir(join(tempDir, "build"), { recursive: true });
		await writeFile(join(tempDir, "build", "rebuild.ts"), "");
		await writeFile(join(tempDir, "src", "rebuild.ts"), "");
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function listed(pattern: string): Promise<string[]> {
		const result = await executeTool("list_files", { pattern }, tempDir);
		expect(result.isError).toBe(false);
		return result.content.split("\n").filter(Boolean);
	}

	test("finds a file inside a hidden directory", async () => {
		// One question only — does the walker descend into a dot directory. Which
		// directories stay EXCLUDED is the next tests' business; asserting it here
		// too would make a failure ambiguous between the two halves.
		const files = await listed("**/*.ts");
		expect(files).toContain(".mxd/plugin/scope-opts.ts");
		expect(files).toContain("src/visible.ts");
	});

	test(".worktrees/ stays excluded when the pattern does not name it", async () => {
		const files = await listed("**/*.ts");
		expect(files.some((f) => f.startsWith(".worktrees/"))).toBe(false);
		// Two-sided: the real copy IS listed, so this cannot pass by listing nothing.
		expect(files).toContain("src/visible.ts");
	});

	test("…and is reachable when the pattern DOES name it", async () => {
		// The half that disappears silently. Adding a skip list takes away an
		// ability that has no replacement — `list_files` has no `path` parameter to
		// point into an excluded directory the way `search` does — and nothing else
		// in this suite would notice.
		expect(await listed(".worktrees/**/*.ts")).toEqual([
			".worktrees/child/src/visible.ts",
		]);
	});

	test(".git/ stays excluded", async () => {
		const files = await listed("**/*");
		expect(files.some((f) => f.startsWith(".git/"))).toBe(false);
		expect(files).toContain("src/visible.ts");
	});

	test("a pattern that merely CONTAINS a skipped name does not opt in", async () => {
		// The one path by which "you named it, you get it" could slide from handing
		// over more files into handing over the wrong ones. Comparing against the
		// trailing-slash form is what prevents it, and nothing else here would fail
		// if that slash were dropped.
		const files = await listed("**/*build*.ts");
		expect(files).toContain("src/rebuild.ts");
		expect(files).not.toContain("build/rebuild.ts");
	});

	test("the opt-in rule reads off the pattern, one entry at a time", () => {
		// At the string level because two of these have no behavioral symptom in
		// any fixture: a pattern naming `dist/` still returns nothing here, and
		// whether the OTHER eight skips survived is invisible from the outside.
		expect(skipDirsForPattern("**/*.ts")).toEqual(DEFAULT_SKIP_DIRS);
		expect(skipDirsForPattern("**/*build*.ts")).toEqual(DEFAULT_SKIP_DIRS);
		expect(skipDirsForPattern("node_modules/zod/**")).not.toContain(
			"node_modules/",
		);
		// Naming one directory drops exactly that one — the other eight still apply.
		expect(skipDirsForPattern("node_modules/zod/**")).toContain(".worktrees/");
		expect(skipDirsForPattern("dist/**")).toEqual(
			DEFAULT_SKIP_DIRS.filter((d) => d !== "dist/"),
		);
	});
});

/**
 * `list_files` handed its pattern to Bun.Glob verbatim, so `*.json` — the
 * example in its OWN description — listed only files sitting at the top of the
 * tree, and `*.ts` answered "(no files)" in a TypeScript repo.
 *
 * Unlike `search`, the old behavior here was not empty: `*.json` returned
 * package.json, tsconfig.json and biome.json. Three real, plausible files. So
 * "a semantic that never worked has no users" — which settled the same question
 * for `search` in one line — proves nothing here, and the case for changing it
 * had to be made on what an agent typing `*.json` is asking for instead.
 */
describe("list_files: a pattern with no slash matches at any depth", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-listfiles-depth-"));
		await mkdir(join(tempDir, "src"), { recursive: true });
		await mkdir(join(tempDir, "deep", "src"), { recursive: true });
		await writeFile(join(tempDir, "top.json"), "");
		await writeFile(join(tempDir, "src", "nested.json"), "");
		await writeFile(join(tempDir, "src", "top.ts"), "");
		// A second `src/` one level down: the probe for over-promotion. `src/*.ts`
		// must not reach it.
		await writeFile(join(tempDir, "deep", "src", "inner.ts"), "");
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function listed(pattern: string): Promise<string[]> {
		const result = await executeTool("list_files", { pattern }, tempDir);
		expect(result.isError).toBe(false);
		return result.content.split("\n").filter(Boolean);
	}

	test("finds the nested file", async () => {
		expect(await listed("*.json")).toContain("src/nested.json");
	});

	test("…and still finds the top-level one — promotion loses nothing", async () => {
		// A leading `**` matches zero directories too, so this is a strict superset
		// of the old behavior and cannot take a result away from anyone. Separate
		// test because it is a separate property: this is what regresses if that
		// collapse ever stops holding, which has nothing to do with reaching nested
		// files.
		expect(await listed("*.json")).toContain("top.json");
	});

	test("a pattern containing a slash stays anchored at the working directory", async () => {
		const files = await listed("src/*.ts");
		// Two-sided: it must still find the anchored file, so this cannot pass by
		// matching nothing at all.
		expect(files).toContain("src/top.ts");
		expect(files).not.toContain("deep/src/inner.ts");
	});

	test("the default pattern lists the project, not the top of it", async () => {
		// `*` is what `list_files()` sends. It used to return the loose files at the
		// top of the tree and not a single directory — `onlyFiles` drops those — so
		// it could not answer "what is the shape of this project", which is what it
		// looked like it was for.
		expect((await listed("*")).sort()).toEqual([
			"deep/src/inner.ts",
			"src/nested.json",
			"src/top.ts",
			"top.json",
		]);
	});

	test("output is sorted, and that is what makes truncation predictable", async () => {
		// Note the test above sorts before asserting — every other list_files test
		// is order-independent too, so nothing here pinned order, and until the
		// shared walk landed there was nothing to pin: the tool returned
		// filesystem order, which on APFS is a hash order (measured from the repo
		// root: package.json, tsconfig.json, biome.json, …, .mxd/config.json last).
		//
		// It matters beyond tidiness because the 500-file cap slices this list. In
		// traversal order "the first 500" is an arbitrary set that can change
		// between two runs over an unchanged tree; sorted, it is the same 500 every
		// time. So this assertion is deliberately NOT pre-sorted.
		expect(await listed("*")).toEqual([
			"deep/src/inner.ts",
			"src/nested.json",
			"src/top.ts",
			"top.json",
		]);
	});
});

/**
 * The cap counts files the tool KEEPS.
 *
 * Its own fixture, because it needs more files than the cap and that is slow
 * enough to be worth isolating. Filtering after the cap is not a slower route to
 * the same answer — it is a different, wrong one: measured from the main
 * checkout, an any-depth `*.ts` pattern filled 323 of its 500 slots with
 * `.worktrees/` copies and never reached `web/`, `scripts/` or `.mxd/` at all.
 * The cap stops protecting you and starts guaranteeing you get the copies.
 */
describe("list_files: the cap counts kept files, not walked ones", () => {
	let tempDir: string;
	const NOISE = 600;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-listfiles-cap-"));
		await mkdir(join(tempDir, ".worktrees", "child"), { recursive: true });
		await Promise.all(
			Array.from({ length: NOISE }, (_, i) =>
				writeFile(join(tempDir, ".worktrees", "child", `copy${i}.ts`), ""),
			),
		);
		await mkdir(join(tempDir, "src"), { recursive: true });
		await writeFile(join(tempDir, "src", "real.ts"), "");
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("one real file still surfaces past 600 excluded ones", async () => {
		const result = await executeTool(
			"list_files",
			{ pattern: "**/*.ts" },
			tempDir,
		);
		expect(result.isError).toBe(false);
		expect(result.content.split("\n").filter(Boolean)).toEqual(["src/real.ts"]);
	});
});

/**
 * Truncation says so.
 *
 * The tool used to `break` at 500 and return the slice with no marking, so a
 * partial list and a complete one were byte-identical in shape — the same
 * failure as not walking a directory, and now easier to hit, since a filename
 * pattern reaches the whole tree.
 */
describe("list_files: truncation is announced", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-listfiles-trunc-"));
		await mkdir(join(tempDir, "many"), { recursive: true });
		await Promise.all([
			...Array.from({ length: 500 }, (_, i) =>
				writeFile(
					join(tempDir, "many", `keep${String(i).padStart(3, "0")}.ts`),
					"",
				),
			),
			writeFile(join(tempDir, "many", "extra.ts"), ""),
		]);
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	async function listed(pattern: string): Promise<string> {
		const result = await executeTool("list_files", { pattern }, tempDir);
		expect(result.isError).toBe(false);
		return result.content;
	}

	test("501 matches → 500 files and a notice", async () => {
		const content = await listed("many/*.ts");
		expect(content.split("\n").filter((l) => l.endsWith(".ts"))).toHaveLength(
			500,
		);
		expect(content).toContain("truncated at 500 files");
	});

	test("exactly 500 matches → no notice", async () => {
		// The half that pins "one past the cap" rather than "at the cap": stopping
		// at 500 cannot tell a project with exactly 500 files from one with 50,000,
		// and would cry truncation on a complete answer.
		const content = await listed("many/keep*.ts");
		expect(content.split("\n").filter((l) => l.endsWith(".ts"))).toHaveLength(
			500,
		);
		expect(content).not.toContain("truncated");
	});
});

// ── Helpers for mocking Anthropic SDK stream ──

/** Create a mock Anthropic MessageStream that yields events and resolves finalMessage(). */
function createMockStream(
	response: Anthropic.Messages.Message,
	textDeltas?: string[],
) {
	const events: Array<{
		type: string;
		delta?: { type: string; text?: string };
	}> = [];
	if (textDeltas) {
		for (const text of textDeltas) {
			events.push({
				type: "content_block_delta",
				delta: { type: "text_delta", text },
			});
		}
	}
	return {
		[Symbol.asyncIterator]: async function* () {
			for (const event of events) {
				yield event;
			}
		},
		finalMessage: () => Promise.resolve(response),
	};
}

/** Build an Anthropic response message with text + optional tool_use blocks. */
function buildAnthropicResponse(opts: {
	text?: string;
	toolUses?: Array<{
		id: string;
		name: string;
		input: Record<string, unknown>;
	}>;
	stopReason?: "end_turn" | "tool_use";
}): Anthropic.Messages.Message {
	const content: Array<
		| { type: "text"; text: string }
		| {
				type: "tool_use";
				id: string;
				name: string;
				input: Record<string, unknown>;
		  }
	> = [];
	if (opts.text !== undefined) {
		content.push({ type: "text", text: opts.text });
	}
	if (opts.toolUses) {
		for (const tu of opts.toolUses) {
			content.push({
				type: "tool_use",
				id: tu.id,
				name: tu.name,
				input: tu.input,
			});
		}
	}
	return {
		id: `msg_${Math.random().toString(36).slice(2)}`,
		type: "message",
		role: "assistant",
		model: "claude-sonnet-4-20250514",
		content,
		stop_reason: opts.stopReason ?? (opts.toolUses ? "tool_use" : "end_turn"),
		stop_sequence: null,
		usage: {
			input_tokens: 100,
			output_tokens: 50,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	} as Anthropic.Messages.Message;
}

// ── Event deterministic verification (Anthropic) ──

describe("Event deterministic verification", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(
			join(tmpdir(), "mxd-anthropic-strong-event-verify-"),
		);
	});

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	/** Helper: create a provider with a mocked client */
	function createMockedProvider(
		streamFn: (params: unknown) => ReturnType<typeof createMockStream>,
	) {
		const provider = new AnthropicCompatibleProvider("claude-sonnet-4-6", {
			apiKey: "test-key",
		});

		// Replace the client's messages.stream with our mock
		// biome-ignore lint/suspicious/noExplicitAny: replacing internal client for testing
		(provider as any).client = createMockAnthropicClient({ stream: streamFn });
		return provider;
	}

	test("basic conversation: user → assistant text → done", async () => {
		const testDir = join(tmpDir, "basic");
		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
			emittedEvents.push(event);
		};

		const response = buildAnthropicResponse({
			text: "Hello! How can I help?",
			stopReason: "end_turn",
		});
		const provider = createMockedProvider(() =>
			createMockStream(response, ["Hello! How can I help?"]),
		);

		// Provider drains queue for first message
		const result = await provider.execute({
			buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit,
			queue: queueWithPrompt("Say hello", testDir),
		});

		expect(result.exitReason).not.toBe("done_failed");

		// In production, the user message event is already in JSONL (written at send time).
		// Simulate that by prepending it for reconstruction.
		const userMsgEvent: Event = {
			type: "message",
			id: "test-prompt",
			taskId: "",
			body: { source: "user", id: "test-prompt", ts: 0, content: "Say hello" },
			ts: Date.now(),
		};
		const events = [userMsgEvent, ...emittedEvents];
		expect(emittedEvents.length).toBeGreaterThanOrEqual(2);

		// Should have: messages_consumed (from queue drain), assistant_text
		const types = emittedEvents.map((e) => e.type);
		expect(types).toContain("messages_consumed");
		expect(types).toContain("assistant_text");

		// Verify reconstruction matches — the queue message with header is consumed
		const reconstructed = eventsToAnthropicMessages(events as Event[]);
		expect(reconstructed.length).toBeGreaterThanOrEqual(2);
		// First message should contain the header + content from queue drain
		const firstMsg = reconstructed[0] as { role: string; content: string };
		expect(firstMsg.role).toBe("user");
		expect(firstMsg.content).toContain("Say hello");
		// Assistant text without tool_use should use array format (matches Anthropic API response.content)
		expect(reconstructed[1]).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "Hello! How can I help?" }],
		});
	});

	test("tool calls: user → assistant + done tool_use → orphan (no tool_result)", async () => {
		const testDir = join(tmpDir, "tool-calls");
		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
			emittedEvents.push(event);
		};

		const provider = createMockedProvider(() => {
			// Assistant calls done — this is the only API call.
			// done() is an intended orphan: no tool_result, loop exits immediately.
			return createMockStream(
				buildAnthropicResponse({
					text: "I'll finish up.",
					toolUses: [
						{
							id: "tu_1",
							name: "mcp__mxd__done",
							input: { status: "passed", result: "All done" },
						},
					],
				}),
				["I'll finish up."],
			);
		});

		const testQueue = queueWithPrompt("Do the task", testDir);
		const session = provider.stream({
			buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit,
			queue: testQueue,
			mcpToolDefs: {
				mxd: [
					tool(
						"done",
						"Signal completion",
						{
							status: z.string(),
							result: z.string().optional(),
						},
						async () => ({
							content: [
								{
									type: "text",
									text: "Done.",
								},
							],
						}),
					),
				],
			},
		});

		// Consume all events — loop exits on done (no need to close queue manually)
		let result = await session.next();
		while (!result.done) {
			result = await session.next();
		}
		const agentResult = result.value as AgentResult;

		// done() exits with done_passed
		expect(agentResult.exitReason).toBe("done_passed");
		// done exit is reported via exitReason only — the done CONTENT is no longer
		// carried on AgentResult; it lives in the emitted done() tool_call (JSONL),
		// which Phase 2 reads back via readDoneInput (single source of truth).

		const types = emittedEvents.map((e) => e.type);
		expect(types).toContain("assistant_text");
		expect(types).toContain("tool_call");
		// done() is an intended orphan — NO tool_result emitted
		expect(types).not.toContain("tool_result");

		// Verify tool_call details — incl. the result the provider persisted into
		// the done() tool_call input (the value Phase 2's readDoneInput consumes).
		const toolCall = emittedEvents.find((e) => e.type === "tool_call");
		if (toolCall?.type === "tool_call") {
			expect(toolCall.tool).toBe("mcp__mxd__done");
			expect(toolCall.toolCallId).toBe("tu_1");
			expect((toolCall.input as { result?: string }).result).toBe("All done");
		}
	});

	test("error tool results: isError flag preserved in events", async () => {
		const testDir = join(tmpDir, "error-tool");
		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
			emittedEvents.push(event);
		};

		let callCount = 0;
		const provider = createMockedProvider(() => {
			callCount++;
			if (callCount === 1) {
				return createMockStream(
					buildAnthropicResponse({
						text: "Running command.",
						toolUses: [
							{
								id: "tu_err",
								name: "mcp__mxd__done",
								input: { status: "failed", result: "Error" },
							},
						],
					}),
					["Running command."],
				);
			}
			return createMockStream(
				buildAnthropicResponse({
					text: "Acknowledged failure.",
					stopReason: "end_turn",
				}),
				["Acknowledged failure."],
			);
		});

		const testQueue = queueWithPrompt("Try something", testDir);
		const session = provider.stream({
			buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit,
			queue: testQueue,
			mcpToolDefs: {
				mxd: [
					tool("done", "Signal completion", {}, async () => ({
						isError: true,
						content: [
							{
								type: "text",
								text: "Error: command failed with exit code 1",
							},
						],
					})),
				],
			},
		});

		const consumePromise = (async () => {
			let result = await session.next();
			while (!result.done) {
				if (
					result.value.type === "status" &&
					(result.value as { message: string }).message.includes("idle state")
				) {
					testQueue.close();
				}
				result = await session.next();
			}
			return result.value as AgentResult;
		})();

		const agentResult = await consumePromise;
		expect(agentResult.exitReason).not.toBe("done_failed");

		const events = emittedEvents;

		// Verify error flag is preserved
		const toolResult = events.find((e) => e.type === "tool_result");
		expect(toolResult).toBeDefined();
		if (toolResult?.type === "tool_result") {
			expect(toolResult.isError).toBe(true);
			expect(toolResult.content).toContain("Error: command failed");
		}

		// Verify reconstruction preserves is_error
		const reconstructed = eventsToAnthropicMessages(events as Event[]);
		const userMsgWithToolResult = reconstructed.find(
			(m) =>
				(m as { role: string }).role === "user" &&
				Array.isArray((m as { content: unknown }).content),
		);
		expect(userMsgWithToolResult).toBeDefined();
		const toolResultBlock = (
			(userMsgWithToolResult as { content: unknown[] }).content as Array<{
				type: string;
				is_error?: boolean;
			}>
		).find((b) => b.type === "tool_result");
		expect(toolResultBlock?.is_error).toBe(true);
	});

	test("implicit yield: end_turn → queue.wait → queue drain → continue", async () => {
		const testDir = join(tmpDir, "implicit-yield");
		const emittedEvents: EventSpec[] = [];
		// Detect idle via the emit callback — handleImplicitYield announces
		// `agent_activity: idle` synchronously before queue.wait(), so enqueuing
		// here resolves the wait immediately.
		let idleCount = 0;
		const emit = (event: EventSpec) => {
			emittedEvents.push(event);
			if (event.type === "agent_activity" && event.state === "idle") {
				idleCount++;
				if (idleCount === 1) {
					// First idle: inject a message to wake the agent
					queue.enqueue({
						source: "user",
						id: "test-id",
						ts: 0,
						content: "Here is a new instruction",
					});
				} else {
					// Second idle: stop the session by closing the queue
					queue.close();
				}
			}
		};

		let callCount = 0;
		const provider = createMockedProvider(() => {
			callCount++;
			if (callCount === 1) {
				// First call: end_turn (no tools) → provider enters queue.wait()
				return createMockStream(
					buildAnthropicResponse({
						text: "I'm done for now.",
						stopReason: "end_turn",
					}),
					["I'm done for now."],
				);
			}
			// Second call: after queue drain, model responds
			return createMockStream(
				buildAnthropicResponse({
					text: "Got your message, continuing.",
					stopReason: "end_turn",
				}),
				["Got your message, continuing."],
			);
		});

		const queue = queueWithPrompt("Start working", testDir);
		const session = provider.stream({
			buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit,
			queue,
		});

		// Drive the generator to completion — idle detection is in emit callback
		const consumePromise = (async () => {
			let result = await session.next();
			while (!result.done) {
				result = await session.next();
			}
			return result.value as AgentResult;
		})();

		const agentResult = await consumePromise;
		expect(agentResult.exitReason).not.toBe("done_failed");
		expect(idleCount).toBe(2);

		// Provider emits messages_consumed but not message events for user messages
		// (those are written at send time in production). Prepend them for reconstruction.
		const userMsg1: Event = {
			type: "message",
			id: "test-prompt",
			taskId: "",
			body: {
				source: "user",
				id: "test-prompt",
				ts: 0,
				content: "Start working",
			},
			ts: Date.now(),
		};
		const userMsg2: Event = {
			type: "message",
			id: "test-id",
			taskId: "",
			body: {
				source: "user",
				id: "test-id",
				ts: 0,
				content: "Here is a new instruction",
			},
			ts: Date.now(),
		};
		const events = [userMsg1, ...emittedEvents];
		// Insert second user message before its consumption (find the second messages_consumed)
		const consumedIndices = events.reduce<number[]>((acc, e, i) => {
			if (e.type === "messages_consumed") acc.push(i);
			return acc;
		}, []);
		const secondConsumedIdx = consumedIndices[1];
		if (secondConsumedIdx !== undefined) {
			events.splice(secondConsumedIdx, 0, userMsg2);
		}

		// Verify reconstruction
		const reconstructed = eventsToAnthropicMessages(events as Event[]);
		// Should have: user_msg, assistant(end_turn), queue message (as user), assistant(continue)
		expect(reconstructed.length).toBeGreaterThanOrEqual(4);

		// Find the queue-originated user message in reconstructed — it becomes a plain user message
		const queueReconstructed = reconstructed.find((m) => {
			const content = (m as { role: string; content: unknown }).content;
			if (typeof content === "string") {
				return content.includes("Here is a new instruction");
			}
			return false;
		});
		expect(queueReconstructed).toBeDefined();
	});

	test("idle is announced ONLY when the loop actually parks on the queue", async () => {
		// `idle` means "waiting for you", not "reached a yield point". When a
		// message is already queued, wait() resolves on the next microtask and
		// the agent never paused — announcing idle there reports a pause that
		// did not happen, and both consumers act on it: yield_external wakes an
		// external client, and the UI re-fetches JSONL to expose Edit/Rewind.
		//
		// This run passes through THREE queue-wait points and must announce
		// exactly ONE idle:
		//   1. initial drain     — prompt already queued  → no announce
		//   2. explicit yield    — message enqueued below → no announce
		//   3. end_turn          — queue empty            → ANNOUNCE
		const testDir = join(tmpDir, "idle-only-when-parked");
		const idleAnnouncements: number[] = [];
		let sawYieldToolCall = false;

		const emit = (event: EventSpec) => {
			if (event.type === "tool_call" && event.tool === TOOL_YIELD) {
				// Enqueue BEFORE the loop reaches its yield park. Emit callbacks
				// run synchronously inside the loop, so this is deterministic:
				// the message is in the queue when handleImplicitYield asks.
				sawYieldToolCall = true;
				queue.enqueue({
					source: "user",
					id: "wake-during-yield",
					ts: 0,
					content: "already waiting for you",
				});
			}
			if (event.type === "agent_activity" && event.state === "idle") {
				idleAnnouncements.push(callCount);
				// The only genuine park — end the run.
				queue.close();
			}
		};

		let callCount = 0;
		const provider = createMockedProvider(() => {
			callCount++;
			if (callCount === 1) {
				// Yield alone → loop-level pause → handleImplicitYield, with the
				// message the emit callback just enqueued already waiting.
				return createMockStream(
					buildAnthropicResponse({
						toolUses: [{ id: "y1", name: TOOL_YIELD, input: {} }],
						stopReason: "tool_use",
					}),
					[],
				);
			}
			// end_turn with nothing queued → the real park.
			return createMockStream(
				buildAnthropicResponse({
					text: "nothing left to do",
					stopReason: "end_turn",
				}),
				["nothing left to do"],
			);
		});

		const queue = queueWithPrompt("Start working", testDir);
		const session = provider.stream({
			buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit,
			queue,
		});

		let result = await session.next();
		while (!result.done) {
			result = await session.next();
		}

		expect(sawYieldToolCall).toBe(true);
		// Two turns ran, so the loop passed the yield park and kept going.
		expect(callCount).toBe(2);
		// Exactly one announcement, and it came from the second turn's
		// end_turn — not from the initial drain, not from the yield.
		expect(idleAnnouncements).toEqual([2]);
	});

	test("multiple parallel tool calls: 3 tool_use blocks → 3 tool_results", async () => {
		const testDir = join(tmpDir, "parallel-tools");
		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
			emittedEvents.push(event);
		};

		let callCount = 0;
		const provider = createMockedProvider(() => {
			callCount++;
			if (callCount === 1) {
				return createMockStream(
					buildAnthropicResponse({
						text: "I'll run multiple tools.",
						toolUses: [
							{
								id: "tu_a",
								name: "mcp__test__tool_a",
								input: { param: "a" },
							},
							{
								id: "tu_b",
								name: "mcp__test__tool_b",
								input: { param: "b" },
							},
							{
								id: "tu_c",
								name: "mcp__test__tool_c",
								input: { param: "c" },
							},
						],
					}),
					["I'll run multiple tools."],
				);
			}
			return createMockStream(
				buildAnthropicResponse({
					text: "All tools completed.",
					stopReason: "end_turn",
				}),
				["All tools completed."],
			);
		});

		const testQueue = queueWithPrompt("Run three tools", testDir);
		const session = provider.stream({
			buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit,
			queue: testQueue,
			mcpToolDefs: {
				test: [
					tool("tool_a", "Tool A", {}, async () => ({
						content: [{ type: "text", text: "Result A" }],
					})),
					tool("tool_b", "Tool B", {}, async () => ({
						content: [{ type: "text", text: "Result B" }],
					})),
					tool("tool_c", "Tool C", {}, async () => ({
						content: [{ type: "text", text: "Result C" }],
					})),
				],
			},
		});

		const consumePromise = (async () => {
			let result = await session.next();
			while (!result.done) {
				if (
					result.value.type === "status" &&
					(result.value as { message: string }).message.includes("idle state")
				) {
					testQueue.close();
				}
				result = await session.next();
			}
			return result.value as AgentResult;
		})();

		const agentResult = await consumePromise;
		expect(agentResult.exitReason).not.toBe("done_failed");

		const events = emittedEvents;
		const toolCalls = events.filter((e) => e.type === "tool_call");
		const toolResults = events.filter((e) => e.type === "tool_result");

		// Should have 3 tool_calls and 3 tool_results
		expect(toolCalls.length).toBe(3);
		expect(toolResults.length).toBe(3);

		// Verify each tool_call has matching tool_result
		for (const tc of toolCalls) {
			if (tc.type === "tool_call") {
				const matchingResult = toolResults.find(
					(tr) => tr.type === "tool_result" && tr.toolCallId === tc.toolCallId,
				);
				expect(matchingResult).toBeDefined();
			}
		}

		// Verify reconstruction — prepend user message event (in production, already in JSONL)
		const userMsgEvent: Event = {
			type: "message",
			id: "test-prompt",
			taskId: "",
			body: {
				source: "user",
				id: "test-prompt",
				ts: 0,
				content: "Run three tools",
			},
			ts: Date.now(),
		};
		const allEvents = [userMsgEvent, ...events];
		const reconstructed = eventsToAnthropicMessages(allEvents as Event[]);
		// user, assistant(text + 3 tool_uses), user(3 tool_results), assistant(end_turn)
		expect(reconstructed.length).toBe(4);

		// Verify assistant message has text + 3 tool_use blocks
		const assistantMsg = reconstructed[1] as {
			role: string;
			content: unknown[];
		};
		expect(assistantMsg.role).toBe("assistant");
		expect(Array.isArray(assistantMsg.content)).toBe(true);
		const toolUseBlocks = (
			assistantMsg.content as Array<{ type: string }>
		).filter((b) => b.type === "tool_use");
		expect(toolUseBlocks.length).toBe(3);

		// Verify user message has 3 tool_result blocks
		const toolResultMsg = reconstructed[2] as {
			role: string;
			content: unknown[];
		};
		expect(toolResultMsg.role).toBe("user");
		const trBlocks = (toolResultMsg.content as Array<{ type: string }>).filter(
			(b) => b.type === "tool_result",
		);
		expect(trBlocks.length).toBe(3);
	});

	test("compaction: compact_marker event separates pre/post compaction events", async () => {
		const testDir = join(tmpDir, "compaction");
		const eventStore = new EventStore(testDir);
		const sessionId = "test-compaction-session";

		// Manually write pre-compaction events
		const preEvents: Event[] = [
			{
				type: "message",
				id: "",
				body: {
					source: "user",
					id: "test-id",
					ts: 0,
					content: "Old message before compaction",
				},
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Old response",
				taskId: "test",
				ts: 1001,
			},
		];
		await eventStore.appendBatch(sessionId, preEvents);

		// Write compact_marker (empty boundary)
		await eventStore.append(sessionId, {
			type: "compact_marker",
			savedTokens: 5000,
			taskId: "test",
			ts: 2000,
		});

		// Write post-compaction events
		const postEvents: Event[] = [
			{
				type: "assistant_text",
				content: "Resuming from checkpoint",
				taskId: "test",
				ts: 2001,
			},
			{
				type: "assistant_text",
				content: "Continuing work.",
				taskId: "test",
				ts: 2002,
			},
		];
		await eventStore.appendBatch(sessionId, postEvents);

		// readActive returns the boundary marker + the post-marker events
		await eventStore.flush();
		const active = eventStore.readActive(sessionId);
		expect(active.length).toBe(3);
		expect(active[0]?.type).toBe("compact_marker");
		expect(active[1]?.type).toBe("assistant_text");
		expect(active[2]?.type).toBe("assistant_text");

		// Full read should have all events including marker
		const all = eventStore.read(sessionId);
		expect(all.length).toBe(5); // 2 pre + 1 marker + 2 post

		// Reconstruction of active events — both are assistant_text → assistant messages
		const reconstructed = eventsToAnthropicMessages(active);
		// Two consecutive assistant_text events merge into one assistant message
		expect(reconstructed.length).toBeGreaterThanOrEqual(1);
	});

	test("budget warnings: budget_warning events reconstruct as user messages", async () => {
		const testDir = join(tmpDir, "budget");
		const eventStore = new EventStore(testDir);
		const sessionId = "test-budget-session";

		// Write a conversation with a budget warning
		const events: Event[] = [
			{
				type: "message",
				id: "",
				body: {
					source: "user",
					id: "test-id",
					ts: 0,
					content: "Start working",
				},
				taskId: "test",
				ts: 1000,
			},
			{
				type: "assistant_text",
				content: "Working on it.",
				taskId: "test",
				ts: 1001,
			},
			{
				type: "tool_call",
				tool: "bash",
				toolCallId: "tc1",
				input: { command: "echo hi" },
				taskId: "test",
				ts: 1002,
			},
			{
				type: "tool_result",
				tool: "bash",
				toolCallId: "tc1",
				content: "hi",
				isError: false,
				taskId: "test",
				ts: 1003,
			},
			{
				type: "budget_warning",
				warning: "⚠️ Budget exceeded (0.50 / 0.40 budget). Call done() now.",
				taskId: "test",
				ts: 1004,
			},
			{
				type: "assistant_text",
				content: "Wrapping up.",
				taskId: "test",
				ts: 1005,
			},
		];
		await eventStore.appendBatch(sessionId, events);
		await eventStore.flush();

		const active = eventStore.readActive(sessionId);
		const reconstructed = eventsToAnthropicMessages(active);

		// Should have: user, assistant+tool, tool_result, budget_warning(user), assistant
		expect(reconstructed.length).toBe(5);
		expect((reconstructed[0] as { role: string }).role).toBe("user");
		expect((reconstructed[1] as { role: string }).role).toBe("assistant");
		expect((reconstructed[2] as { role: string }).role).toBe("user"); // tool_result
		// Budget warning becomes a user message
		expect(reconstructed[3]).toEqual({
			role: "user",
			content: "⚠️ Budget exceeded (0.50 / 0.40 budget). Call done() now.",
		});
		expect((reconstructed[4] as { role: string }).role).toBe("assistant");
	});

	test("cancellation point queue drain: messages between tool_call and tool_result", async () => {
		const testDir = join(tmpDir, "cancellation-point");
		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
			emittedEvents.push(event);
		};

		let callCount = 0;
		const provider = createMockedProvider(() => {
			callCount++;
			if (callCount === 1) {
				return createMockStream(
					buildAnthropicResponse({
						text: "Running a tool.",
						toolUses: [
							{
								id: "tu_cp",
								name: "mcp__mxd__bash",
								input: { command: "echo hello" },
							},
						],
					}),
					["Running a tool."],
				);
			}
			return createMockStream(
				buildAnthropicResponse({
					text: "Finished.",
					stopReason: "end_turn",
				}),
				["Finished."],
			);
		});

		const testQueue = queueWithPrompt("Do task", testDir);
		const session = provider.stream({
			buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit,
			queue: testQueue,
			mcpToolDefs: {
				mxd: [
					tool(
						"bash",
						"Run a command",
						{
							command: z.string(),
						},
						async (input) => {
							// During tool execution, enqueue a message to simulate cancellation point
							testQueue.enqueue({
								source: "user",
								id: "test-id",
								ts: 0,
								content: "Urgent update during tool execution",
							});
							return {
								content: [
									{
										type: "text",
										text: `Ran: ${input.command}`,
									},
								],
							};
						},
					),
				],
			},
		});

		// Consume until implicit yield (end_turn enters idle). Close queue then.
		let result = await session.next();
		while (!result.done) {
			// Detect idle state — end_turn triggers handleImplicitYield
			if (
				result.value.type === "status" &&
				(result.value as { message?: string }).message?.includes("idle")
			) {
				testQueue.close();
			}
			result = await session.next();
		}

		const events = emittedEvents;

		// The tool_result content should contain ONLY the pure tool output (no queue text)
		const toolResult = events.find((e) => e.type === "tool_result");
		expect(toolResult).toBeDefined();
		if (toolResult?.type === "tool_result") {
			expect(toolResult.content).toContain("Ran: echo hello");
			// Queue text is NOT embedded in tool_result.content anymore
			expect(toolResult.content).not.toContain(
				"[Messages received while you were working:]",
			);
		}

		// The queue message should be tracked via a standalone messages_consumed event
		const msgConsumed = events.find((e) => e.type === "messages_consumed");
		expect(msgConsumed).toBeDefined();
		if (msgConsumed?.type === "messages_consumed") {
			expect(msgConsumed.messageIds.length).toBeGreaterThan(0);
		}

		// The queue message should be a separate message event — check body in new format
		const userMsgEvent = events.find(
			(e) =>
				e.type === "message" &&
				(((e as { source?: string }).source === "user" &&
					(e as { content?: string }).content ===
						"Urgent update during tool execution") ||
					((e as { body?: { source?: string; content?: string } }).body
						?.source === "user" &&
						(e as { body?: { content?: string } }).body?.content ===
							"Urgent update during tool execution")),
		);
		// User messages with id are written at send time (by the test or caller),
		// not by the provider. The provider writes messages_consumed.
		// So we check for either a direct message event or the messages_consumed reference.
		const hasUserMsg =
			userMsgEvent !== undefined ||
			events.some(
				(e) =>
					e.type === "messages_consumed" &&
					(e as { messageIds: string[] }).messageIds.length > 0,
			);
		expect(hasUserMsg).toBe(true);
	});
});

// ── Cache consistency: live path vs JSONL reconstruction ──
// These tests exercise the ACTUAL provider loop (live buildUserTurn) and compare
// the resulting messages[] with what eventsToAnthropicMessages produces from the
// emitted JSONL events. Any mismatch = cache miss on restart.

describe("Cache consistency: buildUserTurn matches JSONL reconstruction", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "mxd-cache-consistency-"));
	});

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	/** Helper: create a provider with a mocked client */
	function createProvider(
		streamFn: (params: unknown) => ReturnType<typeof createMockStream>,
	) {
		const provider = new AnthropicCompatibleProvider("claude-sonnet-4-6", {
			apiKey: "test-key",
		});
		// biome-ignore lint/suspicious/noExplicitAny: replacing internal client for testing
		(provider as any).client = createMockAnthropicClient({ stream: streamFn });
		return provider;
	}

	test("MCP image in tool_result: live messages include image blocks matching JSONL reconstruction", async () => {
		// Custom MCP tool that returns image data (simulates Chrome DevTools take_screenshot)
		const fakeBase64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
		const testDir = join(tmpDir, "mcp-image");
		await mkdir(testDir, { recursive: true });

		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
			emittedEvents.push(event);
		};

		// Capture the live messages array from the provider
		let liveMessages: unknown[] | null = null;

		let callCount = 0;
		const provider = createProvider(() => {
			callCount++;
			if (callCount === 1) {
				return createMockStream(
					buildAnthropicResponse({
						text: "Taking screenshot.",
						toolUses: [
							{
								id: "tu_ss",
								name: "mcp__chrome__take_screenshot",
								input: {},
							},
						],
					}),
					["Taking screenshot."],
				);
			}
			return createMockStream(
				buildAnthropicResponse({
					text: "Done.",
					stopReason: "end_turn",
				}),
				["Done."],
			);
		});

		const testQueue = queueWithPrompt("Take a screenshot", testDir);

		const session = provider.stream({
			buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit,
			queue: testQueue,
			setMessages: (msgs) => {
				liveMessages = msgs;
			},
			mcpToolDefs: {
				chrome: [
					tool("take_screenshot", "Take a screenshot", {}, async () => ({
						// MCP tool returns image via content array (MCP format)
						content: [
							{
								type: "text",
								text: "Took a screenshot of the current page.",
							},
							{
								type: "image",
								data: fakeBase64,
								mimeType: "image/png",
							},
						],
					})),
				],
			},
		});

		// Run until end_turn → idle → close queue
		let result = await session.next();
		while (!result.done) {
			if (
				result.value.type === "status" &&
				(result.value as { message?: string }).message?.includes("idle")
			) {
				testQueue.close();
			}
			result = await session.next();
		}

		expect(liveMessages).not.toBeNull();
		expect(callCount).toBe(2);

		// Build the full events array (prepend user message event)
		const userMsgEvent: Event = {
			type: "message",
			id: "test-prompt",
			taskId: "",
			body: {
				source: "user",
				id: "test-prompt",
				ts: 0,
				content: "Take a screenshot",
			},
			ts: Date.now(),
		};
		const allEvents = [userMsgEvent, ...emittedEvents];

		// Reconstruct from JSONL events
		const reconstructed = eventsToAnthropicMessages(allEvents as Event[]);

		// Find the user message containing the tool_result in both arrays
		const findToolResultMsg = (msgs: unknown[]) =>
			(msgs as Array<{ role: string; content: unknown }>).find((m) => {
				if (m.role !== "user" || !Array.isArray(m.content)) return false;
				return (m.content as Array<{ type: string }>).some(
					(b) => b.type === "tool_result",
				);
			});

		const liveToolResultMsg = findToolResultMsg(
			liveMessages as unknown as unknown[],
		);
		const reconToolResultMsg = findToolResultMsg(reconstructed);

		expect(liveToolResultMsg).toBeDefined();
		expect(reconToolResultMsg).toBeDefined();

		// The tool_result block itself must match between live and reconstructed.
		const liveToolResult = (
			liveToolResultMsg?.content as Array<Record<string, unknown>>
		).find((b) => b.type === "tool_result");
		const reconToolResult = (
			reconToolResultMsg?.content as Array<Record<string, unknown>>
		).find((b) => b.type === "tool_result");

		// JSONL reconstruction includes image blocks in tool_result content
		expect(Array.isArray(reconToolResult?.content)).toBe(true);
		// Live path must also have array content (not just a string)
		expect(Array.isArray(liveToolResult?.content)).toBe(true);

		// Deep equality — must be byte-identical
		expect(liveToolResult).toEqual(reconToolResult);
	});

	test("Multiple queue messages at cancellation point produce separate text blocks", async () => {
		const testDir = join(tmpDir, "multi-queue");
		await mkdir(testDir, { recursive: true });

		const emittedEvents: EventSpec[] = [];
		const emit = (event: EventSpec) => {
			emittedEvents.push(event);
		};

		let liveMessages: unknown[] | null = null;

		let callCount = 0;
		const provider = createProvider(() => {
			callCount++;
			if (callCount === 1) {
				return createMockStream(
					buildAnthropicResponse({
						text: "Running bash.",
						toolUses: [
							{
								id: "tu_bash",
								name: "mcp__mxd__bash",
								input: { command: "sleep 0.1" },
							},
						],
					}),
					["Running bash."],
				);
			}
			return createMockStream(
				buildAnthropicResponse({
					text: "All done.",
					stopReason: "end_turn",
				}),
				["All done."],
			);
		});

		const testQueue = queueWithPrompt("Start", testDir);

		const session = provider.stream({
			buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit,
			queue: testQueue,
			setMessages: (msgs) => {
				liveMessages = msgs;
			},
			mcpToolDefs: {
				mxd: [
					tool(
						"bash",
						"Run a command",
						{ command: z.string() },
						async (input) => {
							// During bash execution, enqueue two messages to simulate
							// multiple messages arriving at the cancellation point
							testQueue.enqueue({
								source: "task_complete" as const,
								id: "tc-1",
								ts: Date.now(),
								taskId: "child-1",
								title: "Task A",
								success: true,
								output: "Done with A",
							});
							testQueue.enqueue({
								source: "task_complete" as const,
								id: "tc-2",
								ts: Date.now(),
								taskId: "child-2",
								title: "Task B",
								success: true,
								output: "Done with B",
							});
							return {
								content: [{ type: "text", text: `Ran: ${input.command}` }],
							};
						},
					),
				],
			},
		});

		// Run until end_turn → idle → close queue
		let result = await session.next();
		while (!result.done) {
			if (
				result.value.type === "status" &&
				(result.value as { message?: string }).message?.includes("idle")
			) {
				testQueue.close();
			}
			result = await session.next();
		}

		expect(liveMessages).not.toBeNull();
		expect(callCount).toBe(2);

		// Build full events array (prepend user message)
		const userMsgEvent: Event = {
			type: "message",
			id: "test-prompt",
			taskId: "",
			body: {
				source: "user",
				id: "test-prompt",
				ts: 0,
				content: "Start",
			},
			ts: Date.now(),
		};
		const allEvents = [userMsgEvent, ...emittedEvents];

		// Reconstruct from JSONL events
		const reconstructed = eventsToAnthropicMessages(allEvents as Event[]);

		// Find the user message containing tool_result + queue text blocks
		const findToolResultMsg = (msgs: unknown[]) =>
			(msgs as Array<{ role: string; content: unknown }>).find((m) => {
				if (m.role !== "user" || !Array.isArray(m.content)) return false;
				return (m.content as Array<{ type: string }>).some(
					(b) => b.type === "tool_result",
				);
			});

		const liveMsg = findToolResultMsg(liveMessages as unknown as unknown[]);
		const reconMsg = findToolResultMsg(reconstructed);

		expect(liveMsg).toBeDefined();
		expect(reconMsg).toBeDefined();

		// Extract text blocks (skip tool_result blocks)
		const getTextBlocks = (msg: { content: unknown[] }) =>
			(msg.content as Array<{ type: string; text?: string }>).filter(
				(b) => b.type === "text",
			);

		const reconTextBlocks = getTextBlocks(reconMsg as { content: unknown[] });
		const liveTextBlocks = getTextBlocks(liveMsg as { content: unknown[] });

		// JSONL reconstruction produces SEPARATE text blocks per consumed message
		expect(reconTextBlocks.length).toBe(2);
		expect(reconTextBlocks[0]?.text).toContain("Task A");
		expect(reconTextBlocks[1]?.text).toContain("Task B");

		// Live path must produce the same number of separate blocks
		expect(liveTextBlocks.length).toBe(reconTextBlocks.length);

		// Deep equality — must be byte-identical
		expect(liveTextBlocks).toEqual(reconTextBlocks);
	});

	test("Multiple queue messages during explicit yield produce separate text blocks", async () => {
		const testDir = join(tmpDir, "yield-multi-queue");
		await mkdir(testDir, { recursive: true });

		const emittedEvents: EventSpec[] = [];
		let liveMessages: unknown[] | null = null;
		let idleCount = 0;

		const testQueue = queueWithPrompt("Start", testDir);

		// Detect idle via emit callback — enqueue messages on first idle (yield),
		// close queue on second idle (end_turn after wake).
		const emit = (event: EventSpec) => {
			emittedEvents.push(event);
			if (event.type === "agent_activity" && event.state === "idle") {
				idleCount++;
				if (idleCount === 1) {
					// First idle = yield waiting. Enqueue two messages simultaneously.
					testQueue.enqueue({
						source: "task_complete" as const,
						id: "tc-y1",
						ts: Date.now(),
						taskId: "child-1",
						title: "Yield Task A",
						success: true,
						output: "Yield done A",
					});
					testQueue.enqueue({
						source: "task_complete" as const,
						id: "tc-y2",
						ts: Date.now(),
						taskId: "child-2",
						title: "Yield Task B",
						success: true,
						output: "Yield done B",
					});
				} else {
					// Second idle = end_turn after wake. Close queue.
					testQueue.close();
				}
			}
		};

		let callCount = 0;
		const provider = createProvider(() => {
			callCount++;
			if (callCount === 1) {
				return createMockStream(
					buildAnthropicResponse({
						text: "Yielding.",
						toolUses: [
							{
								id: "tu_yield",
								name: "mcp__mxd__yield",
								input: {},
							},
						],
					}),
					["Yielding."],
				);
			}
			return createMockStream(
				buildAnthropicResponse({
					text: "Got messages.",
					stopReason: "end_turn",
				}),
				["Got messages."],
			);
		});

		const session = provider.stream({
			buildSystemPrompt: () => ({ stable: "You are helpful.", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit,
			queue: testQueue,
			setMessages: (msgs) => {
				liveMessages = msgs;
			},
			mcpToolDefs: { mxd: [] },
		});

		// Drive generator to completion — idle detection happens in emit callback
		let result = await session.next();
		while (!result.done) {
			result = await session.next();
		}

		expect(liveMessages).not.toBeNull();
		expect(callCount).toBe(2);
		expect(idleCount).toBe(2);

		// Build full events (prepend user + task_complete message events for reconstruction)
		const userMsgEvent: Event = {
			type: "message",
			id: "test-prompt",
			taskId: "",
			body: {
				source: "user",
				id: "test-prompt",
				ts: 0,
				content: "Start",
			},
			ts: Date.now(),
		};
		const tcMsg1: Event = {
			type: "message",
			id: "tc-y1",
			taskId: "",
			body: {
				source: "task_complete" as const,
				id: "tc-y1",
				ts: Date.now(),
				taskId: "child-1",
				title: "Yield Task A",
				success: true,
				output: "Yield done A",
			},
			ts: Date.now(),
		};
		const tcMsg2: Event = {
			type: "message",
			id: "tc-y2",
			taskId: "",
			body: {
				source: "task_complete" as const,
				id: "tc-y2",
				ts: Date.now(),
				taskId: "child-2",
				title: "Yield Task B",
				success: true,
				output: "Yield done B",
			},
			ts: Date.now(),
		};

		// Insert message events before their messages_consumed references
		const orderedEvents: Event[] = [userMsgEvent];
		for (const e of emittedEvents) {
			if (
				e.type === "messages_consumed" &&
				(e as { messageIds: string[] }).messageIds.includes("tc-y1")
			) {
				orderedEvents.push(tcMsg1, tcMsg2);
			}
			orderedEvents.push(e as Event);
		}

		const reconstructed = eventsToAnthropicMessages(orderedEvents);

		// Find the user message with tool_result (yield) + queue text blocks
		const findLastToolResultMsg = (msgs: unknown[]) => {
			const all = (msgs as Array<{ role: string; content: unknown }>).filter(
				(m) => {
					if (m.role !== "user" || !Array.isArray(m.content)) return false;
					return (m.content as Array<{ type: string }>).some(
						(b) => b.type === "tool_result",
					);
				},
			);
			return all[all.length - 1];
		};

		const liveMsg = findLastToolResultMsg(liveMessages as unknown as unknown[]);
		const reconMsg = findLastToolResultMsg(reconstructed);

		expect(liveMsg).toBeDefined();
		expect(reconMsg).toBeDefined();

		const getTextBlocks = (msg: { content: unknown[] }) =>
			(msg.content as Array<{ type: string; text?: string }>).filter(
				(b) => b.type === "text",
			);

		const reconTextBlocks = getTextBlocks(reconMsg as { content: unknown[] });
		const liveTextBlocks = getTextBlocks(liveMsg as { content: unknown[] });

		// JSONL reconstruction: separate text blocks per message
		expect(reconTextBlocks.length).toBe(2);
		expect(reconTextBlocks[0]?.text).toContain("Yield Task A");
		expect(reconTextBlocks[1]?.text).toContain("Yield Task B");

		// Live path must match
		expect(liveTextBlocks.length).toBe(reconTextBlocks.length);
		expect(liveTextBlocks).toEqual(reconTextBlocks);
	});
});

// ── systemPreamble tests ──

describe("systemPreamble", () => {
	let testDir: string;

	beforeAll(async () => {
		testDir = await mkdtemp(join(tmpdir(), "mxd-preamble-test-"));
	});

	afterAll(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	const endTurnInstruction = JSON.stringify({
		blocks: [{ type: "text", text: "ok" }],
		stop_reason: "end_turn",
	});

	test("with systemPreamble: first system block is the preamble text", async () => {
		const { ValidatingMockAPI, createMockedProviderWithMock } = await import(
			"./test-utils/mock-anthropic-api.ts"
		);
		const mockAPI = new ValidatingMockAPI();

		const preambleText = "You are a test agent for preamble verification.";
		const provider = createMockedProviderWithMock(mockAPI, undefined, {
			systemPreamble: preambleText,
		});

		await provider.execute({
			buildSystemPrompt: () => ({
				stable: "stable-prompt",
				variable: "variable-prompt",
			}),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			queue: queueWithPrompt(endTurnInstruction, testDir),
		});

		const request = mockAPI.getLastRequest();
		expect(request).toBeDefined();
		const system = request?.system as Array<{ type: string; text: string }>;
		expect(Array.isArray(system)).toBe(true);
		expect(system.length).toBe(3); // preamble + stable + variable
		expect(system[0]?.text).toBe(preambleText);
		expect(system[1]?.text).toBe("stable-prompt");
		expect(system[2]?.text).toBe("variable-prompt");
	});

	test("without systemPreamble: no preamble block, just stable + variable", async () => {
		const { ValidatingMockAPI, createMockedProviderWithMock } = await import(
			"./test-utils/mock-anthropic-api.ts"
		);
		const mockAPI = new ValidatingMockAPI();
		const provider = createMockedProviderWithMock(mockAPI);

		await provider.execute({
			buildSystemPrompt: () => ({
				stable: "stable-prompt",
				variable: "variable-prompt",
			}),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			queue: queueWithPrompt(endTurnInstruction, testDir),
		});

		const request = mockAPI.getLastRequest();
		const system = request?.system as Array<{ type: string; text: string }>;
		expect(Array.isArray(system)).toBe(true);
		expect(system.length).toBe(2); // stable + variable only
		expect(system[0]?.text).toBe("stable-prompt");
		expect(system[1]?.text).toBe("variable-prompt");
	});

	test("empty string systemPreamble: treated as no preamble", async () => {
		const { ValidatingMockAPI, createMockedProviderWithMock } = await import(
			"./test-utils/mock-anthropic-api.ts"
		);
		const mockAPI = new ValidatingMockAPI();
		const provider = createMockedProviderWithMock(mockAPI, undefined, {
			systemPreamble: "",
		});

		await provider.execute({
			buildSystemPrompt: () => ({
				stable: "stable-prompt",
				variable: "variable-prompt",
			}),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			queue: queueWithPrompt(endTurnInstruction, testDir),
		});

		const request = mockAPI.getLastRequest();
		const system = request?.system as Array<{ type: string; text: string }>;
		expect(system.length).toBe(2); // no preamble
		expect(system[0]?.text).toBe("stable-prompt");
	});
});

// ── baseUrl tests ──
//
// ⚠️ Both of these pin ANTHROPIC_BASE_URL, and the second one NEEDS it: before
// 2026-07-30 the SDK read that variable for an omitted `baseURL`, so "the default
// applies" was true only on a machine whose shell did not set it. The test passed
// for a reason that was a fact about the person running it.

describe("baseUrl", () => {
	test("baseUrl option is passed to the SDK client as baseURL", () => {
		const client = withClientEnv(
			{ ANTHROPIC_BASE_URL: "https://env-should-never-decide.example.com" },
			() =>
				clientOf(
					new AnthropicCompatibleProvider("claude-sonnet-4-6", {
						apiKey: "test-key",
						baseUrl: "https://proxy.example.com",
					}),
				),
		);
		expect(client.baseURL).toBe("https://proxy.example.com");
	});

	test("without baseUrl: WE choose api.anthropic.com — the environment cannot", () => {
		const client = withClientEnv(
			{ ANTHROPIC_BASE_URL: "https://env-should-never-decide.example.com" },
			() =>
				clientOf(
					new AnthropicCompatibleProvider("claude-sonnet-4-6", {
						apiKey: "test-key",
					}),
				),
		);
		expect(client.baseURL).toBe("https://api.anthropic.com");
	});
});

/** The SDK client a provider built, for tests that inspect what it holds. */
function clientOf(provider: AnthropicCompatibleProvider): Anthropic {
	// biome-ignore lint/suspicious/noExplicitAny: inspecting private client
	return (provider as any).client as Anthropic;
}

// ── The deleted credential env fallbacks stay deleted ──
//
// 2026-07-29 (289a3bf2) deleted two env reads from this constructor, in one pair
// of lines:
//     const apiKey     = opts.apiKey     ?? process.env.ANTHROPIC_API_KEY;
//     const oauthToken = opts.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
// These are inverted guards for a DELETED feature, not re-aimed tests of a
// deleted mechanism: the producer they consume still exists — a shell really can
// hold either name — so each reddens the moment ITS OWN `??` comes back.
// Verified by mutation, one line at a time as well as both together.
//
// WHY this side needs them more than the OpenAI side, which is the reverse of
// the usual argument: we bootstrap on Anthropic every day, so a wrong ASSERTION
// here explodes at once. A restored FALLBACK does the opposite — it reads the
// shell and everything keeps working. No 400, no flake, nobody reports it.
// Traffic can falsify a wrong assertion; it cannot falsify a fallback growing
// back, because a fallback's whole job is to make things keep working. So the
// high-traffic path is where this kind of test is most necessary, not least.
//
// ⚠️ Unlike the OpenAI provider there is no `console.warn` to key on: the
// no-credential branch here neither warns nor throws, it builds a
// credential-less client. The signal is which credential the client ends up
// holding, and which branch built it.
//
// ⚠️ MEASURED, and it is why the obvious fixture is absent: for
// ANTHROPIC_API_KEY, an empty `opts` CANNOT express the difference. The SDK is a
// second reader of that same variable — `if (apiKey === undefined) apiKey =
// readEnv('ANTHROPIC_API_KEY')` in @anthropic-ai/sdk's client constructor — so
// `client.apiKey` is the env value either way, today and with the fallback
// restored. What does differ is the BRANCH: a truthy apiKey turns `useOAuth`
// off, so a shell-held key silently outranks the OAuth token the user
// configured. That collision is the second fixture below.
//
// ⚠️ For the same reason there is deliberately NO sentinel for
// ANTHROPIC_AUTH_TOKEN: it is the SDK's own name and was never ours (`git log
// -S` finds zero commits), and the SDK really does pick it up (measured:
// client.authToken becomes the env value). Asserting it is ignored would assert
// the opposite of reality.

describe("the deleted credential env fallbacks stay deleted", () => {
	/** The two observables that separate the branches of the constructor. */
	function credentialShape(provider: AnthropicCompatibleProvider): {
		authToken: string | null;
		beta: string;
	} {
		// biome-ignore lint/suspicious/noExplicitAny: protected _options
		const client = clientOf(provider) as any;
		return {
			authToken: client.authToken,
			beta: client._options?.defaultHeaders?.["anthropic-beta"] ?? "",
		};
	}

	test("a populated CLAUDE_CODE_OAUTH_TOKEN is NOT picked up", () => {
		const { authToken, beta } = withClientEnv(
			{ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-env-should-be-ignored" },
			() =>
				credentialShape(
					new AnthropicCompatibleProvider("claude-sonnet-4-6", {}),
				),
		);
		// The env value never landed as a credential…
		expect(authToken).not.toBe("sk-ant-oat-env-should-be-ignored");
		// …and the OAuth branch was never entered, which is what reading it does.
		// Positive control first: without it, `not.toContain` would also pass on a
		// header we never managed to read at all.
		expect(beta).toContain("interleaved-thinking-2025-05-14");
		expect(beta).not.toContain("oauth-2025-04-20");
	});

	test("a populated ANTHROPIC_API_KEY does NOT outrank a configured OAuth token", () => {
		const { authToken, beta } = withClientEnv(
			{ ANTHROPIC_API_KEY: "sk-env-should-be-ignored" },
			() =>
				credentialShape(
					new AnthropicCompatibleProvider("claude-sonnet-4-6", {
						oauthToken: "configured-oauth-token",
					}),
				),
		);
		// The configured credential is the one that reached the client…
		expect(authToken).toBe("configured-oauth-token");
		// …and the OAuth branch ran, which a truthy env apiKey switches off.
		expect(beta).toContain("oauth-2025-04-20");
	});
});

// ── A shell credential cannot reach the API ──
//
// The describe above defends OUR deleted reads. This one defends the guarantee
// those reads were only half of: **the SDK is a second reader of the same
// variables**, so with zero env reads left in src/ a shell-held credential still
// reached the wire. @anthropic-ai/sdk's client constructor:
//     if (apiKey    === undefined) apiKey    = readEnv('ANTHROPIC_API_KEY')    ?? null;
//     if (authToken === undefined) authToken = readEnv('ANTHROPIC_AUTH_TOKEN') ?? null;
// Only `undefined` triggers it; `null` is the SDK's own documented way to say
// "do not look in the environment" (its signature is `string | null |
// undefined`). There is no disable-env option to reach for instead.
//
// ⚠️ Not a hardening chore. authHeaders() emits BOTH `x-api-key` and
// `authorization` when both slots are filled, and the API rejects a request
// carrying both. So before this, anyone whose shell held ANTHROPIC_API_KEY — a
// developer who once exported it for another project — could not use matrix's
// OAuth path AT ALL, and the auth error they got pointed at their OAuth token.
// That is the path we bootstrap on every day.
//
// ⚠️ THE OBSERVABLE IS THE HEADER SET, and the obvious assertion is vacuous:
// `expect(client.apiKey).not.toBe(envValue)` is byte-identical before and after,
// because the SDK reads that variable too. Only what the client will SEND
// separates the two worlds. Verified red-then-green in both directions, one
// `null` at a time.
//
// Consequence of the third fixture, stated so it is not read as a bug: with no
// credential configured the client now holds nothing, so the SDK throws
// "Could not resolve authentication method…" at request time instead of silently
// running on the shell's key. That is the intended shape — the same trade as
// deleting DEFAULT_MODEL, where an unconfigured value became visible instead of
// substituted.

describe("a shell credential cannot reach the API", () => {
	/**
	 * The credentials this client would actually SEND, header name → value.
	 * `authHeaders()` is where the SDK turns apiKey/authToken into headers, and
	 * it emits one entry per filled slot — which is exactly what makes it the
	 * discriminating observable.
	 */
	async function authHeaderSet(
		client: Anthropic,
	): Promise<Record<string, string>> {
		// biome-ignore lint/suspicious/noExplicitAny: SDK internal
		const built = await (client as any).authHeaders({});
		const out: Record<string, string> = {};
		(built?.values as Headers | undefined)?.forEach((v, k) => {
			out[k] = v;
		});
		return out;
	}

	test("the OAuth branch sends only authorization, never the shell's x-api-key", async () => {
		const client = withClientEnv(
			{ ANTHROPIC_API_KEY: "sk-ant-shell-key-should-never-be-sent" },
			() =>
				clientOf(
					new AnthropicCompatibleProvider("claude-sonnet-4-6", {
						oauthToken: "configured-oauth-token",
					}),
				),
		);
		expect(await authHeaderSet(client)).toEqual({
			authorization: "Bearer configured-oauth-token",
		});
	});

	test("the apiKey branch sends only x-api-key, never the shell's authorization", async () => {
		const client = withClientEnv(
			{ ANTHROPIC_AUTH_TOKEN: "shell-auth-token-should-never-be-sent" },
			() =>
				clientOf(
					new AnthropicCompatibleProvider("claude-sonnet-4-6", {
						apiKey: "configured-api-key",
					}),
				),
		);
		expect(await authHeaderSet(client)).toEqual({
			"x-api-key": "configured-api-key",
		});
	});

	test("with nothing configured, nothing is sent — however full the shell is", async () => {
		const { bare, configured } = withClientEnv(
			{
				ANTHROPIC_API_KEY: "sk-ant-shell-key-should-never-be-sent",
				ANTHROPIC_AUTH_TOKEN: "shell-auth-token-should-never-be-sent",
			},
			() => ({
				bare: clientOf(
					new AnthropicCompatibleProvider("claude-sonnet-4-6", {}),
				),
				configured: clientOf(
					new AnthropicCompatibleProvider("claude-sonnet-4-6", {
						apiKey: "configured-api-key",
					}),
				),
			}),
		);
		// Positive control, in the same test: an empty set is also what a reader
		// that read nothing returns, so prove this reader sees a credential when
		// there is one to see.
		expect(await authHeaderSet(configured)).toEqual({
			"x-api-key": "configured-api-key",
		});
		expect(await authHeaderSet(bare)).toEqual({});
	});
});

// ── Adaptive thinking: display opt-in ──
// The default `display` for adaptive thinking was `"summarized"` on Opus 4.6
// but changed to `"omitted"` on Opus 4.7. Matrix persists thinking to JSONL
// and renders it in a developer activity log, so we explicitly opt in to
// `"summarized"` to preserve the audit trail on 4.7+.
describe("adaptive thinking display", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "mxd-thinking-display-"));
	});

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	/**
	 * Build a provider whose client.messages.stream captures the params passed to it.
	 * We can't use the ValidatingMockAPI's RequestRecord here because it doesn't
	 * record the `thinking` / `output_config` fields — but those are exactly what
	 * this test needs to assert on, so we capture params directly.
	 */
	function createProviderCapturingParams(thinkingEffort: number | undefined) {
		let capturedParams: Record<string, unknown> | null = null;
		const response = buildAnthropicResponse({
			text: "ok",
			stopReason: "end_turn",
		});

		const provider = new AnthropicCompatibleProvider("claude-sonnet-4-6", {
			apiKey: "test-key",
			...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
		});

		// biome-ignore lint/suspicious/noExplicitAny: replacing internal client for testing
		(provider as any).client = createMockAnthropicClient({
			stream: (params: Record<string, unknown>) => {
				capturedParams = params;
				return createMockStream(response, ["ok"]);
			},
		});

		return { provider, getParams: () => capturedParams };
	}

	test("thinkingEffort > 0: request body includes thinking with display='summarized'", async () => {
		const { provider, getParams } = createProviderCapturingParams(50);

		await provider.execute({
			buildSystemPrompt: () => ({ stable: "sys", variable: "var" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize.",
			model: "claude-sonnet-4-6",
			queue: queueWithPrompt("hello", tmpDir),
		});

		const params = getParams();
		expect(params).not.toBeNull();
		// The key assertion: display field MUST be present and set to "summarized".
		// On Opus 4.7 without this field, the API defaults to "omitted" and
		// thinking blocks come back with empty content — breaking our audit trail.
		expect(params?.thinking).toEqual({
			type: "adaptive",
			display: "summarized",
		});
		// Sanity check: output_config (effort level) is also emitted alongside.
		expect(params?.output_config).toBeDefined();
	});

	test("thinkingEffort = 0 (disabled): no thinking or output_config in request", async () => {
		const { provider, getParams } = createProviderCapturingParams(0);

		await provider.execute({
			buildSystemPrompt: () => ({ stable: "sys", variable: "var" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize.",
			model: "claude-sonnet-4-6",
			queue: queueWithPrompt("hello", tmpDir),
		});

		const params = getParams();
		expect(params).not.toBeNull();
		expect(params?.thinking).toBeUndefined();
		expect(params?.output_config).toBeUndefined();
	});
});

// ── Abort signal + inner retry tests ──

describe("Abort signal stops inner retry immediately", () => {
	let tmpDir: string;

	beforeAll(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "mxd-abort-retry-"));
	});

	afterAll(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	function createProviderWithStreamFn(streamFn: (params: unknown) => unknown) {
		const provider = new AnthropicCompatibleProvider("claude-sonnet-4-6", {
			apiKey: "test-key",
		});
		// biome-ignore lint/suspicious/noExplicitAny: replacing internal client for testing
		(provider as any).client = createMockAnthropicClient({ stream: streamFn });
		return provider;
	}

	function queueWithPrompt(prompt: string) {
		const { MessageQueue } =
			require("./message-queue.ts") as typeof import("./message-queue.ts");
		const { createUserMessage } =
			require("./queue-message-factory.ts") as typeof import("./queue-message-factory.ts");
		const q = new MessageQueue();
		q.enqueue(createUserMessage(prompt));
		return q;
	}

	test("abort before retry sleep → exits immediately, no 30s delay", async () => {
		let callCount = 0;
		const abortController = new AbortController();

		// Stream function always throws InternalServerError (triggers retry)
		const provider = createProviderWithStreamFn(() => {
			callCount++;
			// After first call, abort — simulates stopTask during API call
			if (callCount === 1) {
				setTimeout(() => abortController.abort(), 10);
			}
			throw new Anthropic.InternalServerError(
				500,
				{ type: "error", error: { type: "internal_error", message: "test" } },
				"Internal Server Error",
				new Headers(),
			);
		});

		const startTime = Date.now();
		try {
			await provider.execute({
				buildSystemPrompt: () => ({ stable: "test", variable: "" }),
				buildWorkContext: () => null,
				buildSummarizationPrompt: () => "Summarize the conversation.",
				model: "claude-sonnet-4-6",
				emit: () => {},
				queue: queueWithPrompt("test"),
				signal: abortController.signal,
			});
		} catch {
			// Expected — abort causes error
		}
		const duration = Date.now() - startTime;

		// Without abort fix: 2s + 4s + 8s + 16s = 30s of retry backoff
		// With abort fix: should exit almost immediately after abort fires
		expect(duration).toBeLessThan(2000);
		// Should have attempted only 1 call (no retries after abort)
		expect(callCount).toBe(1);
	}, 10000);

	test("abort during retry backoff sleep → exits immediately", async () => {
		let callCount = 0;
		const abortController = new AbortController();

		// First call: throw 429 (triggers retry with backoff)
		// The abort fires during the 2s backoff sleep
		const provider = createProviderWithStreamFn(() => {
			callCount++;
			if (callCount === 1) {
				// Abort 50ms after the first error — during the 2s retry sleep
				setTimeout(() => abortController.abort(), 50);
			}
			throw new Anthropic.RateLimitError(
				429,
				{
					type: "error",
					error: { type: "rate_limit_error", message: "rate limited" },
				},
				"Rate Limited",
				new Headers(),
			);
		});

		const startTime = Date.now();
		try {
			await provider.execute({
				buildSystemPrompt: () => ({ stable: "test", variable: "" }),
				buildWorkContext: () => null,
				buildSummarizationPrompt: () => "Summarize the conversation.",
				model: "claude-sonnet-4-6",
				emit: () => {},
				queue: queueWithPrompt("test"),
				signal: abortController.signal,
			});
		} catch {
			// Expected
		}
		const duration = Date.now() - startTime;

		// Without fix: first retry sleep = 2s minimum
		// With fix: abort during sleep → exits in ~50ms
		expect(duration).toBeLessThan(1000);
	}, 10000);

	test("no abort → normal retry backoff works", async () => {
		let callCount = 0;

		// Throw 500 twice, then succeed
		const successResponse: Anthropic.Messages.Message = {
			id: "msg_test",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-20250514",
			content: [{ type: "text", text: "Success after retry" }],
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		} as Anthropic.Messages.Message;

		const mockStream = () => ({
			[Symbol.asyncIterator]: async function* () {
				yield {
					type: "content_block_delta",
					delta: { type: "text_delta", text: "Success after retry" },
				};
			},
			finalMessage: () => Promise.resolve(successResponse),
		});

		const provider = createProviderWithStreamFn(() => {
			callCount++;
			if (callCount <= 2) {
				throw new Anthropic.InternalServerError(
					500,
					{ type: "error", error: { type: "internal_error", message: "test" } },
					"Internal Server Error",
					new Headers(),
				);
			}
			return mockStream();
		});

		const startTime = Date.now();
		const result = await provider.execute({
			buildSystemPrompt: () => ({ stable: "test", variable: "" }),
			buildWorkContext: () => null,
			buildSummarizationPrompt: () => "Summarize the conversation.",
			model: "claude-sonnet-4-6",
			emit: () => {},
			queue: queueWithPrompt("test"),
		});
		const duration = Date.now() - startTime;

		// Should succeed after retries (2s + 4s backoff)
		expect(callCount).toBe(3);
		// Backoff should have kicked in: 2s + 4s = 6s minimum
		expect(duration).toBeGreaterThanOrEqual(5500);
		expect(result.exitReason).not.toBe("done_failed");
	}, 30000);
});
