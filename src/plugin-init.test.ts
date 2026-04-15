import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

import manifest from "../.mxd/plugin/index.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "plugin-init-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

// ── 1. Memory content: new project ──

describe("memory.md", () => {
	test("new project gets 'First Launch Checklist' content", async () => {
		await manifest.onProjectInit!(tmp, { isNew: true });
		const content = readFileSync(join(tmp, ".mxd", "memory.md"), "utf-8");
		expect(content).toContain("First Launch Checklist");
		expect(content).toContain("# Project Memory");
	});

	// ── 2. Memory content: existing project ──

	test("existing project gets 'Converted existing project' content", async () => {
		// Pre-create .git so it looks like an existing git repo
		mkdirSync(join(tmp, ".git"), { recursive: true });
		await manifest.onProjectInit!(tmp, { isNew: false });
		const content = readFileSync(join(tmp, ".mxd", "memory.md"), "utf-8");
		expect(content).toContain("Converted existing project");
		expect(content).toContain("setup_worktree.sh");
	});

	// ── 3. Does NOT overwrite existing memory.md ──

	test("does not overwrite existing memory.md", async () => {
		mkdirSync(join(tmp, ".mxd"), { recursive: true });
		writeFileSync(join(tmp, ".mxd", "memory.md"), "custom content", "utf-8");
		// Need .git so isNew: false doesn't git init
		mkdirSync(join(tmp, ".git"), { recursive: true });
		await manifest.onProjectInit!(tmp, { isNew: false });
		const content = readFileSync(join(tmp, ".mxd", "memory.md"), "utf-8");
		expect(content).toBe("custom content");
	});
});

// ── 4-9. Package manager detection ──

describe("setup_worktree.sh.example", () => {
	async function initAndReadHook(lockfile?: string): Promise<string> {
		// git init so excludeWorktrees doesn't fail on missing .git
		mkdirSync(join(tmp, ".git", "info"), { recursive: true });
		if (lockfile) {
			writeFileSync(join(tmp, lockfile), "", "utf-8");
		}
		await manifest.onProjectInit!(tmp, { isNew: false });
		return readFileSync(
			join(tmp, ".mxd", "hooks", "setup_worktree.sh.example"),
			"utf-8",
		);
	}

	// ── 4. bun ──
	test("bun project (bun.lockb)", async () => {
		const script = await initAndReadHook("bun.lockb");
		expect(script).toContain("bun install --frozen-lockfile");
	});

	// ── 5. npm ──
	test("npm project (package-lock.json)", async () => {
		const script = await initAndReadHook("package-lock.json");
		expect(script).toContain("npm ci");
	});

	// ── 6. yarn ──
	test("yarn project (yarn.lock)", async () => {
		const script = await initAndReadHook("yarn.lock");
		expect(script).toContain("yarn install --frozen-lockfile");
	});

	// ── 7. pnpm ──
	test("pnpm project (pnpm-lock.yaml)", async () => {
		const script = await initAndReadHook("pnpm-lock.yaml");
		expect(script).toContain("pnpm install --frozen-lockfile");
	});

	// ── 8. python ──
	test("python project (requirements.txt)", async () => {
		const script = await initAndReadHook("requirements.txt");
		expect(script).toContain("pip install -r requirements.txt");
	});

	// ── 9. generic ──
	test("generic project (no lockfile)", async () => {
		const script = await initAndReadHook();
		expect(script).toContain("#!/bin/bash");
		expect(script).toContain("# Setup hook for new worktrees");
		// Generic template has example commands in comments, not real installs
		expect(script).toContain("# Examples:");
		expect(script).not.toContain("bun install");
	});

	// ── 10. Does NOT overwrite existing .example ──
	test("does not overwrite existing setup_worktree.sh.example", async () => {
		mkdirSync(join(tmp, ".git", "info"), { recursive: true });
		mkdirSync(join(tmp, ".mxd", "hooks"), { recursive: true });
		writeFileSync(
			join(tmp, ".mxd", "hooks", "setup_worktree.sh.example"),
			"my custom example",
			"utf-8",
		);
		await manifest.onProjectInit!(tmp, { isNew: false });
		const content = readFileSync(
			join(tmp, ".mxd", "hooks", "setup_worktree.sh.example"),
			"utf-8",
		);
		expect(content).toBe("my custom example");
	});

	// ── 11. Does NOT overwrite existing real hook ──
	test("does not create .example when setup_worktree.sh exists", async () => {
		mkdirSync(join(tmp, ".git", "info"), { recursive: true });
		mkdirSync(join(tmp, ".mxd", "hooks"), { recursive: true });
		writeFileSync(
			join(tmp, ".mxd", "hooks", "setup_worktree.sh"),
			"my real hook",
			"utf-8",
		);
		await manifest.onProjectInit!(tmp, { isNew: false });
		expect(
			existsSync(join(tmp, ".mxd", "hooks", "setup_worktree.sh.example")),
		).toBe(false);
		// Real hook untouched
		const content = readFileSync(
			join(tmp, ".mxd", "hooks", "setup_worktree.sh"),
			"utf-8",
		);
		expect(content).toBe("my real hook");
	});
});

