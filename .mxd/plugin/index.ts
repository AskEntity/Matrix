/**
 * Matrix plugin manifest — the coding IDE.
 *
 * Registered as scope: "global" — available in all projects.
 * This is NOT special-cased. Any plugin can register as global.
 */
import { chmod, mkdir, writeFile, readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest } from "../../src/plugin.ts";

const NEW_PROJECT_MEMORY = `# Project Memory

> This file is read by every agent on session start. Keep it focused and current.

## First Launch Checklist

1. Read this file + any existing docs (README.md, etc.)
2. Explore the codebase structure
3. Run the test suite to verify everything works
4. Update this file with key project knowledge
5. Only after this passes, begin actual work
`;

const CONVERTED_PROJECT_MEMORY = `# Project Memory

Converted existing project. Check existing documentation (README.md, AGENTS.md, etc.)
to understand the project, then update this file with key knowledge for future sessions.

## CRITICAL: First Launch Setup

\`.mxd/hooks/setup_worktree.sh\` is THE most important config.
It runs every time a child agent's worktree is created (like \`bun install\`).
Check if .mxd/hooks/setup_worktree.sh.example exists — if so, review it,
adjust if needed, rename to setup_worktree.sh, and commit.
`;

/** Create .mxd/hooks/setup_worktree.sh.example with auto-detected content. */
async function createSetupHook(projectPath: string): Promise<void> {
	const hookDir = join(projectPath, ".mxd", "hooks");
	const hookPath = join(hookDir, "setup_worktree.sh.example");

	if (existsSync(hookPath) || existsSync(join(hookDir, "setup_worktree.sh")))
		return;

	await mkdir(hookDir, { recursive: true });

	let script: string;
	if (existsSync(join(projectPath, "bun.lockb"))) {
		script = '#!/bin/bash\ncd "$1" && bun install --frozen-lockfile\n';
	} else if (existsSync(join(projectPath, "package-lock.json"))) {
		script = '#!/bin/bash\ncd "$1" && npm ci\n';
	} else if (existsSync(join(projectPath, "yarn.lock"))) {
		script = '#!/bin/bash\ncd "$1" && yarn install --frozen-lockfile\n';
	} else if (existsSync(join(projectPath, "pnpm-lock.yaml"))) {
		script = '#!/bin/bash\ncd "$1" && pnpm install --frozen-lockfile\n';
	} else if (existsSync(join(projectPath, "requirements.txt"))) {
		script = '#!/bin/bash\ncd "$1" && pip install -r requirements.txt\n';
	} else {
		script =
			'#!/bin/bash\n# Setup hook for new worktrees.\n# $1 is the worktree path.\n# Examples:\n#   cd "$1" && npm ci\n#   cd "$1" && pip install -r requirements.txt\n';
	}

	await writeFile(hookPath, script, "utf-8");
	await chmod(hookPath, 0o755);
}

/** Ensure .worktrees is in .git/info/exclude. */
async function excludeWorktrees(projectPath: string): Promise<void> {
	const infoDir = join(projectPath, ".git", "info");
	const excludePath = join(infoDir, "exclude");

	await mkdir(infoDir, { recursive: true });

	let content = "";
	try {
		content = await readFile(excludePath, "utf-8");
	} catch {}

	if (!content.split("\n").some((line) => line.trim() === ".worktrees")) {
		const suffix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
		await appendFile(excludePath, `${suffix}.worktrees\n`, "utf-8");
	}
}

function exec(cmd: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
		proc.exited.then((code) => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd.join(" ")} exited ${code}`));
		});
	});
}

const manifest: PluginManifest = {
	name: "matrix",
	scope: "global",
	dataRoot: "@",
	web: "./web/App.tsx",
	runtime: "./runtime.ts",

	async onProjectInit(projectPath, { isNew }) {
		await mkdir(join(projectPath, ".mxd"), { recursive: true });

		// Memory
		const memoryPath = join(projectPath, ".mxd", "memory.md");
		if (!existsSync(memoryPath)) {
			await writeFile(
				memoryPath,
				isNew ? NEW_PROJECT_MEMORY : CONVERTED_PROJECT_MEMORY,
				"utf-8",
			);
		}

		// Setup hook
		await createSetupHook(projectPath);

		// Git
		if (isNew) {
			await exec(["git", "init"], projectPath);
			await writeFile(
				join(projectPath, ".gitignore"),
				"node_modules/\ndist/\n.env\n",
				"utf-8",
			);
			await exec(["git", "add", ".gitignore"], projectPath);
			await exec(["git", "commit", "-m", "Initial commit"], projectPath);
		} else if (!existsSync(join(projectPath, ".git"))) {
			await exec(["git", "init"], projectPath);
		}

		await excludeWorktrees(projectPath);
	},
};

export default manifest;
