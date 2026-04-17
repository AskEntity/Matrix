/**
 * Stateless HTTP MCP endpoint — exposes Matrix tools to external MCP clients
 * (e.g., Claude Code) via the MCP Streamable HTTP transport.
 *
 * Architecture:
 *   - Stateless: no attach_to, no session state. Each tool call carries its own scope.
 *   - Reuses existing ToolDef objects from orchestrator-tools.ts
 *   - External bind params become explicit required params (buildExternalShape)
 *   - Auth: createHumanAuth() — all permission checks pass
 *   - Additional external-only tools: send_user_message, yield_external
 *
 * WHY: External clients need to read and interact with Matrix state.
 * The old HTTP MCP was removed because it used an attach-based session model.
 * This version is stateless — each call carries its own scope.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { z } from "zod";
import { buildAllToolDefs } from "../../orchestrator-tools.ts";
import { createUserMessage } from "../../queue-message-factory.ts";
import * as R from "../../resource-registry.ts";
import { initResourceRegistry } from "../../resource-registry.ts";
import { createHumanAuth } from "../../tool-auth.ts";
import {
	type AnyToolDef,
	buildExternalShape,
	type ToolDef,
	type ToolHandlerResult,
} from "../../tool-def.ts";
import type { RuntimeContext } from "../context.ts";
import { subscribeToEvents } from "../event-system.ts";

/**
 * Build external-only ToolDefs (availability: "external").
 * These are NOT in orchestrator-tools — they only exist for external MCP clients.
 */
function buildExternalOnlyToolDefs(ctx: RuntimeContext): AnyToolDef[] {
	return [
		// ── send_user_message ──
		{
			name: "send_user_message",
			availability: "external",
			description:
				"Send a user message to a specific task. The message is delivered " +
				"as if a human typed it in the Matrix UI. Use this to give instructions " +
				"or provide input to a running agent.",
			params: {
				projectId: {
					schema: z.string().describe("Project ID"),
					decl: { kind: "explicit" },
				},
				taskId: {
					schema: z.string().describe("Task node ID to send the message to"),
					decl: { kind: "explicit" },
				},
				content: {
					schema: z.string().describe("Message content"),
					decl: { kind: "explicit" },
				},
			},
			handler: async (args) => {
				const projectId = args.projectId as string;
				const taskId = args.taskId as string;
				const content = args.content as string;

				const project = R.getProject(projectId);
				if (!project) {
					return {
						content: [
							{ type: "text", text: `Project not found: ${projectId}` },
						],
						isError: true,
					};
				}

				const tracker = R.getTracker(projectId);
				if (!tracker) {
					return {
						content: [
							{ type: "text", text: `Project not loaded: ${projectId}` },
						],
						isError: true,
					};
				}

				const node = tracker.getTask(taskId);
				if (!node) {
					return {
						content: [{ type: "text", text: `Task not found: ${taskId}` }],
						isError: true,
					};
				}

				// Read cursor before delivery — stable snapshot of "where we are now"
				const eventStore = R.getEventStore(projectId);
				await eventStore.flushSession(taskId);
				const { events } = eventStore.readFromLastCompactMarker(taskId);
				const cursor = events.length;

				const message = createUserMessage(content);

				try {
					await R.deliverMessage(projectId, taskId, message);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									delivered: true,
									taskId,
									cursor,
								}),
							},
						],
					};
				} catch (e) {
					return {
						content: [
							{
								type: "text",
								text: `Error delivering message: ${e instanceof Error ? e.message : String(e)}`,
							},
						],
						isError: true,
					};
				}
			},
		},

		// ── yield_external ──
		{
			name: "yield_external",
			availability: "external",
			description:
				"Wait for activity on a task. Blocks until the agent pauses (idle, done, stopped) " +
				"or timeout expires. Returns reason and task status — use get_logs to fetch actual events.",
			params: {
				projectId: {
					schema: z.string().describe("Project ID"),
					decl: { kind: "explicit" },
				},
				taskId: {
					schema: z.string().describe("Task node ID to watch"),
					decl: { kind: "explicit" },
				},
				timeoutMs: {
					schema: z.number(),
					decl: { kind: "optional" },
					description:
						"Maximum time to wait in milliseconds (default 30000, max 120000).",
				},
			},
			handler: async (args) => {
				const projectId = args.projectId as string;
				const taskId = args.taskId as string;
				const timeoutMs = Math.min(
					Math.max((args.timeoutMs as number) ?? 30000, 1000),
					120000,
				);

				const tracker = R.getTracker(projectId);
				if (!tracker) {
					return {
						content: [
							{ type: "text", text: `Project not loaded: ${projectId}` },
						],
						isError: true,
					};
				}

				const node = tracker.getTask(taskId);
				if (!node) {
					return {
						content: [{ type: "text", text: `Task not found: ${taskId}` }],
						isError: true,
					};
				}

				const result = async (reason: string) => {
					const current = tracker.getTask(taskId);
					// Provide cursor so caller can pass it directly to get_logs
					const eventStore = R.getEventStore(projectId);
					await eventStore.flushSession(taskId);
					const { events } = eventStore.readFromLastCompactMarker(taskId);
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									reason,
									taskStatus: current?.status ?? "unknown",
									cursor: events.length,
								}),
							},
						],
					};
				};

				// Wake signals — agent paused or stopped
				const WAKE_SIGNALS = new Set([
					"agent_idle",
					"done_notified",
					"agent_stopped",
					"orchestration_completed",
				]);

				// ── Fast path: agent already idle/stopped/done ──
				// If the agent isn't actively running, return immediately.
				// Without this, yield_external would deadlock waiting for
				// an event that was already emitted before we subscribed.
				const session = node.session;
				if (!session) {
					// No session = agent not running (never started, or stopped)
					return result("not_running");
				}
				if (session.queue?.idle) {
					// Agent is in yield/idle state — already paused
					return result("agent_idle");
				}

				return new Promise<ToolHandlerResult>((resolve) => {
					let settled = false;

					const finish = async (reason: string) => {
						if (settled) return;
						settled = true;
						unsub();
						clearTimeout(timer);
						resolve(await result(reason));
					};

					const unsub = subscribeToEvents(ctx, projectId, (event) => {
						if (event.taskId !== taskId) return;
						const eventType = event.type as string;
						if (WAKE_SIGNALS.has(eventType)) {
							// Small delay to let Phase 2 (status update) complete
							setTimeout(() => finish(eventType), 50);
						}
					});

					const timer = setTimeout(() => finish("timeout"), timeoutMs);
				});
			},
		},
	];
}

