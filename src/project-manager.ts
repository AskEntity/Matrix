import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { validateProjectId } from "./data-paths.ts";
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
				// Defence in depth: refuse to load a projects.json with a
				// path-unsafe ID. Legal IDs pass `/^[A-Za-z0-9_-]+$/` so this
				// only fires on hand-edited / corrupted metadata.
				validateProjectId(p.id);
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

		// The path must exist. Without this check, a user typo like
		// `mxd init /Users/me/my-proejct` (sic) would be silently accepted:
		// Matrix's `onProjectInit` calls `mkdir({recursive: true})`, which
		// materialises every missing ancestor and runs `git init` inside,
		// producing a ghost project the user never intended.
		// Matches the `updateProject` check below — init was the odd one out.
		if (!existsSync(projectPath)) {
			throw new Error(`Path does not exist: ${projectPath}`);
		}

		// Check if this path is already registered
		for (const p of this.projects.values()) {
			if (p.path === projectPath) {
				throw new Error(`Project already registered: ${projectPath}`);
			}
		}

		const id = ulid();
		// ULIDs match /^[A-Za-z0-9]{26}$/ which is a subset of the projectId
		// regex — the validate call costs nothing and makes the invariant
		// explicit at the spawn point.
		validateProjectId(id);
		const now = new Date().toISOString();
		const project: Project = {
			id,
			name: basename(projectPath),
			path: projectPath,
			createdAt: now,
		};

		this.projects.set(id, project);
		await this.save();

		// NOTE: tasks/ and debug/ directories are created lazily by EventStore
		// and TaskTracker when the first write happens. Creating them eagerly
		// here hardcoded Matrix's dataRoot="@" layout — wrong for plugins with
		// a nested dataRoot. Lazy creation respects the owning plugin's path.

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

	/** Check whether a project with the given ID is registered. */
	has(id: string): boolean {
		this.ensureLoaded();
		return this.projects.has(id);
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
