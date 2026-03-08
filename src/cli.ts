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
	const prompt = args.join(" ");
	if (!prompt) {
		console.error("Usage: og run <prompt>");
		process.exit(1);
	}

	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	console.log("Running agent...");
	const res = await api(`/projects/${projectId}/run`, {
		method: "POST",
		body: JSON.stringify({ prompt }),
	});

	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}

	const result = (await res.json()) as {
		success: boolean;
		output: string;
		turns?: number;
		costUsd?: number;
	};

	console.log(result.success ? "Success" : "Failed");
	if (result.turns) console.log(`Turns: ${result.turns}`);
	if (result.costUsd) console.log(`Cost: $${result.costUsd.toFixed(4)}`);
	console.log("");
	console.log(result.output);
}

async function handleDecompose(args: string[]): Promise<void> {
	const goal = args.join(" ");
	if (!goal) {
		console.error("Usage: og decompose <goal>");
		process.exit(1);
	}

	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	console.log("Decomposing goal...");
	const res = await api(`/projects/${projectId}/decompose`, {
		method: "POST",
		body: JSON.stringify({ goal }),
	});

	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}

	const result = (await res.json()) as {
		root: { title: string };
		nodes: { title: string; status: string }[];
		costUsd?: number;
	};

	console.log(`Created task tree: ${result.root.title}`);
	console.log(`Tasks: ${result.nodes.length}`);
	for (const node of result.nodes) {
		console.log(`  - ${node.title}`);
	}
	if (result.costUsd) console.log(`Cost: $${result.costUsd.toFixed(4)}`);
}

async function handleOrchestrate(args: string[]): Promise<void> {
	const goal = args.join(" ");
	if (!goal) {
		console.error("Usage: og orchestrate <goal>");
		process.exit(1);
	}

	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	console.log("Orchestrating...");
	const res = await api(`/projects/${projectId}/orchestrate/agent`, {
		method: "POST",
		body: JSON.stringify({ prompt: goal }),
	});

	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}

	const result = (await res.json()) as {
		success: boolean;
		output: string;
		costUsd?: number;
		turns?: number;
		tree?: {
			root: { title: string; status: string } | null;
			nodes: { id: string; title: string; status: string }[];
		};
	};

	console.log(result.success ? "Success" : "Failed");
	if (result.turns) console.log(`Turns: ${result.turns}`);
	if (result.costUsd) console.log(`Cost: $${result.costUsd.toFixed(4)}`);
	if (result.tree) {
		console.log(`\nTask tree: ${result.tree.nodes.length} nodes`);
		for (const node of result.tree.nodes) {
			const icon = statusEmoji(node.status);
			console.log(`  ${icon} ${node.title} [${node.status}]`);
		}
	}
	console.log("");
	console.log(result.output);
}

async function handleExecute(): Promise<void> {
	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	console.log("Executing task tree...");

	// Use SSE endpoint for real-time output
	const res = await fetch(
		`${DAEMON_URL}/projects/${projectId}/execute/stream`,
		{
			method: "POST",
		},
	);

	if (!res.ok || !res.body) {
		console.error("Error: execution failed");
		process.exit(1);
	}

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
				const data = JSON.parse(line.slice(6));
				if (data.type === "task_started") {
					console.log(`> Starting: ${data.title}`);
				} else if (data.type === "task_completed") {
					const icon = data.success ? "+" : "x";
					console.log(`${icon} Completed: ${data.title}`);
				} else if (data.type === "merge_started") {
					console.log(`> Merging: ${data.title}`);
				} else if (data.type === "merge_completed") {
					const icon = data.success ? "+" : "x";
					console.log(
						`${icon} Merge: ${data.success ? "succeeded" : "failed"}`,
					);
				} else if (data.type === "error") {
					console.error(`! Error: ${data.message}`);
				} else if (data.completed !== undefined) {
					// Final result
					console.log("");
					console.log(`Completed: ${data.completed}, Failed: ${data.failed}`);
				}
			}
		}
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
		console.error("No project found for current directory. Run: og init");
		process.exit(1);
	}

	return match.id;
}

async function handleRetry(args: string[]): Promise<void> {
	const taskId = args[0];
	if (!taskId) {
		console.error("Usage: og retry <taskId>");
		process.exit(1);
	}

	const projectId = await resolveCurrentProject();
	if (!projectId) return;

	const res = await api(`/projects/${projectId}/tasks/${taskId}/retry`, {
		method: "POST",
	});

	if (!res.ok) {
		const err = (await res.json()) as { error: string };
		console.error(`Error: ${err.error}`);
		process.exit(1);
	}

	const node = (await res.json()) as { title: string; status: string };
	console.log(`Retried: ${node.title} -> ${node.status}`);
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
	case "decompose":
	case "dec":
		await handleDecompose(args);
		break;
	case "orchestrate":
	case "orch":
		await handleOrchestrate(args);
		break;
	case "execute":
	case "exec":
		await handleExecute();
		break;
	case "retry":
		await handleRetry(args);
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
		console.log("  decompose <goal>  Break goal into task tree");
		console.log(
			"  orchestrate <goal>  Agent-driven: decompose + execute + merge",
		);
		console.log("  execute         Execute task tree with worktrees");
		console.log("  retry <taskId>  Retry a failed/stuck task");
		console.log("  health          Check daemon status");
		break;
}
