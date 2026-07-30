import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
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
	await writeFile(join(dir, "README.md"), "# Test\n");
	// Create a no-op setup hook (required for worktree creation)
	const hookDir = join(dir, ".mxd", "hooks");
	await mkdir(hookDir, { recursive: true });
	const hookPath = join(hookDir, "setup_worktree.sh");
	await writeFile(hookPath, "#!/bin/bash\nexit 0\n", "utf-8");
	await chmod(hookPath, 0o755);
	await exec(["git", "add", "-A"], dir);
	await exec(["git", "commit", "-m", "init"], dir);
}

/** Add a setup_worktree.sh hook to the repo and commit it. */
async function addSetupHook(dir: string, script: string): Promise<void> {
	const hookDir = join(dir, ".mxd", "hooks");
	await mkdir(hookDir, { recursive: true });
	await writeFile(join(hookDir, "setup_worktree.sh"), script, "utf-8");
	await chmod(join(hookDir, "setup_worktree.sh"), 0o755);
	await exec(["git", "add", "-A"], dir);
	await exec(["git", "commit", "-m", "add setup hook"], dir);
}

/**
 * Copy THIS repo's real `.hooks/worktree/prepare-commit-msg` into the fixture and
 * point a setup hook at it, exactly as `.mxd/hooks/setup_worktree.sh` does.
 *
 * The shipped script is the thing under test — a fixture-local reimplementation
 * would pass while the real hook was broken. Only the dependency install is
 * dropped, because a fixture repo has no package.json to install from.
 */
async function installTrailerHook(dir: string): Promise<void> {
	const hookDir = join(dir, ".hooks", "worktree");
	await mkdir(hookDir, { recursive: true });
	const real = join(
		import.meta.dir,
		"..",
		".hooks",
		"worktree",
		"prepare-commit-msg",
	);
	await writeFile(
		join(hookDir, "prepare-commit-msg"),
		await readFile(real, "utf-8"),
		"utf-8",
	);
	await chmod(join(hookDir, "prepare-commit-msg"), 0o755);
	await addSetupHook(
		dir,
		'#!/bin/bash\nset -e\ngit config --worktree core.hooksPath "$1/.hooks/worktree"\n',
	);
}

/** The Task-Id trailer as git itself parses it — not a substring match. */
async function readTrailer(cwd: string): Promise<string> {
	return (
		await exec(
			["git", "log", "-1", "--format=%(trailers:key=Task-Id,valueonly)"],
			cwd,
		)
	).trim();
}

