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

// ── Auth type (branded opaque) ──

declare const AuthBrand: unique symbol;

/**
 * Opaque auth handle. Handlers receive this but cannot inspect its internals.
 * Only `checkPermission` can look inside.
 */
export type Auth = {
	readonly [AuthBrand]: true;
};

/** Internal structure — only accessible within this module. */
interface AgentAuth {
	readonly kind: "agent";
	readonly projectId: string;
	readonly taskId: string | null; // null = root orchestrator
	readonly tracker: TaskTracker;
}

interface HumanAuth {
	readonly kind: "human";
}

type AuthInternal = AgentAuth | HumanAuth;

/** Map from branded Auth to its internal representation. */
const authInternals = new WeakMap<object, AuthInternal>();

/** Create an agent auth. Called by the framework layer, not by tool handlers. */
export function createAgentAuth(
	projectId: string,
	taskId: string | null,
	tracker: TaskTracker,
): Auth {
	const handle = Object.freeze({
		[Symbol.for("AuthBrand")]: true,
	}) as Auth;
	authInternals.set(handle as unknown as object, {
		kind: "agent",
		projectId,
		taskId,
		tracker,
	});
	return handle;
}

/** Create a human auth. All permissions granted (for now). */
export function createHumanAuth(): Auth {
	const handle = Object.freeze({
		[Symbol.for("AuthBrand")]: true,
	}) as Auth;
	authInternals.set(handle as unknown as object, { kind: "human" });
	return handle;
}

// ── Permission checking ──

export type PermissionMode =
	| "project" // auth belongs to this project?
	| "exact" // auth IS this task?
	| "subtree" // target in auth's subtree?
	| "family" // target in auth's subtree or parent chain?
	| "root"; // auth is the root agent (depth 0)?

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
	const internal = authInternals.get(auth as unknown as object);
	if (!internal) return false;

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

		default:
			return false;
	}
}

// ── Bind value extraction (framework-only) ──

/**
 * Extract the bind values from an Auth for framework-level parameter injection.
 * This is NOT for tool handlers — it's for the ToolDef adapter that resolves
 * bind params before calling the handler.
 *
 * Returns { projectId, taskId } for agent auth, or null values for human auth.
 */
export function getBindValues(auth: Auth): {
	projectId: string | null;
	taskId: string | null;
} {
	const internal = authInternals.get(auth as unknown as object);
	if (!internal || internal.kind === "human") {
		return { projectId: null, taskId: null };
	}
	return { projectId: internal.projectId, taskId: internal.taskId };
}
