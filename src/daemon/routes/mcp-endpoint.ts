/**
 * HTTP MCP endpoint — exposes Matrix's read-only tools to external MCP clients
 * (e.g., Claude Code) via the MCP Streamable HTTP transport.
 *
 * Each external MCP client connection gets a stateful session with its own
 * attachment — which project (and optionally which task) the session is
 * looking at. Tools execute in the attached context.
 *
 * Routes:
 *   ALL /mcp        — MCP Streamable HTTP endpoint (POST/GET/DELETE)
 *
 * Auth: reuses the daemon's JWT auth middleware (applied globally in daemon.ts).
 *
 * WHY: External Claude Code can query Matrix state without context-switching
 * to Matrix's web UI. Foundation for graceful degradation if OAuth tightens.
 */

import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { z } from "zod";
import { getImageDimensions } from "../../image-dimensions.ts";
import { createCrossProjectMessage } from "../../queue-message-factory.ts";
import { jsSearch } from "../../tools/search.ts";
import { isFolder, isTask, stripSession } from "../../types.ts";
import { deliverMessage } from "../agent-lifecycle.ts";
import type { DaemonContext } from "../context.ts";
import { subscribeToEvents } from "../event-system.ts";
import { getEventStore, getTracker, stripEventForUI } from "../helpers.ts";

/** Check path is inside root after resolution. Returns resolved path. */
function assertPathInRoot(absPath: string, rootDir: string): string {
	const resolvedPath = resolve(absPath);
	const resolvedRoot = resolve(rootDir);
	const withSep = resolvedRoot.endsWith("/")
		? resolvedRoot
		: `${resolvedRoot}/`;
	if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(withSep)) {
		throw new Error(
			`Path escapes attached root: ${absPath} is not inside ${rootDir}`,
		);
	}
	return resolvedPath;
}

/**
 * Wire Matrix's MCP tools into an McpServer instance. The session ID is
 * resolved lazily via getSessionId() so we can bind tools before the
 * transport has generated its session ID.
 */
