/** @type {WebSocket | null} */
let ws = null;
/** @type {string} */
let selectedProjectId = "";
/** @type {string | null} */
let selectedTaskId = null;
/** @type {Map<string, object>} */
const taskNodes = new Map();
/** @type {Map<string, Array<{eventType: string, text: string}>>} */
const taskEvents = new Map();

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
const injectForm = document.getElementById("inject-form");
const injectInput = document.getElementById("inject-input");
const btnInject = document.getElementById("btn-inject");
const taskDetail = document.getElementById("task-detail");
const btnCloseDetail = document.getElementById("btn-close-detail");
const continueForm = document.getElementById("continue-form");
const continueInput = document.getElementById("continue-input");
const detailLog = document.getElementById("detail-log");

// --- WebSocket ---

function connectWS() {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	ws = new WebSocket(`${protocol}//${location.host}/ws`);

	ws.onopen = () => {
		connectionStatus.className = "status-dot connected";
		connectionStatus.title = "Connected";
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
			injectInput.disabled = false;
			btnInject.disabled = false;
			break;
		case "orchestration_completed":
			logEntry(
				"orchestration_completed",
				`Orchestration completed: ${msg.success ? "SUCCESS" : "FAILED"}` +
					(msg.costUsd ? ` ($${msg.costUsd.toFixed(2)})` : ""),
			);
			btnOrchestrate.disabled = false;
			btnOrchestrate.textContent = "Orchestrate";
			injectInput.disabled = true;
			btnInject.disabled = true;
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
		case "message_injected":
			logEntry("orchestration_started", `You: ${msg.message}`);
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
	selectedTaskId = null;
	closeDetail();
	if (!projectId) {
		taskTree.innerHTML = "";
		noTasks.style.display = "block";
		return;
	}
	await fetchTasks(projectId);
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

	// If detail is open, refresh it
	if (selectedTaskId && taskNodes.has(selectedTaskId)) {
		showDetail(taskNodes.get(selectedTaskId));
	}
}

function renderNode(node, childMap, depth) {
	const div = document.createElement("div");
	div.className = "task-node";
	if (node.id === selectedTaskId) div.className += " selected";
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

	div.addEventListener("click", (e) => {
		e.stopPropagation();
		selectTask(node.id);
	});

	taskTree.appendChild(div);

	const children = childMap.get(node.id) || [];
	for (const child of children) {
		renderNode(child, childMap, depth + 1);
	}
}

// --- Task Detail ---

function selectTask(taskId) {
	selectedTaskId = taskId;
	const node = taskNodes.get(taskId);
	if (!node) return;

	// Update selected state in tree
	for (const el of taskTree.querySelectorAll(".task-node")) {
		el.classList.toggle("selected", el.dataset.id === taskId);
	}

	showDetail(node);
}

function showDetail(node) {
	taskDetail.classList.remove("hidden");

	document.getElementById("detail-title").textContent = node.title;

	const statusEl = document.getElementById("detail-status");
	statusEl.innerHTML = `<div class="detail-label">Status</div><span class="status-badge ${node.status}">${node.status}</span>`;

	setDetailField(
		"detail-description",
		"Description",
		node.description,
		"description",
	);
	setDetailField("detail-branch", "Branch", node.branch);
	setDetailField("detail-worktree", "Worktree", node.worktreePath);
	setDetailField(
		"detail-session",
		"Session",
		node.sessionId ? `${node.sessionId.slice(0, 12)}...` : null,
	);
	setDetailField(
		"detail-updated",
		"Updated",
		node.updatedAt ? new Date(node.updatedAt).toLocaleString() : null,
	);
	setDetailField("detail-message", "Message", node.message);

	// Render per-task agent output
	renderDetailLog(node.id);

	// Show continue form for failed/stuck tasks
	if (node.status === "failed" || node.status === "stuck") {
		continueForm.classList.remove("hidden");
	} else {
		continueForm.classList.add("hidden");
	}
}

function setDetailField(id, label, value, extraClass) {
	const el = document.getElementById(id);
	if (!value) {
		el.innerHTML = "";
		return;
	}
	el.innerHTML = `<div class="detail-label">${label}</div><div class="detail-value ${extraClass || ""}">${escapeHtml(value)}</div>`;
}

function escapeHtml(text) {
	const div = document.createElement("div");
	div.textContent = text;
	return div.innerHTML;
}

function renderDetailLog(taskId) {
	detailLog.innerHTML = "";
	const events = taskEvents.get(taskId) || [];
	for (const evt of events) {
		appendDetailLogEntry(evt.eventType, evt.text);
	}
}

function appendDetailLogEntry(eventType, text) {
	const div = document.createElement("div");
	div.className = `detail-log-entry event-${eventType}`;
	div.textContent = text;
	detailLog.appendChild(div);
	detailLog.scrollTop = detailLog.scrollHeight;
}

function closeDetail() {
	taskDetail.classList.add("hidden");
	selectedTaskId = null;
	for (const el of taskTree.querySelectorAll(".task-node.selected")) {
		el.classList.remove("selected");
	}
}

// --- Continue task ---

continueForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	if (!selectedProjectId || !selectedTaskId) return;

	const message = continueInput.value.trim();
	const body = message ? { message } : {};

	try {
		const res = await fetch(
			`/projects/${selectedProjectId}/tasks/${selectedTaskId}/continue`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		if (res.ok) {
			const updated = await res.json();
			taskNodes.set(updated.id, updated);
			showDetail(updated);
			logEntry(
				"task_started",
				`Continued task: ${updated.title}${message ? ` — "${message}"` : ""}`,
			);
			continueInput.value = "";
			// Refresh tree to show updated status
			await fetchTasks(selectedProjectId);
		} else {
			const err = await res.json();
			logEntry("error", `Continue failed: ${err.error}`);
		}
	} catch (err) {
		logEntry("error", `Continue failed: ${err.message}`);
	}
});

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
	let text;
	if (msg.eventType === "tool_use") {
		text = `Tool: ${msg.tool} ${JSON.stringify(msg.input || {}).slice(0, 200)}`;
	} else if (msg.eventType === "text") {
		text = msg.content || "";
	} else if (msg.eventType === "status") {
		text = `Status: ${msg.message}`;
	} else {
		text = JSON.stringify(msg).slice(0, 300);
	}

	logEntry("agent_event", text);

	// Store per-task events for the detail panel
	if (msg.taskId) {
		if (!taskEvents.has(msg.taskId)) taskEvents.set(msg.taskId, []);
		taskEvents.get(msg.taskId).push({ eventType: msg.eventType, text });
		// If this task is currently selected, append to detail log
		if (msg.taskId === selectedTaskId) {
			appendDetailLogEntry(msg.eventType, text);
		}
	}
}

