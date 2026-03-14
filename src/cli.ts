#!/usr/bin/env bun

const _pkg = JSON.parse(
	await Bun.file(new URL("../package.json", import.meta.url).pathname).text(),
) as { version: string };
const VERSION = _pkg.version;

const DAEMON_URL = process.env.OG_DAEMON_URL ?? "http://localhost:7433";

async function api(path: string, options?: RequestInit): Promise<Response> {
	return fetch(`${DAEMON_URL}${path}`, {
		...options,
		headers: {
			"Content-Type": "application/json",
			...options?.headers,
		},
	});
}

async function handleInit(args: string[]): Promise<void> {
	const path = args[0] ?? process.cwd();
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
	}[];

	if (projects.length === 0) {
		console.log("No projects registered.");
		return;
	}

	for (const p of projects) {
		console.log(`${p.id.slice(0, 8)}  ${p.name}  ${p.path}`);
	}
}

async function handleStatus(args: string[]): Promise<void> {
	const projectId = await resolveProject(args[0]);
	if (!projectId) return;

	const res = await api(`/projects/${projectId}/tasks`);
	const body = (await res.json()) as {
		root: { title: string; status: string } | null;
		nodes: {
			id: string;
			title: string;
			status: string;
			parentId: string | null;
			branch: string | null;
			costUsd?: number;
		}[];
	};

	if (!body.root) {
		console.log("No task tree.");
		return;
	}

	console.log(`Task tree: ${body.root.title} [${body.root.status}]`);
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
	const withCost = body.nodes.filter((n) => n.costUsd && n.costUsd > 0);
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
		case "testing":
			return "~";
		case "passed":
			return "+";
		case "failed":
			return "x";
		case "stuck":
			return "!";
		default:
			return "?";
	}
}

