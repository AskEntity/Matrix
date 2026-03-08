import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "./worktree-manager.ts";

async function exec(cmd: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	return new Response(proc.stdout).text();
}

async function initRepo(dir: string): Promise<void> {
	await exec(["git", "init"], dir);
	await exec(["git", "config", "user.email", "test@test.com"], dir);
	await exec(["git", "config", "user.name", "Test"], dir);
	// Create a minimal package.json so installDeps has something to work with
	await writeFile(
		join(dir, "package.json"),
		JSON.stringify({ name: "test-repo", private: true }),
	);
	await writeFile(join(dir, "README.md"), "# Test\n");
	await exec(["git", "add", "-A"], dir);
	await exec(["git", "commit", "-m", "init"], dir);
}

describe("WorktreeManager", () => {
	let repoDir: string;
	let wtRoot: string;
	let mgr: WorktreeManager;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), "og-wt-repo-"));
		wtRoot = join(repoDir, ".worktrees");
		await initRepo(repoDir);
		mgr = new WorktreeManager(repoDir, wtRoot);
	});

	afterEach(async () => {
		await mgr.cleanup();
		await rm(repoDir, { recursive: true });
	});

	test("create makes a worktree with a new branch", async () => {
		const taskId = "abcdef12-3456-7890-abcd-ef1234567890";
		const info = await mgr.create(taskId, "setup");

		expect(info.branch).toBe("og/abcdef12/setup");
		expect(existsSync(info.path)).toBe(true);
		expect(existsSync(join(info.path, "README.md"))).toBe(true);
	});

	test("create enables extensions.worktreeConfig", async () => {
		const taskId = "abcdef12-3456-7890-abcd-ef1234567890";
		await mgr.create(taskId, "setup");

		const value = (
			await exec(
				["git", "config", "--get", "extensions.worktreeConfig"],
				repoDir,
			)
		).trim();
		expect(value).toBe("true");
	});

	test("create disables hooks per-worktree", async () => {
		const taskId = "abcdef12-3456-7890-abcd-ef1234567890";
		const info = await mgr.create(taskId, "setup");

		// Check that core.hooksPath is set to /dev/null in the worktree
		const hooksPath = (
			await exec(["git", "config", "--worktree", "core.hooksPath"], info.path)
		).trim();
		expect(hooksPath).toBe("/dev/null");
	});

	test("create from specific base branch", async () => {
		// Create a feature branch with extra content
		await exec(["git", "checkout", "-b", "feature"], repoDir);
		await writeFile(join(repoDir, "feature.txt"), "feature\n");
		await exec(["git", "add", "-A"], repoDir);
		await exec(["git", "commit", "-m", "feature commit"], repoDir);
		await exec(["git", "checkout", "main"], repoDir).catch(() =>
			exec(["git", "checkout", "master"], repoDir),
		);

		const taskId = "11111111-2222-3333-4444-555555555555";
		const info = await mgr.create(taskId, "from-feat", "feature");

		// Worktree should have the feature file
		expect(existsSync(join(info.path, "feature.txt"))).toBe(true);
	});

	test("remove cleans up worktree and branch", async () => {
		const taskId = "bbbbbbbb-1111-2222-3333-444444444444";
		const info = await mgr.create(taskId, "cleanup");
		expect(existsSync(info.path)).toBe(true);

		await mgr.remove(taskId, "cleanup");

		expect(existsSync(info.path)).toBe(false);

		// Branch should be gone
		const branches = await exec(["git", "branch"], repoDir);
		expect(branches).not.toContain("og/bbbbbbbb/cleanup");
	});

	test("list returns managed worktrees", async () => {
		const id1 = "aaaaaaaa-1111-2222-3333-444444444444";
		const id2 = "cccccccc-1111-2222-3333-444444444444";
		await mgr.create(id1, "alpha");
		await mgr.create(id2, "beta");

		const list = await mgr.list();
		expect(list).toHaveLength(2);
		expect(list.map((w) => w.branch).sort()).toEqual([
			"og/aaaaaaaa/alpha",
			"og/cccccccc/beta",
		]);
	});

	test("merge integrates task branch into target", async () => {
		const taskId = "dddddddd-1111-2222-3333-444444444444";
		const info = await mgr.create(taskId, "merge-me");

		// Make a change in the worktree
		await writeFile(join(info.path, "new-file.txt"), "hello\n");
		await exec(["git", "add", "-A"], info.path);
		await exec(["git", "commit", "-m", "add new file"], info.path);

		// Merge into main repo (repoDir has the target branch checked out)
		const success = await mgr.merge(taskId, "merge-me", repoDir);
		expect(success).toBe(true);

		// The merged file should now exist in the main repo
		expect(existsSync(join(repoDir, "new-file.txt"))).toBe(true);
	});

	test("merge returns false on conflict", async () => {
		const taskId = "eeeeeeee-1111-2222-3333-444444444444";
		const info = await mgr.create(taskId, "conflict");

		// Modify same file in both places
		await writeFile(join(repoDir, "README.md"), "main change\n");
		await exec(["git", "add", "-A"], repoDir);
		await exec(["git", "commit", "-m", "main change"], repoDir);

		await writeFile(join(info.path, "README.md"), "worktree change\n");
		await exec(["git", "add", "-A"], info.path);
		await exec(["git", "commit", "-m", "worktree change"], info.path);

		const success = await mgr.merge(taskId, "conflict", repoDir);
		expect(success).toBe(false);

		// Abort the failed merge
		await exec(["git", "merge", "--abort"], repoDir);
	});

	test("cleanup removes all worktrees", async () => {
		const id1 = "ffffffff-1111-2222-3333-444444444444";
		const id2 = "00000000-1111-2222-3333-444444444444";
		await mgr.create(id1, "one");
		await mgr.create(id2, "two");

		await mgr.cleanup();

		expect(existsSync(wtRoot)).toBe(false);
	});

	test("create fails for invalid base branch", async () => {
		const taskId = "12345678-1111-2222-3333-444444444444";
		await expect(
			mgr.create(taskId, "bad", "nonexistent-branch"),
		).rejects.toThrow();
	});
});
