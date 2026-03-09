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

/** @type {boolean} */
let showToolCalls = false;

// DOM refs
const projectSelect = document.getElementById("project-select");
const taskTree = document.getElementById("task-tree");
const noTasks = document.getElementById("no-tasks");
const activityLog = document.getElementById("activity-log");
const promptInput = document.getElementById("prompt-input");
const btnOrchestrate = document.getElementById("btn-orchestrate");
const btnStop = document.getElementById("btn-stop");
const btnRefresh = document.getElementById("btn-refresh");
const btnClearLog = document.getElementById("btn-clear-log");
const btnAddTask = document.getElementById("btn-add-task");
const btnInitProject = document.getElementById("btn-init-project");
const btnDeleteProject = document.getElementById("btn-delete-project");
const btnDeleteTask = document.getElementById("btn-delete-task");
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
const modelSelect = document.getElementById("model-select");
const childModelSelect = document.getElementById("child-model-select");

// --- "Show tool calls" toggle in activity panel header ---

(function injectToolCallsToggle() {
	const activitySection = document.getElementById("activity-section");
	if (!activitySection) return;
	const panelActions = activitySection.querySelector(".panel-actions");
	if (!panelActions) return;

	const label = document.createElement("label");
	label.title = "Toggle tool call visibility";
	label.style.cssText =
		"font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:4px;";

	const checkbox = document.createElement("input");
	checkbox.type = "checkbox";
	checkbox.id = "show-tool-calls";
	checkbox.checked = showToolCalls;

	label.appendChild(checkbox);
	label.appendChild(document.createTextNode("Tools"));
	panelActions.insertBefore(label, panelActions.firstChild);

	checkbox.addEventListener("change", () => {
		showToolCalls = checkbox.checked;
		activityLog.classList.toggle("hide-tool-calls", !showToolCalls);
	});

	// Apply initial state
	activityLog.classList.toggle("hide-tool-calls", !showToolCalls);
})();

// --- WebSocket ---

let wsReconnectDelay = 1000;

function connectWS() {
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	ws = new WebSocket(`${protocol}//${location.host}/ws`);

	ws.onopen = () => {
		connectionStatus.className = "status-dot connected";
		connectionStatus.title = "Connected";
		wsReconnectDelay = 1000; // Reset backoff on success
		if (selectedProjectId) {
			ws.send(
				JSON.stringify({ type: "subscribe", projectId: selectedProjectId }),
			);
		}
	};

	ws.onclose = () => {
		connectionStatus.className = "status-dot disconnected";
		connectionStatus.title = "Disconnected";
		setTimeout(connectWS, wsReconnectDelay);
		wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
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
			logLifecycleEntry("orchestration_started", "Orchestration started");
			setOrchestrationRunning(true);
			break;
		case "orchestration_completed":
			logLifecycleEntry(
				"orchestration_completed",
				`Orchestration completed: ${msg.success ? "SUCCESS" : "FAILED"}` +
					(msg.costUsd ? ` ($${msg.costUsd.toFixed(2)})` : ""),
			);
			setOrchestrationRunning(false);
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
		case "agent_stopped":
			logLifecycleEntry("orchestration_completed", "Agent stopped");
			setOrchestrationRunning(false);
			break;
		case "error":
			logEntry("error", `Error: ${msg.message}`);
			break;
		default:
			logEntry("agent_event", JSON.stringify(msg));
	}
}

function setOrchestrationRunning(running) {
	btnOrchestrate.disabled = running;
	btnOrchestrate.textContent = running ? "Running..." : "Orchestrate";
	btnStop.classList.toggle("hidden", !running);
	injectInput.disabled = !running;
	btnInject.disabled = !running;
}

// --- API ---