async function handleTasks(args: string[]): Promise<void> {
	const projectId = await resolveProject(args[0]);
	if (!projectId) return;

	const res = await api(`/projects/${projectId}/tasks`);
	const body = (await res.json()) as {
		root: { title: string; status: string } | null;
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

	if (!body.root || body.nodes.length === 0) {
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
		const shortId = node.id.slice(0, 8);
		const title = node.title.padEnd(36).slice(0, 36);
		const branch = node.branch ?? "";
		const cost =
			node.costUsd != null && node.costUsd > 0
				? `  ${node.costUsd.toFixed(4)}`
				: "";
		const prefix = isChild ? "↳ " : "  ";
		console.log(
			`${indent}${prefix}${icon} ${shortId}  ${title}  ${branch}${cost}`,
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
		console.error("Usage: og delete <taskId>");
		process.exit(1);
	}

	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	const res = await api(`/projects/${projectId}/tasks/${taskId}`, {
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

async function handleRun(args: string[]): Promise<void> {
	let model: string | undefined;
	let childModel: string | undefined;
	const filteredArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--model" && i + 1 < args.length) {
			model = args[++i] as string;
		} else if (arg === "--child-model" && i + 1 < args.length) {
			childModel = args[++i] as string;
		} else if (arg) {
			filteredArgs.push(arg);
		}
	}
	const prompt = filteredArgs.join(" ");
	if (!prompt) {
		console.error("Usage: og run [--model <model>] <prompt>");
		process.exit(1);
	}

	// Auto-detect project from cwd
	const body: Record<string, unknown> = { path: process.cwd(), prompt };
	if (model) body.model = model;
	if (childModel) body.childModel = childModel;

	const res = await api("/agents/start", {
		method: "POST",
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}

	const result = (await res.json()) as { projectId: string };
	console.log("Agent started. Watching activity (Ctrl+C to detach)...\n");
	await watchProject(result.projectId);
}

async function handleOrchestrate(args: string[]): Promise<void> {
	const isResume = args[0] === "--resume";
	// Parse --model and --child-model flags
	let model: string | undefined;
	let childModel: string | undefined;
	const filteredArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--model" && i + 1 < args.length) {
			model = args[++i] as string;
		} else if (arg === "--child-model" && i + 1 < args.length) {
			childModel = args[++i] as string;
		} else if (arg) {
			filteredArgs.push(arg);
		}
	}
	const goal = isResume
		? filteredArgs.slice(1).join(" ")
		: filteredArgs.join(" ");

	if (!goal && !isResume) {
		console.error("Usage: og orchestrate [--model <model>] <goal>");
		console.error("       og orchestrate --resume [prompt]");
		process.exit(1);
	}

	// Auto-detect project from cwd
	const body: Record<string, unknown> = { path: process.cwd() };
	if (isResume) {
		body.resume = true;
		if (goal) body.prompt = goal;
	} else {
		body.prompt = goal;
	}
	if (model) body.model = model;
	if (childModel) body.childModel = childModel;

	// Submit orchestration (returns immediately)
	const res = await api("/agents/start", {
		method: "POST",
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}

	const result = (await res.json()) as { projectId: string };
	console.log(
		isResume ? "Resuming orchestration..." : "Orchestration started.",
	);
	console.log("Watching agent activity (Ctrl+C to detach)...\n");

	// Auto-switch to watch mode
	await watchProject(result.projectId);
}

async function handleStop(): Promise<void> {
	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	const res = await api(`/projects/${projectId}/stop`, { method: "POST" });
	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}
	console.log("Agent stopped.");
	console.log(
		"Tip: Session history is preserved on disk. Restart the daemon and resume with: og orchestrate --resume",
	);
}

async function handleSessionsClear(): Promise<void> {
	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	const res = await api(`/projects/${projectId}/sessions/clear`, {
		method: "POST",
	});
	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}
	console.log("Session history cleared. Next orchestration will start fresh.");
}

async function handleSessionsPrune(args: string[]): Promise<void> {
	const keepIdx = args.indexOf("--keep");
	const keepCount = keepIdx >= 0 ? parseInt(args[keepIdx + 1] ?? "10", 10) : 10;

	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	const res = await api(`/projects/${projectId}/sessions/prune`, {
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

	const res = await api(`/projects/${projectId}/events`);
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
				const prompt = String(event.prompt ?? "").slice(0, 200);
				line = `🚀 Orchestration started: ${prompt}`;
				break;
			}
			case "task_created": {
				const title = String(event.title ?? "");
				const taskId = String(event.taskId ?? "");
				line = `➕ Task created: ${title} (${taskId})`;
				break;
			}
			case "task_completed": {
				const title = String(event.title ?? "");
				const success = Boolean(event.success);
				const icon = success ? "✅" : "❌";
				line = `${icon} Task completed: ${title} - ${success ? "passed" : "failed"}`;
				break;
			}
			case "agent_turn": {
				const turns = event.turns ?? event.turnCount ?? "?";
				line = `💬 Agent turn (turns: ${turns})`;
				break;
			}
			case "tree_updated":
				// Too noisy, skip
				continue;
			case "queue_message": {
				const source = String(event.source ?? event.messageType ?? "");
				const content = String(event.content ?? event.message ?? "").slice(
					0,
					200,
				);
				line = `📨 Queue message: ${source} - ${content}`;
				break;
			}
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
			"No project found for current directory. Run: og run <prompt>",
		);
		process.exit(1);
	}

	return match.id;
}

