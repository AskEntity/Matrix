/**
 * Shared "story" scope — a minimal, non-Matrix plugin scope used by tests to
 * prove the runtime + plugin system is genuinely generic.
 *
 * Two consumers:
 *  - `plugin-custom-scope.test.ts` style in-process tests (override
 *    `ctx.scopeOpts` directly).
 *  - The project-scoped-plugin daemon test, which writes a tiny `.mxd/plugin/`
 *    whose `runtime.ts` just re-exports `buildScopeOpts` + `registerRoutes`
 *    from THIS file by absolute path. Re-exporting keeps the on-disk plugin
 *    free of bare imports (`zod`, `./tool-def.ts`) that wouldn't resolve from
 *    a tmpdir — this file lives inside matrix `src/`, so its own imports
 *    resolve normally.
 *
 * The scope ships ONE custom tool (`write_paragraph`) plus the runtime
 * primitives (`done` / `yield`) — deliberately none of matrix's tools. That
 * lets a hermetic test assert a project-scoped plugin runs ITS scope, with
 * matrix's tools absent, without driving a real provider.
 */

import type { Hono } from "hono";
import { z } from "zod";
import type { RuntimeContext, ScopeOpts } from "../runtime/context.ts";
import { defineTool, toToolDefinition } from "../tool-def.ts";
import { createDoneTool, createYieldTool } from "../tools/prefab.ts";
import type { TaskNode } from "../types.ts";

// biome-ignore lint/suspicious/noExplicitAny: ScopeOpts generic varies by plugin
export function buildStoryScopeOpts(_projectId: string): ScopeOpts<any> {
	return {
		buildTools: (auth, _taskId) => {
			const storyTool = defineTool({
				name: "write_paragraph",
				description: "Write a paragraph of the story",
				availability: "internal",
				params: {
					projectId: {
						schema: z.string(),
						decl: { kind: "bind", from: "projectId" },
					},
					taskId: {
						schema: z.string(),
						decl: { kind: "bind", from: "taskId" },
					},
					text: {
						schema: z.string().describe("The paragraph text"),
						decl: { kind: "explicit" },
					},
				},
				handler: async (args) => {
					return {
						content: [
							{
								type: "text" as const,
								text: `Paragraph written: ${args.text}`,
							},
						],
						isError: false,
					};
				},
			});
			return {
				tools: [
					storyTool,
					createYieldTool(),
					createDoneTool({
						extraParams: {
							status: {
								schema: z.enum(["passed", "failed"]),
								decl: { kind: "explicit" },
							},
							summary: { schema: z.string(), decl: { kind: "explicit" } },
						},
					}),
				].map((def) => toToolDefinition(def, auth)),
			};
		},
		buildPrompt: () => ({
			stable: "You are a storyteller. Write creative stories.",
			variable: "Today is story time.",
		}),
		buildWorkContext: () => "You are writing a story. Be creative.",
		buildSummarizationPrompt: () => "Summarize the story so far.",
		shouldResume: (node: TaskNode) => node.status === "in_progress",
		onLaunch: (node: TaskNode, tracker) => {
			tracker.updateStatus(node.id, "in_progress");
		},
		onDone: (node: TaskNode, tracker, doneArgs) => {
			tracker.updateStatus(
				node.id,
				doneArgs.status === "passed" ? "verify" : "failed",
			);
			return { status: "published", wordCount: 42 };
		},
	};
}

/** Plugin-runtime entry: `(projectId, ctx) → ScopeOpts`. */
export function buildScopeOpts(projectId: string, _ctx: RuntimeContext) {
	return buildStoryScopeOpts(projectId);
}

/**
 * Diagnostic route exposing the scope's agent tool names + system prompt for a
 * project. Lets a hermetic daemon test prove a worker runs THIS scope (story
 * tools, NOT matrix tools) without running a real agent against a live
 * provider. The `auth` stub is never dereferenced — `toToolDefinition` only
 * touches it when a tool handler actually runs, so enumerating tool names is
 * safe with a placeholder.
 */
export function registerRoutes(app: Hono, ctx: RuntimeContext) {
	app.get("/projects/:id/scope-info", (c) => {
		const projectId = c.req.param("id");
		if (!ctx.config.buildScopeOpts) {
			return c.json({ error: "no buildScopeOpts on this worker" }, 500);
		}
		const opts = ctx.config.buildScopeOpts(projectId, ctx);
		const prompt = opts.buildPrompt();
		// biome-ignore lint/suspicious/noExplicitAny: stub auth, not dereferenced
		const { tools } = opts.buildTools({} as any, "diagnostic");
		return c.json({
			promptStable: prompt.stable,
			toolNames: tools.map((t) => t.name),
		});
	});
}
