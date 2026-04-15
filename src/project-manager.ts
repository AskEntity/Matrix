import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Project } from "./types.ts";
import { ulid } from "./ulid.ts";

const PROJECTS_METADATA_FILE = "projects.json";

/** Manages project lifecycle: creation, initialization, deletion. */
export class ProjectManager {
	private projects: Map<string, Project> = new Map();
	private loaded = false;

	constructor(
		/** Daemon data directory for metadata (e.g. ~/.mxd). */
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

	/**
	 * Sync project list from daemon (golden source).
	 * Worker receives the full project list and replaces its local copy.
	 * No disk write — worker is read-only.
	 */
	syncFromDaemon(projects: Array<{ id: string; name: string; path: string }>): void {
		this.projects.clear();
		for (const p of projects) {
			this.projects.set(p.id, {
				id: p.id,
				name: p.name,
				path: p.path,
				createdAt: new Date().toISOString(),
			});
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
	 * Register a project at the given path.
	 * Registry only — no filesystem operations (mkdir, git init, etc.).
	 * Filesystem setup belongs to the plugin's onProjectInit hook.
	 */
	async init(path: string): Promise<Project> {
		this.ensureLoaded();
		if (!isAbsolute(path)) {
			throw new Error(
				`Project path must be absolute. Got: ${path}. ` +
					`Example: /Users/you/projects/my-app`,
			);
		}
		const projectPath = resolve(path);

		// Check if this path is already registered
		for (const p of this.projects.values()) {
			if (p.path === projectPath) {
				throw new Error(`Project already registered: ${projectPath}`);
			}
		}

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

		// Create daemon-side project data directory with unified layout:
		//   projects/<id>/
		//     tasks/    — per-task JSONL event files
		//     debug/    — drift snapshots and future investigation artifacts
		const projectDir = join(this.dataDir, "projects", id);
		await mkdir(join(projectDir, "tasks"), { recursive: true });
		await mkdir(join(projectDir, "debug"), { recursive: true });

		return project;
	}

	/** Check if a project's path exists on disk. */
	checkPathExists(id: string): boolean {
		const project = this.get(id);
		if (!project) return false;
		return existsSync(project.path);
	}

	/**
	 * Update a project's metadata (path and/or name).
	 * When updating path: validates the new path exists and has a .mxd/ directory.
	 */
	async updateProject(
		id: string,
		updates: { path?: string; name?: string },
	): Promise<Project> {
		this.ensureLoaded();
		const project = this.projects.get(id);
		if (!project) {
			throw new Error(`Project not found: ${id}`);
		}

		if (updates.path !== undefined) {
			if (!isAbsolute(updates.path)) {
				throw new Error(
					`Project path must be absolute. Got: ${updates.path}. ` +
						`Example: /Users/you/projects/my-app`,
				);
			}
			const newPath = resolve(updates.path);

			if (!existsSync(newPath)) {
				throw new Error(`Path does not exist: ${newPath}`);
			}

			if (!existsSync(join(newPath, ".mxd"))) {
				throw new Error(
					`Path is not an Matrix project (missing .mxd/ directory): ${newPath}`,
				);
			}

			// Check no other project uses this path
			for (const p of this.projects.values()) {
				if (p.id !== id && p.path === newPath) {
					throw new Error(
						`Path already used by project "${p.name}": ${newPath}`,
					);
				}
			}

			project.path = newPath;
		}

		if (updates.name !== undefined) {
			project.name = updates.name;
		}

		await this.save();
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
}