async function handleContinue(args: string[]): Promise<void> {
	const taskId = args[0];
	if (!taskId) {
		console.error("Usage: og continue <taskId> [message]");
		process.exit(1);
	}

	const message = args.slice(1).join(" ") || undefined;

	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	const body: Record<string, unknown> = {};
	if (message) body.message = message;

	const res = await api(`/projects/${projectId}/tasks/${taskId}/continue`, {
		method: "POST",
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}

	const node = (await res.json()) as { title: string; status: string };
	console.log(`Continued: ${node.title} -> ${node.status}`);
	console.log("Watching activity (Ctrl+C to detach)...\n");
	await watchProject(projectId);
}

/** Watch a project's agent activity via WebSocket. Resolves never (runs until Ctrl+C). */
async function watchProject(projectId: string): Promise<void> {
	const wsUrl = `${DAEMON_URL.replace(/^http/, "ws")}/ws`;
	let retryCount = 0;
	let userCancelled = false;

	// Handle Ctrl+C gracefully — add only once here
	process.on("SIGINT", () => {
		userCancelled = true;
		console.log("\nDetached.");
		process.exit(0);
	});

	function connect(): void {
		const ws = new WebSocket(wsUrl);

		ws.onopen = () => {
			if (retryCount > 0) {
				console.log("Reconnected.");
			}
			retryCount = 0;
			ws.send(JSON.stringify({ type: "subscribe", projectId }));
		};

		ws.onclose = () => {
			if (userCancelled) return;
			retryCount++;
			const delay = Math.min(1000 * 2 ** (retryCount - 1), 30000);
			console.log(
				`\nDisconnected. Reconnecting in ${delay / 1000}s... (attempt ${retryCount})`,
			);
			setTimeout(connect, delay);
		};

		ws.onerror = () => {
			// Error handling is done in onclose (which fires after onerror)
			if (retryCount === 0) {
				// First connection failure
				console.error("WebSocket error. Is the daemon running?");
			}
		};

		ws.onmessage = (evt) => {
			try {
				const msg = JSON.parse(
					typeof evt.data === "string" ? evt.data : "",
				) as Record<string, unknown>;
				formatWatchEvent(msg);
			} catch {
				/* ignore parse errors */
			}
		};
	}

	connect();

	// Keep process alive
	await new Promise(() => {});
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
		case "agent_event": {
			const eventType = msg.eventType as string;
			if (eventType === "tool_use") {
				const tool = msg.tool as string;
				const input = JSON.stringify(msg.input ?? {}).slice(0, 120);
				console.log(`${time} ${c.blue("[tool]")} ${tool} ${input}`);
			} else if (eventType === "tool_result") {
				const tool = msg.tool as string;
				const isError = msg.isError;
				const ok = isError ? c.red("ERR") : c.green("OK");
				const content =
					((msg.content as string) ?? "").split("\n")[0]?.slice(0, 100) ?? "";
				console.log(`${time} [result] ${tool} ${ok} ${content}`);
			} else if (eventType === "text") {
				const content = (msg.content as string) ?? "";
				// Show first line only for brevity
				const firstLine = content.split("\n")[0]?.slice(0, 120) ?? "";
				if (firstLine) console.log(`${time} [text] ${firstLine}`);
			} else if (eventType === "status") {
				console.log(`${time} ${c.yellow("[status]")} ${msg.message}`);
			}
			break;
		}
		case "task_started":
			console.log(`${time} [task] ${c.green(">")} ${msg.title}`);
			break;
		case "task_completed":
			console.log(
				`${time} [task] ${msg.success ? c.brightGreen("+") : c.red("x")} ${msg.title}`,
			);
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

	// Fetch task tree
	const res = await api(`/projects/${projectId}/tasks`);
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

	const res = await api(`/projects/${projectId}/agent`);
	if (!res.ok) {
		console.error("Error checking agent status");
		process.exit(1);
	}
	const body = (await res.json()) as {
		running: boolean;
		sessionId: string | null;
	};
	if (body.running) {
		console.log("Agent is RUNNING");
		if (body.sessionId) console.log(`Session: ${body.sessionId.slice(0, 8)}`);
	} else {
		console.log("Agent is IDLE");
		if (body.sessionId)
			console.log(
				`Last session: ${body.sessionId.slice(0, 8)} (saved, can resume)`,
			);
	}
}

async function handleSend(args: string[]): Promise<void> {
	const message = args.join(" ");
	if (!message) {
		console.error("Usage: og send <message>");
		process.exit(1);
	}

	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	const res = await api(`/projects/${projectId}/message`, {
		method: "POST",
		body: JSON.stringify({ message }),
	});

	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}

	console.log("Message sent to running agent.");
}

