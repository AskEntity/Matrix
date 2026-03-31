/**
 * Centralized API URL builder for frontend → backend calls.
 *
 * All API URLs go through these helpers so the prefix is a one-place change.
 */

/** Base prefix for all project API routes. */
const PROJECT_PREFIX = "/projects";

// ── URL builders ──

/** Project-scoped URL: /projects/:id/... */
export function projectUrl(projectId: string, ...segments: string[]): string {
	const path = segments.length > 0 ? `/${segments.join("/")}` : "";
	return `${PROJECT_PREFIX}/${projectId}${path}`;
}

/** Task-scoped URL: /projects/:id/tasks/:nodeId/... */
export function taskUrl(
	projectId: string,
	nodeId: string,
	...segments: string[]
): string {
	return projectUrl(projectId, "tasks", nodeId, ...segments);
}

// ── Convenience shortcuts ──

export const api = {
	// Project-level
	project: (id: string) => projectUrl(id),
	events: (id: string, query?: string) =>
		projectUrl(id, "events") + (query ? `?${query}` : ""),
	clarifications: (id: string) => projectUrl(id, "clarifications"),
	agent: (id: string) => projectUrl(id, "agent"),
	agentStatus: (id: string) => projectUrl(id, "agent", "status"),
	orchestrate: (id: string) => projectUrl(id, "orchestrate", "agent"),
	stop: (id: string) => projectUrl(id, "stop"),
	compact: (id: string) => projectUrl(id, "compact"),
	clarify: (id: string) => projectUrl(id, "clarify"),
	sessionsClear: (id: string) => projectUrl(id, "sessions", "clear"),
	sessionsPrune: (id: string) => projectUrl(id, "sessions", "prune"),
	configAll: (id: string) => projectUrl(id, "config", "all"),
	configRepo: (id: string) => projectUrl(id, "config", "repo"),
	config: (id: string) => projectUrl(id, "config"),
	backgroundMove: (id: string) => projectUrl(id, "background", "move"),
	backgroundKill: (id: string, bgId: string) =>
		projectUrl(id, "background", bgId, "kill"),

	eventsOlder: (id: string, query: string) =>
		projectUrl(id, "events", "older") + `?${query}`,

	// Task-level
	tasks: (id: string) => projectUrl(id, "tasks"),
	task: (id: string, nodeId: string) => taskUrl(id, nodeId),
	taskContinue: (id: string, nodeId: string) => taskUrl(id, nodeId, "continue"),
	taskMessage: (id: string, nodeId: string) => taskUrl(id, nodeId, "message"),
	taskEvents: (id: string, nodeId: string) => taskUrl(id, nodeId, "events"),
	taskStop: (id: string, nodeId: string) => taskUrl(id, nodeId, "stop"),
	taskSessionsClear: (id: string, nodeId: string) =>
		taskUrl(id, nodeId, "sessions", "clear"),
	taskFork: (id: string, nodeId: string) => taskUrl(id, nodeId, "fork"),
	taskReorder: (id: string, nodeId: string) => taskUrl(id, nodeId, "reorder"),
	taskGitlog: (id: string, nodeId: string) => taskUrl(id, nodeId, "gitlog"),
} as const;
