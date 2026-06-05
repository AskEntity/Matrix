#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	encryptWithPublicKey,
	hasJwtSecret,
	signCLIToken,
	signSessionToken,
} from "./auth.ts";
import { runAnalyzeCache } from "./cli-analyze-cache.ts";
import {
	type AuthGroup,
	GLOBAL_ONLY_FIELDS,
	loadGlobalConfig,
	loadProjectRepoConfig,
	type MatrixConfig,
	type ProjectConfig,
	resolveConfig,
	saveGlobalConfig,
	saveProjectRepoConfig,
} from "./config.ts";
import { pluginApiPrefix } from "./plugin-url.ts";

const _pkg = JSON.parse(
	await Bun.file(new URL("../package.json", import.meta.url).pathname).text(),
) as { version: string };
const VERSION = _pkg.version;

const DAEMON_URL = process.env.MXD_DAEMON_URL ?? "http://localhost:7433";
// Must stay in lockstep with daemon.ts's production entry block. If the daemon
// runs with a custom MXD_DATA_DIR, the CLI must sign with the same jwtSecret —
// otherwise the token is verified against the wrong secret and rejected.
const DATA_DIR = process.env.MXD_DATA_DIR ?? join(homedir(), ".mxd");
const AUTH_JSON_PATH = join(DATA_DIR, "auth.json");

/**
 * Plugin namespace prefix for matrix-worker routes.
 *
 * CLI is matrix-specific — it knows the plugin name at build time. Plugin-owned
 * routes (tasks, agent, events, messages, sessions, etc.) live under
 * `/api/matrix/*`; daemon-owned routes (`/projects` CRUD, `/projects/:id`,
 * `/projects/:id/config*`, `/health`, `/events`) stay at root.
 */
const MATRIX_API = pluginApiPrefix("matrix");

/**
 * Generate a short-lived CLI JWT for auto-auth.
 * Returns null if auth.json has no jwtSecret (auth not initialized).
 */
async function getCLIToken(): Promise<string | null> {
	try {
		if (!(await hasJwtSecret(AUTH_JSON_PATH))) return null;
		return await signCLIToken(AUTH_JSON_PATH);
	} catch {
		return null;
	}
}

/**
 * Exchange the long-lived CLI token for a short-lived (5min) stream
 * token. Mirrors `web/.../hooks.ts` useSSE's pattern — the CLI token
 * must never ride in the `/events` URL (proxy logs, shell history,
 * `ps`-visible argv for subprocesses). After Audit R7 P1.3 the
 * middleware accepts only `sub=stream` JWTs on `/events`, so the CLI's
 * own `sub=cli` token would 401-loop.
 *
 * Returns null if:
 *   - auth.json has no jwtSecret (shouldn't happen — P1.3 inits on daemon boot)
 *   - the POST fails (network blip, daemon down, daemon rejected the CLI token)
 * On null, the caller falls through to a tokenless GET /events: the
 * server returns 401 and the existing reconnect backoff handles it.
 * Reconnecting calls fetchStreamToken() again for a fresh token — never
 * reuse across reconnects (token may have expired or been revoked by a
 * logout-all bumpSecretVersion).
 */
async function fetchStreamToken(): Promise<string | null> {
	const cliToken = await getCLIToken();
	if (!cliToken) return null;
	try {
		const res = await fetch(`${DAEMON_URL}/auth/stream-token`, {
			method: "POST",
			headers: { Authorization: `Bearer ${cliToken}` },
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { token: string | null };
		return data.token;
	} catch {
		return null;
	}
}

async function api(path: string, options?: RequestInit): Promise<Response> {
	const token = await getCLIToken();
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	try {
		return await fetch(`${DAEMON_URL}${path}`, {
			...options,
			headers: {
				...headers,
				...(options?.headers as Record<string, string> | undefined),
			},
		});
	} catch (e) {
		// Daemon offline / wrong port / hostname unreachable. Without this
		// handler the user sees a raw Bun stack trace on every CLI call
		// except `mxd health`, which has its own try/catch.
		if (isConnectionError(e)) {
			console.error(
				`Daemon is not reachable at ${DAEMON_URL}. Run \`mxd daemon start\`.`,
			);
			process.exit(1);
		}
		throw e;
	}
}

/**
 * Classify a `fetch` exception as a connection failure. Connection codes
 * appear in three shapes depending on runtime:
 *   - Bun directly: `{ code: "ConnectionRefused" | "ECONNREFUSED" }` on the
 *     error object itself.
 *   - Node/undici `TypeError: fetch failed` with `cause.code`.
 *   - Plain message match (last resort).
 * We accept any of them so the CLI emits the friendly message on every
 * runtime the user might be on.
 */
function isConnectionError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const CODES = [
		"ECONNREFUSED",
		"ENOTFOUND",
		"ConnectionRefused",
		"ENETUNREACH",
		"EHOSTUNREACH",
	];
	const topCode = (e as Error & { code?: string }).code;
	if (typeof topCode === "string" && CODES.includes(topCode)) return true;
	const cause = (e as Error & { cause?: { code?: string } }).cause;
	if (cause && typeof cause.code === "string" && CODES.includes(cause.code))
		return true;
	return CODES.some((c) => e.message.includes(c));
}

async function handleInit(args: string[]): Promise<void> {
	// Resolve relative to CLI's cwd (user-predictable) before sending to the
	// daemon. The daemon rejects non-absolute paths because its own cwd is
	// wherever launchd started it — meaningless to users.
	const raw = args[0] ?? process.cwd();
	const path = resolve(process.cwd(), raw);
	const res = await api("/projects", {
		method: "POST",
		body: JSON.stringify({ path }),
	});

	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}

	const project = (await res.json()) as {
		id: string;
		name: string;
		path: string;
	};
	console.log(`Project initialized: ${project.name}`);
	console.log(`  ID: ${project.id}`);
	console.log(`  Path: ${project.path}`);
}

async function handleList(): Promise<void> {
	const res = await api("/projects");
	const projects = (await res.json()) as {
		id: string;
		name: string;
		path: string;
		pathExists?: boolean;
	}[];

	if (projects.length === 0) {
		console.log("No projects registered.");
		return;
	}

	for (const p of projects) {
		const warning = p.pathExists === false ? " ⚠ (path not found)" : "";
		console.log(`${p.id}  ${p.name}  ${p.path}${warning}`);
	}
}