const KNOWN_CONFIG_KEYS = [
	"model",
	"childModel",
	"provider",
	"budgetUsd",
	"clarifyTimeoutMs",
	"maxDepth",
] as const;

type KnownConfigKey = (typeof KNOWN_CONFIG_KEYS)[number];

interface ProjectConfig {
	model?: string;
	childModel?: string;
	provider?: string;
	budgetUsd?: number;
	clarifyTimeoutMs?: number;
	maxDepth?: number;
}

function printConfig(cfg: ProjectConfig): void {
	const defaultModel =
		process.env.OG_MODEL ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
	const defaultChildModel = process.env.OG_CHILD_MODEL ?? defaultModel;

	const rows: [string, string][] = [
		["model", cfg.model ?? `${defaultModel} (default)`],
		["childModel", cfg.childModel ?? `${defaultChildModel} (default)`],
		["provider", cfg.provider ?? "anthropic (default)"],
		[
			"budgetUsd",
			cfg.budgetUsd != null ? `${cfg.budgetUsd}` : "unlimited (default)",
		],
		[
			"clarifyTimeoutMs",
			cfg.clarifyTimeoutMs != null
				? `${cfg.clarifyTimeoutMs}ms`
				: "none (default)",
		],
		[
			"maxDepth",
			cfg.maxDepth != null ? String(cfg.maxDepth) : "none (default)",
		],
	];

	const keyWidth = Math.max(...rows.map(([k]) => k.length));
	for (const [key, value] of rows) {
		console.log(`  ${key.padEnd(keyWidth)}  ${value}`);
	}
}

async function handleConfig(args: string[]): Promise<void> {
	const projectId = await resolveCurrentProject();
	if (!projectId) {
		console.error("No project found for current directory.");
		process.exit(1);
	}

	const sub = args[0];

	if (sub === "set" && args.length >= 3) {
		const key = args[1] as string;
		if (!KNOWN_CONFIG_KEYS.includes(key as KnownConfigKey)) {
			console.warn(
				`Warning: "${key}" is not a known config key. Known keys: ${KNOWN_CONFIG_KEYS.join(", ")}`,
			);
		}
		let value: string | number = args[2] as string;
		if (!Number.isNaN(Number(value))) value = Number(value);
		const res = await api(`/projects/${projectId}/config`, {
			method: "PATCH",
			body: JSON.stringify({ [key]: value }),
		});
		const cfg = (await res.json()) as ProjectConfig;
		console.log(`Set ${key} =`, value);
		console.log("");
		printConfig(cfg);
	} else if (sub === "unset" && args.length >= 2) {
		const key = args[1] as string;
		const res = await api(`/projects/${projectId}/config`, {
			method: "PATCH",
			body: JSON.stringify({ [key]: null }),
		});
		const cfg = (await res.json()) as ProjectConfig;
		console.log(`Unset ${key}`);
		console.log("");
		printConfig(cfg);
	} else if (!sub) {
		const res = await api(`/projects/${projectId}/config`);
		const cfg = (await res.json()) as ProjectConfig;
		const hasAny = Object.keys(cfg).length > 0;
		if (hasAny) {
			console.log("Project config:");
		} else {
			console.log("Project config (all defaults):");
		}
		console.log("");
		printConfig(cfg);
		console.log("");
		console.log(`  Use: og config set <key> <value>  |  og config unset <key>`);
	} else {
		console.error("Usage: og config [set <key> <value> | unset <key>]");
		console.error(`Known keys: ${KNOWN_CONFIG_KEYS.join(", ")}`);
		process.exit(1);
	}
}

async function handleHealth(): Promise<void> {
	try {
		const res = await api("/health");
		const body = (await res.json()) as {
			status: string;
			version: string;
			uptime: number;
		};
		console.log(
			`Daemon: ${body.status} v${body.version} (uptime: ${Math.round(body.uptime / 1000)}s)`,
		);
	} catch {
		console.error("Daemon not reachable. Start it with: og daemon start");
		process.exit(1);
	}
}

