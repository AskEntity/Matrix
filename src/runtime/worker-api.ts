/**
 * Worker API — the boundary between HTTP shell (main thread) and runtime worker.
 *
 * Intentionally minimal. The shell is a reverse proxy with auth.
 * The worker runs the full app (routes + ctx + agent lifecycle).
 *
 * Two directions:
 * 1. Shell → Worker: forward HTTP requests
 * 2. Worker → Shell: emit events (for SSE relay to browser)
 */

import type { Event } from "../events.ts";

// ── Shell → Worker messages ──

export interface WorkerRequest {
	/** Unique request ID for response correlation */
	id: string;
	type: "http_request";
	/** Serialized HTTP request */
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

export interface WorkerControlMessage {
	type: "shutdown" | "reload";
}

export type ShellToWorker = WorkerRequest | WorkerControlMessage;

// ── Worker → Shell messages ──

export interface WorkerHttpResponse {
	type: "http_response";
	/** Correlates with WorkerRequest.id */
	id: string;
	status: number;
	headers: Record<string, string>;
	body?: string;
}

export interface WorkerEventMessage {
	type: "event";
	projectId: string;
	event: Event;
}

export interface WorkerSSESetup {
	/** Worker tells shell "a new SSE stream was requested for this project" */
	type: "sse_subscribe";
	projectId: string;
	/** Request ID — shell opens a long-lived response for this */
	requestId: string;
}

export interface WorkerLog {
	type: "log";
	level: "info" | "warn" | "error";
	message: string;
}

export type WorkerToShell =
	| WorkerHttpResponse
	| WorkerEventMessage
	| WorkerSSESetup
	| WorkerLog;
