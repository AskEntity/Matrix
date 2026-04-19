import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Event } from "../../events.ts";
import { mcpToolName } from "../../tool-names.ts";

// Matrix tool constants — local to this demo file
const T = mcpToolName;
const TOOL_BACKGROUND = T("background");
const TOOL_BASH = T("bash");
const TOOL_CLARIFY = T("clarify");
const TOOL_CLOSE_TASK = T("close_task");
const TOOL_CREATE_TASK = T("create_task");
const TOOL_DELETE_TASK = T("delete_task");
const TOOL_DONE = T("done");
const TOOL_EDIT_FILE = T("edit_file");
const TOOL_EVALUATE_SCRIPT = T("evaluate_script");
const TOOL_EXECUTE_TASKS = T("execute_tasks");
const TOOL_FORK_TASK_CONTEXT = T("fork_task_context");
const TOOL_GET_TASK = T("get_task");
const TOOL_GET_TREE = T("get_tree");
const TOOL_LIST_FILES = T("list_files");
const TOOL_LIST_PROJECTS = T("list_projects");
const TOOL_READ_FILE = T("read_file");
const TOOL_REORDER_TASKS = T("reorder_tasks");
const TOOL_RESET_TASK = T("reset_task");
const TOOL_SEARCH = T("search");
const TOOL_SEND_MESSAGE = T("send_message");
const TOOL_SEND_MESSAGE_TO_PROJECT = T("send_message_to_project");
const TOOL_UPDATE_TASK = T("update_task");
const TOOL_WRITE_FILE = T("write_file");
const TOOL_YIELD = T("yield");
const TOOL_CREATE_FOLDER = T("create_folder");
const TOOL_DELETE_FOLDER = T("delete_folder");
const TOOL_RENAME_FOLDER = T("rename_folder");

import type { GeneralNode, TaskNode, TaskStatus } from "../../types.ts";
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
const SESSION_ID = ROOT_ID;

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
		cwd: null,
		costUsd: opts?.costUsd ?? 0,
		editedBy: "agent",
		color: opts?.color,
		createdAt: new Date(ts(120)).toISOString(),
		updatedAt: new Date(ts(1)).toISOString(),
		type: "task",
	};
}

