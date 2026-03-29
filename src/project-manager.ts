import { existsSync } from "node:fs";
import {
	appendFile,
	chmod,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Project } from "./types.ts";
import { ulid } from "./ulid.ts";

const PROJECTS_METADATA_FILE = "projects.json";

const NEW_PROJECT_MEMORY = `# Project Memory

This file is the agent's scratch pad. Discoveries, patterns, and lessons go here.

## CRITICAL: First Launch Setup

\`.opengraft/hooks/setup_worktree.sh\` is THE most important config.
It runs every time a sub task starts — installs deps, sets up env.
If it's wrong, EVERY sub task fails on startup and wastes money.

DO THIS FIRST:
1. Review \`.opengraft/hooks/setup_worktree.sh.example\` — understand what each section does
2. Customize it for this project (dependencies, env vars, build steps, any project-specific setup)
3. Save as \`setup_worktree.sh\` and make executable (\`chmod +x\`)
4. TEST IT: create a test task, verify it can run the project's test suite
5. Only after this passes, begin actual work
`;

const CONVERTED_PROJECT_MEMORY = `# Project Memory

Converted existing project. Check existing documentation (README.md, AGENTS.md, etc.)
to understand the project, then update this file with key knowledge for future sessions.

## CRITICAL: First Launch Setup

\`.opengraft/hooks/setup_worktree.sh\` is THE most important config.
It runs every time a sub task starts — installs deps, sets up env.
If it's wrong, EVERY sub task fails on startup and wastes money.

DO THIS FIRST:
1. Review \`.opengraft/hooks/setup_worktree.sh.example\` — understand what each section does
2. Customize it for this project (dependencies, env vars, build steps, any project-specific setup)
3. Save as \`setup_worktree.sh\` and make executable (\`chmod +x\`)
4. TEST IT: create a test task, verify it can run the project's test suite
5. Only after this passes, begin actual work
`;

/** Manages project lifecycle: creation, initialization, deletion. */
export class ProjectManager {
	private projects: Map<string, Project> = new Map();
	private loaded = false;

	constructor(
		/** Daemon data directory for metadata (e.g. ~/.opengraft). */
		private readonly dataDir: string,
	) {}

	/** Load saved project metadata from disk. */
	async load(): Promise<void> {
		const metaPath = join(this.dataDir, PROJECTS_METADATA_FILE);
		if (existsSync(metaPath)) {
			const raw = await readFile(metaPath, "utf-8");
			const entries = JSON.parse(raw) as Project[];
			for (const p of entries) {
				this.projects.set(p.id, p);
			}
		}
		this.loaded = true;
	}

	/** Persist project metadata to disk. */
	private async save(): Promise<void> {
		await mkdir(this.dataDir, { recursive: true });
		const metaPath = join(this.dataDir, PROJECTS_METADATA_FILE);
		const entries = Array.from(this.projects.values());
		await writeFile(metaPath, JSON.stringify(entries, null, "\t"), "utf-8");
	}

	/**
	 * Initialize a project at the given path.
	 * - If the directory does not exist, create it as a fresh project.
	 * - If the directory exists, convert it into an OpenGraft project.
	 * Sets up .opengraft/ structure and daemon-side metadata.
	 */
	async init(path: string): Promise<Project> {
		this.ensureLoaded();
		const projectPath = resolve(path);

		// Check if this path is already registered
		for (const p of this.projects.values()) {
			if (p.path === projectPath) {
				throw new Error(`Project already registered: ${projectPath}`);
			}
		}

		const isExisting = existsSync(projectPath);

		if (isExisting) {
			return this.convertExisting(projectPath);
		}
		return this.createNew(projectPath);
	}

	/** Create a fresh project from scratch. */
	private async createNew(projectPath: string): Promise<Project> {
		await mkdir(projectPath, { recursive: true });
		await mkdir(join(projectPath, ".opengraft"), { recursive: true });
		await mkdir(join(projectPath, "src"), { recursive: true });

		await writeFile(
			join(projectPath, ".opengraft", "memory.md"),
			NEW_PROJECT_MEMORY,
			"utf-8",
		);

		await this.createSetupHook(projectPath);

		// Initialize git repo with a minimal first commit (.gitignore only).
		// Everything else (.opengraft/, src/) stays uncommitted —
		// the agent reviews and commits as part of first-launch setup.
		await this.exec(["git", "init"], projectPath);
		await this.excludeWorktrees(projectPath);

		await writeFile(
			join(projectPath, ".gitignore"),
			"node_modules/\ndist/\n.env\n",
			"utf-8",
		);

		await this.exec(["git", "add", ".gitignore"], projectPath);
		await this.exec(["git", "commit", "-m", "Initial commit"], projectPath);

		return this.register(projectPath);
	}