async function handleRelocate(args: string[]): Promise<void> {
	const target = args[0];
	const newPath = args[1];
	if (!target || !newPath) {
		console.error("Usage: mxd relocate <project-id-or-name> <new-path>");
		process.exit(1);
	}

	const projectId = await resolveProject(target);
	if (!projectId) return;

	const res = await api(`/projects/${projectId}`, {
		method: "PATCH",
		body: JSON.stringify({ path: newPath }),
	});

	if (!res.ok) {
		const err = (await res.json()) as { error?: string };
		console.error(`Error: ${err.error ?? "Failed to relocate"}`);
		process.exit(1);
	}

	const updated = (await res.json()) as { name: string; path: string };
	console.log(`Relocated "${updated.name}" → ${updated.path}`);
}

async function handleStatus(args: string[]): Promise<void> {
	const projectId = await resolveProject(args[0]);
	if (!projectId) return;

	const res = await api(`${MATRIX_API}/projects/${projectId}/tasks`);
	// Wire-format note: daemon returns `{ rootNodeId, nodes }`. Previously
	// the CLI read `body.root` (an object that was never emitted), so
	// `mxd status` and `mxd tasks` always printed "No task tree." even on
	// populated projects. Look up the root node inside `nodes` by its id.
	const body = (await res.json()) as {
		rootNodeId: string | null;
		nodes: {
			id: string;
			title: string;
			status: string;
			parentId: string | null;
			branch: string | null;
			costUsd?: number;
		}[];
	};

	const rootNode = body.rootNodeId
		? body.nodes.find((n) => n.id === body.rootNodeId)
		: null;

	if (!rootNode) {
		console.log("No task tree.");
		return;
	}

	console.log(`Task tree: ${rootNode.title} [${rootNode.status}]`);
	console.log("");

	// Build tree display
	const byParent = new Map<string | null, typeof body.nodes>();
	for (const node of body.nodes) {
		const key = node.parentId;
		if (!byParent.has(key)) byParent.set(key, []);
		byParent.get(key)?.push(node);
	}

	const rootNodes = byParent.get(null) ?? [];
	for (const node of rootNodes) {
		printTree(node, byParent, "");
	}

	// Show cost summary if any tasks have cost data
	const withCost = body.nodes.filter((n) => (n.costUsd ?? 0) > 0);
	const total = withCost.reduce((acc, n) => acc + (n.costUsd ?? 0), 0);
	if (total > 0) {
		console.log("");
		console.log(
			`Total cost: ${total.toFixed(4)} across ${withCost.length} task(s)`,
		);
	}
}

function printTree(
	node: { id: string; title: string; status: string; branch: string | null },
	byParent: Map<
		string | null,
		{ id: string; title: string; status: string; branch: string | null }[]
	>,
	prefix: string,
): void {
	const statusIcon = statusEmoji(node.status);
	const branch = node.branch ? ` (${node.branch})` : "";
	console.log(`${prefix}${statusIcon} ${node.title}${branch}`);

	const children = byParent.get(node.id) ?? [];
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		const isLast = i === children.length - 1;
		const childPrefix = prefix + (isLast ? "  " : "| ");
		if (child) printTree(child, byParent, childPrefix);
	}
}

function statusEmoji(status: string): string {
	switch (status) {
		case "pending":
			return "o";
		case "in_progress":
			return ">";
		case "passed":
			return "+";
		case "failed":
			return "x";
		default:
			return "?";
	}
}

async function handleTasks(args: string[]): Promise<void> {
	const projectId = await resolveProject(args[0]);
	if (!projectId) return;

	const res = await api(`${MATRIX_API}/projects/${projectId}/tasks`);
	// See handleStatus — daemon emits `rootNodeId`, not a `root` object.
	const body = (await res.json()) as {
		rootNodeId: string | null;
		nodes: {
			id: string;
			title: string;
			status: string;
			parentId: string | null;
			branch: string | null;
			description?: string;
			costUsd?: number;
		}[];
	};

	if (!body.rootNodeId || body.nodes.length === 0) {
		console.log("No tasks.");
		return;
	}

	// Build parent map for tree display
	const byParent = new Map<string | null, typeof body.nodes>();
	for (const node of body.nodes) {
		const key = node.parentId;
		if (!byParent.has(key)) byParent.set(key, []);
		byParent.get(key)?.push(node);
	}

	function printTaskTree(
		node: (typeof body.nodes)[0],
		indent: string,
		isChild: boolean,
	): void {
		const icon = statusEmoji(node.status);
		const title = node.title.padEnd(36).slice(0, 36);
		const branch = node.branch ?? "";
		const cost =
			node.costUsd != null && node.costUsd > 0
				? `  ${node.costUsd.toFixed(4)}`
				: "";
		const prefix = isChild ? "↳ " : "  ";
		console.log(
			`${indent}${prefix}${icon} ${node.id}  ${title}  ${branch}${cost}`,
		);

		if (node.description) {
			const desc = node.description.slice(0, 60);
			console.log(`${indent}   ${" ".repeat(12)}${desc}`);
		}

		const children = byParent.get(node.id) ?? [];
		for (const child of children) {
			printTaskTree(child, `${indent}  `, true);
		}
	}

	const rootNodes = byParent.get(null) ?? [];
	for (const node of rootNodes) {
		printTaskTree(node, "", false);
	}
}

async function handleDelete(args: string[]): Promise<void> {
	const taskId = args[0];
	if (!taskId) {
		console.error("Usage: mxd delete <taskId>");
		process.exit(1);
	}

	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	const res = await api(`${MATRIX_API}/projects/${projectId}/tasks/${taskId}`, {
		method: "DELETE",
	});

	if (!res.ok) {
		if (res.status === 404) {
			console.error(`Task not found: ${taskId}`);
		} else if (res.status === 409) {
			const err = (await res.json()) as { error: string };
			console.error(`Conflict: ${err.error}`);
		} else {
			const err = (await res.json()) as { error: string };
			console.error(`Error: ${err.error}`);
		}
		process.exit(1);
	}

	const result = (await res.json()) as { title?: string };
	const title = result.title ?? taskId;
	console.log(`Deleted task: ${title}`);
}