describe("WorktreeManager", () => {
	let repoDir: string;
	let wtRoot: string;
	let mgr: WorktreeManager;
	let defaultBranch: string;

	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), "mxd-wt-repo-"));
		wtRoot = join(repoDir, ".worktrees");
		await initRepo(repoDir);
		defaultBranch = (
			await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], repoDir)
		).trim();
		mgr = new WorktreeManager(repoDir, wtRoot);
	});

	afterEach(async () => {
		await mgr.cleanup();
		await rm(repoDir, { recursive: true });
	});

	test("create makes a worktree with a new branch", async () => {
		const taskId = "abcdef12-3456-7890-abcd-ef1234567890";
		const info = await mgr.create(taskId, "setup", defaultBranch);

		expect(info.branch).toBe("mxd/abcdef12-3456-7890-abcd-ef1234567890/setup");
		expect(existsSync(info.path)).toBe(true);
		expect(existsSync(join(info.path, "README.md"))).toBe(true);
	});

	test("create enables extensions.worktreeConfig", async () => {
		const taskId = "abcdef12-3456-7890-abcd-ef1234567890";
		await mgr.create(taskId, "setup", defaultBranch);

		const value = (
			await exec(
				["git", "config", "--get", "extensions.worktreeConfig"],
				repoDir,
			)
		).trim();
		expect(value).toBe("true");
	});

	test("create defaults hooks off per-worktree", async () => {
		const taskId = "abcdef12-3456-7890-abcd-ef1234567890";
		const info = await mgr.create(taskId, "setup", defaultBranch);

		// The fixture's setup hook doesn't touch hooksPath, so the framework
		// default stands: no hooks at all in the worktree.
		const hooksPath = (
			await exec(["git", "config", "--worktree", "core.hooksPath"], info.path)
		).trim();
		expect(hooksPath).toBe("/dev/null");
	});

	test("the setup hook can override the hooks default", async () => {
		await addSetupHook(
			repoDir,
			'#!/bin/bash\nset -e\ngit config --worktree core.hooksPath "$1/.my-hooks"\n',
		);
		const taskId = "abcdef12-3456-7890-abcd-ef1234567891";
		const info = await mgr.create(taskId, "own-hooks", defaultBranch);

		const hooksPath = (
			await exec(["git", "config", "--worktree", "core.hooksPath"], info.path)
		).trim();
		expect(hooksPath).toBe(join(info.path, ".my-hooks"));
	});

	test("create records the task id in per-worktree git config", async () => {
		const taskId = "abcdef12-3456-7890-abcd-ef1234567892";
		const info = await mgr.create(taskId, "identity", defaultBranch);

		const recorded = (
			await exec(["git", "config", "--worktree", "mxd.taskId"], info.path)
		).trim();
		expect(recorded).toBe(taskId);
	});

	test("create from specific base branch", async () => {
		// Create a feature branch with extra content
		await exec(["git", "checkout", "-b", "feature"], repoDir);
		await writeFile(join(repoDir, "feature.txt"), "feature\n");
		await exec(["git", "add", "-A"], repoDir);
		await exec(["git", "commit", "-m", "feature commit"], repoDir);
		await exec(["git", "checkout", defaultBranch], repoDir);

		const taskId = "11111111-2222-3333-4444-555555555555";
		const info = await mgr.create(taskId, "from-feat", "feature");

		// Worktree should have the feature file
		expect(existsSync(join(info.path, "feature.txt"))).toBe(true);
	});

	test("remove cleans up worktree and branch", async () => {
		const taskId = "bbbbbbbb-1111-2222-3333-444444444444";
		const info = await mgr.create(taskId, "cleanup", defaultBranch);
		expect(existsSync(info.path)).toBe(true);

		await mgr.remove(taskId, "cleanup");

		expect(existsSync(info.path)).toBe(false);

		// Branch should be gone
		const branches = await exec(["git", "branch"], repoDir);
		expect(branches).not.toContain(
			"mxd/bbbbbbbb-1111-2222-3333-444444444444/cleanup",
		);
	});

	test("removeByPath removes the exact stored worktree path + branch", async () => {
		const taskId = "abcd1234-1111-2222-3333-444444444444";
		const info = await mgr.create(taskId, "feature", defaultBranch);
		expect(existsSync(info.path)).toBe(true);

		// Remove by the EXACT stored path + branch (no slug recomputation).
		await mgr.removeByPath(info.path, info.branch);

		expect(existsSync(info.path)).toBe(false);
		const branches = await exec(["git", "branch"], repoDir);
		expect(branches).not.toContain(info.branch);
	});

	test("cc#6: re-slugified remove orphans the worktree; removeByPath cleans it up", async () => {
		const taskId = "deadbeef-1111-2222-3333-444444444444";
		const info = await mgr.create(taskId, "original-slug", defaultBranch);
		expect(existsSync(info.path)).toBe(true);

		// Simulate the OLD bug: the task was renamed, so removal re-slugifies the
		// NEW title and computes a different path/branch that doesn't exist.
		await mgr.remove(taskId, "renamed-slug");
		// The REAL worktree is still there — orphaned. This is exactly cc#6.
		expect(existsSync(info.path)).toBe(true);
		const stillThere = await exec(["git", "branch"], repoDir);
		expect(stillThere).toContain(info.branch);

		// removeByPath with the STORED path + branch cleans it up correctly.
		await mgr.removeByPath(info.path, info.branch);
		expect(existsSync(info.path)).toBe(false);
		const gone = await exec(["git", "branch"], repoDir);
		expect(gone).not.toContain(info.branch);
	});

	test("list returns managed worktrees", async () => {
		const id1 = "aaaaaaaa-1111-2222-3333-444444444444";
		const id2 = "cccccccc-1111-2222-3333-444444444444";
		await mgr.create(id1, "alpha", defaultBranch);
		await mgr.create(id2, "beta", defaultBranch);

		const list = await mgr.list();
		expect(list).toHaveLength(2);
		expect(list.map((w) => w.branch).sort()).toEqual([
			"mxd/aaaaaaaa-1111-2222-3333-444444444444/alpha",
			"mxd/cccccccc-1111-2222-3333-444444444444/beta",
		]);
	});

	test("merge integrates task branch into target", async () => {
		const taskId = "dddddddd-1111-2222-3333-444444444444";
		const info = await mgr.create(taskId, "merge-me", defaultBranch);

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
		const info = await mgr.create(taskId, "conflict", defaultBranch);

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
		await mgr.create(id1, "one", defaultBranch);
		await mgr.create(id2, "two", defaultBranch);

		await mgr.cleanup();

		expect(existsSync(wtRoot)).toBe(false);
	});

	test("create fails for invalid base branch", async () => {
		const taskId = "12345678-1111-2222-3333-444444444444";
		await expect(
			mgr.create(taskId, "bad", "nonexistent-branch"),
		).rejects.toThrow();
	});

	test("create runs setup hook when present", async () => {
		// Add a hook that creates a marker file
		await addSetupHook(repoDir, '#!/bin/bash\ntouch "$1/setup-ran.marker"\n');

		const taskId = "aabbccdd-1111-2222-3333-444444444444";
		const info = await mgr.create(taskId, "with-hook", defaultBranch);

		// The hook should have created the marker file
		expect(existsSync(join(info.path, "setup-ran.marker"))).toBe(true);
	});

	test("create fails when setup hook is missing", async () => {
		// Remove the hook from the repo
		await exec(["git", "rm", ".mxd/hooks/setup_worktree.sh"], repoDir);
		await exec(["git", "commit", "-m", "remove hook"], repoDir);

		const taskId = "11223344-1111-2222-3333-444444444444";
		await expect(mgr.create(taskId, "no-hook", defaultBranch)).rejects.toThrow(
			"Missing .mxd/hooks/setup_worktree.sh",
		);

		// Worktree should be cleaned up
		const wtPath = join(wtRoot, `${taskId}-no-hook`);
		expect(existsSync(wtPath)).toBe(false);
	});

	test("create fails and rolls back when setup hook fails", async () => {
		// Add a hook that exits with error
		await addSetupHook(
			repoDir,
			'#!/bin/bash\necho "setup failed" >&2\nexit 1\n',
		);

		const taskId = "55667788-1111-2222-3333-444444444444";
		await expect(mgr.create(taskId, "bad-hook", defaultBranch)).rejects.toThrow(
			"Setup hook failed",
		);

		// Worktree should be cleaned up
		const wtPath = join(wtRoot, `${taskId}-bad-hook`);
		expect(existsSync(wtPath)).toBe(false);

		// Branch should be cleaned up
		const branches = await exec(["git", "branch"], repoDir);
		expect(branches).not.toContain(
			"mxd/55667788-1111-2222-3333-444444444444/bad-hook",
		);
	});

	/**
	 * The user action is "an agent commits inside its worktree"; the observable
	 * result is that the commit names its task in a form a machine can read.
	 * Every assertion here goes through `%(trailers:key=…)` — git's own parser —
	 * because a trailer that is present as TEXT but unreadable as a TRAILER is
	 * the exact failure this hook was measured into shape against.
	 */
	describe("Task-Id trailer", () => {
		const taskId = "01KYQMNB0DPAZ3XJGATTW2NQAP";

		test("an ordinary commit carries the id, and the subject is untouched", async () => {
			await installTrailerHook(repoDir);
			const info = await mgr.create(taskId, "trailer", defaultBranch);

			await writeFile(join(info.path, "work.txt"), "work\n");
			await exec(["git", "add", "-A"], info.path);
			await exec(["git", "commit", "-m", "do the work"], info.path);

			expect(await readTrailer(info.path)).toBe(taskId);
			// Not competing for the subject line is the whole reason for a trailer.
			const subject = (
				await exec(["git", "log", "-1", "--format=%s"], info.path)
			).trim();
			expect(subject).toBe("do the work");

			// Half this repo's commit messages are Chinese, so a hook that ever stops
			// delegating to interpret-trailers and starts slicing text itself has to
			// fail here rather than in production.
			await writeFile(join(info.path, "more.txt"), "more\n");
			await exec(["git", "add", "-A"], info.path);
			await exec(["git", "commit", "-m", "修复：会话恢复丢消息"], info.path);

			expect(await readTrailer(info.path)).toBe(taskId);
			expect(
				(await exec(["git", "log", "-1", "--format=%s"], info.path)).trim(),
			).toBe("修复：会话恢复丢消息");
		});

		test("a merge made inside the worktree carries a READABLE id", async () => {
			await installTrailerHook(repoDir);
			const info = await mgr.create(taskId, "merger", defaultBranch);

			// Something to merge in, produced outside the worktree.
			await exec(["git", "checkout", "-b", "side"], repoDir);
			await writeFile(join(repoDir, "side.txt"), "side\n");
			await exec(["git", "add", "-A"], repoDir);
			await exec(["git", "commit", "-m", "side work"], repoDir);
			await exec(["git", "checkout", defaultBranch], repoDir);

			// A carefully written merge message — the exact move that destroys the
			// link when the id lives in the subject line.
			await exec(
				[
					"git",
					"merge",
					"--no-ff",
					"side",
					"-m",
					"Integrate the thing that does the stuff",
				],
				info.path,
			);

			// MERGE_MSG arrives without a trailing newline, so a naive
			// interpret-trailers call glues the trailer onto the subject and git can
			// no longer parse it back. Asserting through %(trailers:…) is what makes
			// this test able to see that.
			expect(await readTrailer(info.path)).toBe(taskId);
			const subject = (
				await exec(["git", "log", "-1", "--format=%s"], info.path)
			).trim();
			expect(subject).toBe("Integrate the thing that does the stuff");
		});

		test("a `---` line in the body does not swallow the id", async () => {
			// `---` is the format-patch divider (there it precedes the diffstat), and
			// interpret-trailers ends the message at it, inserting the trailer ABOVE
			// it — where it is no longer the last paragraph and therefore no longer a
			// trailer. Only the WRITER honours `---`; the reader just takes the last
			// paragraph. Reached by any commit message using a horizontal rule, which
			// markdown-minded agents write constantly: found when a real task's first
			// commit came out with no id.
			//
			// A substring check on %B would PASS this test. Going through
			// %(trailers:key=…) is the only reason the trap is visible at all.
			await installTrailerHook(repoDir);
			const info = await mgr.create(taskId, "divider", defaultBranch);

			await writeFile(join(info.path, "work.txt"), "work\n");
			await exec(["git", "add", "-A"], info.path);
			await exec(
				[
					"git",
					"commit",
					"-m",
					"subject with a divider",
					"-m",
					"body paragraph.",
					"-m",
					"---",
					"-m",
					"trailing note below the divider",
				],
				info.path,
			);

			expect(await readTrailer(info.path)).toBe(taskId);
			expect(
				(await exec(["git", "log", "-1", "--format=%s"], info.path)).trim(),
			).toBe("subject with a divider");
		});

		test("a divider and a missing trailing newline do not cancel each other", async () => {
			// The intersection of the two message-end guards: a merge supplies
			// MERGE_MSG with no trailing newline AND the message carries a `---`.
			// Each guard is measured alone above; this is the one case where a fix
			// for either could plausibly undo the other.
			await installTrailerHook(repoDir);
			const info = await mgr.create(taskId, "both-traps", defaultBranch);

			await exec(["git", "checkout", "-b", "side"], repoDir);
			await writeFile(join(repoDir, "side.txt"), "side\n");
			await exec(["git", "add", "-A"], repoDir);
			await exec(["git", "commit", "-m", "side work"], repoDir);
			await exec(["git", "checkout", defaultBranch], repoDir);

			await exec(
				[
					"git",
					"merge",
					"--no-ff",
					"side",
					"-m",
					"Integrate the side branch",
					"-m",
					"---",
					"-m",
					"note below the divider",
				],
				info.path,
			);

			expect(await readTrailer(info.path)).toBe(taskId);
			expect(
				(await exec(["git", "log", "-1", "--format=%s"], info.path)).trim(),
			).toBe("Integrate the side branch");
		});

		test("amending does not stack duplicate trailers", async () => {
			await installTrailerHook(repoDir);
			const info = await mgr.create(taskId, "amender", defaultBranch);

			await writeFile(join(info.path, "work.txt"), "work\n");
			await exec(["git", "add", "-A"], info.path);
			await exec(["git", "commit", "-m", "first"], info.path);
			await exec(["git", "commit", "--amend", "--no-edit"], info.path);
			await exec(["git", "commit", "--amend", "-m", "reworded"], info.path);

			expect(await readTrailer(info.path)).toBe(taskId);
			const body = await exec(["git", "log", "-1", "--format=%B"], info.path);
			expect(
				body.split("\n").filter((l) => l.startsWith("Task-Id:")).length,
			).toBe(1);
		});

		test("no mxd.taskId means no trailer, and the commit still lands", async () => {
			// The main repo has the hook available but no task identity — which is
			// root's situation, and every pre-migration commit's situation. A missing
			// trailer must never be a failed commit.
			await installTrailerHook(repoDir);
			await exec(
				[
					"git",
					"config",
					"core.hooksPath",
					join(repoDir, ".hooks", "worktree"),
				],
				repoDir,
			);

			await writeFile(join(repoDir, "rooty.txt"), "root\n");
			await exec(["git", "add", "-A"], repoDir);
			await exec(["git", "commit", "-m", "root does its own work"], repoDir);

			expect(await readTrailer(repoDir)).toBe("");
			const subject = (
				await exec(["git", "log", "-1", "--format=%s"], repoDir)
			).trim();
			expect(subject).toBe("root does its own work");
		});

		test("a message that already names a task keeps exactly that one id", async () => {
			// Reached by `git commit -c <sha>` and by cherry-pick, where the message
			// travels in from another task's worktree. DECIDED: the pre-existing id
			// wins — the line of code came from there, and a commit carrying TWO
			// Task-Id values makes `%(trailers:key=Task-Id)` ambiguous for every
			// consumer. That is `--if-exists doNothing`; the amend case alone cannot
			// tell it apart from `addIfDifferent`, this can.
			await installTrailerHook(repoDir);
			const info = await mgr.create(taskId, "inherited", defaultBranch);
			const otherId = "01KN8DXBPGQBFT1WG17A85P1X1";

			await writeFile(join(info.path, "work.txt"), "work\n");
			await exec(["git", "add", "-A"], info.path);
			await exec(
				["git", "commit", "-m", "carried over", "-m", `Task-Id: ${otherId}`],
				info.path,
			);

			expect(await readTrailer(info.path)).toBe(otherId);
			const body = await exec(["git", "log", "-1", "--format=%B"], info.path);
			expect(
				body.split("\n").filter((l) => l.startsWith("Task-Id:")).length,
			).toBe(1);
		});

		test("the shipped setup hook is what wires the trailer hook up", async () => {
			// No fixture can run the real .mxd/hooks/setup_worktree.sh — it installs
			// dependencies — so the one line that points core.hooksPath at the hook in
			// PRODUCTION is unreachable from a behavioural test. This pins the wiring
			// against its three silent breakages: the line deleted, the directory
			// renamed, the hook losing its executable bit (git skips it, mutely).
			const repoRoot = join(import.meta.dir, "..");
			const script = await readFile(
				join(repoRoot, ".mxd", "hooks", "setup_worktree.sh"),
				"utf-8",
			);
			expect(script).toContain('core.hooksPath "$1/.hooks/worktree"');

			const hook = join(repoRoot, ".hooks", "worktree", "prepare-commit-msg");
			expect(existsSync(hook)).toBe(true);
			expect((statSync(hook).mode & 0o111) !== 0).toBe(true);
		});

		test("an empty message stays empty rather than becoming the trailer", async () => {
			// The hook adding content to an otherwise-empty message would turn git's
			// "aborting, empty commit message" into a commit whose subject line is
			// `Task-Id: …`. Measured, then guarded.
			await installTrailerHook(repoDir);
			const info = await mgr.create(taskId, "emptymsg", defaultBranch);

			await writeFile(join(info.path, "work.txt"), "work\n");
			await exec(["git", "add", "-A"], info.path);
			const before = (
				await exec(["git", "rev-parse", "HEAD"], info.path)
			).trim();
			await exec(["git", "commit", "-m", ""], info.path);

			const after = (
				await exec(["git", "rev-parse", "HEAD"], info.path)
			).trim();
			expect(after).toBe(before);
		});
	});
});
