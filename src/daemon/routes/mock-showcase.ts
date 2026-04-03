import type { Hono } from "hono";
import type { Event } from "../../events.ts";
import {
	TOOL_BASH,
	TOOL_CREATE_TASK,
	TOOL_DONE,
	TOOL_EDIT_FILE,
	TOOL_GET_TREE,
	TOOL_LIST_FILES,
	TOOL_READ_FILE,
	TOOL_SEARCH,
	TOOL_SEND_MESSAGE,
	TOOL_YIELD,
} from "../../tool-names.ts";
import type { TaskNode, TaskStatus } from "../../types.ts";
import { ulid } from "../../ulid.ts";

/**
 * Mock showcase endpoint — returns a complete dataset for UI development.
 * No auth, no project context needed. Pure static data.
 */
export function registerMockShowcaseRoute(app: Hono) {
	app.get("/mock-showcase", (c) => {
		const data = buildMockData();
		return c.json(data);
	});
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ROOT_ID = "mock-root-0000000000000000000";
const FOLDER_ID = "mock-folder-000000000000000000";
const NESTED_FOLDER_ID = "mock-nested-folder-0000000000";
const SESSION_ID = ROOT_ID; // events are tagged with root session

function ts(minutesAgo: number): number {
	return Date.now() - minutesAgo * 60_000;
}

function mockTaskNode(
	id: string,
	title: string,
	status: TaskStatus,
	parentId: string | null,
	opts?: { description?: string; color?: string; costUsd?: number },
): TaskNode {
	return {
		id,
		title,
		description: opts?.description ?? `Description for "${title}"`,
		status,
		branch: `mxd/${id}`,
		parentId,
		children: [],
		worktreePath: null,
		costUsd: opts?.costUsd ?? 0,
		editedBy: "agent",
		color: opts?.color,
		createdAt: new Date(ts(60)).toISOString(),
		updatedAt: new Date(ts(1)).toISOString(),
	};
}

// ── Build mock data ──────────────────────────────────────────────────────────

function buildMockData() {
	// ── Task tree ──────────────────────────────────────────────────────────
	const taskIds = {
		draft: "mock-task-draft-00000000000000",
		pending: "mock-task-pending-000000000000",
		inProgress: "mock-task-in-progress-00000000",
		verify: "mock-task-verify-0000000000000",
		failed: "mock-task-failed-0000000000000",
		closed: "mock-task-closed-0000000000000",
		nestedTask: "mock-task-nested-0000000000000",
	};

	const root = mockTaskNode(
		ROOT_ID,
		"Mock Showcase Project",
		"in_progress",
		null,
		{
			description: "Root orchestrator for the mock showcase.",
			costUsd: 2.45,
		},
	);
	root.children = [
		FOLDER_ID,
		taskIds.draft,
		taskIds.pending,
		taskIds.inProgress,
	];

	const folder = {
		id: FOLDER_ID,
		title: "Completed Work",
		parentId: ROOT_ID,
		children: [
			taskIds.verify,
			taskIds.failed,
			taskIds.closed,
			NESTED_FOLDER_ID,
		],
		type: "folder" as const,
	};

	const nestedFolder = {
		id: NESTED_FOLDER_ID,
		title: "Archived Tasks",
		parentId: FOLDER_ID,
		children: [taskIds.nestedTask],
		type: "folder" as const,
	};

	const tasks: TaskNode[] = [
		root,
		mockTaskNode(
			taskIds.draft,
			"Draft: Design new auth system",
			"draft",
			ROOT_ID,
			{
				description: "Research OAuth2 + PKCE flow for browser clients.",
				color: "purple",
			},
		),
		mockTaskNode(
			taskIds.pending,
			"Pending: Add rate limiting middleware",
			"pending",
			ROOT_ID,
			{
				description:
					"Implement token bucket rate limiter for API endpoints.",
				color: "blue",
			},
		),
		mockTaskNode(
			taskIds.inProgress,
			"In Progress: Refactor event system",
			"in_progress",
			ROOT_ID,
			{
				description:
					"Migrate from string-based event types to discriminated unions.",
				color: "green",
				costUsd: 0.73,
			},
		),
		mockTaskNode(
			taskIds.verify,
			"Verify: Add JWT auth middleware",
			"verify",
			FOLDER_ID,
			{
				description:
					"JWT validation middleware with Bearer token support.",
				color: "blue",
				costUsd: 1.12,
			},
		),
		mockTaskNode(
			taskIds.failed,
			"Failed: Docker multi-stage build",
			"failed",
			FOLDER_ID,
			{
				description:
					"Optimize Docker image with multi-stage build. Failed due to missing native deps.",
				color: "red",
				costUsd: 0.45,
			},
		),
		mockTaskNode(
			taskIds.closed,
			"Closed: Database migration tool",
			"closed",
			FOLDER_ID,
			{
				description: "Built schema migration tool with up/down support.",
				color: "gray",
				costUsd: 0.89,
			},
		),
		mockTaskNode(
			taskIds.nestedTask,
			"Nested: Legacy cleanup",
			"closed",
			NESTED_FOLDER_ID,
			{
				description:
					"Removed deprecated API endpoints and unused dependencies.",
				color: "gray",
				costUsd: 0.15,
			},
		),
	];

	const nodes = [...tasks, folder, nestedFolder];

	// ── Activity events ───────────────────────────────────────────────────
	//
	// Design:
	// - Each tool type has TWO entries: resolved (tool_call + tool_result)
	//   and pending (tool_call only, renders with spinner).
	// - yield tool_call without result → renders as "Waiting" card.
	// - done tool_call without result → renders as pass/fail done card.
	// - Two unconsumed message events → render as pending chips in footer.
	// - Two-phase messages: some consumed (rendered), some not (pending).

	const events: Event[] = [];
	let minute = 50; // start 50 minutes ago, plenty of room

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 1: Lifecycle + basic content
	// ═══════════════════════════════════════════════════════════════════════

	// ── Lifecycle: Agent started ──
	events.push({
		type: "orchestration_started",
		taskId: SESSION_ID,
		resume: false,
		model: "claude-sonnet-4-20250514",
		provider: "anthropic",
		ts: ts(minute--),
	});

	// ── User message (direct, no two-phase) ──
	events.push({
		type: "message",
		id: "",
		taskId: SESSION_ID,
		body: {
			source: "user",
			id: ulid(),
			ts: ts(minute),
			content: "Build the mock showcase page with all card types.",
		},
		ts: ts(minute--),
	});

	// ── Thinking ──
	events.push({
		type: "thinking",
		thinking:
			"The user wants a mock showcase page. I need to understand the event types and how the UI renders them. Let me check the existing card components and event handler to ensure I cover all cases.\n\nI should create both a backend endpoint and frontend integration.",
		signature: "mock-signature-thinking",
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Assistant text ──
	events.push({
		type: "assistant_text",
		content:
			"I'll start by exploring the project structure to understand the existing patterns, then build the mock showcase page.\n\nLet me check the current files and understand the architecture.",
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 2: Resolved tool pairs (tool_call + tool_result)
	// ═══════════════════════════════════════════════════════════════════════

	// ── bash (success) ──
	const bashOkId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_BASH,
		toolCallId: bashOkId,
		input: { command: "ls -la src/daemon/routes/" },
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_BASH,
		toolCallId: bashOkId,
		content:
			"total 48\ndrwxr-xr-x  8 user  staff   256 Apr  3 10:00 .\n-rw-r--r--  1 user  staff  3200 Apr  3 10:00 agent.ts\n-rw-r--r--  1 user  staff  1800 Apr  3 10:00 auth.ts\n-rw-r--r--  1 user  staff  5600 Apr  3 10:00 projects.ts\n-rw-r--r--  1 user  staff  8900 Apr  3 10:00 tasks.ts",
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── bash (error) ──
	const bashErrId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_BASH,
		toolCallId: bashErrId,
		input: { command: "cat /nonexistent/file.ts" },
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_BASH,
		toolCallId: bashErrId,
		content:
			"cat: /nonexistent/file.ts: No such file or directory\nexit code: 1",
		isError: true,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── bash (long output — collapsed) ──
	const bashLongId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_BASH,
		toolCallId: bashLongId,
		input: { command: "bun test" },
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	const longTestOutput = Array.from({ length: 50 }, (_, i) => {
		const suite = Math.floor(i / 5) + 1;
		const names = [
			"initialization",
			"handles valid input",
			"handles edge cases",
			"cleanup works",
			"integration test",
		];
		return `✓ test suite ${suite} > ${names[i % 5]} [${(Math.random() * 2 + 0.1).toFixed(1)}ms]`;
	}).join("\n");
	events.push({
		type: "tool_result",
		tool: TOOL_BASH,
		toolCallId: bashLongId,
		content: `${longTestOutput}\n\n 50 pass\n 0 fail\n 10 suites\n\nRan 50 tests across 10 suites. [4.32s]`,
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── bash (background — shows background process info) ──
	const bashBgId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_BASH,
		toolCallId: bashBgId,
		input: {
			command: "bun run typecheck",
			run_in_background: true,
		},
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_BASH,
		toolCallId: bashBgId,
		content: "Command moved to background.",
		isError: false,
		backgroundId: "bg-MOCK001",
		backgroundCommand: "bun run typecheck",
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── read_file (success) ──
	const readOkId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_READ_FILE,
		toolCallId: readOkId,
		input: { path: "src/daemon/routes/projects.ts", offset: 1, limit: 10 },
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_READ_FILE,
		toolCallId: readOkId,
		content:
			'1: import type { Hono } from "hono";\n2: import { stopAgent } from "../agent-lifecycle.ts";\n3: import type { DaemonContext } from "../context.ts";\n4: import { getPendingClarifications } from "../event-system.ts";\n5: import { getEventStore, stripEventForUI } from "../helpers.ts";\n6:\n7: export function registerProjectRoutes(app: Hono, ctx: DaemonContext) {\n8:   // Projects CRUD\n9:   app.post("/projects", async (c) => {\n10:    const body = await c.req.json<{ path: string }>();',
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── read_file (with image) ──
	const readImgId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_READ_FILE,
		toolCallId: readImgId,
		input: { path: "screenshot.png" },
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	// 1x1 red PNG
	const tinyPng =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
	events.push({
		type: "tool_result",
		tool: TOOL_READ_FILE,
		toolCallId: readImgId,
		content: "Image file read successfully (1x1 pixels)",
		isError: false,
		images: [{ base64: tinyPng, mediaType: "image/png" }],
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── search ──
	const searchId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_SEARCH,
		toolCallId: searchId,
		input: {
			pattern: "registerRoutes",
			path: "src/daemon",
			output_mode: "files_with_matches",
		},
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_SEARCH,
		toolCallId: searchId,
		content:
			"src/daemon/routes/projects.ts\nsrc/daemon/routes/agent.ts\nsrc/daemon/routes/sse.ts\nsrc/daemon/routes/config.ts\nsrc/daemon/routes/tasks.ts",
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── list_files ──
	const listFilesId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_LIST_FILES,
		toolCallId: listFilesId,
		input: { pattern: "web/components/**/*.tsx" },
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_LIST_FILES,
		toolCallId: listFilesId,
		content:
			"web/components/ActivityLog.tsx\nweb/components/Card.tsx\nweb/components/TaskTree.tsx\nweb/components/ToolCard.tsx\nweb/components/InputBar.tsx",
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── edit_file (with diff) ──
	const editId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_EDIT_FILE,
		toolCallId: editId,
		input: {
			path: "src/config.ts",
			old_string:
				'export const DEFAULT_MODEL = "claude-3-opus";\nexport const MAX_TOKENS = 4096;',
			new_string:
				'export const DEFAULT_MODEL = "claude-sonnet-4-20250514";\nexport const MAX_TOKENS = 8192;\nexport const DEFAULT_TIMEOUT = 30_000;',
		},
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_EDIT_FILE,
		toolCallId: editId,
		content: "Applied edit to src/config.ts",
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── MCP: create_task ──
	const createTaskId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_CREATE_TASK,
		toolCallId: createTaskId,
		input: {
			title: "Add rate limiting middleware",
			description:
				"Implement token bucket rate limiter for API endpoints. Should support per-IP and per-user limits.",
			color: "blue",
		},
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_CREATE_TASK,
		toolCallId: createTaskId,
		content: JSON.stringify({
			id: taskIds.pending,
			title: "Add rate limiting middleware",
			status: "pending",
		}),
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── MCP: get_tree ──
	const getTreeId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_GET_TREE,
		toolCallId: getTreeId,
		input: { format: "tree" },
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_GET_TREE,
		toolCallId: getTreeId,
		content: JSON.stringify({
			nodes: [
				{
					id: ROOT_ID,
					title: "Root",
					status: "in_progress",
					children: [taskIds.inProgress],
				},
				{
					id: taskIds.inProgress,
					title: "Refactor event system",
					status: "in_progress",
					children: [],
				},
			],
		}),
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── MCP: send_message ──
	const sendMsgId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_SEND_MESSAGE,
		toolCallId: sendMsgId,
		input: {
			taskId: taskIds.inProgress,
			title: "Progress update",
			message:
				"Completed the type refactoring. All 47 compile errors resolved. Moving to tests.",
		},
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_SEND_MESSAGE,
		toolCallId: sendMsgId,
		content: "Message delivered.",
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── MCP: done (resolved pair — the merged card) ──
	const doneResolvedId = ulid();
	events.push({
		type: "tool_call",
		tool: TOOL_DONE,
		toolCallId: doneResolvedId,
		input: {
			status: "passed",
			summary:
				"Built the mock showcase page with all card types. Backend endpoint returns mock task tree and events.",
		},
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: TOOL_DONE,
		toolCallId: doneResolvedId,
		content: "",
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── External MCP tool (non-builtin) ──
	const externalToolId = ulid();
	events.push({
		type: "tool_call",
		tool: "mcp__brave-search__brave_web_search",
		toolCallId: externalToolId,
		input: { query: "hono framework middleware patterns", count: 5 },
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool: "mcp__brave-search__brave_web_search",
		toolCallId: externalToolId,
		content: JSON.stringify([
			{
				title: "Hono - Ultrafast web framework",
				url: "https://hono.dev",
				description:
					"Hono is an ultrafast web framework for the Edge.",
			},
			{
				title: "Middleware Guide - Hono",
				url: "https://hono.dev/docs/guides/middleware",
				description:
					"Learn how to create and use middleware in Hono.",
			},
		]),
		isError: false,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 3: Two-phase messages — consumed (rendered as cards)
	// ═══════════════════════════════════════════════════════════════════════

	// ── Task message (upward — from child to parent) ──
	const taskMsgUpId = ulid();
	events.push({
		type: "message",
		id: taskMsgUpId,
		taskId: SESSION_ID,
		body: {
			source: "task_message",
			id: taskMsgUpId,
			ts: ts(minute),
			fromTaskId: taskIds.inProgress,
			fromTitle: "Refactor event system",
			content:
				"Completed the discriminated union migration. All 47 type errors fixed. Tests pass. Ready for review.",
			title: "Migration complete",
			requestReply: false,
		},
		ts: ts(minute),
	});
	events.push({
		type: "messages_consumed",
		messageIds: [taskMsgUpId],
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Task message (downward — requestReply) ──
	const taskMsgDownId = ulid();
	events.push({
		type: "message",
		id: taskMsgDownId,
		taskId: SESSION_ID,
		body: {
			source: "task_message",
			id: taskMsgDownId,
			ts: ts(minute),
			fromTaskId: ROOT_ID,
			fromTitle: "Orchestrator",
			content:
				"Good work. Please also update the test snapshots before calling done().",
			title: "Review feedback",
			requestReply: true,
		},
		ts: ts(minute),
	});
	events.push({
		type: "messages_consumed",
		messageIds: [taskMsgDownId],
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── User message forwarded ──
	const fwdMsgId = ulid();
	events.push({
		type: "message",
		id: fwdMsgId,
		taskId: SESSION_ID,
		body: {
			source: "user_message_forwarded",
			id: fwdMsgId,
			ts: ts(minute),
			fromTaskId: ROOT_ID,
			fromTitle: "Orchestrator",
			content: "Please prioritize the auth middleware task.",
		},
		ts: ts(minute),
	});
	events.push({
		type: "messages_consumed",
		messageIds: [fwdMsgId],
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Task complete (passed) ──
	const taskCompletePassedId = ulid();
	events.push({
		type: "message",
		id: taskCompletePassedId,
		taskId: SESSION_ID,
		body: {
			source: "task_complete",
			id: taskCompletePassedId,
			ts: ts(minute),
			taskId: taskIds.verify,
			title: "Add JWT auth middleware",
			success: true,
			output:
				"Implemented JWT validation middleware with Bearer token support. All 12 tests pass.",
		},
		ts: ts(minute),
	});
	events.push({
		type: "messages_consumed",
		messageIds: [taskCompletePassedId],
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Task complete (failed) ──
	const taskCompleteFailedId = ulid();
	events.push({
		type: "message",
		id: taskCompleteFailedId,
		taskId: SESSION_ID,
		body: {
			source: "task_complete",
			id: taskCompleteFailedId,
			ts: ts(minute),
			taskId: taskIds.failed,
			title: "Docker multi-stage build",
			success: false,
			output:
				"Failed: Native dependency `better-sqlite3` requires build tools not available in alpine. Segfaults on ARM64.",
		},
		ts: ts(minute),
	});
	events.push({
		type: "messages_consumed",
		messageIds: [taskCompleteFailedId],
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Tree change ──
	const treeChangeId = ulid();
	events.push({
		type: "message",
		id: treeChangeId,
		taskId: SESSION_ID,
		body: {
			source: "tree_change",
			id: treeChangeId,
			ts: ts(minute),
			action: "created",
			nodeId: taskIds.draft,
			title: "Design new auth system",
		},
		ts: ts(minute),
	});
	events.push({
		type: "messages_consumed",
		messageIds: [treeChangeId],
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Background complete ──
	const bgCompleteId = ulid();
	events.push({
		type: "message",
		id: bgCompleteId,
		taskId: SESSION_ID,
		body: {
			source: "background_complete",
			id: bgCompleteId,
			ts: ts(minute),
			commandId: "bg-MOCK001",
			command: "bun run typecheck",
			exitCode: 0,
			durationMs: 12500,
			stdout: "No errors found.\n\nChecked 142 files in 12.5s.",
			stderr: "",
		},
		ts: ts(minute),
	});
	events.push({
		type: "messages_consumed",
		messageIds: [bgCompleteId],
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Cross-project message ──
	const crossProjectId = ulid();
	events.push({
		type: "message",
		id: crossProjectId,
		taskId: SESSION_ID,
		body: {
			source: "cross_project",
			id: crossProjectId,
			ts: ts(minute),
			fromProjectId: "other-project-id",
			fromProjectName: "API Gateway",
			content:
				"The auth middleware changes are ready for integration. Please update your import to `@company/auth-middleware`.",
		},
		ts: ts(minute),
	});
	events.push({
		type: "messages_consumed",
		messageIds: [crossProjectId],
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Clarify response (from queue) ──
	const clarifyRespId = ulid();
	events.push({
		type: "message",
		id: clarifyRespId,
		taskId: SESSION_ID,
		body: {
			source: "clarify_response",
			id: clarifyRespId,
			ts: ts(minute),
			answer:
				"Yes, include both builtin and external MCP tool examples.",
		},
		ts: ts(minute),
	});
	events.push({
		type: "messages_consumed",
		messageIds: [clarifyRespId],
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 4: Non-message event cards
	// ═══════════════════════════════════════════════════════════════════════

	// ── Task started ──
	events.push({
		type: "task_started",
		taskId: SESSION_ID,
		title: "Refactor event system",
		ts: ts(minute--),
	});

	// ── Error ──
	events.push({
		type: "error",
		taskId: SESSION_ID,
		message:
			"API Error: 429 Too Many Requests — Rate limit exceeded. Retry after 30 seconds.\nRequest ID: req_abc123def456\nModel: claude-sonnet-4-20250514",
		ts: ts(minute--),
	});

	// ── Budget warning ──
	events.push({
		type: "budget_warning",
		warning:
			"Task is at 80% of budget ($1.92 / $2.40). Consider calling done() soon.",
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Clarification requested + answered ──
	events.push({
		type: "clarification_requested",
		taskId: SESSION_ID,
		question:
			"Should the mock showcase include MCP external tool cards, or only builtin tools?",
		title: "Mock showcase scope",
		body: "I noticed there are external MCP tools (e.g., brave-search, chrome-devtools) in the system. Should I include sample cards for those too?",
		ts: ts(minute--),
	});
	events.push({
		type: "clarification_answered",
		taskId: SESSION_ID,
		answer:
			"Include both — builtin and at least one external MCP tool example.",
		ts: ts(minute--),
	});

	// ── Compact started + compact marker ──
	events.push({
		type: "compact_started",
		taskId: SESSION_ID,
		ts: ts(minute--),
	});
	events.push({
		type: "compact_marker",
		checkpoint:
			"## Checkpoint Summary\n\n### Completed:\n- Created backend endpoint at `/mock-showcase`\n- Added task tree with all status variants\n- Generated sample events for all card types\n\n### In Progress:\n- Frontend integration with `?mock=true` parameter\n\n### Key Decisions:\n- Using processEventBatch for consistent rendering\n- Events use the two-phase message lifecycle",
		savedTokens: 45000,
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Fork marker ──
	events.push({
		type: "fork_marker",
		sourceTaskId: taskIds.verify,
		targetTitle: "Continue auth work",
		targetDescription: "Pick up where the auth task left off.",
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Lifecycle: resumed + stopped ──
	events.push({
		type: "orchestration_started",
		taskId: SESSION_ID,
		resume: true,
		model: "claude-sonnet-4-20250514",
		provider: "anthropic",
		ts: ts(minute--),
	});
	events.push({
		type: "agent_stopped",
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── More assistant text ──
	events.push({
		type: "assistant_text",
		content:
			"All card types have been generated. Let me now verify everything renders correctly in the UI.",
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 5: Pending tool_calls (no result — renders with spinner)
	// ═══════════════════════════════════════════════════════════════════════

	// ── Pending: bash ──
	events.push({
		type: "tool_call",
		tool: TOOL_BASH,
		toolCallId: ulid(),
		input: { command: "bun test --watch" },
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Pending: read_file ──
	events.push({
		type: "tool_call",
		tool: TOOL_READ_FILE,
		toolCallId: ulid(),
		input: { path: "src/daemon.ts" },
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Pending: search ──
	events.push({
		type: "tool_call",
		tool: TOOL_SEARCH,
		toolCallId: ulid(),
		input: { pattern: "createApp", path: "src" },
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Pending: edit_file ──
	events.push({
		type: "tool_call",
		tool: TOOL_EDIT_FILE,
		toolCallId: ulid(),
		input: {
			path: "web/App.tsx",
			old_string: "const [mock, setMock] = useState(false);",
			new_string: 'const [mock, setMock] = useState(params.has("mock"));',
		},
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Pending: list_files ──
	events.push({
		type: "tool_call",
		tool: TOOL_LIST_FILES,
		toolCallId: ulid(),
		input: { pattern: "src/**/*.test.ts" },
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Pending: create_task ──
	events.push({
		type: "tool_call",
		tool: TOOL_CREATE_TASK,
		toolCallId: ulid(),
		input: {
			title: "Add WebSocket support",
			description: "Replace SSE with WebSocket for bidirectional communication.",
		},
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Pending: get_tree ──
	events.push({
		type: "tool_call",
		tool: TOOL_GET_TREE,
		toolCallId: ulid(),
		input: { include_details: true },
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Pending: send_message ──
	events.push({
		type: "tool_call",
		tool: TOOL_SEND_MESSAGE,
		toolCallId: ulid(),
		input: {
			taskId: taskIds.inProgress,
			title: "Checking status",
			message: "Are you still working on the event system refactor?",
		},
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── Pending: external MCP tool ──
	events.push({
		type: "tool_call",
		tool: "mcp__chrome-devtools__take_screenshot",
		toolCallId: ulid(),
		input: { fullPage: true },
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 6: Special tools — yield and done standalone
	// ═══════════════════════════════════════════════════════════════════════

	// ── yield (standalone tool_call → "Waiting" card) ──
	events.push({
		type: "tool_call",
		tool: TOOL_YIELD,
		toolCallId: ulid(),
		input: {},
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── done passed (standalone tool_call → pass card) ──
	events.push({
		type: "tool_call",
		tool: TOOL_DONE,
		toolCallId: ulid(),
		input: {
			status: "passed",
			summary:
				"Successfully implemented the mock showcase with all card types and task states.",
		},
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ── done failed (standalone tool_call → fail card) ──
	events.push({
		type: "tool_call",
		tool: TOOL_DONE,
		toolCallId: ulid(),
		input: {
			status: "failed",
			summary:
				"Could not complete the Docker build — missing native dependencies for ARM64.",
		},
		taskId: SESSION_ID,
		ts: ts(minute--),
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 7: Unconsumed messages — show as pending chips in footer
	// ═══════════════════════════════════════════════════════════════════════

	// These have `id` set but no `messages_consumed` follows →
	// they stay in deferredMessages → appear as pending chips.

	const pendingUserMsgId = ulid();
	events.push({
		type: "message",
		id: pendingUserMsgId,
		taskId: SESSION_ID,
		body: {
			source: "user",
			id: pendingUserMsgId,
			ts: ts(minute),
			content: "Can you also add dark mode support?",
		},
		ts: ts(minute--),
	});

	const pendingTaskMsgId = ulid();
	events.push({
		type: "message",
		id: pendingTaskMsgId,
		taskId: SESSION_ID,
		body: {
			source: "task_message",
			id: pendingTaskMsgId,
			ts: ts(minute),
			fromTaskId: taskIds.inProgress,
			fromTitle: "Refactor event system",
			content: "I found a circular dependency in the event module. Need guidance.",
			title: "Circular dependency issue",
			requestReply: true,
		},
		ts: ts(minute--),
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 8: Final lifecycle
	// ═══════════════════════════════════════════════════════════════════════

	events.push({
		type: "orchestration_completed",
		taskId: SESSION_ID,
		success: true,
		costUsd: 2.45,
		turns: 15,
		inputTokens: 125000,
		cacheCreationTokens: 8500,
		cacheReadTokens: 95000,
		outputTokens: 12000,
		childCosts: {
			totalCostUsd: 1.57,
			totalTurns: 42,
			taskCount: 3,
		},
		ts: ts(minute--),
	});

	return {
		nodes,
		rootNodeId: ROOT_ID,
		events,
	};
}
