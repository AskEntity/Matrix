/**
 * ProjectStore — read-only project registry for the runtime worker.
 *
 * Purely in-memory. Populated via sync() from daemon.
 * No create, no delete, no save, no disk access.
 * Daemon owns project lifecycle and syncs state to workers.
 */

export interface ProjectInfo {
	id: string;
	name: string;
	path: string;
}

export class ProjectStore {
	private projects = new Map<string, ProjectInfo>();

	/** Replace all projects with daemon-provided list. */
	sync(projects: ProjectInfo[]): void {
		this.projects.clear();
		for (const p of projects) {
			this.projects.set(p.id, p);
		}
	}

	/** Get a project by ID. */
	get(id: string): ProjectInfo | undefined {
		return this.projects.get(id);
	}

	/** List all projects. */
	list(): ProjectInfo[] {
		return [...this.projects.values()];
	}
}