/**
 * Register a ToolDef on an McpServer for external callers.
 *
 * Uses buildExternalShape: bind params become required explicit params.
 * Calls the SAME handler with createHumanAuth() (all permissions granted).
 */
function registerToolDefOnMcpServer(
	server: McpServer,
	toolDef: AnyToolDef,
): void {
	const shape = buildExternalShape(toolDef.params);

	const humanAuth = createHumanAuth();

	server.registerTool(
		toolDef.name,
		{
			description: toolDef.description,
			inputSchema: shape,
		},
		async (args, _extra) => {
			const result = await toolDef.handler(
				args as Record<string, unknown>,
				humanAuth,
				"", // toolCallId — not meaningful for external MCP
			);
			return {
				content: result.content.map((c) => {
					if (c.type === "text") return { type: "text" as const, text: c.text };
					if (c.type === "image")
						return {
							type: "image" as const,
							data: c.data,
							mimeType: c.mimeType,
						};
					return c;
				}),
				isError: result.isError,
			};
		},
	);
}

/**
 * Register the stateless MCP endpoint on the Hono app.
 *
 * POST /mcp — MCP Streamable HTTP endpoint
 * GET /mcp — SSE stream (for MCP clients that use GET for server-initiated messages)
 * DELETE /mcp — session termination (no-op for stateless)
 */
export function registerMcpEndpoint(app: Hono, ctx: RuntimeContext): void {
	// Ensure resource registry is initialized — MCP tools call R.* functions
	// which need the daemon context. Idempotent if already initialized by agent-lifecycle.
	initResourceRegistry(ctx);

	// Collect all externally-available ToolDefs: "both" from shared + "external" only
	const allToolDefs = buildAllToolDefs();
	const externalOnlyDefs = buildExternalOnlyToolDefs(ctx);
	const externalDefs = [
		...allToolDefs.filter(
			(def) => def.availability === "both" || def.availability === "external",
		),
		...externalOnlyDefs,
	];

	// Create a new McpServer + transport for each request (stateless)
	app.all("/mcp", async (c) => {
		const server = new McpServer(
			{
				name: "matrix",
				version: "1.0.0",
			},
			{
				capabilities: {
					tools: {},
				},
			},
		);

		for (const def of externalDefs) {
			registerToolDefOnMcpServer(server, def);
		}

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // stateless mode
			enableJsonResponse: true,
		});

		await server.connect(transport);

		try {
			return await transport.handleRequest(c.req.raw);
		} finally {
			// Clean up transport after each request (stateless — no session to maintain)
			await transport.close();
			await server.close();
		}
	});
}
