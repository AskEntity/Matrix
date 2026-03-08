import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

/** Info about a created worktree. */
export interface WorktreeInfo {
	/** Absolute path to the worktree directory. */
	path: string;
	/** Branch name associated with the worktree. */
	branch: string;
}

/**
 * Clean git environment: strip vars that parent git processes inject.
 * Without this, git worktree operations fail when run inside hooks.
 */
function cleanGitEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	]) {
		delete env[key];
	}
	return env;
}

/**
 * Manages git worktrees for task isolation.
 * Each task gets its own worktree on a dedicated branch.
 * Branch naming: og/<taskId-short>/<slug>
 */
export class WorktreeManager {
	constructor(
		/** Root of the main git repository. */
		private readonly repoPath: string,
		/** Directory where worktrees are created (e.g. <repo>/.worktrees). */
		private readonly worktreeRoot: string,
	) {}

	/**
	 * Create a worktree for a task.
	 * Creates a new branch from the given base and sets up an isolated working directory.
	 */
	async create(
		taskId: string,
		slug: string,
		baseBranch?: string,
	): Promise<WorktreeInfo> {
		const branch = this.branchName(taskId, slug);
		const wtPath = join(this.worktreeRoot, `${taskId.slice(0, 8)}-${slug}`);

		// Determine the base: explicit branch, or current HEAD
		const base = baseBranch ?? "HEAD";

		// Create new branch + worktree in one command
		const proc = this.git(["worktree", "add", "-b", branch, wtPath, base]);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`Failed to create worktree: ${stderr.trim()}`);
		}

		// Workaround: git worktree add can mark the main repo as bare.
		// Force core.bare=false to keep the main repo functional.
		await this.git(["config", "core.bare", "false"]).exited;

		return { path: wtPath, branch };
	}

	/** Remove a worktree and its associated branch. */
	async remove(taskId: string, slug: string): Promise<void> {
		const branch = this.branchName(taskId, slug);
		const wtPath = join(this.worktreeRoot, `${taskId.slice(0, 8)}-${slug}`);

		// Remove worktree
		if (existsSync(wtPath)) {
			await this.git(["worktree", "remove", "--force", wtPath]).exited;
		}

		// Delete the branch
		await this.git(["branch", "-D", branch]).exited;
	}

	/** Merge a task branch into a target branch. Returns true if merge succeeded. */
	async merge(
		taskId: string,
		slug: string,
		targetBranch: string,
	): Promise<boolean> {
		const branch = this.branchName(taskId, slug);

		// Checkout the target branch in the main repo
		if ((await this.git(["checkout", targetBranch]).exited) !== 0) return false;

		// Merge the task branch
		return (
			(await this.git(["merge", "--no-ff", branch, "-m", `Merge task: ${slug}`])
				.exited) === 0
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
		// Prune stale worktrees first
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
			env: cleanGitEnv(),
		});
	}

	private branchName(taskId: string, slug: string): string {
		return `og/${taskId.slice(0, 8)}/${slug}`;
	}
}