/** Send a message to a task (or root if no taskId). */
async function sendMessage(
	projectId: string,
	message: string,
	taskId?: string,
): Promise<void> {
	let targetId = taskId;
	if (!targetId) {
		// Resolve root node ID from task tree
		const tasksRes = await api(`${MATRIX_API}/projects/${projectId}/tasks`);
		if (!tasksRes.ok) {
			console.error("Error: could not fetch task tree");
			process.exit(1);
		}
		const tasks = (await tasksRes.json()) as { rootNodeId?: string | null };
		targetId = tasks.rootNodeId ?? undefined;
		if (!targetId) {
			console.error("Error: no root node found. Run `mxd init` first.");
			process.exit(1);
		}
	}

	const res = await api(
		`${MATRIX_API}/projects/${projectId}/tasks/${targetId}/message`,
		{
			method: "POST",
			body: JSON.stringify({ content: message }),
		},
	);

	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}
}

async function handleStop(): Promise<void> {
	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	const res = await api(`${MATRIX_API}/projects/${projectId}/stop`, {
		method: "POST",
	});
	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}
	console.log("Agent stopped.");
	console.log(
		"Tip: Session history is preserved on disk. Send a message to resume.",
	);
}

async function handleSessionsPrune(args: string[]): Promise<void> {
	const keepIdx = args.indexOf("--keep");
	const keepCount = keepIdx >= 0 ? parseInt(args[keepIdx + 1] ?? "10", 10) : 10;

	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	const res = await api(`${MATRIX_API}/projects/${projectId}/sessions/prune`, {
		method: "POST",
		body: JSON.stringify({ keepCount }),
	});
	if (!res.ok) {
		console.error("Error pruning sessions");
		process.exit(1);
	}
	const body = (await res.json()) as { pruned: number; remaining: number };
	console.log(
		`Pruned ${body.pruned} old session file(s). ${body.remaining} remain.`,
	);
}

async function handleLogs(args: string[]): Promise<void> {
	let tail: number | undefined;
	const filteredArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if ((arg === "-n" || arg === "--tail") && i + 1 < args.length) {
			tail = Number.parseInt(args[++i] as string, 10);
		} else if (arg) {
			filteredArgs.push(arg);
		}
	}

	const projectId = await resolveProject(filteredArgs[0]);
	if (!projectId) return;

	const res = await api(`${MATRIX_API}/projects/${projectId}/events`);
	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}

	const body = (await res.json()) as { events: Record<string, unknown>[] };
	let events = body.events;

	if (events.length === 0) {
		console.log("No events recorded yet.");
		return;
	}

	if (tail !== undefined) {
		events = events.slice(-tail);
	}

	for (const event of events) {
		const ts = event.timestamp
			? new Date(event.timestamp as number).toLocaleTimeString()
			: "??:??:??";
		const type = event.type as string;
		let line: string;

		switch (type) {
			case "orchestration_started": {
				const model = String(event.model ?? "");
				line = model
					? `🚀 Orchestration started (${model})`
					: "🚀 Orchestration started";
				break;
			}
			case "task_created": {
				const title = String(event.title ?? "");
				const taskId = String(event.taskId ?? "");
				line = `➕ Task created: ${title} (${taskId})`;
				break;
			}
			case "task_completed":
				// Removed — done() tool card replaces this
				continue;
			case "agent_turn": {
				const turns = event.turns ?? event.turnCount ?? "?";
				line = `💬 Agent turn (turns: ${turns})`;
				break;
			}
			case "tree_updated":
				// Too noisy, skip
				continue;
			case "compact_boundary":
				line = "📦 Context compacted";
				break;
			default: {
				const { type: _t, timestamp: _ts, ...rest } = event;
				const details = JSON.stringify(rest).slice(0, 200);
				line = `• ${type}: ${details}`;
				break;
			}
		}

		console.log(`[${ts}] ${line}`);
	}
}

async function resolveProject(idOrPath?: string): Promise<string | null> {
	if (idOrPath) {
		// Try as ID first
		const res = await api(`/projects/${idOrPath}`);
		if (res.ok) return idOrPath;

		// Try as path
		const listRes = await api("/projects");
		const projects = (await listRes.json()) as { id: string; path: string }[];
		const match = projects.find((p) => p.path === idOrPath);
		if (match) return match.id;

		console.error(`Project not found: ${idOrPath}`);
		process.exit(1);
	}

	return resolveCurrentProject();
}

async function resolveCurrentProject(): Promise<string | null> {
	const cwd = process.cwd();
	const res = await api("/projects");
	const projects = (await res.json()) as { id: string; path: string }[];

	// Find project whose path matches or is a parent of cwd
	const match = projects.find(
		(p) => cwd === p.path || cwd.startsWith(`${p.path}/`),
	);

	if (!match) {
		console.error(
			"No project found for current directory. Run: mxd run <prompt>",
		);
		process.exit(1);
	}

	return match.id;
}

/** Watch a project's agent activity via SSE. Resolves never (runs until Ctrl+C). */
async function watchProject(projectId: string): Promise<void> {
	let retryCount = 0;
	let userCancelled = false;
	let abortController: AbortController | null = null;

	process.on("SIGINT", () => {
		userCancelled = true;
		abortController?.abort();
		console.log("\nDetached.");
		process.exit(0);
	});

	async function connect(): Promise<void> {
		if (userCancelled) return;

		abortController = new AbortController();
		try {
			// Mint a fresh stream token on every (re)connect. `/events`
			// accepts only sub=stream JWTs after Audit R7 P1.3; the CLI's
			// own sub=cli token would 401-loop. Reconnect path naturally
			// re-enters this block, so reconnect re-mints too.
			const token = await fetchStreamToken();
			const sseUrl = token
				? `${DAEMON_URL}/events?projectId=${encodeURIComponent(projectId)}&token=${encodeURIComponent(token)}`
				: `${DAEMON_URL}/events?projectId=${encodeURIComponent(projectId)}`;
			const res = await fetch(sseUrl, {
				signal: abortController.signal,
				headers: { Accept: "text/event-stream" },
			});

			if (!res.ok || !res.body) {
				throw new Error(`SSE connection failed: ${res.status}`);
			}

			if (retryCount > 0) console.log("Reconnected.");
			retryCount = 0;

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						try {
							const msg = JSON.parse(line.slice(6)) as Record<string, unknown>;
							formatWatchEvent(msg);
						} catch {
							/* ignore parse errors */
						}
					}
				}
			}
		} catch (err) {
			if (userCancelled) return;
			if ((err as Error).name === "AbortError") return;
		}

		// Reconnect with backoff
		if (!userCancelled) {
			retryCount++;
			const delay = Math.min(1000 * 2 ** retryCount, 30000);
			if (retryCount === 1) {
				console.error("SSE connection lost. Is the daemon running?");
			}
			console.log(
				`Reconnecting in ${delay / 1000}s... (attempt ${retryCount})`,
			);
			await new Promise((r) => setTimeout(r, delay));
			return connect();
		}
	}

	await connect();
}

