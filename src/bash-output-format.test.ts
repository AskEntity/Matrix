/**
 * Tests for bash tool tiered output handling.
 *
 * Design axis: how big is the output?
 *   <1024 bytes         → inline only, no file
 *   1024..10240 bytes   → full inline + file saved + top/bottom banner
 *   >10240 bytes        → head+tail truncation + file saved + banner + hint
 *
 * Design axis: do we separate stdout/stderr?
 *   separate=false (default): one `.out` file, streams merged via `(cmd) 2>&1`
 *   separate=true: two files (`.stdout` + `.stderr`), budget-allocated display
 *
 * Foreground completion and background_complete use the SAME formatter.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MessageQueue } from "./message-queue.ts";
import {
	allocateSeparateBudget,
	cleanupSessionBackgroundProcesses,
	executeBashWithTimeout,
	formatMergedOutput,
	formatSeparateOutput,
	truncateMiddle,
} from "./tools/bash.ts";

// ── Helpers ──

function makeBgMap() {
	return new Map<string, import("./tools/bash.ts").BackgroundProcess>();
}

function makeFgMap() {
	return new Map<string, { resolve: () => void; command: string }>();
}

const TMP_ROOT = "/tmp/mxd-test-bash";
beforeEach(() => {
	if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
	mkdirSync(TMP_ROOT, { recursive: true });
});
afterEach(() => {
	if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ── Pure-function tests: truncateMiddle ──

describe("truncateMiddle", () => {
	test("respects newline alignment at head", () => {
		const content = Buffer.from(
			"line1\nline2\nline3\nline4\nline5\nline6\nline7\n",
		);
		const { head, tail, midCut } = truncateMiddle(content, 12, 12);
		expect(midCut).toBe(false);
		// head ends on a newline
		expect(head.toString().endsWith("\n")).toBe(true);
		// tail starts after a newline (first line is a complete line)
		expect(tail.toString().startsWith("line")).toBe(true);
	});

	test("hard-cuts when no newline in head window", () => {
		// 10000 chars, one big line, no newline in first 5120 bytes
		const content = Buffer.from("A".repeat(10000));
		const { head, tail, midCut } = truncateMiddle(content, 5120, 5120);
		expect(midCut).toBe(true);
		expect(head.length).toBe(5120);
		expect(tail.length).toBe(5120);
	});

	test("finds newlines within budget windows", () => {
		const content = Buffer.from("ab\ncd\nef\ngh\nij\n");
		// head budget 5 → can find '\n' at pos 2 ("ab\n")
		// tail budget 5 → can find '\n' in last 5 bytes
		const { head, midCut } = truncateMiddle(content, 5, 5);
		expect(midCut).toBe(false);
		// head ends on newline
		expect(head[head.length - 1]).toBe(0x0a);
		// caller decides whether head+tail >= total means "full"
	});
});

// ── Pure-function tests: allocateSeparateBudget ──

describe("allocateSeparateBudget", () => {
	test("stderr=0 (trivial) → stdout gets 5k head + 5k tail", () => {
		const alloc = allocateSeparateBudget(50_000, 0);
		expect(alloc.stderr).toBe("full");
		if (alloc.stdout !== "full") {
			expect(alloc.stdout.head).toBe(5120);
			expect(alloc.stdout.tail).toBe(5120);
		}
	});

	test("stderr=5120 boundary → both shown in 5k/5k total (stderr full)", () => {
		// stdout > TRIVIAL (so first branch fails), stderr === TRIVIAL
		const alloc = allocateSeparateBudget(50_000, 5120);
		expect(alloc.stderr).toBe("full");
		if (alloc.stdout !== "full") {
			// remaining = 10240 - 5120 = 5120 → half = 2560
			expect(alloc.stdout.head).toBe(2560);
			expect(alloc.stdout.tail).toBe(2560);
		}
	});

	test("stderr=5121 (just above boundary) → both 2.5k+2.5k (continuous)", () => {
		const alloc = allocateSeparateBudget(50_000, 5121);
		expect(alloc.stdout).not.toBe("full");
		expect(alloc.stderr).not.toBe("full");
		if (alloc.stdout !== "full") expect(alloc.stdout.head).toBe(2560);
		if (alloc.stderr !== "full") expect(alloc.stderr.head).toBe(2560);
	});

	test("stderr=3072 (3K) trivial → stdout gets 3584/3584", () => {
		const alloc = allocateSeparateBudget(50_000, 3072);
		expect(alloc.stderr).toBe("full");
		if (alloc.stdout !== "full") {
			expect(alloc.stdout.head).toBe(3584);
			expect(alloc.stdout.tail).toBe(3584);
		}
	});

	test("stdout trivial → stderr gets split, stdout full", () => {
		const alloc = allocateSeparateBudget(2_048, 50_000);
		expect(alloc.stdout).toBe("full");
		if (alloc.stderr !== "full") {
			// remaining = 10240 - 2048 = 8192 → half = 4096
			expect(alloc.stderr.head).toBe(4096);
			expect(alloc.stderr.tail).toBe(4096);
		}
	});

	test("both non-trivial → each 2.5k+2.5k", () => {
		const alloc = allocateSeparateBudget(20_000, 30_000);
		expect(alloc.stdout).not.toBe("full");
		expect(alloc.stderr).not.toBe("full");
		if (alloc.stdout !== "full") expect(alloc.stdout.head).toBe(2560);
		if (alloc.stderr !== "full") expect(alloc.stderr.head).toBe(2560);
	});
});

// ── Pure-function tests: formatMergedOutput ──

describe("formatMergedOutput", () => {
	test("empty file → simple exit-code line, no file kept", () => {
		const path = join(TMP_ROOT, "empty.out");
		writeFileSync(path, "");
		const { content, keepFile } = formatMergedOutput(path, 0);
		expect(content).toBe("exit code: 0");
		expect(keepFile).toBe(false);
	});

	test("small (<1024) → inline, no file kept, no banner", () => {
		const path = join(TMP_ROOT, "small.out");
		writeFileSync(path, "hello world\n");
		const { content, keepFile } = formatMergedOutput(path, 0);
		expect(content).toContain("hello world");
		expect(content).toContain("exit code: 0");
		expect(content).not.toContain("Full output:");
		expect(keepFile).toBe(false);
	});

	test("medium (2KB) → full inline + top/bottom banner + file kept", () => {
		const path = join(TMP_ROOT, "medium.out");
		const text = `${"x".repeat(2000)}\n`;
		writeFileSync(path, text);
		const { content, keepFile } = formatMergedOutput(path, 0);
		expect(keepFile).toBe(true);
		// Banner appears twice (top + bottom)
		const bannerMatches = content.match(/Full output:/g);
		expect(bannerMatches?.length).toBe(2);
		// Full content preserved (not truncated)
		expect(content).toContain("x".repeat(2000));
		expect(content).toContain("exit code: 0");
	});

	test("10KB exact boundary → full inline, no truncation marker", () => {
		// 10240 bytes exactly — head_budget(5k) + tail_budget(5k) covers full
		const path = join(TMP_ROOT, "boundary.out");
		const text = "x".repeat(10240);
		writeFileSync(path, text);
		const { content, keepFile } = formatMergedOutput(path, 0);
		expect(keepFile).toBe(true);
		// No truncation marker
		expect(content).not.toContain("truncated");
		// Full content preserved
		expect(content).toContain(text);
	});

	test("large (50KB) → head + truncation marker + tail + banner + hint", () => {
		const path = join(TMP_ROOT, "large.out");
		const lines: string[] = [];
		// ~5000 lines × 10 bytes = ~50KB
		for (let i = 0; i < 5000; i++)
			lines.push(`line-${i.toString().padStart(5, "0")}`);
		const text = `${lines.join("\n")}\n`;
		writeFileSync(path, text);
		const { content, keepFile } = formatMergedOutput(path, 0);
		expect(keepFile).toBe(true);
		expect(content).toContain("Full output:");
		expect(content).toContain("truncated");
		expect(content).toContain("line-00000"); // head
		expect(content).toContain("line-04999"); // tail
		// NOT present: middle lines
		expect(content).not.toContain("line-02500");
		// Read hint at bottom
		expect(content).toContain("Read:");
	});

	test("single-line 100KB (no newlines) → hard byte cut + mid-line-cut marker", () => {
		const path = join(TMP_ROOT, "long-line.out");
		const text = "A".repeat(100_000);
		writeFileSync(path, text);
		const { content, keepFile } = formatMergedOutput(path, 0);
		expect(keepFile).toBe(true);
		expect(content).toContain("mid-line cut");
	});
});

// ── Pure-function tests: formatSeparateOutput ──

describe("formatSeparateOutput", () => {
	test("total=0 → simple exit-code line, no files kept", () => {
		const so = join(TMP_ROOT, "a.stdout");
		const se = join(TMP_ROOT, "a.stderr");
		writeFileSync(so, "");
		writeFileSync(se, "");
		const { content, keepFiles } = formatSeparateOutput(so, se, 0);
		expect(content).toBe("exit code: 0");
		expect(keepFiles).toBe(false);
	});

	test("total 800 bytes (<1024) → no file saved, two labeled sections", () => {
		const so = join(TMP_ROOT, "small.stdout");
		const se = join(TMP_ROOT, "small.stderr");
		writeFileSync(so, "x".repeat(400));
		writeFileSync(se, "e".repeat(200));
		const { content, keepFiles } = formatSeparateOutput(so, se, 0);
		expect(keepFiles).toBe(false);
		expect(content).toContain("stdout:");
		expect(content).toContain("stderr:");
		expect(content).toContain("x".repeat(400));
		expect(content).toContain("e".repeat(200));
		expect(content).not.toContain("Full stdout:");
	});

	test("total 5KB (medium) → two files, full inline, top/bottom banners list both paths", () => {
		const so = join(TMP_ROOT, "med.stdout");
		const se = join(TMP_ROOT, "med.stderr");
		const stdoutText = `${"a".repeat(2500)}\n`;
		const stderrText = `${"b".repeat(2500)}\n`;
		writeFileSync(so, stdoutText);
		writeFileSync(se, stderrText);
		const { content, keepFiles } = formatSeparateOutput(so, se, 0);
		expect(keepFiles).toBe(true);
		// Both banners appear twice (top+bottom)
		expect(content.match(/Full stdout:/g)?.length).toBe(2);
		expect(content.match(/Full stderr:/g)?.length).toBe(2);
		expect(content).toContain(so);
		expect(content).toContain(se);
		// Full content shown
		expect(content).toContain(stdoutText.trim());
		expect(content).toContain(stderrText.trim());
	});

	test("large + stdout trivial (2KB) + stderr 50KB → stdout full, stderr head 4KB + tail 4KB", () => {
		const so = join(TMP_ROOT, "t1.stdout");
		const se = join(TMP_ROOT, "t1.stderr");
		const stdoutText = `${"a".repeat(2000)}\n`; // 2001 bytes
		const stderrLines: string[] = [];
		for (let i = 0; i < 2000; i++) stderrLines.push(`err-line-${i}`);
		const stderrText = `${stderrLines.join("\n")}\n`; // ~24KB
		writeFileSync(so, stdoutText);
		writeFileSync(se, stderrText);
		const { content, keepFiles } = formatSeparateOutput(so, se, 1);
		expect(keepFiles).toBe(true);
		// stdout full (no truncation in stdout block)
		expect(content).toContain("a".repeat(2000));
		// stderr truncated
		expect(content).toContain("err-line-0"); // head
		expect(content).toContain("err-line-1999"); // tail
		// Middle lines absent
		expect(content).not.toContain("err-line-1000");
		expect(content).toContain("truncated");
	});

	test("large + stderr trivial (0 bytes) + stdout 50KB → stdout head 5KB + tail 5KB, stderr empty", () => {
		const so = join(TMP_ROOT, "t2.stdout");
		const se = join(TMP_ROOT, "t2.stderr");
		const stdoutLines: string[] = [];
		for (let i = 0; i < 5000; i++) stdoutLines.push(`out-line-${i}`);
		const stdoutText = `${stdoutLines.join("\n")}\n`; // ~60KB
		writeFileSync(so, stdoutText);
		writeFileSync(se, "");
		const { content, keepFiles } = formatSeparateOutput(so, se, 0);
		expect(keepFiles).toBe(true);
		expect(content).toContain("out-line-0"); // head
		expect(content).toContain("out-line-4999"); // tail
		expect(content).not.toContain("out-line-2500");
	});

	test("large + neither trivial (stdout=20KB, stderr=30KB) → each 2.5k head + 2.5k tail", () => {
		const so = join(TMP_ROOT, "t3.stdout");
		const se = join(TMP_ROOT, "t3.stderr");
		const stdoutLines: string[] = [];
		for (let i = 0; i < 2000; i++) stdoutLines.push(`out-${i}`);
		const stderrLines: string[] = [];
		for (let i = 0; i < 3000; i++) stderrLines.push(`err-${i}`);
		writeFileSync(so, `${stdoutLines.join("\n")}\n`);
		writeFileSync(se, `${stderrLines.join("\n")}\n`);
		const { content } = formatSeparateOutput(so, se, 0);
		// Both truncated — both show head AND tail
		expect(content).toContain("out-0");
		expect(content).toContain("out-1999");
		expect(content).toContain("err-0");
		expect(content).toContain("err-2999");
		// Middle absent for each
		expect(content).not.toContain("out-1000");
		expect(content).not.toContain("err-1500");
	});
});

// ── Integration tests: executeBashWithTimeout ──

describe("executeBashWithTimeout — merged mode (default)", () => {
	test("small output: inline, no file", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const result = await executeBashWithTimeout(
			'echo "hello world"',
			process.cwd(),
			undefined,
			120_000,
			"sess",
			undefined,
			"tc1",
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("hello world");
		expect(result.content).toContain("exit code: 0");
		expect(result.content).not.toContain("Full output:");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("stderr ends up merged into output (stream merging)", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const result = await executeBashWithTimeout(
			'echo "to-stderr" >&2',
			process.cwd(),
			undefined,
			120_000,
			"sess",
			undefined,
			"tc1",
			bgMap,
			fgMap,
		);
		// stderr content visible without `2>&1` in the command
		expect(result.content).toContain("to-stderr");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("empty output: no file, no content section", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const result = await executeBashWithTimeout(
			"true",
			process.cwd(),
			undefined,
			120_000,
			"sess",
			undefined,
			"tc1",
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("exit code: 0");
		expect(result.content).not.toContain("Full output:");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("medium output (2KB): full inline + banner + file kept; readable after", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		// 2000 'x' characters
		const result = await executeBashWithTimeout(
			"python3 -c \"print('x' * 2000)\"",
			process.cwd(),
			undefined,
			120_000,
			"sess",
			undefined,
			"tc1",
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("Full output:");
		expect(result.content).toContain("x".repeat(2000));
		// Extract file path from banner
		const match = result.content.match(/Full output: (\S+\.out)/);
		expect(match).toBeTruthy();
		const savedPath = match?.[1];
		if (savedPath) {
			expect(existsSync(savedPath)).toBe(true);
			const saved = readFileSync(savedPath, "utf-8");
			expect(saved).toContain("x".repeat(2000));
			// Cleanup
			rmSync(savedPath, { force: true });
		}
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("large output (50KB): head/tail truncation + hint", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const result = await executeBashWithTimeout(
			"python3 -c \"import sys; [print(f'line-{i}') for i in range(5000)]\"",
			process.cwd(),
			undefined,
			120_000,
			"sess",
			undefined,
			"tc1",
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("Full output:");
		expect(result.content).toContain("truncated");
		expect(result.content).toContain("Read:");
		expect(result.content).toContain("line-0"); // head
		expect(result.content).toContain("line-4999"); // tail
		expect(result.content).not.toContain("line-2500"); // middle cut
		const match = result.content.match(/Full output: (\S+\.out)/);
		if (match?.[1]) rmSync(match[1], { force: true });
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("10KB boundary (exact): full inline, no truncation marker", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		// Produce exactly 10240 bytes: 10 blocks of 1024 'a's
		const result = await executeBashWithTimeout(
			// 1024 × 10 = 10240 bytes, no trailing newline via printf
			'printf "%s" "$(python3 -c "print(\'a\' * 10240, end=\'\')")"',
			process.cwd(),
			undefined,
			120_000,
			"sess",
			undefined,
			"tc1",
			bgMap,
			fgMap,
		);
		expect(result.content).toContain("Full output:");
		// No truncation marker because head+tail (5k+5k) == 10240 == total
		expect(result.content).not.toContain("truncated");
		const match = result.content.match(/Full output: (\S+\.out)/);
		if (match?.[1]) rmSync(match[1], { force: true });
		cleanupSessionBackgroundProcesses(bgMap);
	});
});

describe("executeBashWithTimeout — separate mode", () => {
	test("small total: two labeled sections, no file", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const result = await executeBashWithTimeout(
			"echo out-hello; echo err-hello >&2",
			process.cwd(),
			undefined,
			120_000,
			"sess",
			undefined,
			"tc1",
			bgMap,
			fgMap,
			true, // separate
		);
		expect(result.content).toContain("stdout:");
		expect(result.content).toContain("stderr:");
		expect(result.content).toContain("out-hello");
		expect(result.content).toContain("err-hello");
		expect(result.content).not.toContain("Full stdout:");
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("medium total (5KB): two files saved, both inline, banners list both", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const result = await executeBashWithTimeout(
			"python3 -c \"print('a' * 2500); import sys; print('b' * 2500, file=sys.stderr)\"",
			process.cwd(),
			undefined,
			120_000,
			"sess",
			undefined,
			"tc1",
			bgMap,
			fgMap,
			true,
		);
		expect(result.content.match(/Full stdout:/g)?.length).toBe(2);
		expect(result.content.match(/Full stderr:/g)?.length).toBe(2);
		expect(result.content).toContain("a".repeat(2500));
		expect(result.content).toContain("b".repeat(2500));
		const soMatch = result.content.match(/Full stdout: (\S+\.stdout)/);
		const seMatch = result.content.match(/Full stderr: (\S+\.stderr)/);
		if (soMatch?.[1]) rmSync(soMatch[1], { force: true });
		if (seMatch?.[1]) rmSync(seMatch[1], { force: true });
		cleanupSessionBackgroundProcesses(bgMap);
	});
});

describe("executeBashWithTimeout — background parity", () => {
	test("background small output matches foreground format", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const queue = new MessageQueue();
		const result = await executeBashWithTimeout(
			'echo "hello"',
			process.cwd(),
			undefined,
			0, // immediate bg
			"sess",
			queue,
			"tc1",
			bgMap,
			fgMap,
		);
		expect(result.backgroundId).toBeTruthy();
		const msg = await queue.wait();
		expect(msg.source).toBe("background_complete");
		if (msg.source === "background_complete") {
			expect(msg.content).toContain("hello");
			expect(msg.content).toContain("exit code: 0");
			expect(msg.content).not.toContain("Full output:");
		}
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("background large output uses same tiered format", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const queue = new MessageQueue();
		const result = await executeBashWithTimeout(
			"python3 -c \"import sys; [print(f'line-{i}') for i in range(5000)]\"",
			process.cwd(),
			undefined,
			0,
			"sess",
			queue,
			"tc1",
			bgMap,
			fgMap,
		);
		expect(result.backgroundId).toBeTruthy();
		const msg = await queue.wait();
		if (msg.source === "background_complete") {
			expect(msg.content).toContain("Full output:");
			expect(msg.content).toContain("truncated");
			expect(msg.content).toContain("Read:");
		}
		cleanupSessionBackgroundProcesses(bgMap);
	});
});

describe("executeBashWithTimeout — moved-to-background message", () => {
	test("moved-to-background shows single output file path in merged mode", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const queue = new MessageQueue();
		const result = await executeBashWithTimeout(
			'echo "partial-data-xyz"; sleep 30',
			process.cwd(),
			undefined,
			100, // short timeout → move to bg
			"sess",
			queue,
			"tc1",
			bgMap,
			fgMap,
		);
		expect(result.backgroundId).toBeTruthy();
		expect(result.content).toContain("Output file:"); // singular for merged mode
		expect(result.content).not.toContain("Output files:"); // plural would be for separate mode
		cleanupSessionBackgroundProcesses(bgMap);
	});

	test("moved-to-background shows both files in separate mode", async () => {
		const bgMap = makeBgMap();
		const fgMap = makeFgMap();
		const queue = new MessageQueue();
		const result = await executeBashWithTimeout(
			"sleep 30",
			process.cwd(),
			undefined,
			100,
			"sess",
			queue,
			"tc1",
			bgMap,
			fgMap,
			true, // separate
		);
		expect(result.backgroundId).toBeTruthy();
		expect(result.content).toContain("Output files:");
		cleanupSessionBackgroundProcesses(bgMap);
	});
});

// ── Preserved: formatBodyForAI for background_complete ──

describe("formatBodyForAI — background_complete uses content field", () => {
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
				content: "exit code: 0\nhello\n",
			},
		};

		const formatted = formatEventForAI(event);
		expect(formatted).toContain("exit code: 0");
		expect(formatted).toContain("hello");
		expect(formatted).toContain("background_complete");
		expect(formatted).toContain("bg-001");
	});

	test("background_complete with large output content (truncated)", async () => {
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
					'Full output: /tmp/mxd/exec-abc.out (50KB, 1200 lines)\nexit code: 0\n<head>\n... [45KB / 1000 lines truncated] ...\n<tail>\nFull output: /tmp/mxd/exec-abc.out (50KB, 1200 lines)\nRead: bash "grep X /tmp/mxd/exec-abc.out" or read_file',
			},
		};

		const formatted = formatEventForAI(event);
		expect(formatted).toContain("Full output:");
		expect(formatted).toContain("truncated");
		expect(formatted).toContain("Read:");
	});
});