// ── 12-14. Git initialization ──

describe("git init", () => {
	// ── 12. New project: git init + .gitignore + initial commit ──
	test("new project: git init, .gitignore, initial commit", async () => {
		await manifest.onProjectInit!(tmp, { isNew: true });

		// .git directory created
		expect(existsSync(join(tmp, ".git"))).toBe(true);

		// .gitignore created with expected content
		const gitignore = readFileSync(join(tmp, ".gitignore"), "utf-8");
		expect(gitignore).toContain("node_modules/");
		expect(gitignore).toContain(".env");

		// Initial commit exists
		const proc = Bun.spawnSync(["git", "log", "--oneline", "-1"], {
			cwd: tmp,
		});
		expect(proc.exitCode).toBe(0);
		const log = proc.stdout.toString();
		expect(log).toContain("Initial commit");
	});

	// ── 13. Existing git project: no git init ──
	test("existing git project: skips git init", async () => {
		// Create a real git repo first
		Bun.spawnSync(["git", "init"], { cwd: tmp });
		Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "pre-existing"], {
			cwd: tmp,
		});

		await manifest.onProjectInit!(tmp, { isNew: false });

		// Verify the original commit is still the only one (no new commits added)
		const proc = Bun.spawnSync(["git", "log", "--oneline"], { cwd: tmp });
		expect(proc.exitCode).toBe(0);
		const log = proc.stdout.toString().trim();
		expect(log).toContain("pre-existing");
		expect(log).not.toContain("Initial commit");
	});

	// ── 14. Non-git existing project: git init but no .gitignore/commit ──
	test("non-git existing project: git init but no .gitignore or commit", async () => {
		await manifest.onProjectInit!(tmp, { isNew: false });

		// .git created
		expect(existsSync(join(tmp, ".git"))).toBe(true);

		// No .gitignore created (isNew: false)
		expect(existsSync(join(tmp, ".gitignore"))).toBe(false);

		// No commits (git log fails on empty repo)
		const proc = Bun.spawnSync(["git", "log", "--oneline"], { cwd: tmp });
		expect(proc.exitCode).not.toBe(0);
	});
});

// ── 15. .worktrees in .git/info/exclude ──

describe(".git/info/exclude", () => {
	test(".worktrees added to exclude", async () => {
		await manifest.onProjectInit!(tmp, { isNew: true });
		const exclude = readFileSync(
			join(tmp, ".git", "info", "exclude"),
			"utf-8",
		);
		expect(exclude).toContain(".worktrees");
	});

	test("idempotent — running twice does not duplicate .worktrees", async () => {
		await manifest.onProjectInit!(tmp, { isNew: true });
		// Run again
		await manifest.onProjectInit!(tmp, { isNew: false });
		const exclude = readFileSync(
			join(tmp, ".git", "info", "exclude"),
			"utf-8",
		);
		const matches = exclude.split("\n").filter((l) => l.trim() === ".worktrees");
		expect(matches).toHaveLength(1);
	});

	test("appends to existing exclude content", async () => {
		// Create .git/info/exclude with existing content (no trailing newline)
		mkdirSync(join(tmp, ".git", "info"), { recursive: true });
		writeFileSync(
			join(tmp, ".git", "info", "exclude"),
			"some-dir",
			"utf-8",
		);
		await manifest.onProjectInit!(tmp, { isNew: false });
		const exclude = readFileSync(
			join(tmp, ".git", "info", "exclude"),
			"utf-8",
		);
		expect(exclude).toContain("some-dir");
		expect(exclude).toContain(".worktrees");
		// Properly separated (newline between existing and new)
		expect(exclude).toBe("some-dir\n.worktrees\n");
	});
});