async function handleWatch(): Promise<void> {
	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	console.log("Watching agent activity (Ctrl+C to stop)...\n");
	await watchProject(projectId);
}

// ANSI color helpers — no-op when stdout is not a TTY (e.g. piped to file)
const isTTY = process.stdout.isTTY === true;
const c = {
	dim: (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
	green: (s: string) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
	brightGreen: (s: string) => (isTTY ? `\x1b[92m${s}\x1b[0m` : s),
	red: (s: string) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
	brightRed: (s: string) => (isTTY ? `\x1b[91m${s}\x1b[0m` : s),
	cyan: (s: string) => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
	yellow: (s: string) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
	blue: (s: string) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s),
};

function formatWatchEvent(msg: Record<string, unknown>): void {
	const time = c.dim(new Date().toLocaleTimeString());
	const type = msg.type as string;

	switch (type) {
		case "tree_updated": {
			const nodes = msg.nodes as { title: string; status: string }[];
			const counts: Record<string, number> = {};
			for (const n of nodes) {
				counts[n.status] = (counts[n.status] ?? 0) + 1;
			}
			const summary = Object.entries(counts)
				.map(([s, count]) => `${s}:${count}`)
				.join(" ");
			console.log(
				`${time} ${c.cyan("[tree]")} ${nodes.length} nodes (${summary})`,
			);
			break;
		}
		case "tool_call": {
			const tool = msg.tool as string;
			const input = JSON.stringify(msg.input ?? {}).slice(0, 120);
			console.log(`${time} ${c.blue("[tool]")} ${tool} ${input}`);
			break;
		}
		case "tool_result": {
			const tool = msg.tool as string;
			const isError = msg.isError;
			const ok = isError ? c.red("ERR") : c.green("OK");
			const content =
				((msg.content as string) ?? "").split("\n")[0]?.slice(0, 100) ?? "";
			console.log(`${time} [result] ${tool} ${ok} ${content}`);
			break;
		}
		case "assistant_text": {
			const content = (msg.content as string) ?? "";
			// Show first line only for brevity
			const firstLine = content.split("\n")[0]?.slice(0, 120) ?? "";
			if (firstLine) console.log(`${time} [text] ${firstLine}`);
			break;
		}
		case "status":
			console.log(`${time} ${c.yellow("[status]")} ${msg.message}`);
			break;
		case "task_started":
			console.log(`${time} [task] ${c.green(">")} ${msg.title}`);
			break;
		case "task_completed":
			// Removed — done() tool card replaces this
			break;
		case "orchestration_started":
			console.log(`${time} ${c.cyan("[orch]")} Started`);
			break;
		case "orchestration_completed":
			console.log(
				`${time} ${msg.success ? c.green("[orch]") : c.red("[orch]")} ${msg.success ? "Success" : "Failed"}` +
					(msg.costUsd ? ` (${"$"}${(msg.costUsd as number).toFixed(2)})` : ""),
			);
			break;
		case "error":
			console.error(`${time} ${c.brightRed("[error]")} ${msg.message}`);
			break;
		default:
			console.log(`${time} [${type}] ${JSON.stringify(msg).slice(0, 200)}`);
	}
}

async function handleCost(args: string[]): Promise<void> {
	const projectId = await resolveProject(args[0]);
	if (!projectId) return;

	// Fetch task tree (plugin-owned route)
	const res = await api(`${MATRIX_API}/projects/${projectId}/tasks`);
	if (!res.ok) {
		console.error("Error fetching tasks");
		process.exit(1);
	}
	const { nodes } = (await res.json()) as {
		nodes: Array<{ title: string; costUsd?: number; status: string }>;
	};

	const withCost = nodes.filter((n) => n.costUsd && n.costUsd > 0);
	const total = withCost.reduce((acc, n) => acc + (n.costUsd ?? 0), 0);

	if (total === 0) {
		console.log("No cost data recorded yet. Run some tasks first.");
		return;
	}

	// Get project name
	const projectRes = await api(`/projects/${projectId}`);
	const project = (await projectRes.json()) as { name: string };

	console.log(`Cost Summary for ${project.name}`);
	console.log("─".repeat(40));
	console.log(`Total: ${total.toFixed(4)}`);

	if (withCost.length > 0) {
		console.log("");
		console.log("By task (top 10):");
		const sorted = [...withCost].sort(
			(a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0),
		);
		for (const task of sorted.slice(0, 10)) {
			const cost = `${(task.costUsd ?? 0).toFixed(4)}`;
			const status =
				task.status === "passed" ? "✓" : task.status === "failed" ? "✗" : "·";
			console.log(`  ${cost.padEnd(10)} ${status} ${task.title}`);
		}
	}

	console.log("");
	console.log(
		`${withCost.length} task${withCost.length !== 1 ? "s" : ""} with recorded cost.`,
	);
}

async function handleAgent(args: string[]): Promise<void> {
	const projectId = await resolveProject(args[0]);
	if (!projectId) return;

	const res = await api(`${MATRIX_API}/projects/${projectId}/agent`);
	if (!res.ok) {
		console.error("Error checking agent status");
		process.exit(1);
	}
	const body = (await res.json()) as {
		running: boolean;
	};
	if (body.running) {
		console.log("Agent is RUNNING");
	} else {
		console.log("Agent is IDLE");
	}
}

const KNOWN_CONFIG_KEYS = [
	"model",
	"childModel",
	"defaultAuth",
	"childAuth",
	"budgetUsd",
] as const;

type KnownConfigKey = (typeof KNOWN_CONFIG_KEYS)[number];