	/** Convert an existing directory into an OpenGraft project. */
	private async convertExisting(projectPath: string): Promise<Project> {
		// Create .opengraft/ if it doesn't exist
		await mkdir(join(projectPath, ".opengraft"), { recursive: true });

		// Only write memory.md if it doesn't already exist
		const memoryPath = join(projectPath, ".opengraft", "memory.md");
		if (!existsSync(memoryPath)) {
			await writeFile(memoryPath, CONVERTED_PROJECT_MEMORY, "utf-8");
		}

		await this.createSetupHook(projectPath);

		// Initialize git if not already a repo
		if (!existsSync(join(projectPath, ".git"))) {
			await this.exec(["git", "init"], projectPath);
		}
		await this.excludeWorktrees(projectPath);

		// Don't auto-commit .opengraft/ files — the agent reviews and commits
		// as part of first-launch setup (especially the setup hook).

		return this.register(projectPath);
	}

	/**
	 * Create .opengraft/hooks/setup_worktree.sh with auto-detected content.
	 * Returns true if the file was created, false if it already existed.
	 */
	private async createSetupHook(projectPath: string): Promise<boolean> {
		const hookDir = join(projectPath, ".opengraft", "hooks");
		const hookPath = join(hookDir, "setup_worktree.sh.example");

		// Don't create .example if either the final or example file already exists
		if (existsSync(hookPath) || existsSync(join(hookDir, "setup_worktree.sh")))
			return false;

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
				'#!/bin/bash\n# Setup hook for new worktrees.\n# This script runs after a worktree is created.\n# $1 is the worktree path.\n#\n# Examples:\n#   cd "$1" && npm ci\n#   cd "$1" && pip install -r requirements.txt\n';
		}

		await writeFile(hookPath, script, "utf-8");
		await chmod(hookPath, 0o755);
		return true;
	}

	/** Ensure .worktrees is listed in .git/info/exclude so worktree dirs stay untracked. */
	private async excludeWorktrees(projectPath: string): Promise<void> {
		const infoDir = join(projectPath, ".git", "info");
		const excludePath = join(infoDir, "exclude");

		await mkdir(infoDir, { recursive: true });

		let content = "";
		try {
			content = await readFile(excludePath, "utf-8");
		} catch {
			// File doesn't exist yet — will create it
		}

		if (!content.split("\n").some((line) => line.trim() === ".worktrees")) {
			const suffix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
			await appendFile(excludePath, `${suffix}.worktrees\n`, "utf-8");
		}
	}

	/** Register the project in daemon metadata. */
	private async register(projectPath: string): Promise<Project> {
		const id = ulid();
		const now = new Date().toISOString();
		const project: Project = {
			id,
			name: basename(projectPath),
			path: projectPath,
			createdAt: now,
		};

		this.projects.set(id, project);
		await this.save();

		// Create daemon-side project data directory
		await mkdir(join(this.dataDir, "projects", id), { recursive: true });

		return project;
	}

	/** Get a project by ID. */
	get(id: string): Project | undefined {
		this.ensureLoaded();
		return this.projects.get(id);
	}

	/** Find a project by its path. */
	getByPath(path: string): Project | undefined {
		this.ensureLoaded();
		const resolved = resolve(path);
		for (const p of this.projects.values()) {
			if (p.path === resolved) return p;
		}
		return undefined;
	}

	/**
	 * Find or auto-create a project at the given path.
	 * If the path is already registered, returns the existing project.
	 * Otherwise, initializes it as a new project.
	 */
	async ensureProject(path: string): Promise<Project> {
		const existing = this.getByPath(path);
		if (existing) return existing;
		return this.init(path);
	}

	/** List all projects. */
	list(): Project[] {
		this.ensureLoaded();
		return Array.from(this.projects.values());
	}

	/** Delete a project (metadata only — does not delete the code directory). */
	async delete(id: string): Promise<void> {
		this.ensureLoaded();
		if (!this.projects.has(id)) {
			throw new Error(`Project not found: ${id}`);
		}
		this.projects.delete(id);
		await this.save();
		const projectDataDir = join(this.dataDir, "projects", id);
		if (existsSync(projectDataDir)) {
			await rm(projectDataDir, { recursive: true });
		}
	}

	private ensureLoaded(): void {
		if (!this.loaded) {
			throw new Error("ProjectManager not loaded. Call load() first.");
		}
	}

	private async exec(cmd: string[], cwd: string): Promise<void> {
		const proc = Bun.spawn(cmd, {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
	}
}