// ── Daemon management via launchctl ──

const PLIST_LABEL = "com.opengraft.daemon";
const PLIST_DIR = `${process.env.HOME}/Library/LaunchAgents`;
const PLIST_PATH = `${PLIST_DIR}/${PLIST_LABEL}.plist`;
const OG_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LOG_DIR = `${process.env.HOME}/.opengraft/logs`;

function daemonPlist(): string {
	const bunPath = process.argv[0]; // bun binary that's running this CLI

	// Collect env vars to forward
	const envEntries: string[] = [];
	const forwardVars = [
		"PATH",
		"HOME",
		"ANTHROPIC_API_KEY",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
		"OPENAI_API_BASE",
		"OPENAI_MODEL",
		"OG_PROVIDER",
		"OG_MODEL",
		"ANTHROPIC_MODEL",
		"PORT",
	];
	for (const key of forwardVars) {
		const val = process.env[key];
		if (val) {
			// XML-escape ampersands and angle brackets
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
\t\t<string>${OG_ROOT}/src/daemon.ts</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${OG_ROOT}</string>
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
\t<key>ProcessType</key>
\t<string>Background</string>
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
					console.log("Daemon not installed. Running: og daemon install");
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
					console.log("Daemon not installed. Running: og daemon install");
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
					uptime: number;
				};
				console.log(
					`Daemon: ${body.status} v${body.version} (uptime: ${Math.round(body.uptime / 1000)}s)`,
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
			console.log("Usage: og daemon <command>");
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
	console.log(`og v${VERSION}`);
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
	case "run":
		await handleRun(args);
		break;
	case "orchestrate":
	case "orch":
		await handleOrchestrate(args);
		break;
	case "continue":
	case "cont":
		await handleContinue(args);
		break;
	case "watch":
	case "w":
		await handleWatch();
		break;
	case "send":
	case "msg":
		await handleSend(args);
		break;
	case "stop":
		await handleStop();
		break;
	case "sessions": {
		const sub = args[0];
		if (sub === "clear") {
			await handleSessionsClear();
		} else if (sub === "prune") {
			await handleSessionsPrune(args.slice(1));
		} else {
			console.error("Usage: og sessions clear|prune [--keep N]");
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
	case "cost":
		await handleCost(args);
		break;
	case "config":
	case "cfg":
		await handleConfig(args);
		break;
	case "daemon":
		await handleDaemon(args);
		break;
	default:
		console.log(`OpenGraft v${VERSION}`);
		console.log("");
		console.log("USAGE");
		console.log("  og <command> [options]");
		console.log("");
		console.log("COMMANDS");
		console.log("  Project");
		console.log("    init [path]              Initialize a project");
		console.log("    list                     List all projects");
		console.log("");
		console.log("  Agent");
		console.log(
			"    orchestrate <goal>       Start orchestration (auto-watches)",
		);
		console.log(
			"    orchestrate --resume     Resume from saved session history",
		);
		console.log("    continue <taskId> [msg]  Continue a failed/stuck task");
		console.log("    stop                     Stop running agent");
		console.log("    agent [id]               Check if an agent is running");
		console.log("    send <msg>               Send message to running agent");
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
		console.log("    sessions clear           Clear session history");
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
			"    config                   Show project config (all fields)",
		);
		console.log("    config set <key> <value> Set a config value");
		console.log(
			"    config unset <key>       Remove a config value (reset to default)",
		);
		console.log("");
		console.log(`  Known config keys: ${KNOWN_CONFIG_KEYS.join(", ")}`);
		console.log("");
		console.log("  Other");
		console.log("    health                   Check daemon health");
		console.log("    version                  Show version");
		console.log("");
		console.log("QUICK START");
		console.log(
			"  og daemon install                  # Install and start daemon",
		);
		console.log(
			"  og init .                          # Register current directory",
		);
		console.log("  og orchestrate 'build feature X'   # Start agent");
		console.log(
			"  og watch                           # Watch in separate terminal",
		);
		break;
}