/** Push a resolved tool pair (tool_call + tool_result). */
function pushResolved(
	events: Event[],
	tool: string,
	input: Record<string, unknown>,
	content: string,
	minute: number,
	opts?: {
		isError?: boolean;
		images?: Array<{ base64: string; mediaType: string }>;
		backgroundId?: string;
		backgroundCommand?: string;
	},
): number {
	const id = ulid();
	events.push({
		type: "tool_call",
		tool,
		toolCallId: id,
		input,
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	events.push({
		type: "tool_result",
		tool,
		toolCallId: id,
		content,
		isError: opts?.isError ?? false,
		...(opts?.images ? { images: opts.images } : {}),
		...(opts?.backgroundId ? { backgroundId: opts.backgroundId } : {}),
		...(opts?.backgroundCommand
			? { backgroundCommand: opts.backgroundCommand }
			: {}),
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	return minute - 1;
}

/** Push a pending tool_call (no result — renders spinner). */
function pushPending(
	events: Event[],
	tool: string,
	input: Record<string, unknown>,
	minute: number,
): number {
	events.push({
		type: "tool_call",
		tool,
		toolCallId: ulid(),
		input,
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	return minute - 1;
}

/** Push a two-phase consumed message. */
function pushConsumedMessage(
	events: Event[],
	body: Record<string, unknown>,
	minute: number,
): number {
	const msgId = ulid();
	const fullBody = { ...body, id: msgId, ts: ts(minute) };
	events.push({
		type: "message",
		id: msgId,
		taskId: SESSION_ID,
		body: fullBody as Event extends { type: "message"; body: infer B }
			? B
			: never,
		ts: ts(minute),
	});
	events.push({
		type: "messages_consumed",
		messageIds: [msgId],
		taskId: SESSION_ID,
		ts: ts(minute),
	});
	return minute - 1;
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

	const folder: GeneralNode = {
		id: FOLDER_ID,
		title: "Completed Work",
		parentId: ROOT_ID,
		children: [
			taskIds.verify,
			taskIds.failed,
			taskIds.closed,
			NESTED_FOLDER_ID,
		],
		type: "folder",
	};

	const nestedFolder: GeneralNode = {
		id: NESTED_FOLDER_ID,
		title: "Archived Tasks",
		parentId: FOLDER_ID,
		children: [taskIds.nestedTask],
		type: "folder",
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
				description: "Implement token bucket rate limiter for API endpoints.",
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
				description: "JWT validation middleware with Bearer token support.",
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
	const events: Event[] = [];
	let m = 120; // start 120 minutes ago — plenty of room

	// 200x200 gradient PNG loaded from file — visible image for testing rendering
	const mockPng = readFileSync(
		join(import.meta.dirname, "mock-showcase-image.png"),
	).toString("base64");

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 1: Lifecycle + content events
	// ═══════════════════════════════════════════════════════════════════════

	// agent_start (initial)
	events.push({
		type: "agent_start",
		taskId: SESSION_ID,
		resume: false,
		model: "claude-sonnet-4-20250514",
		provider: "anthropic",
		ts: ts(m--),
	});

	// User message — plain text (two-phase consumed)
	m = pushConsumedMessage(
		events,
		{
			source: "user",
			content: "Build the mock showcase page with all card types.",
		},
		m,
	);

	// User message — with images (two-phase consumed)
	m = pushConsumedMessage(
		events,
		{
			source: "user",
			content:
				"Here's the screenshot of the current UI. Can you fix the alignment?",
			images: [
				{ base64: mockPng, mediaType: "image/png" },
				{ base64: mockPng, mediaType: "image/png" },
			],
		},
		m,
	);

	// thinking
	events.push({
		type: "thinking",
		thinking:
			"The user wants a mock showcase page. I need to understand the event types and how the UI renders them. Let me check the existing card components and event handler to ensure I cover all cases.\n\nI should create both a backend endpoint and frontend integration.",
		signature: "mock-signature-thinking",
		taskId: SESSION_ID,
		ts: ts(m--),
	});

	// assistant_text
	events.push({
		type: "assistant_text",
		content:
			"I'll start by exploring the project structure to understand the existing patterns, then build the mock showcase page.\n\nLet me check the current files and understand the architecture.",
		taskId: SESSION_ID,
		ts: ts(m--),
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 2: Resolved tool pairs (tool_call + tool_result)
	// ═══════════════════════════════════════════════════════════════════════

	// ── File tools ───────────────────────────────────────────────────────

	// bash (success)
	m = pushResolved(
		events,
		TOOL_BASH,
		{ command: "ls -la src/daemon/routes/" },
		"total 48\ndrwxr-xr-x  8 user  staff   256 Apr  3 10:00 .\n-rw-r--r--  1 user  staff  3200 Apr  3 10:00 agent.ts\n-rw-r--r--  1 user  staff  1800 Apr  3 10:00 auth.ts\n-rw-r--r--  1 user  staff  5600 Apr  3 10:00 projects.ts\n-rw-r--r--  1 user  staff  8900 Apr  3 10:00 tasks.ts",
		m,
	);

	// bash (error)
	m = pushResolved(
		events,
		TOOL_BASH,
		{ command: "cat /nonexistent/file.ts" },
		"cat: /nonexistent/file.ts: No such file or directory\nexit code: 1",
		m,
		{ isError: true },
	);

	// bash (long output — collapsed)
	{
		const longOutput = Array.from({ length: 50 }, (_, i) => {
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
		m = pushResolved(
			events,
			TOOL_BASH,
			{ command: "bun test" },
			`${longOutput}\n\n 50 pass\n 0 fail\n 10 suites\n\nRan 50 tests across 10 suites. [4.32s]`,
			m,
		);
	}

	// bash (background)
	m = pushResolved(
		events,
		TOOL_BASH,
		{ command: "bun run typecheck", run_in_background: true },
		"Command moved to background.",
		m,
		{ backgroundId: "bg-MOCK001", backgroundCommand: "bun run typecheck" },
	);

	// read_file (success)
	m = pushResolved(
		events,
		TOOL_READ_FILE,
		{ path: "src/daemon/routes/projects.ts", offset: 1, limit: 10 },
		'1: import type { Hono } from "hono";\n2: import { stopAgent } from "../agent-lifecycle.ts";\n3: import type { RuntimeContext } from "../context.ts";\n4: import { getPendingClarifications } from "../event-system.ts";\n5: import { getEventStore } from "../helpers.ts";\n6:\n7: export function registerProjectRoutes(app: Hono, ctx: RuntimeContext) {\n8:   // Projects CRUD\n9:   app.post("/projects", async (c) => {\n10:    const body = await c.req.json<{ path: string }>();',
		m,
	);

	// read_file (with image result)
	m = pushResolved(
		events,
		TOOL_READ_FILE,
		{ path: "screenshot.png" },
		"Image file read successfully (1x1 pixels)",
		m,
		{ images: [{ base64: mockPng, mediaType: "image/png" }] },
	);

	// search
	m = pushResolved(
		events,
		TOOL_SEARCH,
		{
			pattern: "registerRoutes",
			path: "src/daemon",
			output_mode: "files_with_matches",
		},
		"src/daemon/routes/projects.ts\nsrc/daemon/routes/agent.ts\nsrc/daemon/routes/sse.ts\nsrc/daemon/routes/config.ts\nsrc/daemon/routes/tasks.ts",
		m,
	);

	// list_files
	m = pushResolved(
		events,
		TOOL_LIST_FILES,
		{ pattern: "web/components/**/*.tsx" },
		"web/components/ActivityLog.tsx\nweb/components/Card.tsx\nweb/components/TaskTree.tsx\nweb/components/ToolCard.tsx\nweb/components/InputBar.tsx",
		m,
	);

	// edit_file (with diff view)
	m = pushResolved(
		events,
		TOOL_EDIT_FILE,
		{
			path: "src/config.ts",
			old_string:
				'export const DEFAULT_MODEL = "claude-3-opus";\nexport const MAX_TOKENS = 4096;',
			new_string:
				'export const DEFAULT_MODEL = "claude-sonnet-4-20250514";\nexport const MAX_TOKENS = 8192;\nexport const DEFAULT_TIMEOUT = 30_000;',
		},
		"Applied edit to src/config.ts",
		m,
	);

	// write_file
	m = pushResolved(
		events,
		TOOL_WRITE_FILE,
		{
			path: "src/utils/helpers.ts",
			content:
				"export function formatDuration(ms: number): string {\n  if (ms < 1000) return ms + 'ms';\n  return (ms / 1000).toFixed(1) + 's';\n}\n",
		},
		"Wrote 120 bytes to src/utils/helpers.ts",
		m,
	);

	// ── Task tools ──────────────────────────────────────────────────────

	// create_task
	m = pushResolved(
		events,
		TOOL_CREATE_TASK,
		{
			title: "Add rate limiting middleware",
			description: "Implement token bucket rate limiter for API endpoints.",
			color: "blue",
		},
		JSON.stringify({
			id: taskIds.pending,
			title: "Add rate limiting middleware",
			status: "pending",
		}),
		m,
	);

	// get_tree (plain)
	m = pushResolved(
		events,
		TOOL_GET_TREE,
		{ format: "tree" },
		JSON.stringify({
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
		m,
	);

	// get_tree (with details + closed)
	m = pushResolved(
		events,
		TOOL_GET_TREE,
		{ format: "flat", include_details: true, include_closed: true },
		JSON.stringify({
			nodes: [
				{
					id: ROOT_ID,
					title: "Root",
					status: "in_progress",
					description: "Root orchestrator",
					costUsd: 2.45,
					children: [taskIds.inProgress, taskIds.closed],
				},
				{
					id: taskIds.inProgress,
					title: "Refactor event system",
					status: "in_progress",
					description: "Migrate to discriminated unions.",
					costUsd: 0.73,
					children: [],
				},
				{
					id: taskIds.closed,
					title: "Database migration tool",
					status: "closed",
					description: "Built schema migration tool.",
					costUsd: 0.89,
					children: [],
				},
			],
		}),
		m,
	);

	// get_task
	m = pushResolved(
		events,
		TOOL_GET_TASK,
		{ taskId: taskIds.inProgress },
		JSON.stringify({
			id: taskIds.inProgress,
			title: "Refactor event system",
			status: "in_progress",
			description:
				"Migrate from string-based event types to discriminated unions.",
			color: "green",
			costUsd: 0.73,
		}),
		m,
	);

	// update_task (field changes: status, title, color)
	m = pushResolved(
		events,
		TOOL_UPDATE_TASK,
		{
			taskId: taskIds.draft,
			title: "Design new auth system (OAuth2 + PKCE)",
			status: "pending",
			color: "blue",
		},
		JSON.stringify({
			id: taskIds.draft,
			title: "Design new auth system (OAuth2 + PKCE)",
			status: "pending",
		}),
		m,
	);

	// update_task (surgical description diff — triggers DiffView)
	m = pushResolved(
		events,
		TOOL_UPDATE_TASK,
		{
			taskId: taskIds.inProgress,
			old_description: "Migrate from string-based event types",
			new_description:
				"Migrate from string-based event types to discriminated unions with exhaustive switches",
		},
		JSON.stringify({
			id: taskIds.inProgress,
			title: "Refactor event system",
			status: "in_progress",
		}),
		m,
	);

	// delete_task
	m = pushResolved(
		events,
		TOOL_DELETE_TASK,
		{ taskId: taskIds.nestedTask },
		JSON.stringify({ deleted: taskIds.nestedTask }),
		m,
	);

	// close_task
	m = pushResolved(
		events,
		TOOL_CLOSE_TASK,
		{ taskId: taskIds.verify },
		JSON.stringify({ closed: taskIds.verify }),
		m,
	);

	// reset_task
	m = pushResolved(
		events,
		TOOL_RESET_TASK,
		{ taskId: taskIds.failed },
		JSON.stringify({ reset: taskIds.failed, status: "pending" }),
		m,
	);

	// reorder_tasks
	m = pushResolved(
		events,
		TOOL_REORDER_TASKS,
		{
			nodeId: ROOT_ID,
			children: [taskIds.inProgress, taskIds.pending, taskIds.draft, FOLDER_ID],
		},
		"Reordered 4 children.",
		m,
	);

	// execute_tasks (legacy — start multiple)
	m = pushResolved(
		events,
		TOOL_EXECUTE_TASKS,
		{
			tasks: [
				{ taskId: taskIds.pending, message: "Start rate limiter" },
				{ taskId: taskIds.draft, message: "Begin auth design" },
			],
		},
		JSON.stringify({ launched: [taskIds.pending, taskIds.draft] }),
		m,
	);

	// ── Communication tools ──────────────────────────────────────────────

	// send_message
	m = pushResolved(
		events,
		TOOL_SEND_MESSAGE,
		{
			taskId: taskIds.inProgress,
			title: "Progress update",
			message:
				"Completed the type refactoring. All 47 compile errors resolved. Moving to tests.",
		},
		"Message delivered.",
		m,
	);

	// send_message_to_project
	m = pushResolved(
		events,
		TOOL_SEND_MESSAGE_TO_PROJECT,
		{
			projectId: "other-project-id",
			message:
				"Auth middleware v2 is ready. Please test against your API gateway.",
		},
		"Message sent to project API Gateway.",
		m,
	);

	// clarify
	m = pushResolved(
		events,
		TOOL_CLARIFY,
		{
			question:
				"Should we support both OAuth2 and API key auth, or OAuth2 only?",
		},
		"Clarification sent to user.",
		m,
	);

	// ── Lifecycle tools ──────────────────────────────────────────────────

	// done (resolved pair — tool_call + tool_result)
	m = pushResolved(
		events,
		TOOL_DONE,
		{
			status: "passed",
			summary:
				"Built the mock showcase page with all card types. Backend endpoint returns mock task tree and events.",
		},
		"",
		m,
	);

	// yield (resolved pair — tool_call + tool_result)
	m = pushResolved(events, TOOL_YIELD, {}, "resumed.", m);

	// ── Advanced tools ───────────────────────────────────────────────────

	// fork_task_context
	m = pushResolved(
		events,
		TOOL_FORK_TASK_CONTEXT,
		{
			sourceTaskId: taskIds.verify,
			targetTaskId: taskIds.pending,
		},
		"Forked context from source task. You are the parent agent — continue your work.",
		m,
	);

	// list_projects
	m = pushResolved(
		events,
		TOOL_LIST_PROJECTS,
		{},
		JSON.stringify([
			{ id: "proj-1", name: "Matrix", path: "/Users/dev/matrix" },
			{
				id: "proj-2",
				name: "API Gateway",
				path: "/Users/dev/api-gateway",
			},
		]),
		m,
	);

	// background (list)
	m = pushResolved(
		events,
		TOOL_BACKGROUND,
		{ action: "list" },
		JSON.stringify([
			{
				id: "bg-MOCK001",
				command: "bun run typecheck",
				status: "running",
			},
			{
				id: "bg-MOCK002",
				command: "bun test --watch",
				status: "completed",
				exitCode: 0,
			},
		]),
		m,
	);

	// evaluate_script
	m = pushResolved(
		events,
		TOOL_EVALUATE_SCRIPT,
		{
			function: "() => { return document.querySelectorAll('.card').length; }",
		},
		"42",
		m,
	);

	// ── Folder tools ─────────────────────────────────────────────────────

	// create_folder
	m = pushResolved(
		events,
		TOOL_CREATE_FOLDER,
		{ title: "Sprint 3 Tasks" },
		JSON.stringify({ id: FOLDER_ID, title: "Sprint 3 Tasks" }),
		m,
	);

	// rename_folder
	m = pushResolved(
		events,
		TOOL_RENAME_FOLDER,
		{ folderId: FOLDER_ID, title: "Completed Work" },
		JSON.stringify({ id: FOLDER_ID, title: "Completed Work" }),
		m,
	);

	// delete_folder
	m = pushResolved(
		events,
		TOOL_DELETE_FOLDER,
		{ folderId: NESTED_FOLDER_ID },
		JSON.stringify({ deleted: NESTED_FOLDER_ID }),
		m,
	);

	// ── External MCP tool (non-builtin) ──────────────────────────────────

	// brave_web_search (resolved)
	m = pushResolved(
		events,
		"mcp__brave-search__brave_web_search",
		{ query: "hono framework middleware patterns", count: 5 },
		JSON.stringify([
			{
				title: "Hono - Ultrafast web framework",
				url: "https://hono.dev",
				description: "Hono is an ultrafast web framework for the Edge.",
			},
			{
				title: "Middleware Guide - Hono",
				url: "https://hono.dev/docs/guides/middleware",
				description: "Learn how to create and use middleware in Hono.",
			},
		]),
		m,
	);

	// chrome-devtools take_screenshot (resolved with image)
	m = pushResolved(
		events,
		"mcp__chrome-devtools__take_screenshot",
		{ fullPage: true, format: "png" },
		"Screenshot captured (1x1 pixels)",
		m,
		{ images: [{ base64: mockPng, mediaType: "image/png" }] },
	);

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 3: Two-phase messages — consumed (rendered as cards)
	// ═══════════════════════════════════════════════════════════════════════

	// Task message (upward — from child to parent)
	m = pushConsumedMessage(
		events,
		{
			source: "task_message",
			fromTaskId: taskIds.inProgress,
			fromTitle: "Refactor event system",
			content:
				"Completed the discriminated union migration. All 47 type errors fixed. Tests pass. Ready for review.",
			title: "Migration complete",
			requestReply: false,
		},
		m,
	);

	// Task message (downward — from parent to child, requestReply)
	m = pushConsumedMessage(
		events,
		{
			source: "task_message",
			fromTaskId: ROOT_ID,
			fromTitle: "Orchestrator",
			content:
				"Good work. Please also update the test snapshots before calling done().",
			title: "Review feedback",
			requestReply: true,
		},
		m,
	);

	// User message forwarded
	m = pushConsumedMessage(
		events,
		{
			source: "user_message_forwarded",
			fromTaskId: ROOT_ID,
			fromTitle: "Orchestrator",
			content: "Please prioritize the auth middleware task.",
		},
		m,
	);

	// User message forwarded (resumed)
	m = pushConsumedMessage(
		events,
		{
			source: "user_message_forwarded",
			fromTaskId: ROOT_ID,
			fromTitle: "Orchestrator",
			content: "Pick up where you left off on the auth middleware.",
			resumed: true,
		},
		m,
	);

	// Task complete (success)
	m = pushConsumedMessage(
		events,
		{
			source: "task_complete",
			taskId: taskIds.verify,
			title: "Add JWT auth middleware",
			success: true,
			output:
				"Implemented JWT validation middleware with Bearer token support. All 12 tests pass.",
		},
		m,
	);

	// Task complete (failed)
	m = pushConsumedMessage(
		events,
		{
			source: "task_complete",
			taskId: taskIds.failed,
			title: "Docker multi-stage build",
			success: false,
			output:
				"Failed: Native dependency `better-sqlite3` requires build tools not available in alpine. Segfaults on ARM64.",
		},
		m,
	);

	// Tree change
	m = pushConsumedMessage(
		events,
		{
			source: "tree_change",
			action: "created",
			nodeId: taskIds.draft,
			title: "Design new auth system",
		},
		m,
	);

	// Background complete
	m = pushConsumedMessage(
		events,
		{
			source: "background_complete",
			commandId: "bg-MOCK001",
			command: "bun run typecheck",
			exitCode: 0,
			durationMs: 12500,
			content:
				"exit code: 0\nstdout:\nNo errors found.\n\nChecked 142 files in 12.5s.",
		},
		m,
	);

	// Cross-project message
	m = pushConsumedMessage(
		events,
		{
			source: "cross_project",
			fromProjectId: "other-project-id",
			fromProjectName: "API Gateway",
			content:
				"The auth middleware changes are ready for integration. Please update your import to `@company/auth-middleware`.",
		},
		m,
	);

	// Clarify response
	m = pushConsumedMessage(
		events,
		{
			source: "clarify_response",
			answer: "Yes, include both builtin and external MCP tool examples.",
		},
		m,
	);

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 4: Non-message event cards
	// ═══════════════════════════════════════════════════════════════════════

	// error
	events.push({
		type: "error",
		taskId: SESSION_ID,
		message:
			"API Error: 429 Too Many Requests — Rate limit exceeded. Retry after 30 seconds.\nRequest ID: req_abc123def456\nModel: claude-sonnet-4-20250514",
		ts: ts(m--),
	});

	// budget_warning
	events.push({
		type: "budget_warning",
		warning:
			"Task is at 80% of budget ($1.92 / $2.40). Consider calling done() soon.",
		taskId: SESSION_ID,
		ts: ts(m--),
	});

	// clarification_requested
	events.push({
		type: "clarification_requested",
		taskId: SESSION_ID,
		question:
			"Should the mock showcase include MCP external tool cards, or only builtin tools?",
		title: "Mock showcase scope",
		body: "I noticed there are external MCP tools (e.g., brave-search, chrome-devtools) in the system. Should I include sample cards for those too?",
		ts: ts(m--),
	});

	// clarification_answered
	events.push({
		type: "clarification_answered",
		taskId: SESSION_ID,
		answer:
			"Include both — builtin and at least one external MCP tool example.",
		ts: ts(m--),
	});

	// compact_started
	events.push({
		type: "compact_started",
		taskId: SESSION_ID,
		ts: ts(m--),
	});

	// compact_marker (empty boundary)
	events.push({
		type: "compact_marker",
		savedTokens: 45000,
		taskId: SESSION_ID,
		ts: ts(m--),
	});

	// compacted_resume — post-compact summary card (visual cousin of compact_marker)
	{
		const crId = ulid();
		const crTs = ts(m--);
		events.push({
			type: "message",
			id: crId,
			taskId: SESSION_ID,
			body: {
				source: "compacted_resume",
				id: crId,
				ts: crTs,
				content: [
					"Summary of pre-compact conversation:",
					"",
					"• Implemented JWT auth (login, refresh, session-token).",
					"• Landed tests for the strict-error harness.",
					"• Started the auth-group migration: schema + one provider wired.",
					"",
					"Where you stopped:",
					"You were mid-refactor of the OpenAI provider's auth group lookup",
					"and were about to write a validator for the 'defaultAuth' empty",
					"string case when context filled up.",
					"",
					"Next step: finish `resolveAuthGroup()` in `src/providers/openai.ts`,",
					"then run the drift-lifecycle suite.",
				].join("\n"),
			},
			ts: crTs,
		});
	}

	// fork_marker
	events.push({
		type: "fork_marker",
		sourceTaskId: taskIds.verify,
		targetTitle: "Continue auth work",
		targetDescription: "Pick up where the auth task left off.",
		taskId: SESSION_ID,
		ts: ts(m--),
	});

	// agent_start (resume)
	events.push({
		type: "agent_start",
		taskId: SESSION_ID,
		resume: true,
		model: "claude-sonnet-4-20250514",
		provider: "anthropic",
		ts: ts(m--),
	});

	// agent_end (stopped)
	events.push({
		type: "agent_end",
		taskId: SESSION_ID,
		reason: "stopped",
		ts: ts(m--),
	});

	// More assistant text
	events.push({
		type: "assistant_text",
		content:
			"All card types have been generated. Let me now verify everything renders correctly in the UI.",
		taskId: SESSION_ID,
		ts: ts(m--),
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 5: Pending tool_calls (no result — renders with spinner)
	// ═══════════════════════════════════════════════════════════════════════

	// File tools
	m = pushPending(events, TOOL_BASH, { command: "bun test --watch" }, m);
	m = pushPending(events, TOOL_READ_FILE, { path: "src/daemon.ts" }, m);
	m = pushPending(
		events,
		TOOL_SEARCH,
		{ pattern: "createApp", path: "src" },
		m,
	);
	m = pushPending(
		events,
		TOOL_EDIT_FILE,
		{
			path: "web/App.tsx",
			old_string: "const [mock, setMock] = useState(false);",
			new_string: 'const [mock, setMock] = useState(params.has("mock"));',
		},
		m,
	);
	m = pushPending(
		events,
		TOOL_WRITE_FILE,
		{ path: "src/new-module.ts", content: "export const VERSION = '1.0.0';\n" },
		m,
	);
	m = pushPending(events, TOOL_LIST_FILES, { pattern: "src/**/*.test.ts" }, m);

	// Task tools
	m = pushPending(
		events,
		TOOL_CREATE_TASK,
		{
			title: "Add WebSocket support",
			description:
				"Replace SSE with WebSocket for bidirectional communication.",
		},
		m,
	);
	m = pushPending(events, TOOL_GET_TREE, { include_details: true }, m);
	m = pushPending(events, TOOL_GET_TASK, { taskId: taskIds.verify }, m);
	m = pushPending(
		events,
		TOOL_UPDATE_TASK,
		{ taskId: taskIds.pending, status: "in_progress" },
		m,
	);
	m = pushPending(events, TOOL_DELETE_TASK, { taskId: taskIds.nestedTask }, m);
	m = pushPending(events, TOOL_CLOSE_TASK, { taskId: taskIds.verify }, m);
	m = pushPending(events, TOOL_RESET_TASK, { taskId: taskIds.failed }, m);
	m = pushPending(
		events,
		TOOL_REORDER_TASKS,
		{ nodeId: ROOT_ID, children: [taskIds.draft, taskIds.pending] },
		m,
	);
	m = pushPending(
		events,
		TOOL_EXECUTE_TASKS,
		{ tasks: [{ taskId: taskIds.draft, message: "Go" }] },
		m,
	);

	// Communication tools
	m = pushPending(
		events,
		TOOL_SEND_MESSAGE,
		{
			taskId: taskIds.inProgress,
			title: "Checking status",
			message: "Are you still working on the event system refactor?",
		},
		m,
	);
	m = pushPending(
		events,
		TOOL_SEND_MESSAGE_TO_PROJECT,
		{ projectId: "proj-2", message: "Ready to integrate?" },
		m,
	);
	m = pushPending(
		events,
		TOOL_CLARIFY,
		{ question: "Which auth provider should we use?" },
		m,
	);

	// Advanced tools
	m = pushPending(
		events,
		TOOL_FORK_TASK_CONTEXT,
		{ sourceTaskId: taskIds.verify, targetTaskId: taskIds.pending },
		m,
	);
	m = pushPending(events, TOOL_LIST_PROJECTS, {}, m);
	m = pushPending(
		events,
		TOOL_BACKGROUND,
		{ action: "status", id: "bg-MOCK001" },
		m,
	);
	m = pushPending(
		events,
		TOOL_EVALUATE_SCRIPT,
		{ function: "() => document.title" },
		m,
	);

	// Folder tools
	m = pushPending(events, TOOL_CREATE_FOLDER, { title: "Sprint 4 Tasks" }, m);
	m = pushPending(
		events,
		TOOL_RENAME_FOLDER,
		{ folderId: FOLDER_ID, title: "Finished" },
		m,
	);
	m = pushPending(
		events,
		TOOL_DELETE_FOLDER,
		{ folderId: NESTED_FOLDER_ID },
		m,
	);

	// External MCP tool (pending)
	m = pushPending(
		events,
		"mcp__chrome-devtools__take_screenshot",
		{ fullPage: true },
		m,
	);

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 6: Special tools — yield and done standalone (no result)
	// ═══════════════════════════════════════════════════════════════════════

	// yield (standalone → "Waiting" card)
	m = pushPending(events, TOOL_YIELD, {}, m);

	// done passed (standalone → pass card)
	m = pushPending(
		events,
		TOOL_DONE,
		{
			status: "passed",
			summary:
				"Successfully implemented the mock showcase with all card types and task states.",
		},
		m,
	);

	// done failed (standalone → fail card)
	m = pushPending(
		events,
		TOOL_DONE,
		{
			status: "failed",
			summary:
				"Could not complete the Docker build — missing native dependencies for ARM64.",
		},
		m,
	);

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 7: Unconsumed messages — pending chips in footer
	// ═══════════════════════════════════════════════════════════════════════

	// These have id set but no messages_consumed follows → pending chips
	const pendingUserMsgId = ulid();
	events.push({
		type: "message",
		id: pendingUserMsgId,
		taskId: SESSION_ID,
		body: {
			source: "user",
			id: pendingUserMsgId,
			ts: ts(m),
			content: "Can you also add dark mode support?",
		},
		ts: ts(m--),
	});

	const pendingTaskMsgId = ulid();
	events.push({
		type: "message",
		id: pendingTaskMsgId,
		taskId: SESSION_ID,
		body: {
			source: "task_message",
			id: pendingTaskMsgId,
			ts: ts(m),
			fromTaskId: taskIds.inProgress,
			fromTitle: "Refactor event system",
			content:
				"I found a circular dependency in the event module. Need guidance.",
			title: "Circular dependency issue",
			requestReply: true,
		},
		ts: ts(m--),
	});

	// ═══════════════════════════════════════════════════════════════════════
	// SECTION 8: Final lifecycle
	// ═══════════════════════════════════════════════════════════════════════

	events.push({
		type: "agent_end",
		taskId: SESSION_ID,
		reason: "done_passed",
		stats: {
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
		},
		ts: ts(m--),
	});

	// ── Additional UI state ──
	const backgroundProcesses = [
		{
			id: "bg-MOCK001",
			command: "bun run typecheck --watch",
			startTime: ts(5),
			taskId: SESSION_ID,
		},
		{
			id: "bg-MOCK002",
			command: "bun test --watch --bail",
			startTime: ts(3),
			taskId: SESSION_ID,
		},
	];

	const pendingClarifications = [
		{
			id: ulid(),
			taskId: SESSION_ID,
			question:
				"Should the mock showcase include MCP external tool cards, or only builtin tools?",
			title: "Mock showcase scope",
			body: "I noticed there are external MCP tools (e.g., brave-search, chrome-devtools). Should I include sample cards for those, or focus only on the builtin mxd tools?",
			timestamp: ts(8),
		},
	];

	const tokenUsage = {
		inputTokens: 98500,
		contextWindow: 200000,
	};

	return {
		nodes,
		rootNodeId: ROOT_ID,
		events,
		backgroundProcesses,
		pendingClarifications,
		tokenUsage,
	};
}
