import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Project } from "./types.ts";

const PROJECTS_METADATA_FILE = "projects.json";

const NEW_PROJECT_MEMORY = `# Project Memory

This file is the agent's scratch pad. Discoveries, patterns, and lessons go here.
`;

const CONVERTED_PROJECT_MEMORY = `# Project Memory

Converted existing project. Explore the codebase to understand its structure.
If there are existing CLAUDE.md, AGENTS.md, or similar files, reference them.
Source code is the ground truth — verify everything by reading actual files.
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

		// Initialize git repo
		await this.exec(["git", "init"], projectPath);

		await writeFile(
			join(projectPath, ".gitignore"),
			"node_modules/\ndist/\n.env\n",
			"utf-8",
		);

		await this.exec(["git", "add", "-A"], projectPath);
		await this.exec(
			["git", "commit", "-m", "Initial project structure"],
			projectPath,
		);

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

		// Initialize git if not already a repo
		if (!existsSync(join(projectPath, ".git"))) {
			await this.exec(["git", "init"], projectPath);
		}

		return this.register(projectPath);
	}

	/** Register the project in daemon metadata. */
	private async register(projectPath: string): Promise<Project> {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const project: Project = {
			id,
			name: basename(projectPath),
			path: projectPath,
			rootTaskId: null,
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
