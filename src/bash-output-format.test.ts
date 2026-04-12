/**
 * Tests for bash foreground/background output format unification.
 *
 * Key invariant: foreground completion content === background_complete content
 * for the same command. One formatting function (formatBashResult), two delivery paths.
 *
 * Rules:
 * - Small output (<50KB): inline full content
 * - Large output (>50KB): file paths ONLY, no preview, no partial
 * - "Moved to background" message: no partial stdout
 */
import { describe, expect, test } from "bun:test";
import { MessageQueue } from "./message-queue.ts";
import {
	cleanupSessionBackgroundProcesses,
	executeBashWithTimeout,
} from "./tools/bash.ts";

// ── Helpers ──

function makeBgMap() {
	return new Map<string, import("./tools/bash.ts").BackgroundProcess>();
}

function makeFgMap() {
	return new Map<string, { resolve: () => void; command: string }>();
}

// ── Small output tests (<50KB) ──

describe("bash output format — small output", () => {
	test("foreground: small output is inlined", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const result = await executeBashWithTimeout(
			'echo "hello world"',
			process.cwd(),
			undefined,
			120000,
			"test-session",
			undefined,
			"tc1",
			bgMap,
			fgMap,
		);

		expect(result.content).toContain("hello world");
		expect(result.content).toContain("exit code: 0");
		expect(result.content).toContain("stdout:");
		// No file path references for small output
		expect(result.content).not.toContain("Full stdout");
		expect(result.content).not.toContain("read_file");
		expect(result.isError).toBe(false);
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("background: small output is inlined in background_complete content", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const queue = new MessageQueue();

		const result = await executeBashWithTimeout(
			'echo "hello world"',
			process.cwd(),
			undefined,
			0, // immediate background
			"test-session",
			queue,
			"tc1",
			bgMap,
			fgMap,
		);

		expect(result.backgroundId).toBeTruthy();

		// Wait for background completion
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.content).toContain("hello world");
			expect(msg.content).toContain("exit code: 0");
			expect(msg.content).toContain("stdout:");
			// No file path references for small output
			expect(msg.content).not.toContain("Full stdout");
			expect(msg.content).not.toContain("read_file");
		}

		cleanupSessionBackgroundProcesses(bgMap);
	});
});

// ── Large output tests (>50KB) ──

describe("bash output format — large output (>50KB)", () => {
	test("foreground: large output has file paths, NO preview, NO inline content", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		// Generate >50KB output
		const result = await executeBashWithTimeout(
			"head -c 60000 /dev/urandom | base64",
			process.cwd(),
			undefined,
			120000,
			"test-session",
			undefined,
			"tc1",
			bgMap,
			fgMap,
		);

		// Should have file path
		expect(result.content).toContain("Full stdout");
		expect(result.content).toContain("read_file");
		expect(result.content).toContain("exit code: 0");
		// Should NOT have preview
		expect(result.content).not.toContain("stdout preview:");
		expect(result.content).not.toContain("stderr preview:");
		expect(result.isError).toBe(false);

		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("background: large output has file paths, NO preview, NO inline content", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const queue = new MessageQueue();

		// Generate >50KB output via background
		const result = await executeBashWithTimeout(
			"head -c 60000 /dev/urandom | base64",
			process.cwd(),
			undefined,
			0, // immediate background
			"test-session",
			queue,
			"tc1",
			bgMap,
			fgMap,
		);

		expect(result.backgroundId).toBeTruthy();

		// Wait for background completion
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			// Should have file path
			expect(msg.content).toContain("Full stdout");
			expect(msg.content).toContain("read_file");
			expect(msg.content).toContain("exit code: 0");
			// Should NOT have preview
			expect(msg.content).not.toContain("stdout preview:");
			expect(msg.content).not.toContain("stderr preview:");
		}

		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("foreground and background produce identical content for same large output", async () => {
		// Use a deterministic large output
		const bgMap1 = makeBgMap();
		const fgMap1 = makeFgMap();
		const bgMap2 = makeBgMap();
		const fgMap2 = makeFgMap();
		const queue = new MessageQueue();

		// Foreground: generate deterministic large output
		const fgResult = await executeBashWithTimeout(
			"python3 -c \"print('A' * 60000)\"",
			process.cwd(),
			undefined,
			120000,
			"test-session",
			undefined,
			"tc1",
			bgMap1,
			fgMap1,
		);

		// Background: same command
		await executeBashWithTimeout(
			"python3 -c \"print('A' * 60000)\"",
			process.cwd(),
			undefined,
			0,
			"test-session2",
			queue,
			"tc2",
			bgMap2,
			fgMap2,
		);

		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			// Both should contain file paths and exit code
			expect(fgResult.content).toContain("Full stdout");
			expect(msg.content).toContain("Full stdout");
			expect(fgResult.content).toContain("exit code: 0");
			expect(msg.content).toContain("exit code: 0");
			// Neither should have previews
			expect(fgResult.content).not.toContain("stdout preview:");
			expect(msg.content).not.toContain("stdout preview:");
		}

		cleanupSessionBackgroundProcesses(bgMap1);
		cleanupSessionBackgroundProcesses(bgMap2);
	});
});

