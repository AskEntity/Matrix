/**
 * Centralized API URL builder for frontend → backend calls.
 *
 * All API URLs go through these helpers so the prefix is a one-place change.
 *
 * Plugin-owned routes live under `/api/<plugin-name>/*` on the wire. The daemon
 * strips the prefix and forwards to the matrix worker, which registers its
 * routes as if at root. `pluginApiPrefix` is the single source of truth shared
 * with `src/daemon.ts` (daemon-side strip) so format changes propagate atomically.
 *
 * Daemon-owned routes (`/auth/*`, `/global-context`, `/projects/:id` bare,
 * `/projects/:id/config*`, etc.) are NOT in this builder — plugin code that
 * hits those uses raw relative paths with `authFetch`, and the shell's base
 * authFetch passes them through unchanged.
 */
import { pluginApiPrefix } from "@mxd/types";

/** Base prefix for all matrix plugin project routes (e.g. `/api/matrix/projects`). */
const PROJECT_PREFIX = `${pluginApiPrefix("matrix")}/projects`;

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
	stop: (id: string) => projectUrl(id, "stop"),
	compact: (id: string) => projectUrl(id, "compact"),
	clarify: (id: string) => projectUrl(id, "clarify"),
	sessionsPrune: (id: string) => projectUrl(id, "sessions", "prune"),
	configAll: (id: string) => projectUrl(id, "config", "all"),
	configRepo: (id: string) => projectUrl(id, "config", "repo"),
	config: (id: string) => projectUrl(id, "config"),
	backgroundMove: (id: string) => projectUrl(id, "background", "move"),
	backgroundKill: (id: string, bgId: string) =>
		projectUrl(id, "background", bgId, "kill"),

	eventsOlder: (id: string, query: string) =>
		`${projectUrl(id, "events", "older")}?${query}`,

	// Task-level
	tasks: (id: string) => projectUrl(id, "tasks"),
	task: (id: string, nodeId: string) => taskUrl(id, nodeId),
	taskContinue: (id: string, nodeId: string) => taskUrl(id, nodeId, "continue"),
	taskMessage: (id: string, nodeId: string) => taskUrl(id, nodeId, "message"),
	taskEvents: (id: string, nodeId: string, query?: string) =>
		taskUrl(id, nodeId, "events") + (query ? `?${query}` : ""),
	taskStop: (id: string, nodeId: string) => taskUrl(id, nodeId, "stop"),
	taskSessionsClear: (id: string, nodeId: string) =>
		taskUrl(id, nodeId, "sessions", "clear"),
	taskFork: (id: string, nodeId: string) => taskUrl(id, nodeId, "fork"),
	taskReorder: (id: string, nodeId: string) => taskUrl(id, nodeId, "reorder"),
	taskGitlog: (id: string, nodeId: string) => taskUrl(id, nodeId, "gitlog"),

	// Debug (selfBootstrap only)
	debugDumpMessages: (id: string) => projectUrl(id, "debug", "dump-messages"),
} as const;
