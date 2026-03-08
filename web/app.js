/** @type {WebSocket | null} */
let ws = null;
/** @type {string} */
let selectedProjectId = "";
/** @type {Map<string, object>} */
const taskNodes = new Map();

// DOM refs
const projectSelect = document.getElementById("project-select");
const taskTree = document.getElementById("task-tree");
const noTasks = document.getElementById("no-tasks");
const activityLog = document.getElementById("activity-log");
const promptInput = document.getElementById("prompt-input");
const btnOrchestrate = document.getElementById("btn-orchestrate");
const btnRefresh = document.getElementById("btn-refresh");
const btnClearLog = document.getElementById("btn-clear-log");
const autoScroll = document.getElementById("auto-scroll");
const connectionStatus = document.getElementById("connection-status");
const costDisplay = document.getElementById("cost-display");
const orchestrateForm = document.getElementById("orchestrate-form");

// --- WebSocket ---

function connectWS() {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	ws = new WebSocket(`${protocol}//${location.host}/ws`);

	ws.onopen = () => {
		connectionStatus.className = "status-dot connected";
		connectionStatus.title = "Connected";
		// Subscribe to current project
		if (selectedProjectId) {
			ws.send(
				JSON.stringify({ type: "subscribe", projectId: selectedProjectId }),
			);
		}
	};

	ws.onclose = () => {
		connectionStatus.className = "status-dot disconnected";
		connectionStatus.title = "Disconnected";
		setTimeout(connectWS, 2000);
	};

	ws.onerror = () => {
		ws.close();
	};

	ws.onmessage = (evt) => {
		try {
			const msg = JSON.parse(evt.data);
			handleWSMessage(msg);
		} catch {
			/* ignore parse errors */
		}
	};
}

function handleWSMessage(msg) {
	switch (msg.type) {
		case "tree_updated":
			renderTaskTree(msg.nodes);
			break;
		case "agent_event":
			logAgentEvent(msg);
			break;
		case "orchestration_started":
			logEntry("orchestration_started", "Orchestration started");
			btnOrchestrate.disabled = true;
			btnOrchestrate.textContent = "Running...";
			break;
		case "orchestration_completed":
			logEntry(
				"orchestration_completed",
				`Orchestration completed: ${msg.success ? "SUCCESS" : "FAILED"}` +
					(msg.costUsd ? ` ($${msg.costUsd.toFixed(2)})` : ""),
			);
			btnOrchestrate.disabled = false;
			btnOrchestrate.textContent = "Orchestrate";
			if (msg.costUsd) {
				costDisplay.textContent = `Last run: $${msg.costUsd.toFixed(2)}`;
			}
			break;
		case "task_started":
			logEntry("task_started", `Task started: ${msg.title}`);
			break;
		case "task_completed":
			logEntry(
				"task_completed",
				`Task ${msg.success ? "passed" : "failed"}: ${msg.title}`,
			);
			break;
		case "error":
			logEntry("error", `Error: ${msg.message}`);
			break;
		default:
			logEntry("agent_event", JSON.stringify(msg));
	}
}

// --- API ---

async function fetchProjects() {
	const res = await fetch("/projects");
	const projects = await res.json();
	projectSelect.innerHTML = '<option value="">Select project...</option>';
	for (const p of projects) {
		const opt = document.createElement("option");
		opt.value = p.id;
		opt.textContent = `${p.name} (${p.path})`;
		projectSelect.appendChild(opt);
	}
	// Auto-select if only one project
	if (projects.length === 1) {
		projectSelect.value = projects[0].id;
		selectProject(projects[0].id);
	}
}

async function fetchTasks(projectId) {
	const res = await fetch(`/projects/${projectId}/tasks`);
	const data = await res.json();
	renderTaskTree(data.nodes || []);
}

async function selectProject(projectId) {
	selectedProjectId = projectId;
	if (!projectId) {
		taskTree.innerHTML = "";
		noTasks.style.display = "block";
		return;
	}
	await fetchTasks(projectId);
	// Subscribe via WS
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "subscribe", projectId }));
	}
}

// --- Task Tree Rendering ---

function renderTaskTree(nodes) {
	taskNodes.clear();
	for (const n of nodes) taskNodes.set(n.id, n);

	if (nodes.length === 0) {
		taskTree.innerHTML = "";
		noTasks.style.display = "block";
		return;
	}
	noTasks.style.display = "none";

	// Build tree structure
	const roots = nodes.filter((n) => !n.parentId);
	const childMap = new Map();
	for (const n of nodes) {
		if (n.parentId) {
			if (!childMap.has(n.parentId)) childMap.set(n.parentId, []);
			childMap.get(n.parentId).push(n);
		}
	}

	taskTree.innerHTML = "";
	for (const root of roots) {
		renderNode(root, childMap, 0);
	}
}