function wireTools(
	server: McpServer,
	ctx: DaemonContext,
	getSessionId: () => string | undefined,
): void {
	const getAttachment = () => {
		const sid = getSessionId();
		if (!sid) return undefined;
		return ctx.mcpSessionStore.get(sid)?.attachment;
	};

	const requireAttachedTask = () => {
		const a = getAttachment();
		if (!a) throw new Error("Not attached. Call attach_to first.");
		if (!a.taskId) {
			throw new Error(
				"Not attached to a task. Call attach_to(projectId, taskId) with a taskId.",
			);
		}
		return { projectId: a.projectId, taskId: a.taskId };
	};

	const getAttachedWorktreeRoot = async (): Promise<string> => {
		const { projectId, taskId } = requireAttachedTask();
		const project = ctx.pm.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const tracker = await getTracker(ctx, projectId);
		const node = tracker.getTask(taskId);
		if (!node) throw new Error(`Task not found: ${taskId}`);
		return node.worktreePath ?? project.path;
	};

	// ── Unscoped tools ─────────────────────────────────────────────────────

	server.registerTool(
		"list_projects",
		{
			description:
				"List all registered Matrix projects. Call this first to discover project IDs for attach_to.",
			inputSchema: {},
		},
		async () => {
			const projects = ctx.pm.list().map((p) => ({
				id: p.id,
				name: p.name,
				path: p.path,
			}));
			return {
				content: [{ type: "text", text: JSON.stringify(projects, null, 2) }],
			};
		},
	);

	server.registerTool(
		"attach_to",
		{
			description:
				"Attach this MCP session to a Matrix project and (optionally) a task within it. " +
				"Scoped tools (get_tree, get_task, read_file, etc.) operate in the attached context. " +
				"Calling attach_to again replaces the current attachment. " +
				"Pass peerKey to claim a configured peer identity (required for send_message).",
			inputSchema: {
				projectId: z.string().describe("Project ID (from list_projects)"),
				taskId: z
					.string()
					.optional()
					.describe(
						"Task node ID within the project. Required by scoped file tools.",
					),
				peerKey: z
					.string()
					.optional()
					.describe(
						"Peer identity key. Must match a configured entry in config.mcpClients. " +
							"Matrix looks up the mapped projectId/projectName and uses them as the " +
							"server-enforced identity for any send_message calls from this session. " +
							"Without peerKey, send_message is unavailable (anonymous mode).",
					),
			},
		},
		async (args) => {
			const sid = getSessionId();
			if (!sid) {
				return {
					content: [
						{ type: "text", text: "Error: MCP session not initialized." },
					],
					isError: true,
				};
			}
			const project = ctx.pm.get(args.projectId);
			if (!project) {
				return {
					content: [
						{
							type: "text",
							text: `Error: Project not found: ${args.projectId}`,
						},
					],
					isError: true,
				};
			}
			if (args.taskId) {
				const tracker = await getTracker(ctx, args.projectId);
				const node = tracker.getTask(args.taskId);
				if (!node) {
					return {
						content: [
							{
								type: "text",
								text: `Error: Task not found in project ${project.name}: ${args.taskId}`,
							},
						],
						isError: true,
					};
				}
			}
			// Resolve peer identity from config.mcpClients. If peerKey is provided,
			// it MUST match a configured entry (fail-closed). If omitted, session
			// operates anonymously (read tools + yield work, send_message does not).
			let peerIdentity: { projectId: string; projectName: string } | undefined;
			if (args.peerKey !== undefined) {
				const entry = ctx.globalConfig.mcpClients?.[args.peerKey];
				if (!entry) {
					return {
						content: [
							{
								type: "text",
								text: `Error: peerKey "${args.peerKey}" not found in config.mcpClients. Either add it to your Matrix config or omit peerKey for anonymous mode.`,
							},
						],
						isError: true,
					};
				}
				peerIdentity = {
					projectId: entry.projectId,
					projectName: entry.projectName,
				};
			}
			// Ensure state exists (onsessioninitialized may not have fired yet on first call)
			if (!ctx.mcpSessionStore.get(sid)) ctx.mcpSessionStore.create(sid);
			ctx.mcpSessionStore.attach(sid, {
				projectId: args.projectId,
				taskId: args.taskId,
			});
			// Set peer identity on session state (server-enforced; peer cannot forge).
			const state = ctx.mcpSessionStore.get(sid);
			if (state) {
				state.peerIdentity = peerIdentity;
			}
			// Initialize yield cursor for the attached task at CURRENT event count
			// so the first yield() call starts from "now" — waits for NEW activity
			// rather than replaying history (use get_logs for history).
			if (args.taskId && state && !state.yieldCursors.has(args.taskId)) {
				const eventStore = getEventStore(ctx, args.projectId);
				await eventStore.flushSession(args.taskId);
				const { events } = eventStore.readFromLastCompactMarker(args.taskId);
				state.yieldCursors.set(args.taskId, events.length);
			}
			const info = {
				projectId: args.projectId,
				projectName: project.name,
				projectPath: project.path,
				taskId: args.taskId ?? null,
				peerIdentity: peerIdentity ?? null,
			};
			return {
				content: [
					{
						type: "text",
						text: `Attached.\n${JSON.stringify(info, null, 2)}`,
					},
				],
			};
		},
	);

	server.registerTool(
		"get_attachment",
		{
			description:
				"Return the current attachment for this MCP session — which project and task (if any) scoped tools will operate against.",
			inputSchema: {},
		},
		async () => {
			const a = getAttachment();
			if (!a) {
				return {
					content: [
						{
							type: "text",
							text: "Not attached. Call attach_to(projectId, taskId) to attach.",
						},
					],
				};
			}
			const project = ctx.pm.get(a.projectId);
			const sid = getSessionId();
			const state = sid ? ctx.mcpSessionStore.get(sid) : undefined;
			const info = {
				projectId: a.projectId,
				projectName: project?.name ?? "(missing)",
				projectPath: project?.path ?? null,
				taskId: a.taskId ?? null,
				peerIdentity: state?.peerIdentity ?? null,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
			};
		},
	);

	server.registerTool(
		"send_message",
		{
			description:
				"Send a message to a task in the attached project. Requires peer identity " +
				"(peerKey passed to attach_to, matching a config.mcpClients entry). The message " +
				"is delivered as a cross_project message with server-enforced fromProjectId / " +
				"fromProjectName from the peer's config entry — the peer cannot forge these.\n\n" +
				"Scope: taskId must be the attached task, any ancestor in its parent chain, or " +
				"one of its direct children. Siblings and grandchildren are rejected.\n\n" +
				"Does NOT auto-launch stopped agents (quiet delivery) — the message is queued / " +
				"persisted, and the agent receives it on its next run.",
			inputSchema: {
				taskId: z
					.string()
					.describe(
						"Target task node ID. Must be in scope: attached task, ancestor, or direct child.",
					),
				content: z.string().describe("Message content"),
				title: z
					.string()
					.optional()
					.describe("Optional short subject line for the message"),
			},
		},
		async (args) => {
			try {
				const sid = getSessionId();
				if (!sid) throw new Error("MCP session not initialized");
				const state = ctx.mcpSessionStore.get(sid);
				if (!state) throw new Error("MCP session state missing");
				const attachment = state.attachment;
				if (!attachment) {
					throw new Error("Not attached. Call attach_to first.");
				}
				if (!state.peerIdentity) {
					throw new Error(
						"send_message requires peer identity. Call attach_to with a peerKey " +
							"that matches a config.mcpClients entry. Anonymous sessions can read " +
							"and yield but cannot send messages.",
					);
				}

				const projectId = attachment.projectId;
				const project = ctx.pm.get(projectId);
				if (!project) {
					throw new Error(`Project not found: ${projectId}`);
				}
				const tracker = await getTracker(ctx, projectId);

				// Resolve target task
				const targetNode = tracker.getTask(args.taskId);
				if (!targetNode) {
					throw new Error(`Task not found: ${args.taskId}`);
				}

				// Scope enforcement: attached task, its parent chain, or its direct children.
				// BEFORE any side effect — fail-closed.
				const attachedTaskId = attachment.taskId;
				if (!attachedTaskId) {
					throw new Error(
						"Scope check failed: session is attached at project level only (no taskId). " +
							"Call attach_to with a taskId to enable send_message.",
					);
				}
				let inScope = false;
				// Case A: target IS the attached task
				if (args.taskId === attachedTaskId) {
					inScope = true;
				}
				// Case B: target is an ancestor of attached task (parent chain)
				if (!inScope) {
					let ancestor = tracker.getTaskAbove(attachedTaskId);
					while (ancestor) {
						if (ancestor.id === args.taskId) {
							inScope = true;
							break;
						}
						ancestor = tracker.getTaskAbove(ancestor.id);
					}
				}
				// Case C: target is a DIRECT child of attached task
				// (target's task-above must be the attached task, folders transparent)
				if (!inScope) {
					const targetTaskAbove = tracker.getTaskAbove(args.taskId);
					if (targetTaskAbove?.id === attachedTaskId) {
						inScope = true;
					}
				}
				if (!inScope) {
					throw new Error(
						`Scope check failed: "${args.taskId}" is not the attached task, ` +
							"an ancestor, or a direct child. send_message can only target these.",
					);
				}

				// Build cross_project message with SERVER-ENFORCED identity.
				// Peer supplies only content + optional title.
				// fromProjectId / fromProjectName come from config — peer cannot forge.
				const content = args.title
					? `[${args.title}] ${args.content}`
					: args.content;
				const queueMessage = createCrossProjectMessage(
					state.peerIdentity.projectId,
					state.peerIdentity.projectName,
					content,
				);

				// Quiet delivery — do NOT auto-launch stopped agents.
				// Safer default for external peers. Message is persisted to JSONL;
				// agent picks it up on its next run.
				await deliverMessage(
					ctx,
					{ id: projectId, path: project.path },
					args.taskId,
					queueMessage,
					{ quiet: true },
				);

				return {
					content: [
						{
							type: "text",
							text: `Message delivered to "${targetNode.title}" (${args.taskId}) as cross_project from ${state.peerIdentity.projectName}.`,
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	// ── Scoped tools (require attached project+task) ───────────────────────

	server.registerTool(
		"get_tree",
		{
			description:
				"Get the task tree of the attached project. Returns all nodes with status, hierarchy, and parent links.",
			inputSchema: {
				include_closed: z
					.boolean()
					.optional()
					.describe(
						"Include closed tasks (default false — hidden to reduce noise).",
					),
				include_details: z
					.boolean()
					.optional()
					.describe(
						"Include full details per node (default false — returns only id, title, status, children, parentId).",
					),
			},
		},
		async (args) => {
			try {
				const a = getAttachment();
				if (!a) throw new Error("Not attached. Call attach_to first.");
				const tracker = await getTracker(ctx, a.projectId);
				let nodes = tracker.allNodes();
				if (!args.include_closed) {
					nodes = nodes.filter((n) => isFolder(n) || n.status !== "closed");
				}
				const visibleIds = new Set(nodes.map((n) => n.id));
				const filterChildren = (children: string[]) =>
					children.filter((id) => visibleIds.has(id));
				const result = args.include_details
					? nodes.map((n) => {
							if (isFolder(n)) {
								return { ...n, children: filterChildren(n.children) };
							}
							const rest = stripSession(n);
							return { ...rest, children: filterChildren(rest.children) };
						})
					: nodes.map((n) => {
							const out: Record<string, unknown> = {
								id: n.id,
								title: n.title,
								children: filterChildren(n.children),
								parentId: n.parentId,
							};
							if (isTask(n)) out.status = n.status;
							if (isFolder(n)) out.type = "folder";
							return out;
						});
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{ rootNodeId: tracker.rootNodeId, nodes: result },
								null,
								2,
							),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"get_task",
		{
			description:
				"Get full details (description, status, branch, worktreePath, cost) of a task in the attached project.",
			inputSchema: {
				taskId: z
					.string()
					.describe("Task node ID (or unique prefix, min 8 chars)"),
			},
		},
		async (args) => {
			try {
				const a = getAttachment();
				if (!a) throw new Error("Not attached. Call attach_to first.");
				const tracker = await getTracker(ctx, a.projectId);
				const node = tracker.getTask(args.taskId);
				if (!node) {
					return {
						content: [{ type: "text", text: `Task not found: ${args.taskId}` }],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(stripSession(node), null, 2),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"get_logs",
		{
			description:
				"Get recent JSONL events (activity log) for a task in the attached project. " +
				"Returns events after the last compact_marker or fork_marker, with optional limit.",
			inputSchema: {
				taskId: z.string().describe("Task node ID to fetch logs for"),
				limit: z
					.number()
					.optional()
					.describe(
						"Maximum number of most-recent events to return (default 50, max 500).",
					),
			},
		},
		async (args) => {
			try {
				const a = getAttachment();
				if (!a) throw new Error("Not attached. Call attach_to first.");
				const tracker = await getTracker(ctx, a.projectId);
				const node = tracker.getTask(args.taskId);
				if (!node) {
					return {
						content: [{ type: "text", text: `Task not found: ${args.taskId}` }],
						isError: true,
					};
				}
				const eventStore = getEventStore(ctx, a.projectId);
				await eventStore.flushSession(args.taskId);
				const { events, hasOlderEvents } = eventStore.readFromLastCompactMarker(
					args.taskId,
				);
				const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
				const sliced =
					events.length > limit ? events.slice(events.length - limit) : events;
				const stripped = sliced.map((e) =>
					stripEventForUI(e as unknown as Record<string, unknown>),
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									taskId: args.taskId,
									count: stripped.length,
									totalAfterMarker: events.length,
									hasOlderEvents,
									events: stripped,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"read_file",
		{
			description:
				"Read a file from the attached task's worktree. Paths can be relative (to worktree root) or absolute (must be inside the worktree).",
			inputSchema: {
				path: z.string().describe("File path (relative or absolute)"),
				offset: z
					.number()
					.optional()
					.describe("Start line (1-based, default 1)"),
				limit: z
					.number()
					.optional()
					.describe("Maximum number of lines to return"),
			},
		},
		async (args) => {
			try {
				const root = await getAttachedWorktreeRoot();
				const absPath = isAbsolute(args.path)
					? args.path
					: join(root, args.path);
				const safePath = assertPathInRoot(absPath, root);

				const ext = safePath.split(".").pop()?.toLowerCase();
				const IMAGE_MEDIA_TYPES: Record<
					string,
					"image/jpeg" | "image/png" | "image/gif" | "image/webp"
				> = {
					png: "image/png",
					jpg: "image/jpeg",
					jpeg: "image/jpeg",
					gif: "image/gif",
					webp: "image/webp",
				};
				const imageMediaType = ext ? IMAGE_MEDIA_TYPES[ext] : undefined;

				if (imageMediaType) {
					const data = readFileSync(safePath);
					const MAX_DIMENSION = 8000;
					const dims = getImageDimensions(data);
					if (
						dims &&
						(dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION)
					) {
						return {
							content: [
								{
									type: "text",
									text: `Image too large (${dims.width}x${dims.height} pixels, max ${MAX_DIMENSION}px per dimension).`,
								},
							],
							isError: true,
						};
					}
					const b64 = data.toString("base64");
					return {
						content: [
							{ type: "text", text: `[Image: ${basename(safePath)}]` },
							{ type: "image", data: b64, mimeType: imageMediaType },
						],
					};
				}

				const offset = Math.max(1, args.offset ?? 1);
				const limit = args.limit;
				const raw = readFileSync(safePath, "utf-8");
				if (offset === 1 && !limit) {
					return { content: [{ type: "text", text: raw }] };
				}
				const lines = raw.split("\n");
				const start = offset - 1;
				const sliced =
					limit !== undefined
						? lines.slice(start, start + limit)
						: lines.slice(start);
				const remaining = lines.length - (start + sliced.length);
				let text = sliced.join("\n");
				if (remaining > 0) {
					text += `\n[... ${remaining} more lines, use offset=${offset + sliced.length} to continue]`;
				}
				return { content: [{ type: "text", text }] };
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"list_files",
		{
			description:
				'List files in the attached task\'s worktree matching a glob pattern (e.g. "src/**/*.ts").',
			inputSchema: {
				pattern: z.string().optional().describe('Glob pattern (default: "*")'),
			},
		},
		async (args) => {
			try {
				const root = await getAttachedWorktreeRoot();
				const pattern = args.pattern ?? "*";
				const glob = new Bun.Glob(pattern);
				const files: string[] = [];
				for await (const file of glob.scan({ cwd: root, dot: false })) {
					files.push(file);
					if (files.length >= 500) break;
				}
				return {
					content: [{ type: "text", text: files.join("\n") || "(no files)" }],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"search",
		{
			description:
				"Regex search inside the attached task's worktree. Uses ripgrep-style syntax.",
			inputSchema: {
				pattern: z.string().describe("Regex pattern"),
				path: z
					.string()
					.optional()
					.describe("Subpath to search in (default: worktree root)"),
				glob: z.string().optional().describe("File glob filter"),
				context: z.number().optional().describe("Lines of context"),
				output_mode: z
					.enum(["content", "files_with_matches", "count"])
					.optional(),
				head_limit: z
					.number()
					.optional()
					.describe("Max entries (default 50, max 200)"),
				case_insensitive: z.boolean().optional(),
				multiline: z.boolean().optional(),
				excluded_dirs: z.array(z.string()).optional(),
			},
		},
		async (args) => {
			try {
				const root = await getAttachedWorktreeRoot();
				const result = await jsSearch({
					pattern: args.pattern,
					searchPath: args.path ?? ".",
					glob: args.glob,
					contextLines: args.context,
					outputMode: args.output_mode ?? "content",
					headLimit: Math.min(args.head_limit ?? 50, 200),
					caseInsensitive: args.case_insensitive ?? false,
					multiline: args.multiline ?? false,
					excludedDirs: args.excluded_dirs,
					cwd: root,
				});
				return { content: [{ type: "text", text: result || "(no matches)" }] };
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"yield",
		{
			description:
				"Yield control to the attached Matrix task. Blocks until the task pauses (done, " +
				"explicit yield, implicit yield / end_turn, or stopped), then returns events that " +
				"occurred since the last yield call on this session. " +
				"Reasons: 'idle' (agent at its own yield / end_turn), 'done' (agent called done() " +
				"or finished successfully), 'stopped' (agent stopped or failed), 'not_running' (task " +
				"never started / not in_progress), 'timeout'. " +
				"First call after attach starts watching from 'now' — use get_logs for historical " +
				"events. If the task is already terminal (verify/failed/closed), returns immediately " +
				"with reason=done. " +
				"Symmetric to Matrix agents' own yield(): you give control back to Matrix until " +
				"there's something worth waking you for.",
			inputSchema: {
				timeoutMs: z
					.number()
					.optional()
					.describe(
						"Maximum wait time in milliseconds (default 60000, max 300000).",
					),
			},
		},
		async (args) => {
			try {
				const sid = getSessionId();
				if (!sid) throw new Error("MCP session not initialized.");
				const state = ctx.mcpSessionStore.get(sid);
				if (!state) throw new Error("MCP session state missing.");
				const { projectId, taskId } = requireAttachedTask();
				const timeoutMs = Math.min(
					Math.max(args.timeoutMs ?? 60000, 0),
					300000,
				);

				const tracker = await getTracker(ctx, projectId);
				const node = tracker.getTask(taskId);
				if (!node) throw new Error(`Task not found: ${taskId}`);
				const eventStore = getEventStore(ctx, projectId);

				// Read current events + cursor
				const readCurrent = async () => {
					await eventStore.flushSession(taskId);
					const { events } = eventStore.readFromLastCompactMarker(taskId);
					return events;
				};
				let events = await readCurrent();
				const cursor = state.yieldCursors.get(taskId) ?? 0;

				// Determine current task status + running state.
				const task = tracker.getTask(taskId);
				const status = task?.status ?? "pending";
				const hasSession = !!task?.session;
				// Agent is "running" if status is in_progress AND there's a session.
				// When not running, await() returns immediately — no pause to wait for.
				const isRunning = status === "in_progress" && hasSession;
				// Whether the agent is currently at queue.wait() (idle).
				const isIdleNow = task?.session?.queue?.idle === true;

				// Fast path: not running → return immediately. Also: running+idle with
				// new events → return immediately (already at pause point).
				if (!isRunning || (isIdleNow && events.length > cursor)) {
					const reason = !isRunning
						? status === "verify" || status === "failed" || status === "closed"
							? "done"
							: "not_running"
						: "idle";
					const sliced = events.slice(cursor);
					const stripped = sliced.map((e) =>
						stripEventForUI(e as unknown as Record<string, unknown>),
					);
					state.yieldCursors.set(taskId, events.length);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{
										reason,
										taskStatus: status,
										events: stripped,
										cursorIndex: events.length,
										count: stripped.length,
									},
									null,
									2,
								),
							},
						],
					};
				}

				// Subscribe to broadcast events — resolve when a pause signal for
				// our taskId arrives. The wake SIGNAL tells us *when* to wake;
				// the task's final status tells us *what* happened. We don't try
				// to infer outcome from the event payload (agent lifecycle has
				// multiple terminal signals with races between them).
				//
				// Signals (any one wakes us):
				//   - agent_idle (ephemeral): queue.wait reached → task still in_progress
				//   - done_notified / agent_stopped / orchestration_completed (persisted):
				//     loop exited → read final status from tracker after wake
				type WakeSignal = "pause" | "terminated" | "timeout";
				const waitForPause = () =>
					new Promise<WakeSignal>((resolve) => {
						let settled = false;
						let timer: ReturnType<typeof setTimeout>;
						const settle = (r: WakeSignal) => {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							unsubscribe();
							resolve(r);
						};
						const unsubscribe = subscribeToEvents(ctx, projectId, (evt) => {
							if (settled) return;
							if (evt.taskId !== taskId) return;
							const t = evt.type;
							if (t === "agent_idle") settle("pause");
							else if (
								t === "done_notified" ||
								t === "agent_stopped" ||
								t === "orchestration_completed"
							) {
								settle("terminated");
							}
						});
						timer = setTimeout(() => settle("timeout"), timeoutMs);
					});
				const wakeSignal = await waitForPause();

				// For "terminated" wake signals, give Phase 2 a moment to complete
				// (agent_stopped fires in runAgentForNode's finally, BEFORE Phase 2
				// updates status to verify/failed). Small poll loop — bounded by
				// a few hundred ms.
				if (wakeSignal === "terminated") {
					const waitStart = Date.now();
					while (Date.now() - waitStart < 500) {
						const s = tracker.getTask(taskId)?.status;
						if (s === "verify" || s === "failed") break;
						await new Promise((r) => setTimeout(r, 10));
					}
				}

				// Re-read events after wake (flush to ensure all persisted events
				// are on disk). Determine final status from tracker.
				events = await readCurrent();
				// If MCP session was closed mid-await, state may be gone.
				// Return what we have — caller's connection likely dead anyway.
				if (!ctx.mcpSessionStore.get(sid)) {
					return {
						content: [
							{ type: "text", text: "MCP session closed during await." },
						],
						isError: true,
					};
				}
				const finalStatus = tracker.getTask(taskId)?.status ?? status;
				// Derive user-facing reason from wake signal + final status.
				let reason: "idle" | "done" | "stopped" | "timeout";
				if (wakeSignal === "timeout") {
					reason = "timeout";
				} else if (wakeSignal === "pause") {
					reason = "idle";
				} else {
					// terminated: verify/failed → done, anything else → stopped
					reason =
						finalStatus === "verify" || finalStatus === "failed"
							? "done"
							: "stopped";
				}
				const sliced = events.slice(cursor);
				const stripped = sliced.map((e) =>
					stripEventForUI(e as unknown as Record<string, unknown>),
				);
				state.yieldCursors.set(taskId, events.length);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(
								{
									reason,
									taskStatus: finalStatus,
									events: stripped,
									cursorIndex: events.length,
									count: stripped.length,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}

/**
 * Register the /mcp endpoint on the Hono app.
 *
 * Each new MCP session spawns its own McpServer + transport pair.
 * Subsequent requests on the same session (by mcp-session-id header)
 * reuse the existing transport.
 */
export function registerMcpEndpoint(app: Hono, ctx: DaemonContext): void {
	// One transport per MCP session ID (stateful).
	const transports = new Map<
		string,
		WebStandardStreamableHTTPServerTransport
	>();

	const handleMcp = async (c: {
		req: { raw: Request; header: (name: string) => string | undefined };
	}): Promise<Response> => {
		const sessionIdHeader = c.req.header("mcp-session-id");

		if (sessionIdHeader) {
			const transport = transports.get(sessionIdHeader);
			if (!transport) {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						error: {
							code: -32000,
							message: "Session not found. Start a new initialize request.",
						},
						id: null,
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				);
			}
			return transport.handleRequest(c.req.raw);
		}

		// New session → create transport + server.
		// enableJsonResponse: single POST returns a JSON response (no SSE stream)
		// for request/response calls. Easier for clients and tests; SSE is only needed
		// for server-initiated notifications which we don't use for read-only tools.
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			enableJsonResponse: true,
			onsessioninitialized: (sid) => {
				ctx.mcpSessionStore.create(sid);
				transports.set(sid, transport);
			},
			onsessionclosed: (sid) => {
				ctx.mcpSessionStore.delete(sid);
				transports.delete(sid);
			},
		});

		transport.onclose = () => {
			if (transport.sessionId) {
				ctx.mcpSessionStore.delete(transport.sessionId);
				transports.delete(transport.sessionId);
			}
		};

		const server = new McpServer({ name: "matrix", version: "1.0.0" });
		wireTools(server, ctx, () => transport.sessionId);
		await server.connect(transport);
		return transport.handleRequest(c.req.raw);
	};

	app.all("/mcp", handleMcp);
}