async function fetchProjects() {
	try {
		const res = await fetch("/projects");
		const projects = await res.json();
		const currentValue = projectSelect.value;
		projectSelect.innerHTML = '<option value="">Select project...</option>';
		for (const p of projects) {
			const opt = document.createElement("option");
			opt.value = p.id;
			opt.textContent = `${p.name} (${p.path})`;
			projectSelect.appendChild(opt);
		}
		// Restore selection or auto-select single project
		if (currentValue && projects.some((p) => p.id === currentValue)) {
			projectSelect.value = currentValue;
		} else if (projects.length === 1) {
			projectSelect.value = projects[0].id;
			selectProject(projects[0].id);
		}
		// Show/hide delete button
		btnDeleteProject.classList.toggle("hidden", !projectSelect.value);
	} catch {
		/* ignore fetch errors */
	}
}

async function fetchTasks(projectId) {
	try {
		const res = await fetch(`/projects/${projectId}/tasks`);
		const data = await res.json();
		renderTaskTree(data.nodes || []);
	} catch {
		/* ignore */
	}
}

async function selectProject(projectId) {
	selectedProjectId = projectId;
	selectedTaskId = null;
	closeDetail();
	btnDeleteProject.classList.toggle("hidden", !projectId);
	if (!projectId) {
		taskTree.innerHTML = "";
		noTasks.style.display = "block";
		setOrchestrationRunning(false);
		return;
	}
	await fetchTasks(projectId);
	// Check if an agent is currently running
	try {
		const agentRes = await fetch(`/projects/${projectId}/agent`);
		const agentStatus = await agentRes.json();
		setOrchestrationRunning(agentStatus.running);
	} catch {
		/* ignore */
	}
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
	// Use 'open' class to trigger CSS slide-in transition
	taskDetail.classList.add("open");

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

/**
 * Append a log entry to the per-task detail panel with improved rendering.
 * @param {string} eventType
 * @param {string} text
 */
function appendDetailLogEntry(eventType, text) {
	const div = document.createElement("div");
	div.className = `detail-log-entry event-${eventType}`;

	if (eventType === "tool_use") {
		// Compact, de-emphasized display
		div.textContent = `⚙ ${text}`;
	} else if (eventType === "tool_result") {
		// Even more compact
		div.textContent = text;
	} else if (eventType === "error") {
		// Prominent error prefix
		div.textContent = `✗ ${text}`;
	} else {
		// text / status / default: readable wrap
		div.textContent = text;
	}

	detailLog.appendChild(div);
	detailLog.scrollTop = detailLog.scrollHeight;
}

function closeDetail() {
	// Use 'open' class removal to trigger CSS slide-out transition
	taskDetail.classList.remove("open");
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
			await fetchTasks(selectedProjectId);
		} else {
			const err = await res.json();
			logEntry("error", `Continue failed: ${err.error}`);
		}
	} catch (err) {
		logEntry("error", `Continue failed: ${err.message}`);
	}
});

// --- Delete task ---

btnDeleteTask.addEventListener("click", async () => {
	if (!selectedProjectId || !selectedTaskId) return;
	const node = taskNodes.get(selectedTaskId);
	if (!node) return;

	if (!confirm(`Delete task "${node.title}" and all its children?`)) return;

	try {
		const res = await fetch(
			`/projects/${selectedProjectId}/tasks/${selectedTaskId}`,
			{ method: "DELETE" },
		);
		if (res.ok) {
			logEntry("task_completed", `Deleted task: ${node.title}`);
			closeDetail();
			await fetchTasks(selectedProjectId);
		} else {
			const err = await res.json();
			logEntry("error", `Delete failed: ${err.error}`);
		}
	} catch (err) {
		logEntry("error", `Delete failed: ${err.message}`);
	}
});

// --- Activity Log ---

/**
 * Build a task-badge element from a taskId, if present.
 * @param {string | undefined} taskId
 * @returns {HTMLElement | null}
 */