function printResolvedConfig(cfg: MatrixConfig): void {
	const rows: [string, string][] = [
		["model", cfg.model ?? "(not set)"],
		["childModel", cfg.childModel ?? "(not set)"],
		["defaultAuth", cfg.defaultAuth ?? "(not set)"],
		["childAuth", cfg.childAuth ?? "(not set)"],
		["budgetUsd", cfg.budgetUsd != null ? `${cfg.budgetUsd}` : "(not set)"],
	];

	const keyWidth = Math.max(...rows.map(([k]) => k.length));
	for (const [key, value] of rows) {
		console.log(`  ${key.padEnd(keyWidth)}  ${value}`);
	}

	// Auth groups
	if (cfg.authGroups && Object.keys(cfg.authGroups).length > 0) {
		console.log("");
		console.log("  Auth groups:");
		for (const [name, group] of Object.entries(cfg.authGroups)) {
			const isDefault = name === cfg.defaultAuth;
			const marker = isDefault ? " (default)" : "";
			const keys: string[] = [];
			if (group.provider === "anthropic") {
				if (group.apiKey) keys.push("apiKey");
				if (group.oauthToken) keys.push("oauthToken");
			} else {
				if (group.apiKey) keys.push("apiKey");
				if (group.accessToken) keys.push("accessToken");
				if (group.refreshToken) keys.push("refreshToken");
				if (group.accountId) keys.push("accountId");
				if (group.baseUrl) keys.push(`base=${group.baseUrl}`);
			}
			console.log(
				`    ${name}${marker}: provider=${group.provider} [${keys.join(", ")}]`,
			);
		}
	}

	// MCP servers
	if (cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0) {
		console.log("");
		console.log("  MCP servers:");
		for (const [name, server] of Object.entries(cfg.mcpServers)) {
			const cmdLine = [server.command, ...(server.args ?? [])].join(" ");
			console.log(`    ${name}: ${cmdLine}`);
		}
	}
}

/**
 * Find the project path from cwd by walking up to find .git.
 * Returns null if not in a git repo.
 */
