/**
 * Initialize a test project directory with git repo + hooks.
 * Replaces what ProjectManager.init() used to do for tests.
 */
import { existsSync } from "node:fs";
import { writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";

export async function initTestProject(projectPath: string): Promise<void> {
	// Create directory + hooks
	await mkdir(join(projectPath, ".mxd", "hooks"), { recursive: true });

	// Git init FIRST
	if (!existsSync(join(projectPath, ".git"))) {
		const gitInit = Bun.spawn(["git", "init"], {
			cwd: projectPath, stdout: "pipe", stderr: "pipe",
		});
		await gitInit.exited;
	}

	// Create setup_worktree.sh (required for child task worktree creation)
	const hookPath = join(projectPath, ".mxd", "hooks", "setup_worktree.sh");
	if (!existsSync(hookPath)) {
		await writeFile(hookPath, "#!/bin/bash\n# test hook\n", "utf-8");
		await chmod(hookPath, 0o755);
	}

	// .gitignore
	await writeFile(join(projectPath, ".gitignore"), "node_modules/\n.worktrees/\n", "utf-8");

	// Commit everything so worktrees can see it
	const gitAdd = Bun.spawn(["git", "add", "-A"], {
		cwd: projectPath, stdout: "pipe", stderr: "pipe",
	});
	await gitAdd.exited;

	const gitCommit = Bun.spawn(
		["git", "commit", "-m", "init test project"],
		{
			cwd: projectPath, stdout: "pipe", stderr: "pipe",
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
