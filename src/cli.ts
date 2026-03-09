#!/usr/bin/env bun

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
	const ws = new WebSocket(wsUrl);

	ws.onopen = () => {
		ws.send(JSON.stringify({ type: "subscribe", projectId }));
	};

	ws.onclose = () => {
		console.log("\nDisconnected.");
		process.exit(0);
	};

	ws.onerror = () => {
		console.error("WebSocket error. Is the daemon running?");
		process.exit(1);
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

	// Keep process alive
	await new Promise(() => {});
}

async function handleWatch(): Promise<void> {
	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	console.log("Watching agent activity (Ctrl+C to stop)...\n");
	await watchProject(projectId);
}

function formatWatchEvent(msg: Record<string, unknown>): void {
	const time = new Date().toLocaleTimeString();
	const type = msg.type as string;

	switch (type) {
		case "tree_updated": {
			const nodes = msg.nodes as { title: string; status: string }[];
			const counts: Record<string, number> = {};
			for (const n of nodes) {
				counts[n.status] = (counts[n.status] ?? 0) + 1;
			}
			const summary = Object.entries(counts)
				.map(([s, c]) => `${s}:${c}`)
				.join(" ");
			console.log(`${time} [tree] ${nodes.length} nodes (${summary})`);
			break;
		}
		case "agent_event": {
			const eventType = msg.eventType as string;
			if (eventType === "tool_use") {
				const tool = msg.tool as string;
				const input = JSON.stringify(msg.input ?? {}).slice(0, 120);
				console.log(`${time} [tool] ${tool} ${input}`);
			} else if (eventType === "tool_result") {
				const tool = msg.tool as string;
				const ok = msg.isError ? "ERR" : "OK";
				const content =
					((msg.content as string) ?? "").split("\n")[0]?.slice(0, 100) ?? "";
				console.log(`${time} [result] ${tool} ${ok} ${content}`);
			} else if (eventType === "text") {
				const content = (msg.content as string) ?? "";
				// Show first line only for brevity
				const firstLine = content.split("\n")[0]?.slice(0, 120) ?? "";
				if (firstLine) console.log(`${time} [text] ${firstLine}`);
			} else if (eventType === "status") {
				console.log(`${time} [status] ${msg.message}`);
			}
			break;
		}
		case "task_started":
			console.log(`${time} [task] > ${msg.title}`);
			break;
		case "task_completed":
			console.log(`${time} [task] ${msg.success ? "+" : "x"} ${msg.title}`);
			break;
		case "orchestration_started":
			console.log(`${time} [orch] Started`);
			break;
		case "orchestration_completed":
			console.log(
				`${time} [orch] ${msg.success ? "Success" : "Failed"}` +
					(msg.costUsd ? ` ($${(msg.costUsd as number).toFixed(2)})` : ""),
			);
			break;
		case "error":
			console.error(`${time} [error] ${msg.message}`);
			break;
		default:
			console.log(`${time} [${type}] ${JSON.stringify(msg).slice(0, 200)}`);
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
		console.error("Daemon not reachable. Start it with: bun run dev");
		process.exit(1);
	}
}

// Main
const [command, ...args] = process.argv.slice(2);

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
	case "health":
		await handleHealth();
		break;
	default:
		console.log("OpenGraft CLI");
		console.log("");
		console.log("Usage: og <command> [args]");
		console.log("");
		console.log("Commands:");
		console.log("  init [path]     Initialize a project");
		console.log("  list            List all projects");
		console.log("  status [id]     Show task tree status");
		console.log("  run <prompt>    Run agent task (one-shot)");
		console.log(
			"  orchestrate <goal>  Start agent orchestration (fire-and-forget)",
		);
		console.log("  continue <taskId> [msg]  Continue a failed/stuck task");
		console.log("  watch           Watch agent activity in real-time");
		console.log("  send <msg>      Send instruction to running agent");
		console.log("  stop            Stop running agent");
		console.log("  health          Check daemon status");
		break;
}
