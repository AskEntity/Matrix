import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Info about a created worktree. */
export interface WorktreeInfo {
	/** Absolute path to the worktree directory. */
	path: string;
	/** Branch name associated with the worktree. */
	branch: string;
}

/**
 * Manages git worktrees for task isolation.
 * Each task gets its own worktree on a dedicated branch.
 * Branch naming: og/<taskId-short>/<slug>
 *
 * Worktree setup:
 * - extensions.worktreeConfig is enabled so per-worktree git config works
 * - Hooks are disabled per-worktree (core.hooksPath = /dev/null)
 * - Dependencies are installed (bun install) so the env is complete
 */
export class WorktreeManager {
	constructor(
		/** Root of the main git repository. */
		private readonly repoPath: string,
		/** Directory where worktrees are created (e.g. <repo>/.worktrees). */
		private readonly worktreeRoot: string,
	) {}

	/**
	 * One-time setup: enable extensions.worktreeConfig so that
	 * per-worktree config (core.hooksPath etc.) works correctly.
	 * Safe to call multiple times — checks before writing.
	 */
	async ensureWorktreeConfigEnabled(): Promise<void> {
		const proc = this.git(["config", "--get", "extensions.worktreeConfig"]);
		const exitCode = await proc.exited;
		const value = (await new Response(proc.stdout).text()).trim();

		if (exitCode !== 0 || value !== "true") {
			await this.git(["config", "extensions.worktreeConfig", "true"]).exited;
		}
	}

	/**
	 * Create a worktree for a task.
	 * Sets up a fully isolated environment:
	 * 1. Creates worktree with new branch
	 * 2. Disables hooks (so child agents don't trigger parent project's pre-commit)
	 * 3. Installs dependencies (bun install)
	 */
	async create(
		taskId: string,
		slug: string,
		baseBranch?: string,
	): Promise<WorktreeInfo> {
		await this.ensureWorktreeConfigEnabled();

		const branch = this.branchName(taskId, slug);
		const wtPath = resolve(this.worktreeRoot, `${taskId.slice(0, 8)}-${slug}`);

		// Determine the base: explicit branch, or current HEAD
		const base = baseBranch ?? "HEAD";

		// Create new branch + worktree in one command
		const proc = this.git(["worktree", "add", "-b", branch, wtPath, base]);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`Failed to create worktree: ${stderr.trim()}`);
		}

		// Disable hooks for this worktree — child agents must not trigger
		// the parent project's pre-commit hook (which runs typecheck/lint/test
		// against the main project, not the worktree's isolated code)
		await this.git(
			["config", "--worktree", "core.hooksPath", "/dev/null"],
			wtPath,
		).exited;

		// Install dependencies so the worktree has a complete environment
		// (.gitignore'd files like node_modules don't exist in new worktrees)
		await this.installDeps(wtPath);

		return { path: wtPath, branch };
	}

	/** Remove a worktree and its associated branch. */
	async remove(taskId: string, slug: string): Promise<void> {
		const branch = this.branchName(taskId, slug);
		const wtPath = resolve(this.worktreeRoot, `${taskId.slice(0, 8)}-${slug}`);

		// Remove worktree
		if (existsSync(wtPath)) {
			await this.git(["worktree", "remove", "--force", wtPath]).exited;
		}

		// Delete the branch
		await this.git(["branch", "-D", branch]).exited;
	}

	/**
	 * Merge a task's branch into the target branch.
	 * Executes the merge from `mergeCwd` (the directory that has targetBranch checked out).
	 * This avoids checkout in the main repo — the caller decides where the merge happens.
	 */
	async merge(
		taskId: string,
		slug: string,
		mergeCwd: string,
	): Promise<boolean> {
		const branch = this.branchName(taskId, slug);

		return (
			(await this.git(
				["merge", "--no-ff", branch, "-m", `Merge task: ${slug}`],
				mergeCwd,
			).exited) === 0
		);
	}

	/** List active worktrees. */
	async list(): Promise<WorktreeInfo[]> {
		const proc = this.git(["worktree", "list", "--porcelain"]);
		await proc.exited;
		const output = await new Response(proc.stdout).text();

		const worktrees: WorktreeInfo[] = [];
		let currentPath = "";
		for (const line of output.split("\n")) {
			if (line.startsWith("worktree ")) {
				currentPath = line.slice("worktree ".length);
			} else if (line.startsWith("branch refs/heads/") && currentPath) {
				const branch = line.slice("branch refs/heads/".length);
				// Only include og/ branches (our managed worktrees)
				if (branch.startsWith("og/")) {
					worktrees.push({ path: currentPath, branch });
				}
				currentPath = "";
			}
		}

		return worktrees;
	}

	/** Clean up the worktree root directory entirely. */
	async cleanup(): Promise<void> {
		// Remove each worktree properly via git first
		const worktrees = await this.list();
		for (const wt of worktrees) {
			await this.git(["worktree", "remove", "--force", wt.path]).exited;
			await this.git(["branch", "-D", wt.branch]).exited;
		}

		// Prune any stale worktree references
		await this.git(["worktree", "prune"]).exited;

		if (existsSync(this.worktreeRoot)) {
			await rm(this.worktreeRoot, { recursive: true });
		}
	}

	private git(args: string[], cwd?: string) {
		return Bun.spawn(["git", ...args], {
			cwd: cwd ?? this.repoPath,
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	/** Install dependencies in a worktree directory. */
	private async installDeps(wtPath: string): Promise<void> {
		// Only install if package.json exists (not all projects use bun/node)
		if (!existsSync(join(wtPath, "package.json"))) return;

		const proc = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
			cwd: wtPath,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			// Retry without --frozen-lockfile (lockfile may not exist)
			const retry = Bun.spawn(["bun", "install"], {
				cwd: wtPath,
				stdout: "pipe",
				stderr: "pipe",
			});
			await retry.exited;
		}
	}

	private branchName(taskId: string, slug: string): string {
		return `og/${taskId.slice(0, 8)}/${slug}`;
	}
}
