/**
 * ToolDef — tool definitions with ParamDecl-based bind/explicit/optional params.
 *
 * Each tool declares its parameters with ParamDecl metadata:
 * - "optional": parameter is optional for both agent and external callers
 * - "explicit": parameter is required for both agent and external callers
 * - "bind": auto-bound for agents from identity, required for external callers.
 *           Hidden from agent schema (agent cannot see or override).
 *
 * The framework generates TWO schemas from one ToolDef:
 * - Agent schema: bind params hidden, explicit required, optional optional
 * - External schema: bind params required, explicit required, optional optional
 *
 * Handler signature: (args, auth) => result
 * No deps, no context objects, no closure-captured state.
 * Resources accessed via global functions from resource-registry.ts with handles from args.
 */

import { type ZodRawShape, type ZodTypeAny, z } from "zod";
import { type Auth, getBindValues } from "./tool-auth.ts";
import type { ToolDefinition } from "./tool-definition.ts";

// ── ParamDecl ──

export type ParamDecl =
	| { kind: "optional" }
	| { kind: "explicit" }
	| { kind: "bind"; from: "projectId" | "taskId" };

/** Map of parameter name → { zod schema, decl metadata, description } */
export type ParamDefs = Record<
	string,
	{ schema: ZodTypeAny; decl: ParamDecl; description?: string }
>;

// ── ToolDef ──

/** Handler return type — matches MCP CallToolResult shape. */
export interface ToolHandlerResult {
	content: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	>;
	isError?: boolean;
	[key: string]: unknown;
}

/**
 * A tool definition with ParamDecl metadata.
 * Handler receives (args, auth) — nothing else.
 */
export interface ToolDef {
	name: string;
	description: string;
	params: ParamDefs;
	handler: (
		args: Record<string, unknown>,
		auth: Auth,
		/** Tool call ID — from API (agents) or MCP/transport (external). */
		toolCallId: string,
	) => Promise<ToolHandlerResult>;
	/** If true, tool is in handler registry but NOT sent to API. */
	hidden?: boolean;
}

// ── Schema generation ──

/**
 * Build a Zod raw shape for AGENT callers.
 * - "explicit" → required
 * - "optional" → optional
 * - "bind" → HIDDEN (not in schema, auto-bound by framework)
 */
export function buildAgentShape(params: ParamDefs): ZodRawShape {
	const shape: Record<string, ZodTypeAny> = {};
	for (const [name, def] of Object.entries(params)) {
		const schema = def.description
			? def.schema.describe(def.description)
			: def.schema;
		switch (def.decl.kind) {
			case "explicit":
				shape[name] = schema;
				break;
			case "optional":
				shape[name] = schema.optional();
				break;
			case "bind":
				// Always hidden from agent schema
				break;
		}
	}
	return shape;
}

/**
 * Build a Zod raw shape for EXTERNAL callers.
 * - "explicit" → required
 * - "optional" → optional
 * - "bind" (any) → required
 */
export function buildExternalShape(params: ParamDefs): ZodRawShape {
	const shape: Record<string, ZodTypeAny> = {};
	for (const [name, def] of Object.entries(params)) {
		const schema = def.description
			? def.schema.describe(def.description)
			: def.schema;
		switch (def.decl.kind) {
			case "explicit":
				shape[name] = schema;
				break;
			case "optional":
				shape[name] = schema.optional();
				break;
			case "bind":
				// All bind params are required for external callers
				shape[name] = schema;
				break;
		}
	}
	return shape;
}

/** Strip $schema and additionalProperties from Zod's toJSONSchema output. */
function stripZodMeta(obj: unknown): unknown {
	if (Array.isArray(obj)) return obj.map(stripZodMeta);
	if (obj && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			if (key === "$schema" || key === "additionalProperties") continue;
			result[key] = stripZodMeta(value);
		}
		return result;
	}
	return obj;
}

/** Convert a Zod raw shape to JSON Schema. */
function shapeToJsonSchema(shape: ZodRawShape): Record<string, unknown> {
	return stripZodMeta(z.toJSONSchema(z.object(shape))) as Record<
		string,
		unknown
	>;
}

/** Build the agent-facing JSON Schema for a ToolDef. */
export function buildAgentJsonSchema(
	params: ParamDefs,
): Record<string, unknown> {
	return shapeToJsonSchema(buildAgentShape(params));
}

/** Build the external-facing JSON Schema for a ToolDef. */
export function buildExternalJsonSchema(
	params: ParamDefs,
): Record<string, unknown> {
	return shapeToJsonSchema(buildExternalShape(params));
}

// ── Validation ──

/**
 * Validate agent input: reject if agent passes a bind param (always auto-bound).
 * Returns error message or null if valid.
 */
export function validateAgentInput(
	params: ParamDefs,
	input: Record<string, unknown>,
): string | null {
	for (const [name, def] of Object.entries(params)) {
		if (def.decl.kind === "bind" && input[name] !== undefined) {
			return `Agent cannot pass "${name}" — it is auto-bound by the framework.`;
		}
	}
	return null;
}

/**
 * Resolve bind params into the input for agent callers.
 * Injects bound values from auth identity.
 */
export function resolveBindParams(
	params: ParamDefs,
	input: Record<string, unknown>,
	auth: Auth,
): Record<string, unknown> {
	const bindValues = getBindValues(auth);
	const resolved = { ...input };
	for (const [name, def] of Object.entries(params)) {
		if (def.decl.kind === "bind") {
			const boundValue =
				def.decl.from === "projectId"
					? bindValues.projectId
					: bindValues.taskId;
			// Always use bound value — agent cannot override
			resolved[name] = boundValue;
		}
	}
	return resolved;
}

// ── Adapter: ToolDef → ToolDefinition (existing system) ──

/**
 * Convert a ToolDef (new system) to a ToolDefinition (existing system).
 *
 * The returned ToolDefinition:
 * - Uses the AGENT schema (bind params hidden or optional)
 * - Wraps the handler to validate, resolve bind params, and pass auth
 * - Plugs into the existing executeTool / buildJsonTools / provider loop
 */
export function toToolDefinition(def: ToolDef, auth: Auth): ToolDefinition {
	const agentShape = buildAgentShape(def.params);
	const jsonSchema = buildAgentJsonSchema(def.params);

	const handler = async (
		args: Record<string, unknown>,
		extra: unknown,
	): Promise<ToolHandlerResult> => {
		// Step 1: Validate agent didn't pass bind params (they're auto-bound)
		const validationError = validateAgentInput(def.params, args);
		if (validationError) {
			return {
				content: [{ type: "text", text: `Error: ${validationError}` }],
				isError: true,
			};
		}

		// Step 2: Resolve bind params from auth identity
		const resolvedArgs = resolveBindParams(def.params, args, auth);

		// Step 3: Extract toolCallId
		const toolCallId = (extra as { toolCallId?: string })?.toolCallId ?? "";

		// Step 4: Call the real handler with (args, auth, toolCallId)
		return def.handler(resolvedArgs, auth, toolCallId);
	};

	const result: ToolDefinition = {
		name: def.name,
		description: def.description,
		inputSchema: agentShape,
		handler: handler as ToolDefinition["handler"],
		jsonSchema,
	};
	if (def.hidden) result.hidden = true;
	return result;
}