function findProjectPath(): string | null {
	let dir = process.cwd();
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

async function handleConfig(args: string[]): Promise<void> {
	const sub = args[0];

	// Dispatch to auth subcommand
	if (sub === "auth") {
		await handleConfigAuth(args.slice(1));
		return;
	}

	if (sub === "set" && args.length >= 3) {
		const key = args[1] as string;
		const rawValue = args[2] as string;

		// Determine scope
		const isGlobal = args.includes("--global");
		const isProject = args.includes("--project");

		if (!KNOWN_CONFIG_KEYS.includes(key as KnownConfigKey)) {
			console.warn(
				`Warning: "${key}" is not a known config key. Known keys: ${KNOWN_CONFIG_KEYS.join(", ")}`,
			);
		}

		let value: string | number = rawValue;
		if (!Number.isNaN(Number(value)) && value !== "") value = Number(value);

		if (isGlobal) {
			const cfg = await loadGlobalConfig();
			(cfg as unknown as Record<string, unknown>)[key] = value;
			await saveGlobalConfig(cfg);
			console.log(`Set ${key} = ${value} (global)`);
		} else if (isProject) {
			if ((GLOBAL_ONLY_FIELDS as readonly string[]).includes(key)) {
				console.error(
					`"${key}" is a global-only setting. Use --global instead.`,
				);
				process.exit(1);
			}
			const projectPath = findProjectPath();
			if (!projectPath) {
				console.error("Not in a git repository. Cannot set project config.");
				process.exit(1);
			}
			const cfg = await loadProjectRepoConfig(projectPath);
			(cfg as unknown as Record<string, unknown>)[key] = value;
			await saveProjectRepoConfig(projectPath, cfg);
			console.log(`Set ${key} = ${value} (project: ${projectPath})`);
		} else {
			// Default: use daemon API for local config (backward compat)
			const projectId = await resolveCurrentProject();
			if (!projectId) return;
			const res = await api(`/projects/${projectId}/config`, {
				method: "PATCH",
				body: JSON.stringify({ [key]: value }),
			});
			if (!res.ok) {
				const err = (await res.json()) as { error: string };
				console.error(`Error: ${err.error}`);
				process.exit(1);
			}
			console.log(`Set ${key} = ${value}`);
		}
	} else if (sub === "unset" && args.length >= 2) {
		const key = args[1] as string;
		const isGlobal = args.includes("--global");
		const isProject = args.includes("--project");

		if (isGlobal) {
			console.error(
				`Cannot unset global config fields — all fields are required. Use "mxd config set ${key} <value>" to change it.`,
			);
			process.exit(1);
		} else if (isProject) {
			if ((GLOBAL_ONLY_FIELDS as readonly string[]).includes(key)) {
				console.error(
					`"${key}" is a global-only setting. Use --global instead.`,
				);
				process.exit(1);
			}
			const projectPath = findProjectPath();
			if (!projectPath) {
				console.error("Not in a git repository.");
				process.exit(1);
			}
			const cfg = await loadProjectRepoConfig(projectPath);
			delete (cfg as unknown as Record<string, unknown>)[key];
			await saveProjectRepoConfig(projectPath, cfg);
			console.log(`Unset ${key} (project)`);
		} else {
			const projectId = await resolveCurrentProject();
			if (!projectId) return;
			await api(`/projects/${projectId}/config`, {
				method: "PATCH",
				body: JSON.stringify({ [key]: null }),
			});
			console.log(`Unset ${key}`);
		}
	} else if (!sub) {
		// Show resolved config
		const globalCfg = await loadGlobalConfig();
		const projectPath = findProjectPath();
		const repoCfg = projectPath ? await loadProjectRepoConfig(projectPath) : {};

		// Try to get local config via daemon API
		let localCfg: ProjectConfig = {};
		try {
			const projectId = await resolveCurrentProject();
			if (projectId) {
				const res = await api(`/projects/${projectId}/config`);
				if (res.ok) {
					localCfg = (await res.json()) as MatrixConfig;
				}
			}
		} catch {
			// Daemon not running, skip local config
		}

		const resolved = resolveConfig(globalCfg, repoCfg, localCfg);
		console.log("Resolved config:");
		console.log("");
		printResolvedConfig(resolved);
		console.log("");
		console.log("  Use: mxd config set <key> <value> [--global|--project]");
		console.log(
			"       mxd config auth add <name> --provider <p> [--key <k> | --access-token <t>]",
		);
		console.log("       mxd config auth list");
	} else {
		console.error(
			"Usage: mxd config [set <key> <value> | unset <key> | auth ...]",
		);
		console.error(`Known keys: ${KNOWN_CONFIG_KEYS.join(", ")}`);
		process.exit(1);
	}
}

async function handleConfigAuth(args: string[]): Promise<void> {
	const sub = args[0];

	if (sub === "add" && args.length >= 2) {
		const name = args[1] as string;

		// Parse flags
		let provider: "anthropic" | "openai" = "anthropic";
		let apiKey: string | undefined;
		let oauthToken: string | undefined;
		let accessToken: string | undefined;
		let refreshToken: string | undefined;
		let accountId: string | undefined;
		let baseUrl: string | undefined;
		const isProject = args.includes("--project");

		for (let i = 2; i < args.length; i++) {
			const arg = args[i];
			if (arg === "--provider" && i + 1 < args.length) {
				const p = args[++i] as string;
				if (p !== "anthropic" && p !== "openai") {
					console.error(
						`Invalid provider: ${p}. Must be "anthropic" or "openai".`,
					);
					process.exit(1);
				}
				provider = p;
			} else if (arg === "--key" && i + 1 < args.length) {
				apiKey = args[++i] as string;
			} else if (arg === "--oauth-token" && i + 1 < args.length) {
				oauthToken = args[++i] as string;
			} else if (arg === "--access-token" && i + 1 < args.length) {
				accessToken = args[++i] as string;
			} else if (arg === "--refresh-token" && i + 1 < args.length) {
				refreshToken = args[++i] as string;
			} else if (arg === "--account-id" && i + 1 < args.length) {
				accountId = args[++i] as string;
			} else if (arg === "--base-url" && i + 1 < args.length) {
				baseUrl = args[++i] as string;
			}
		}

		let group: AuthGroup;
		if (provider === "anthropic") {
			if (!apiKey && !oauthToken) {
				console.error(
					"Anthropic auth requires --key <api-key> or --oauth-token <token>",
				);
				process.exit(1);
			}
			group = {
				provider: "anthropic",
				...(apiKey ? { apiKey } : {}),
				...(oauthToken ? { oauthToken } : {}),
			};
		} else {
			if (!apiKey && !accessToken) {
				console.error(
					"OpenAI auth requires --key <api-key> or --access-token <token>",
				);
				process.exit(1);
			}
			group = {
				provider: "openai",
				...(apiKey ? { apiKey } : {}),
				...(accessToken ? { accessToken } : {}),
				...(refreshToken ? { refreshToken } : {}),
				...(accountId ? { accountId } : {}),
				...(baseUrl ? { baseUrl } : {}),
			};
		}

		// Save to appropriate config layer
		if (isProject) {
			console.error("Auth groups are global-only. Use without --project flag.");
			process.exit(1);
		} else {
			// Default to global (auth groups are typically global)
			const cfg = await loadGlobalConfig();
			cfg.authGroups = { ...cfg.authGroups, [name]: group };
			// Auto-promote the first auth group as defaultAuth. README implies
			// `auth add` is sufficient to onboard — without this, fresh users
			// hit "No auth group configured. Add an auth group in Settings >
			// Global > Auth Groups and set defaultAuth." on their first agent
			// call because provider resolution reads `cfg.defaultAuth`, which
			// stays "" after a pure add. Second `auth add` leaves the user's
			// existing pick alone — we only fill in the unset slot.
			const priorDefault = cfg.defaultAuth;
			const hadPriorDefault = Boolean(priorDefault);
			if (!hadPriorDefault) {
				cfg.defaultAuth = name;
			}
			await saveGlobalConfig(cfg);
			if (!hadPriorDefault) {
				console.log(`Added auth group "${name}". Set as default.`);
			} else {
				console.log(
					`Added auth group "${name}". Current default is "${priorDefault}"; ` +
						`run \`mxd config set defaultAuth ${name} --global\` to switch.`,
				);
			}
		}
	} else if (sub === "list") {
		const resolved = await loadGlobalConfig();

		if (!resolved.authGroups || Object.keys(resolved.authGroups).length === 0) {
			console.log("No auth groups configured.");
			console.log(
				"  Add one: mxd config auth add <name> --provider anthropic --key sk-ant-...",
			);
			return;
		}

		console.log("Auth groups:");
		for (const [name, group] of Object.entries(resolved.authGroups)) {
			const isDefault = name === resolved.defaultAuth;
			const marker = isDefault ? " (default)" : "";
			const maskedKeys: string[] = [];
			if (group.provider === "anthropic") {
				if (group.apiKey) {
					maskedKeys.push(`key=${group.apiKey.slice(0, 10)}...`);
				}
				if (group.oauthToken) {
					maskedKeys.push("oauth=***");
				}
			} else {
				if (group.apiKey) {
					maskedKeys.push(`key=${group.apiKey.slice(0, 10)}...`);
				}
				if (group.accessToken) {
					maskedKeys.push("access=***");
				}
				if (group.refreshToken) {
					maskedKeys.push("refresh=***");
				}
				if (group.accountId) {
					maskedKeys.push(`account=${group.accountId.slice(0, 6)}...`);
				}
				if (group.baseUrl) {
					maskedKeys.push(`base=${group.baseUrl}`);
				}
			}
			console.log(
				`  ${name}${marker}: provider=${group.provider} [${maskedKeys.join(", ")}]`,
			);
		}
	} else if (sub === "remove" && args.length >= 2) {
		const name = args[1] as string;
		const isProject = args.includes("--project");

		if (isProject) {
			console.error("Auth groups are global-only. Use without --project flag.");
			process.exit(1);
		}
		const cfg = await loadGlobalConfig();
		delete cfg.authGroups[name];
		await saveGlobalConfig(cfg);
		console.log(`Removed auth group "${name}" from global config.`);
	} else {
		console.error("Usage:");
		console.error(
			"  mxd config auth add <name> --provider <anthropic|openai> [--key <key> | --access-token <token>] [--refresh-token <token>] [--account-id <id>] [--base-url <url>]",
		);
		console.error("  mxd config auth list");
		console.error("  mxd config auth remove <name> [--global|--project]");
		process.exit(1);
	}
}

async function handleAuth(args: string[]): Promise<void> {
	const publicKeyBase64 = args[0];
	if (!publicKeyBase64) {
		console.error("Usage: mxd auth <public_key>");
		console.error("\nCopy the public key from the Matrix web UI login page.");
		process.exit(1);
	}

	try {
		if (!(await hasJwtSecret(AUTH_JSON_PATH))) {
			// Initialize auth.json with a new secret
			const { getSigningKey } = await import("./auth.ts");
			await getSigningKey(AUTH_JSON_PATH);
		}
		const sessionToken = await signSessionToken(AUTH_JSON_PATH);
		const encrypted = await encryptWithPublicKey(publicKeyBase64, sessionToken);
		console.log(encrypted);
	} catch (err) {
		console.error(
			`Error: ${err instanceof Error ? err.message : "Failed to encrypt token"}`,
		);
		console.error("Make sure you copied the full public key from the web UI.");
		process.exit(1);
	}
}

async function handleHealth(): Promise<void> {
	try {
		const res = await api("/health");
		const body = (await res.json()) as {
			status: string;
			version: string;
			gitHash?: string;
			uptime: number;
		};
		const hash = body.gitHash ? ` (${body.gitHash})` : "";
		console.log(
			`Daemon: ${body.status} v${body.version}${hash} (uptime: ${Math.round(body.uptime / 1000)}s)`,
		);
	} catch {
		console.error("Daemon not reachable. Start it with: mxd daemon start");
		process.exit(1);
	}
}

// ── Daemon management via launchctl ──

const PLIST_LABEL = "dev.matrix.daemon";
const PLIST_DIR = `${process.env.HOME}/Library/LaunchAgents`;
const PLIST_PATH = `${PLIST_DIR}/${PLIST_LABEL}.plist`;
const MXD_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LOG_DIR = `${process.env.HOME}/.mxd/logs`;

function daemonPlist(): string {
	const bunPath = process.argv[0]; // bun binary that's running this CLI

	// Only forward PATH and HOME — API keys now live in config.json
	const envEntries: string[] = [];
	for (const key of ["PATH", "HOME"]) {
		const val = process.env[key];
		if (val) {
			const escaped = val
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			envEntries.push(
				`\t\t\t<key>${key}</key>\n\t\t\t<string>${escaped}</string>`,
			);
		}
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${PLIST_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${bunPath}</string>
\t\t<string>run</string>
\t\t<string>${MXD_ROOT}/src/daemon.ts</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${MXD_ROOT}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${envEntries.join("\n")}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${LOG_DIR}/daemon.log</string>
\t<key>StandardErrorPath</key>
\t<string>${LOG_DIR}/daemon.err</string>
</dict>
</plist>`;
}

async function daemonIsLoaded(): Promise<boolean> {
	const proc = Bun.spawn(["launchctl", "list", PLIST_LABEL], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return (await proc.exited) === 0;
}

async function handleDaemon(args: string[]): Promise<void> {
	const sub = args[0];

	switch (sub) {
		case "install": {
			const { mkdirSync, writeFileSync } = await import("node:fs");
			mkdirSync(PLIST_DIR, { recursive: true });
			mkdirSync(LOG_DIR, { recursive: true });

			// Unload existing if loaded
			if (await daemonIsLoaded()) {
				Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
			}

			writeFileSync(PLIST_PATH, daemonPlist());
			const load = Bun.spawnSync(["launchctl", "load", PLIST_PATH]);
			if (load.exitCode !== 0) {
				console.error(
					"Failed to load plist:",
					new TextDecoder().decode(load.stderr),
				);
				process.exit(1);
			}
			console.log("Daemon installed and started.");
			console.log(`  Plist: ${PLIST_PATH}`);
			console.log(`  Logs:  ${LOG_DIR}/daemon.log`);
			console.log(`  URL:   http://localhost:${process.env.PORT ?? "7433"}`);
			break;
		}

		case "uninstall": {
			const { existsSync, unlinkSync } = await import("node:fs");
			if (await daemonIsLoaded()) {
				Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
				console.log("Daemon unloaded.");
			}
			if (existsSync(PLIST_PATH)) {
				unlinkSync(PLIST_PATH);
				console.log(`Removed ${PLIST_PATH}`);
			} else {
				console.log("Plist not found — nothing to remove.");
			}
			break;
		}

		case "start": {
			if (!(await daemonIsLoaded())) {
				const { existsSync } = await import("node:fs");
				if (!existsSync(PLIST_PATH)) {
					console.log("Daemon not installed. Running: mxd daemon install");
					await handleDaemon(["install"]);
					return;
				}
				const load = Bun.spawnSync(["launchctl", "load", PLIST_PATH]);
				if (load.exitCode !== 0) {
					console.error(
						"Failed to start:",
						new TextDecoder().decode(load.stderr),
					);
					process.exit(1);
				}
			} else {
				// Already loaded, just kick it
				Bun.spawnSync([
					"launchctl",
					"kickstart",
					"-k",
					`gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`,
				]);
			}
			console.log("Daemon started.");
			break;
		}

		case "stop": {
			if (await daemonIsLoaded()) {
				Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
				console.log("Daemon stopped.");
			} else {
				console.log("Daemon is not running.");
			}
			break;
		}

		case "restart": {
			// Use kickstart -k to restart in-place. This is safe even when called
			// from a child agent process — unlike unload+load, kickstart doesn't
			// kill the caller before the reload can happen.
			const kick = Bun.spawnSync([
				"launchctl",
				"kickstart",
				"-kp",
				`gui/${process.getuid?.() ?? Bun.spawnSync(["id", "-u"]).stdout.toString().trim()}/${PLIST_LABEL}`,
			]);
			if (kick.exitCode !== 0) {
				// Fallback: maybe not loaded yet
				const { existsSync } = await import("node:fs");
				if (!existsSync(PLIST_PATH)) {
					console.log("Daemon not installed. Running: mxd daemon install");
					await handleDaemon(["install"]);
					return;
				}
				// Try unload+load as fallback
				Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
				const load = Bun.spawnSync(["launchctl", "load", PLIST_PATH]);
				if (load.exitCode !== 0) {
					console.error(
						"Failed to restart:",
						new TextDecoder().decode(load.stderr),
					);
					process.exit(1);
				}
			}
			console.log("Daemon restarted.");
			break;
		}

		case "status": {
			const loaded = await daemonIsLoaded();
			if (!loaded) {
				console.log("Daemon: not running (launchctl not loaded)");
				return;
			}
			// Try health check
			try {
				const res = await api("/health");
				const body = (await res.json()) as {
					status: string;
					version: string;
					gitHash?: string;
					uptime: number;
				};
				const hash = body.gitHash ? ` (${body.gitHash})` : "";
				console.log(
					`Daemon: ${body.status} v${body.version}${hash} (uptime: ${Math.round(body.uptime / 1000)}s)`,
				);
			} catch {
				console.log(
					"Daemon: loaded in launchctl but not responding (starting up?)",
				);
			}
			break;
		}

		case "logs": {
			const follow = args.includes("-f") || args.includes("--follow");
			const logFile = args.includes("--err")
				? `${LOG_DIR}/daemon.err`
				: `${LOG_DIR}/daemon.log`;
			const cmd = follow ? ["tail", "-f", logFile] : ["tail", "-100", logFile];
			const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
			await proc.exited;
			break;
		}

		default:
			console.log("Usage: mxd daemon <command>");
			console.log("");
			console.log("Commands:");
			console.log(
				"  install     Install and start as launchctl service (auto-start on login)",
			);
			console.log("  uninstall   Stop and remove launchctl service");
			console.log("  start       Start the daemon");
			console.log("  stop        Stop the daemon");
			console.log("  restart     Restart the daemon");
			console.log("  status      Check daemon status");
			console.log(
				"  logs [-f]   View daemon logs (--err for stderr, -f to follow)",
			);
			break;
	}
}

// Main
const [command, ...args] = process.argv.slice(2);

if (command === "--version" || command === "-v" || command === "version") {
	let gitHash = "unknown";
	try {
		const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
		if (result.exitCode === 0) {
			gitHash = new TextDecoder().decode(result.stdout).trim();
		}
	} catch {
		// git not available or not a git repo
	}
	console.log(`Matrix v${VERSION} (${gitHash})`);
	process.exit(0);
}

switch (command) {
	case "init":
		await handleInit(args);
		break;
	case "list":
	case "ls":
		await handleList();
		break;
	case "status":
	case "st":
		await handleStatus(args);
		break;
	case "tasks":
		await handleTasks(args);
		break;
	case "delete":
	case "del":
		await handleDelete(args);
		break;
	case "watch":
	case "w":
		await handleWatch();
		break;
	case "stop":
		await handleStop();
		break;
	case "sessions": {
		const sub = args[0];
		if (sub === "prune") {
			await handleSessionsPrune(args.slice(1));
		} else {
			console.error("Usage: mxd sessions prune [--keep N]");
			process.exit(1);
		}
		break;
	}
	case "logs":
	case "log":
		await handleLogs(args);
		break;
	case "agent":
		await handleAgent(args);
		break;
	case "health":
		await handleHealth();
		break;
	case "auth":
		await handleAuth(args);
		break;
	case "cost":
		await handleCost(args);
		break;
	case "relocate":
		await handleRelocate(args);
		break;
	case "config":
	case "cfg":
		await handleConfig(args);
		break;
	case "daemon":
		await handleDaemon(args);
		break;
	case "analyze-cache":
		runAnalyzeCache(args);
		break;
	case "send":
	case "s": {
		let projectId: string | undefined;
		let taskId: string | undefined;
		const messageArgs: string[] = [];

		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "-p" && i + 1 < args.length) {
				projectId = args[++i];
			} else if (arg === "-t" && i + 1 < args.length) {
				taskId = args[++i];
			} else if (arg === "--model" && i + 1 < args.length) {
				i++; // skip model value (config is set separately)
			} else if (arg === "--child-model" && i + 1 < args.length) {
				i++; // skip child-model value
			} else if (arg) {
				messageArgs.push(arg);
			}
		}

		const message = messageArgs.join(" ");
		if (!message) {
			console.error("No message provided. Usage: mxd send <message>");
			process.exit(1);
		}

		if (!projectId) {
			const resolved = await resolveCurrentProject();
			if (!resolved) process.exit(1);
			projectId = resolved;
		}

		await sendMessage(projectId, message, taskId);
		console.log("Message sent.");
		break;
	}
	case "help":
	case "--help":
	case "-h":
	case undefined:
		console.log(`Matrix v${VERSION}`);
		console.log("");
		console.log("USAGE");
		console.log("  mxd <command> [options]");
		console.log("");
		console.log("COMMANDS");
		console.log("  Messaging");
		console.log("    send <message>           Send message to agent");
		console.log(
			"      -p <id>                  Project ID (default: from cwd)",
		);
		console.log("      -t <id>                  Task ID (default: root node)");
		console.log("      --model <model>          Model override");
		console.log("      --child-model <model>    Child model override");
		console.log("");
		console.log("  Project");
		console.log("    init [path]              Initialize a project");
		console.log("    list                     List all projects");
		console.log(
			"    relocate <id> <path>     Update project path (after directory move)",
		);
		console.log("");
		console.log("  Agent");
		console.log("    stop                     Stop running agent");
		console.log("    agent [id]               Check if an agent is running");
		console.log("");
		console.log("  Tasks");
		console.log("    status [id]              Show task tree");
		console.log("    tasks [id]               List tasks with cost details");
		console.log("    delete <taskId>          Delete a task and descendants");
		console.log("    cost [id]                Show cost breakdown by task");
		console.log("");
		console.log("  Logs & Sessions");
		console.log(
			"    logs [-n N] [id]         Show event history (last N events)",
		);
		console.log("    watch                    Watch live agent activity");
		console.log(
			"    sessions prune [--keep N]  Prune old session files (default keep 10)",
		);
		console.log("");
		console.log("  Daemon");
		console.log("    daemon install           Install as background service");
		console.log("    daemon start/stop/restart  Manage daemon");
		console.log("    daemon status            Check daemon status");
		console.log("    daemon logs              View daemon logs");
		console.log("");
		console.log("  Config");
		console.log(
			"    config                   Show resolved config (global + project)",
		);
		console.log(
			"    config set <key> <value> [--global|--project]  Set a config value",
		);
		console.log(
			"    config auth add <name>   Add auth group (--provider, --key/--access-token)",
		);
		console.log("    config auth list         List auth groups");
		console.log("    config auth remove <name>  Remove auth group");
		console.log("");
		console.log("  Auth");
		console.log(
			"    auth <public_key>        Encrypt session token with browser public key",
		);
		console.log("");
		console.log("  Debug");
		console.log(
			"    analyze-cache <projectId> <taskId> [--max-gap <dur>]  List cache miss events in a task's JSONL",
		);
		console.log("");
		console.log("  Other");
		console.log("    health                   Check daemon health");
		console.log("    version                  Show version");
		console.log("");
		console.log("EXAMPLES");
		console.log("  mxd send 'build feature X'           # Send to root agent");
		console.log(
			"  mxd send -t abc123 'try again'       # Send to specific task",
		);
		console.log(
			"  mxd send -p myproj 'fix the bug'     # Specify project explicitly",
		);
		break;
	default:
		console.error(`Unknown command: ${command}. Run \`mxd --help\` for usage.`);
		process.exit(1);
}
