/**
 * Tool Auth — opaque permission handle for tool execution.
 *
 * Auth identifies WHO is calling a tool. It is a branded opaque type:
 * handlers CANNOT extract resource IDs from it. The ONLY operation on auth
 * is `checkPermission(auth, mode, resource)`.
 *
 * Named "auth" intentionally — writing `auth.taskId` to get a resource
 * feels obviously wrong. That's the point.
 *
 * This is a one-way valve: resource IDs flow IN (from args, via bind or explicit),
 * get compared against auth. Never flow OUT of auth.
 */

import type { TaskTracker } from "./task-tracker.ts";
import { isDescendantOf } from "./task-utils.ts";

// ── Auth type ──

/** Private symbol — only this module can access auth internals. */
const AUTH_INTERNAL: unique symbol = Symbol("auth-internal");

/** Internal structure — only accessible within this module via AUTH_INTERNAL. */
interface AgentAuth {
	readonly kind: "agent";
	readonly projectId: string;
	readonly taskId: string;
	readonly tracker: TaskTracker;
}

interface HumanAuth {
	readonly kind: "human";
}

type AuthInternal = AgentAuth | HumanAuth;

/**
 * Opaque auth handle. Handlers receive this but cannot inspect its internals.
 * The AUTH_INTERNAL symbol is unexported — only this module can read it.
 */
export type Auth = {
	readonly [AUTH_INTERNAL]: AuthInternal;
};

/** Create an agent auth. Called by the framework layer, not by tool handlers. */
export function createAgentAuth(
	projectId: string,
	taskId: string,
	tracker: TaskTracker,
): Auth {
	return Object.freeze({
		[AUTH_INTERNAL]: { kind: "agent", projectId, taskId, tracker } as const,
	});
}

/** Create a human auth. All permissions granted (for now). */
export function createHumanAuth(): Auth {
	return Object.freeze({
		[AUTH_INTERNAL]: { kind: "human" } as const,
	});
}

// ── Permission checking ──

export type PermissionMode =
	| "project" // auth belongs to this project?
	| "exact" // auth IS this task?
	| "subtree" // target in auth's subtree?
	| "family" // target in auth's subtree or parent chain?
	| "root" // auth is the root agent (depth 0)?
	| "human"; // auth is a human (external) caller?

export interface PermissionResource {
	projectId?: string;
	taskId?: string;
}

/**
 * Check whether auth has permission for the given mode and resource.
 * This is the ONLY function that looks inside an Auth.
 */
export function checkPermission(
	auth: Auth,
	mode: PermissionMode,
	resource: PermissionResource,
): boolean {
	const internal = auth[AUTH_INTERNAL];

	// Human auth: all permissions granted (for now)
	if (internal.kind === "human") return true;

	const { projectId, taskId, tracker } = internal;

	switch (mode) {
		case "project":
			return resource.projectId === projectId;

		case "exact":
			return resource.taskId === taskId;

		case "subtree": {
			if (!resource.taskId) return false;
			// Root can access everything in its project
			if (taskId === null) return true;
			// Self
			if (resource.taskId === taskId) return true;
			// Descendant
			return isDescendantOf(tracker, resource.taskId, taskId);
		}

		case "family": {
			if (!resource.taskId) return false;
			// Root can access everything
			if (taskId === null) return true;
			// Self
			if (resource.taskId === taskId) return true;
			// Descendant
			if (isDescendantOf(tracker, resource.taskId, taskId)) return true;
			// Ancestor in parent chain
			if (isDescendantOf(tracker, taskId, resource.taskId)) return true;
			return false;
		}

		case "root":
			// Root agent has taskId === rootNodeId (or null for the root orchestrator)
			return taskId === null || taskId === tracker.rootNodeId;

		case "human":
			// Agent auth is never human
			return false;

		default:
			return false;
	}
}

// ── Bind value resolution (framework-only) ──

/**
 * Resolve a single bind param value from auth identity.
 * Framework-only — used by resolveBindParams in tool-def.ts.
 * NOT for tool handlers.
 *
 * Returns the bound value, or null if auth has no identity (human auth).
 */
export function resolveBindParam(
	auth: Auth,
	from: "projectId" | "taskId",
): string {
	const internal = auth[AUTH_INTERNAL];
	if (internal.kind === "human") {
		throw new Error(
			"resolveBindParam called with human auth — this is a framework bug. " +
				"Human/external callers should not go through bind resolution.",
		);
	}
	const value = from === "projectId" ? internal.projectId : internal.taskId;
	if (value === null) {
		throw new Error(
			`resolveBindParam: ${from} is null — agent auth missing ${from}.`,
		);
	}
	return value;
}