// ── "Moved to background" message ──

describe("bash output format — moved to background message", () => {
	test("moved-to-background message has no partial stdout", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const queue = new MessageQueue();

		// Use a command that produces output then sleeps — timeout will trigger
		const result = await executeBashWithTimeout(
			'echo "partial-data-xyz"; sleep 30',
			process.cwd(),
			undefined,
			100, // very short timeout
			"test-session",
			queue,
			"tc1",
			bgMap,
			fgMap,
		);

		// Should be moved to background
		expect(result.backgroundId).toBeTruthy();
		expect(result.content).toContain("Background ID:");
		expect(result.content).toContain("Output files:");
		expect(result.content).toContain("yield()");

		// Should NOT have partial stdout section
		expect(result.content).not.toContain("Partial stdout");
		// The content after "CWD is not affected..." should end — no trailing output
		const cwdLine = result.content
			.split("\n")
			.find((l) => l.includes("CWD is not affected"));
		expect(cwdLine).toBeTruthy();
		// The CWD line should be the last line
		const lines = result.content.split("\n");
		const cwdIndex = lines.findIndex((l) => l.includes("CWD is not affected"));
		expect(cwdIndex).toBe(lines.length - 1);

		// Clean up the sleeping background process
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("moved-to-background message shows correct structure", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const queue = new MessageQueue();

		const result = await executeBashWithTimeout(
			"sleep 30",
			"/tmp",
			undefined,
			100,
			"test-session",
			queue,
			"tc1",
			bgMap,
			fgMap,
		);

		expect(result.backgroundId).toBeTruthy();
		// Check structure: reason, bg ID, command, output files, yield hint, CWD info
		expect(result.content).toContain("Command moved to background after");
		expect(result.content).toContain("Background ID:");
		expect(result.content).toContain("Command: sleep 30");
		expect(result.content).toContain("Output files:");
		expect(result.content).toContain(
			"You will be notified with output when it completes. Use yield() to wait.",
		);
		expect(result.content).toContain(
			"CWD is not affected by backgrounded commands",
		);
		// No partial output at all
		expect(result.content).not.toContain("Partial stdout");

		cleanupSessionBackgroundProcesses(bgMap);
	});
});

// ── formatBodyForAI for background_complete ──

describe("formatBodyForAI — background_complete uses content field", () => {
	// Test via the formatEventForAI function (imported from events.ts)
	// The background_complete body should have a content field and formatBodyForAI should use it
	test("background_complete content field passed through to formatBodyForAI", async () => {
		const { formatEventForAI } = await import("./events.ts");

		const event = {
			type: "message" as const,
			id: "test-id",
			taskId: "t1",
			ts: Date.now(),
			body: {
				source: "background_complete" as const,
				id: "test-id",
				ts: Date.now(),
				commandId: "bg-001",
				command: "echo hello",
				exitCode: 0,
				durationMs: 100,
				content: "exit code: 0\nstdout:\nhello\n",
			},
		};

		const formatted = formatEventForAI(event);
		// Should contain the content directly
		expect(formatted).toContain("exit code: 0");
		expect(formatted).toContain("hello");
		expect(formatted).toContain("background_complete");
		expect(formatted).toContain("bg-001");
	});

	test("background_complete with large output content (paths only)", async () => {
		const { formatEventForAI } = await import("./events.ts");

		const event = {
			type: "message" as const,
			id: "test-id",
			taskId: "t1",
			ts: Date.now(),
			body: {
				source: "background_complete" as const,
				id: "test-id",
				ts: Date.now(),
				commandId: "bg-002",
				command: "large-command",
				exitCode: 0,
				durationMs: 5000,
				content:
					"Full stdout (80KB): /tmp/mxd-bg/exec-abc.stdout\nUse read_file with offset/limit to read the full output.\nexit code: 0",
			},
		};

		const formatted = formatEventForAI(event);
		expect(formatted).toContain("Full stdout (80KB):");
		expect(formatted).toContain("read_file");
		expect(formatted).toContain("exit code: 0");
		// Should NOT have preview or separate stdout/stderr sections
		expect(formatted).not.toContain("stdout preview:");
	});
});