function buildTaskBadge(taskId) {
	if (!taskId) return null;
	const node = taskNodes.get(taskId);
	const label = node?.title
		? node.title.slice(0, 20) + (node.title.length > 20 ? "…" : "")
		: taskId.slice(0, 8);

	const badge = document.createElement("span");
	badge.className = "log-task-badge";
	badge.textContent = label;
	badge.title = taskId;
	badge.style.cssText =
		"display:inline-block;font-size:10px;padding:1px 6px;border-radius:8px;" +
		"background:var(--bg-tertiary);color:var(--text-muted);margin-right:6px;" +
		"font-family:var(--font-mono);vertical-align:middle;border:1px solid var(--border);";
	return badge;
}

/**
 * Append a generic entry to the activity log.
 * @param {string} eventType
 * @param {string} text
 * @param {string | undefined} [taskId]
 */
function logEntry(eventType, text, taskId) {
	const div = document.createElement("div");
	div.className = `log-entry event-${eventType}`;

	const time = document.createElement("span");
	time.className = "log-time";
	time.textContent = new Date().toLocaleTimeString();

	div.appendChild(time);

	// Task badge (if taskId provided)
	const badge = buildTaskBadge(taskId);
	if (badge) div.appendChild(badge);

	const content = document.createElement("span");
	content.className = "log-text";
	content.textContent = text;

	div.appendChild(content);
	activityLog.appendChild(div);

	if (autoScroll.checked) {
		activityLog.scrollTop = activityLog.scrollHeight;
	}
}

/**
 * Log a major lifecycle event with a visual separator before it.
 * @param {string} eventType
 * @param {string} text
 */
function logLifecycleEntry(eventType, text) {
	const hr = document.createElement("hr");
	hr.className = "log-separator";
	hr.style.cssText =
		"border:none;border-top:1px solid var(--border);margin:6px 0;opacity:0.5;";
	activityLog.appendChild(hr);
	logEntry(eventType, text);
}

/**
 * Format tool_use args into a compact human-readable string.
 * @param {object} input
 * @returns {string}
 */
function formatToolArgs(input) {
	if (!input || typeof input !== "object") return "";
	const parts = Object.entries(input).map(([k, v]) => {
		const val = typeof v === "string" ? v : JSON.stringify(v);
		const truncated = val.length > 40 ? `${val.slice(0, 40)}…` : val;
		return `${k}=${truncated}`;
	});
	const joined = parts.join(", ");
	return joined.length > 120 ? `${joined.slice(0, 120)}…` : joined;
}

/**
 * Log an agent_event WebSocket message with improved rendering.
 * @param {object} msg
 */
function logAgentEvent(msg) {
	let text;
	let entryEventType = "agent_event";

	if (msg.eventType === "tool_use") {
		const args = formatToolArgs(msg.input);
		text = args ? `⚙ ${msg.tool}(${args})` : `⚙ ${msg.tool}`;
		entryEventType = "tool_use";
	} else if (msg.eventType === "tool_result") {
		const prefix = msg.isError ? "✗" : "✓";
		const content = (msg.content || "").slice(0, 200);
		text = `${prefix} ${msg.tool}: ${content}`;
		entryEventType = "tool_result";
	} else if (msg.eventType === "text") {
		text = msg.content || "";
		entryEventType = "text";
	} else if (msg.eventType === "status") {
		text = msg.message || msg.content || JSON.stringify(msg).slice(0, 200);
		entryEventType = "status";
	} else if (msg.eventType === "error") {
		text = msg.message || msg.content || JSON.stringify(msg).slice(0, 200);
		entryEventType = "error";
	} else {
		text = JSON.stringify(msg).slice(0, 300);
	}

	// Build the log entry div directly (to support per-event CSS classes for filtering)
	const div = document.createElement("div");
	div.className = `log-entry event-agent_event event-${entryEventType}`;

	const time = document.createElement("span");
	time.className = "log-time";
	time.textContent = new Date().toLocaleTimeString();
	div.appendChild(time);

	// Task badge
	const badge = buildTaskBadge(msg.taskId);
	if (badge) div.appendChild(badge);

	const content = document.createElement("span");
	content.className = "log-text";
	content.textContent = text;
	div.appendChild(content);

	activityLog.appendChild(div);

	if (autoScroll.checked) {
		activityLog.scrollTop = activityLog.scrollHeight;
	}

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

orchestrateForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	const prompt = promptInput.value.trim();
	if (!prompt || !selectedProjectId) return;

	const model = modelSelect.value || undefined;
	const childModel = childModelSelect.value || undefined;

	promptInput.value = "";

	try {
		// Always use HTTP POST (fire-and-forget), observe via WS
		const body = { prompt };
		if (model) body.model = model;
		if (childModel) body.childModel = childModel;

		const res = await fetch(
			`/projects/${selectedProjectId}/orchestrate/agent`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		const result = await res.json();
		if (!res.ok) {
			logEntry("error", result.error || "Failed to start orchestration");
		}
		// orchestration_started event will come via WS
	} catch (err) {
		logEntry("error", err.message);
	}
});