// --- Orchestrate ---

const modelSelect = document.getElementById("model-select");

orchestrateForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const prompt = promptInput.value.trim();
	if (!prompt || !selectedProjectId) return;

	const model = modelSelect.value || undefined;

	btnOrchestrate.disabled = true;
	btnOrchestrate.textContent = "Starting...";
	promptInput.value = "";

	try {
		if (ws && ws.readyState === WebSocket.OPEN) {
			const msg = {
				type: "orchestrate",
				projectId: selectedProjectId,
				prompt,
				maxTurns: 50,
			};
			if (model) msg.model = model;
			ws.send(JSON.stringify(msg));
		} else {
			logEntry(
				"orchestration_started",
				"Orchestration started (HTTP fallback)",
			);
			const res = await fetch(
				`/projects/${selectedProjectId}/orchestrate/agent`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ prompt, maxTurns: 50, model }),
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
btnCloseDetail.addEventListener("click", closeDetail);

// --- Inject Message ---

injectForm.addEventListener("submit", (e) => {
	e.preventDefault();
	const message = injectInput.value.trim();
	if (!message || !selectedProjectId) return;

	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(
			JSON.stringify({
				type: "inject_message",
				projectId: selectedProjectId,
				prompt: message,
			}),
		);
	}
	injectInput.value = "";
});

// --- Init ---

fetchProjects();
connectWS();

// Poll task tree every 5s as fallback
setInterval(() => {
	if (selectedProjectId) fetchTasks(selectedProjectId);
}, 5000);