function renderNode(node, childMap, depth) {
	const div = document.createElement("div");
	div.className = "task-node";
	div.dataset.id = node.id;

	const row = document.createElement("div");
	row.className = "task-row";
	row.style.paddingLeft = `${16 + depth * 20}px`;

	const status = document.createElement("span");
	status.className = `task-status status-${node.status}`;

	const title = document.createElement("span");
	title.className = "task-title";
	title.textContent = node.title;

	row.appendChild(status);
	row.appendChild(title);

	if (node.branch) {
		const branch = document.createElement("span");
		branch.className = "task-branch";
		branch.textContent = node.branch.replace("og/", "");
		row.appendChild(branch);
	}

	div.appendChild(row);

	// Meta info (shown on click)
	const meta = document.createElement("div");
	meta.className = "task-meta";
	const parts = [];
	if (node.description) parts.push(node.description);
	if (node.worktreePath) parts.push(`Worktree: ${node.worktreePath}`);
	if (node.sessionId) parts.push(`Session: ${node.sessionId.slice(0, 8)}...`);
	parts.push(`Updated: ${new Date(node.updatedAt).toLocaleTimeString()}`);
	meta.textContent = parts.join(" | ");
	div.appendChild(meta);

	div.addEventListener("click", (e) => {
		e.stopPropagation();
		div.classList.toggle("expanded");
	});

	taskTree.appendChild(div);

	// Render children
	const children = childMap.get(node.id) || [];
	for (const child of children) {
		renderNode(child, childMap, depth + 1);
	}
}

// --- Activity Log ---

function logEntry(eventType, text) {
	const div = document.createElement("div");
	div.className = `log-entry event-${eventType}`;

	const time = document.createElement("span");
	time.className = "log-time";
	time.textContent = new Date().toLocaleTimeString();

	const content = document.createElement("span");
	content.className = "log-text";
	content.textContent = text;

	div.appendChild(time);
	div.appendChild(content);
	activityLog.appendChild(div);

	if (autoScroll.checked) {
		activityLog.scrollTop = activityLog.scrollHeight;
	}
}

function logAgentEvent(msg) {
	if (msg.eventType === "tool_use") {
		logEntry(
			"agent_event",
			`Tool: ${msg.tool} ${JSON.stringify(msg.input || {}).slice(0, 200)}`,
		);
	} else if (msg.eventType === "text") {
		logEntry("agent_event", msg.content || "");
	} else if (msg.eventType === "status") {
		logEntry("agent_event", `Status: ${msg.message}`);
	} else {
		logEntry("agent_event", JSON.stringify(msg).slice(0, 300));
	}
}

// --- Orchestrate ---

orchestrateForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const prompt = promptInput.value.trim();
	if (!prompt || !selectedProjectId) return;

	btnOrchestrate.disabled = true;
	btnOrchestrate.textContent = "Starting...";
	promptInput.value = "";

	try {
		// Send via WS so we get streaming events
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(
				JSON.stringify({
					type: "orchestrate",
					projectId: selectedProjectId,
					prompt,
					maxTurns: 50,
				}),
			);
		} else {
			// Fallback to HTTP
			logEntry(
				"orchestration_started",
				"Orchestration started (HTTP fallback)",
			);
			const res = await fetch(
				`/projects/${selectedProjectId}/orchestrate/agent`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ prompt, maxTurns: 50 }),
				},
			);
			const result = await res.json();
			logEntry(
				"orchestration_completed",
				`Completed: ${result.success ? "SUCCESS" : "FAILED"} ($${(result.costUsd || 0).toFixed(2)})`,
			);
			if (result.tree) renderTaskTree(result.tree.nodes || []);
			btnOrchestrate.disabled = false;
			btnOrchestrate.textContent = "Orchestrate";
		}
	} catch (err) {
		logEntry("error", err.message);
		btnOrchestrate.disabled = false;
		btnOrchestrate.textContent = "Orchestrate";
	}
});

// --- Event Listeners ---

projectSelect.addEventListener("change", () =>
	selectProject(projectSelect.value),
);
btnRefresh.addEventListener("click", () => {
	if (selectedProjectId) fetchTasks(selectedProjectId);
	fetchProjects();
});
btnClearLog.addEventListener("click", () => {
	activityLog.innerHTML = "";
});

// --- Init ---

fetchProjects();
connectWS();

// Poll task tree every 5s as fallback
setInterval(() => {
	if (selectedProjectId) fetchTasks(selectedProjectId);
}, 5000);
