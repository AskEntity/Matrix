/**
 * Initialize a test project directory with git repo.
 * Replaces what ProjectManager.init() used to do for tests.
 * This is what the Matrix plugin's onProjectInit hook does in production.
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function initTestProject(projectPath: string): Promise<void> {
	// Create directory + hooks
	await mkdir(projectPath, { recursive: true });
	await mkdir(join(projectPath, ".mxd", "hooks"), { recursive: true });

	// Create setup_worktree.sh (required for child task worktree creation)
	const hookPath = join(projectPath, ".mxd", "hooks", "setup_worktree.sh");
	if (!existsSync(hookPath)) {
		await writeFile(hookPath, "#!/bin/bash\n# test hook\n", "utf-8");
		const { chmod } = await import("node:fs/promises");
		await chmod(hookPath, 0o755);
	}

	// Git init if not already
	if (!existsSync(join(projectPath, ".git"))) {
		const gitInit = Bun.spawn(["git", "init"], {
			cwd: projectPath,
			stdout: "pipe",
			stderr: "pipe",
		});
		await gitInit.exited;

		// .gitignore + initial commit
		await writeFile(
			join(projectPath, ".gitignore"),
			"node_modules/\n",
			"utf-8",
		);
		const gitAdd = Bun.spawn(["git", "add", ".gitignore"], {
			cwd: projectPath,
			stdout: "pipe",
			stderr: "pipe",
		});
		await gitAdd.exited;
		const gitCommit = Bun.spawn(
			["git", "commit", "-m", "init", "--allow-empty"],
			{
				cwd: projectPath,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "test",
					GIT_AUTHOR_EMAIL: "test@test.com",
					GIT_COMMITTER_NAME: "test",
					GIT_COMMITTER_EMAIL: "test@test.com",
				},
			},
		);
		await gitCommit.exited;
	}
}