// --- Stop orchestration ---

btnStop.addEventListener("click", async () => {
	if (!selectedProjectId) return;
	try {
		const res = await fetch(`/projects/${selectedProjectId}/stop`, {
			method: "POST",
		});
		if (res.ok) {
			logEntry("agent_event", "Stop requested");
		} else {
			const err = await res.json();
			logEntry("error", err.error || "Failed to stop agent");
		}
	} catch (err) {
		logEntry("error", `Stop failed: ${err.message}`);
	}
});

// --- Project Management ---

btnInitProject.addEventListener("click", async () => {
	const path = prompt("Enter project path:");
	if (!path) return;

	try {
		const res = await fetch("/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path }),
		});
		if (res.ok) {
			const project = await res.json();
			logEntry("orchestration_started", `Project created: ${project.name}`);
			await fetchProjects();
			projectSelect.value = project.id;
			selectProject(project.id);
		} else {
			const err = await res.json();
			logEntry("error", `Init failed: ${err.error}`);
		}
	} catch (err) {
		logEntry("error", `Init failed: ${err.message}`);
	}
});

btnDeleteProject.addEventListener("click", async () => {
	if (!selectedProjectId) return;
	const selectedOpt = projectSelect.options[projectSelect.selectedIndex];
	const name = selectedOpt ? selectedOpt.textContent : selectedProjectId;

	if (!confirm(`Delete project ${name}? (Code will not be deleted)`)) return;

	try {
		const res = await fetch(`/projects/${selectedProjectId}`, {
			method: "DELETE",
		});
		if (res.ok) {
			logEntry("orchestration_completed", `Project deleted: ${name}`);
			selectedProjectId = "";
			projectSelect.value = "";
			await fetchProjects();
			selectProject("");
		} else {
			const err = await res.json();
			logEntry("error", `Delete failed: ${err.error}`);
		}
	} catch (err) {
		logEntry("error", `Delete failed: ${err.message}`);
	}
});

// --- Add Task ---

btnAddTask.addEventListener("click", async () => {
	if (!selectedProjectId) {
		logEntry("error", "Select a project first");
		return;
	}

	const title = prompt("Task title:");
	if (!title) return;

	const description = prompt("Task description:") || "";

	// If a task is selected, create as child; otherwise create root
	const body = { title, description };
	if (selectedTaskId) {
		body.parentId = selectedTaskId;
	}

	try {
		const res = await fetch(`/projects/${selectedProjectId}/tasks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (res.ok) {
			logEntry("task_started", `Task created: ${title}`);
			await fetchTasks(selectedProjectId);
		} else {
			const err = await res.json();
			logEntry("error", `Create failed: ${err.error}`);
		}
	} catch (err) {
		logEntry("error", `Create failed: ${err.message}`);
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
