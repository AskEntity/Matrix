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
 * Turn a raw provider error into a user-facing string. Keeps the raw
 * message as a suffix (for debugging) but surfaces a one-line curated
 * explanation up front — previously the agent-lifecycle `catch` emitted
 * raw JSON blobs straight from Anthropic / OpenAI to the activity log
 * (Audit L H5).
 *
 * Examples:
 *   401 `invalid x-api-key`       → "Invalid API key — update your auth group."
 *   429                           → "Rate limited — retry shortly or switch auth group."
 *   400 `credit_balance_too_low`  → "API account has no remaining credits."
 *   400 other                     → "Request rejected (likely format/context length)."
 *   5xx / 529 / connection reset  → "Upstream provider unavailable — will retry."
 *
 * Provider-agnostic: reads HTTP status + message keywords only.
 */
export function classifyUpstreamError(e: unknown): {
	headline: string;
	category:
		| "auth"
		| "rate_limit"
		| "credits"
		| "invalid_request"
		| "upstream_down"
		| "network"
		| "other";
	raw: string;
} {
	const raw = e instanceof Error ? e.message : String(e);
	const status = (e as { status?: number } | undefined)?.status;
	const lower = raw.toLowerCase();

	if (
		status === 401 ||
		status === 403 ||
		lower.includes("invalid x-api-key") ||
		lower.includes("invalid_api_key") ||
		lower.includes("authentication_error") ||
		lower.includes("unauthorized")
	) {
		return {
			headline:
				"Invalid or missing API key. Update the credentials in Settings → Auth Groups, or switch defaultAuth.",
			category: "auth",
			raw,
		};
	}
	if (
		lower.includes("credit_balance_too_low") ||
		lower.includes("insufficient_quota") ||
		lower.includes("billing") ||
		lower.includes("no credits")
	) {
		return {
			headline:
				"Provider account is out of credits / quota. Top up or switch auth group.",
			category: "credits",
			raw,
		};
	}
	if (status === 429 || lower.includes("rate limit")) {
		return {
			headline:
				"Rate limited by provider. Wait a minute and try again, or switch auth group.",
			category: "rate_limit",
			raw,
		};
	}
	if (status === 400 || lower.includes("invalid_request_error")) {
		return {
			headline:
				"Request rejected by provider (format or context length). Consider /compact and retry.",
			category: "invalid_request",
			raw,
		};
	}
	if (
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 529 ||
		lower.includes("overloaded") ||
		lower.includes("internal_server_error")
	) {
		return {
			headline: "Upstream provider is unavailable. Retrying.",
			category: "upstream_down",
			raw,
		};
	}
	if (
		lower.includes("econnrefused") ||
		lower.includes("econnreset") ||
		lower.includes("fetch failed") ||
		lower.includes("failed to get api response")
	) {
		return {
			headline: "Network error talking to provider. Retrying.",
			category: "network",
			raw,
		};
	}
	return {
		headline: raw.split("\n", 1)[0] || "Agent error",
		category: "other",
		raw,
	};
}

/** Format a classified error for the activity log (headline + details). */
export function formatUpstreamError(e: unknown, prefix = "Agent error"): string {
	const c = classifyUpstreamError(e);
	// Trim the raw to 300 chars so 5KB JSON blobs don't bloat the log.
	const trimmed = c.raw.length > 300 ? `${c.raw.slice(0, 300)}…` : c.raw;
	if (c.category === "other") return `${prefix}: ${trimmed}`;
	return `${prefix}: ${c.headline}\n(provider detail: ${trimmed})`;
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
