/**
 * Tool execution and transient error detection.
 * executeTool() is the single path for ALL tools (built-in + orchestrator + external MCP).
 * isTransientAPIError() is provider-agnostic — used by the outer retry in the run loop.
 */
import { z } from "zod";
import type { PendingState, ToolResult } from "./shared-types.ts";
import type { ToolDefinition } from "./tool-definition.ts";

/** Maximum number of outer retries when callAPI fails after exhausting its own retries. */
export const MAX_OUTER_RETRIES = 3;

/** Default outer retry delay: exponential backoff starting at 30s. */
export function defaultOuterRetryDelay(attempt: number): number {
	return Math.min(30000 * 2 ** attempt, 120000);
}

/**
 * Detect transient API errors that the outer retry should catch.
 * Provider-agnostic — checks error properties rather than SDK-specific class types.
 * The inner retry (in each provider's callAPI) handles SDK-specific errors.
 * The outer retry catches anything that slips through.
 */
export function isTransientAPIError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const status = (e as { status?: number }).status;
	// Rate limit, overloaded, server errors (Anthropic SDK errors have .status)
	if (
		status === 429 ||
		status === 529 ||
		status === 500 ||
		status === 502 ||
		status === 503
	)
		return true;
	// Check error message for transient patterns (OpenAI errors encode status in message)
	const msg = e.message.toLowerCase();
	if (msg.includes("rate limit") || msg.includes("overloaded")) return true;
	// Connection errors
	if (
		msg.includes("econnrefused") ||
		msg.includes("econnreset") ||
		msg.includes("fetch failed") ||
		msg.includes("failed to get api response")
	)
		return true;
	return false;
}

/**
 * Execute a single tool via its handler.
 * ALL tools (built-in + orchestrator + external MCP) go through this single path.
 * Returns a unified ToolResult.
 */
export async function executeTool(
	toolName: string,
	input: Record<string, unknown>,
	// biome-ignore lint/suspicious/noExplicitAny: ToolDefinition generic varies
	mcpHandlers: Map<string, ToolDefinition<any>>,
	toolCallId?: string,
): Promise<ToolResult> {
	const mcpHandler = mcpHandlers.get(toolName);
	if (!mcpHandler) {
		return {
			content: `Unknown tool: ${toolName}`,
			isError: true,
		};
	}

	// Validate input against Zod schema for built-in tools (not external MCP tools).
	// External MCP tools have an empty inputSchema {} — skip validation for those.
	let validatedInput = input;
	if (Object.keys(mcpHandler.inputSchema).length > 0) {
		const result = z.object(mcpHandler.inputSchema).safeParse(input);
		if (!result.success) {
			const issues = result.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; ");
			return {
				content: `Tool input validation error (${toolName}): ${issues}`,
				isError: true,
			};
		}
		validatedInput = result.data as Record<string, unknown>;
	}

	try {
		const mcpResult = await mcpHandler.handler(validatedInput, { toolCallId });
		const parts = Array.isArray(mcpResult.content) ? mcpResult.content : [];
		const textParts: string[] = [];
		const mcpImages: Array<{
			base64: string;
			mediaType: string;
			data: string;
		}> = [];
		for (const c of parts as Array<Record<string, unknown>>) {
			if (c.type === "text") {
				textParts.push((c.text as string) ?? "");
			} else if (c.type === "image" && c.data) {
				// MCP format: { type: "image", data, mimeType }
				mcpImages.push({
					mediaType: (c.mimeType as string) ?? "image/png",
					data: c.data as string,
					base64: c.data as string,
				});
			} else if (
				c.type === "image" &&
				(c.source as Record<string, unknown>)?.type === "base64"
			) {
				// Anthropic format: { type: "image", source: { type: "base64", media_type, data } }
				const src = c.source as Record<string, string>;
				mcpImages.push({
					mediaType: src.media_type ?? "image/png",
					data: src.data ?? "",
					base64: src.data ?? "",
				});
			} else {
				textParts.push(JSON.stringify(c));
			}
		}
		// Extract non-standard properties from handler results.
		// Handlers return CallToolResult (MCP type with index signature).
		// We cast to Record to extract known fields into a clean ToolResult.
		const r = mcpResult as Record<string, unknown>;

		const result: ToolResult = {
			content: textParts.join("\n"),
			isError: mcpResult.isError ?? false,
		};
		if (r.isImage || mcpImages.length > 0) result.isImage = true;
		if (r.cwd) result.cwd = r.cwd as string;
		if (r.backgroundId) result.backgroundId = r.backgroundId as string;
		if (r.backgroundCommand)
			result.backgroundCommand = r.backgroundCommand as string;
		if (r.imageData) result.imageData = r.imageData as string;
		if (r.mediaType) result.mediaType = r.mediaType as string;
		if (mcpImages.length > 0) result.mcpImages = mcpImages;
		if (r.pending) result.pending = r.pending as PendingState;
		return result;
	} catch (e) {
		return {
			content: `Tool error (${toolName}): ${e instanceof Error ? e.message : String(e)}`,
			isError: true,
		};
	}
}
