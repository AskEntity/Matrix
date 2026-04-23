/**
 * Matrix LLM Facility — stateless single-turn LLM access.
 *
 * A thin, provider-agnostic wrapper around the existing provider adapters.
 * Plugins use this to make individual LLM calls without owning session state,
 * JSONL persistence, MessageQueue, tools, or the agent loop.
 *
 * Design:
 * - Strictly single-turn. No tools, no multi-turn loop logic inside the facility.
 *   If you pass `messages: [...]` with multiple entries, it's one request with
 *   the full history sent to the API as context — but there's no follow-up round.
 * - Provider-agnostic chunk stream: `{type: "text_delta" | "thinking_delta" | "final"}`.
 *   OpenAI Responses in v1 does NOT emit `thinking_delta` (reasoning is only
 *   present in `final.thinking`). Anthropic emits both.
 * - Error semantics: transient errors auto-retried by the SDK (up to 5 attempts
 *   via the existing adapter). Non-transient errors and exhaustion propagate as
 *   thrown errors. No `error` chunk in the stream.
 * - Abort via `AbortSignal` — aborts the stream and throws.
 *
 * Reuses (via adapter-level delegation):
 * - Anthropic / OpenAI SDK setup, streaming, inner-retry
 * - Usage extraction, cost computation, pricing tables
 *
 * Does NOT use:
 * - Agent loop, compaction, budget, debug snapshot, MessageQueue, JSONL, tools,
 *   session_config, cache prefixes (cache breakpoints are emitted by callAPI
 *   but harmless for single-shot calls because nothing repeats).
 *
 * Plugin usage:
 * ```ts
 * import { createLLM } from "matrix/src/llm.ts";
 * import { resolveAuthGroup } from "matrix/src/config.ts";
 *
 * const authGroup = resolveAuthGroup(effectiveCfg);
 * if (!authGroup) throw new Error("No auth group configured");
 * const llm = createLLM({
 *   authGroup,
 *   model: effectiveCfg.model,
 *   defaultThinkingEffort: effectiveCfg.thinkingEffort,
 * });
 *
 * const { text } = await llm.run({
 *   system: "You are a story writer.",
 *   user: "Write a one-sentence opening.",
 * });
 * ```
 */

import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicAdapter } from "./anthropic-compatible-provider.ts";
import { type AuthGroup, DEFAULT_MODEL } from "./config.ts";
import type { EventSpec } from "./events.ts";
import { createOpenAIResponsesAdapter } from "./openai-responses-compatible-provider.ts";
import type { ProviderAdapter } from "./provider-shared.ts";
import { ulid } from "./ulid.ts";

// ── Public types ──

/**
 * Normalized token-usage + cost for one LLM call.
 *
 * `cacheCreationTokens` and `cacheReadTokens` are Anthropic-only. For OpenAI
 * calls they are always `undefined`.
 */
export interface LLMUsage {
	inputTokens: number;
	outputTokens: number;
	/** Anthropic only. Tokens written into the prompt cache on this call. */
	cacheCreationTokens?: number;
	/** Anthropic only. Tokens read from the prompt cache on this call. */
	cacheReadTokens?: number;
	/** Computed from token counts × model pricing table. */
	costUsd: number;
}

/**
 * Result of a single-turn LLM call.
 *
 * `thinking` is the aggregated non-redacted reasoning / chain-of-thought text.
 * On Anthropic it concatenates all `thinking` content blocks (redacted blocks
 * are dropped silently). On OpenAI Responses it concatenates reasoning-item
 * content + summary text.
 *
 * `stopReason`:
 *  - `"end_turn"`: natural completion.
 *  - `"max_tokens"`: output was truncated at the `maxTokens` boundary.
 *  - `"other"`: anything else (stop_sequence, incomplete without max_tokens,
 *    safety refusal, etc.).
 */
export interface LLMResult {
	text: string;
	thinking?: string;
	usage: LLMUsage;
	stopReason: "end_turn" | "max_tokens" | "other";
}

/**
 * One chunk of a streaming LLM call.
 *
 * `text_delta` and `thinking_delta` are incremental — concatenating all deltas
 * in order yields the final aggregated text / thinking (modulo `thinking`
 * redaction; see `LLMResult.thinking`).
 *
 * Exactly one `final` chunk is always emitted, at the end of the stream.
 */
export type LLMChunk =
	| { type: "text_delta"; delta: string }
	/**
	 * Incremental thinking / reasoning.
	 * Anthropic only in v1. OpenAI Responses does not stream reasoning deltas
	 * through the facility (reasoning is surfaced via `final.thinking` only).
	 */
	| { type: "thinking_delta"; delta: string }
	| {
			type: "final";
			text: string;
			thinking?: string;
			usage: LLMUsage;
			stopReason: "end_turn" | "max_tokens" | "other";
	  };

/**
 * Configuration for `createLLM`. Plugin resolves auth + model + thinking default
 * once, then issues many calls via the returned `LLMClient`.
 *
 * `defaultThinkingEffort` is used when a per-call `LLMRequest.thinkingEffort`
 * is not specified. Anthropic only — ignored for OpenAI.
 *
 * `model` must be a valid model name for `authGroup.provider`. No cross-check
 * is performed; the API surfaces model-mismatch errors at call time.
 */
export interface LLMConfig {
	authGroup: AuthGroup;
	model: string;
	/**
	 * Default thinking/reasoning depth for this client. Overridden by
	 * per-call `LLMRequest.thinkingEffort`. `0` disables thinking (default).
	 * Valid range: 0-100 (mapped internally: 1-25 low, 26-50 medium,
	 * 51-75 high, 76-100 max).
	 */
	defaultThinkingEffort?: number;
}

/**
 * Single-turn LLM request.
 *
 * Either `user` (single message) or `messages` (multi-turn history) must be
 * set — exactly one, not both. Providing neither throws; providing both throws.
 *
 * `messages` is a history you send as context. The facility does NOT support
 * tool-use; for tool-invoking agents use the full runtime via `runAgentForNode`.
 */
export interface LLMRequest {
	/** System / instructions prompt. Optional. */
	system?: string;
	/** Single user message — simplest single-shot case. */
	user?: string;
	/** Multi-turn history — for "refine this draft" pipelines. */
	messages?: ReadonlyArray<
		{ role: "user"; content: string } | { role: "assistant"; content: string }
	>;
	/** Max output tokens. Default: 8192. */
	maxTokens?: number;
	/**
	 * Thinking/reasoning depth override for this call. Anthropic only.
	 * Overrides `LLMConfig.defaultThinkingEffort`. `0` disables thinking.
	 */
	thinkingEffort?: number;
	/** Abort signal — propagates to the underlying SDK call. */
	signal?: AbortSignal;
}

/** LLM client bound to an auth group + model + default thinking effort. */
export interface LLMClient {
	/** Collect the full response into an `LLMResult`. Blocking. */
	run(req: LLMRequest): Promise<LLMResult>;
	/** Stream chunks. Terminal chunk is `{type: "final", ...}`. */
	stream(req: LLMRequest): AsyncIterable<LLMChunk>;
}

// ── Constants ──

const DEFAULT_MAX_TOKENS = 8192;

// ── Request validation / message construction ──

function validateRequest(req: LLMRequest): void {
	const hasUser = typeof req.user === "string";
	const hasMessages = Array.isArray(req.messages);
	if (hasUser && hasMessages) {
		throw new Error(
			"LLMRequest: provide exactly one of 'user' or 'messages', not both",
		);
	}
	if (!hasUser && !hasMessages) {
		throw new Error("LLMRequest: provide exactly one of 'user' or 'messages'");
	}
	if (hasMessages && (req.messages?.length ?? 0) === 0) {
		throw new Error("LLMRequest: 'messages' must contain at least one entry");
	}
	if (hasUser && req.user === "") {
		throw new Error("LLMRequest: 'user' must be a non-empty string");
	}
}

/**
 * Flatten request into a minimal role/content list.
 *
 * Both Anthropic's `MessageParam` and Matrix's OpenAI `HistoryMessage` accept
 * `{role: "user" | "assistant", content: string}` natively — no provider-
 * specific envelope construction needed. `adapter.callAPI` takes care of the
 * rest (wrapping in provider-native shapes inside the respective walkers).
 */
function requestToRoleList(
	req: LLMRequest,
): Array<{ role: "user" | "assistant"; content: string }> {
	if (typeof req.user === "string") {
		return [{ role: "user", content: req.user }];
	}
	return req.messages ? [...req.messages] : [];
}

// ── Thinking / reasoning extraction ──

/**
 * Extract non-redacted thinking text from an Anthropic response.
 *
 * Reuses `adapter.buildResponseEvents` — the canonical walker that the agent
 * loop also uses. That walker already emits `thinking` events with the correct
 * `redacted` flag for safety-redacted blocks. We filter to non-redacted
 * thinking events and concatenate their text (per Q4: drop redacted silently).
 *
 * Returns `undefined` when no visible thinking exists, so the `final` chunk's
 * `thinking` field stays absent for responses that didn't think.
 */
function extractAnthropicThinking(
	adapter: ProviderAdapter,
	response: unknown,
): string | undefined {
	const events = adapter.buildResponseEvents(response, false);
	const parts: string[] = [];
	for (const e of events) {
		if (e.type === "thinking" && !e.redacted && e.thinking) {
			parts.push(e.thinking);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Extract reasoning from an OpenAI Responses response.
 *
 * **New code** (no existing walker to reuse): `adapter.buildResponseEvents`
 * for OpenAI Responses only handles `message` and `function_call` items —
 * reasoning items are never surfaced as events in the agent loop. We walk
 * them here for the facility's `final.thinking` field.
 *
 * Concatenates `content[].text` (reasoning_text) and `summary[].text`
 * (summary_text) items. Returns undefined when no reasoning was produced.
 * The `adapter` parameter is unused (kept for interface uniformity with
 * `extractAnthropicThinking`).
 */
function extractOpenAIReasoning(
	_adapter: ProviderAdapter,
	response: unknown,
): string | undefined {
	const data = response as {
		output?: Array<{
			type?: string;
			content?: Array<{ type?: string; text?: string }>;
			summary?: Array<{ type?: string; text?: string }>;
		}>;
	};
	const parts: string[] = [];
	for (const item of data.output ?? []) {
		if (item.type !== "reasoning") continue;
		for (const c of item.content ?? []) {
			if (c.type === "reasoning_text" && c.text) parts.push(c.text);
		}
		for (const s of item.summary ?? []) {
			if (s.type === "summary_text" && s.text) parts.push(s.text);
		}
	}
	const joined = parts.join("\n");
	return joined.length > 0 ? joined : undefined;
}

// ── Stop reason normalization ──

function mapStopReasonAnthropic(
	response: unknown,
): "end_turn" | "max_tokens" | "other" {
	const msg = response as Anthropic.Messages.Message;
	if (msg.stop_reason === "end_turn") return "end_turn";
	if (msg.stop_reason === "max_tokens") return "max_tokens";
	return "other";
}

function mapStopReasonOpenAI(
	response: unknown,
): "end_turn" | "max_tokens" | "other" {
	const data = response as {
		status?: string;
		incomplete_details?: { reason?: string } | null;
	};
	if (data.status === "completed") return "end_turn";
	if (
		data.status === "incomplete" &&
		data.incomplete_details?.reason === "max_output_tokens"
	) {
		return "max_tokens";
	}
	return "other";
}

// ── Core streaming implementation ──

/**
 * Shared post-processing around `adapter.callAPI`. Yields `text_delta` /
 * `thinking_delta` chunks from the EventSpec stream, captures the terminal
 * response, builds the `final` chunk, yields it, and returns.
 *
 * Errors from the inner retry loop are thrown (no `error` chunk in v1).
 */
async function* runAdapterStream(
	adapter: ProviderAdapter,
	params: {
		model: string;
		messages: unknown[];
		systemPrompt: { stable: string; variable: string };
		maxTokens: number;
		signal?: AbortSignal;
	},
	extractThinking: (
		adapter: ProviderAdapter,
		response: unknown,
	) => string | undefined,
	mapStopReason: (response: unknown) => "end_turn" | "max_tokens" | "other",
): AsyncGenerator<LLMChunk, void> {
	// Fresh sessionId per call — adapter.callAPI writes it to the SDK client
	// (side channel for test-mock conversation keying). Harmless in production
	// (the debug-snapshot path is never set from the facility, so sessionId
	// is unused beyond test-mock routing).
	const sessionId = ulid();

	const gen = adapter.callAPI({
		model: params.model,
		messages: params.messages,
		tools: [],
		systemPrompt: params.systemPrompt,
		maxTokens: params.maxTokens,
		signal: params.signal,
		isCompacting: false,
		sessionId,
	});

	let result = await gen.next();
	while (!result.done) {
		const event = result.value as EventSpec;
		if (event.type === "text_delta") {
			yield { type: "text_delta", delta: event.content };
		} else if (event.type === "thinking_delta") {
			yield { type: "thinking_delta", delta: event.thinking };
		}
		// Intentionally ignore any `error` events emitted during retry — they're
		// informational (the retry itself handles recovery). Only retry
		// EXHAUSTION or non-transient errors make it out, as thrown exceptions.
		result = await gen.next();
	}
	const response = result.value;

	const usage = adapter.getTokenUsage(response);
	const costUsd = adapter.computeCost(
		params.model,
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheCreationTokens ?? 0,
		usage.cacheReadTokens ?? 0,
	);

	const thinking = extractThinking(adapter, response);
	const finalChunk: LLMChunk = {
		type: "final",
		text: adapter.getResponseText(response),
		...(thinking !== undefined ? { thinking } : {}),
		usage: {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			...(usage.cacheCreationTokens !== undefined
				? { cacheCreationTokens: usage.cacheCreationTokens }
				: {}),
			...(usage.cacheReadTokens !== undefined
				? { cacheReadTokens: usage.cacheReadTokens }
				: {}),
			costUsd,
		},
		stopReason: mapStopReason(response),
	};
	yield finalChunk;
}

// ── Anthropic implementation ──

function createAnthropicClient(authGroup: AuthGroup): {
	client: Anthropic;
	useOAuth: boolean;
} {
	if (authGroup.provider !== "anthropic") {
		throw new Error(
			`createAnthropicClient: expected anthropic auth group, got ${authGroup.provider}`,
		);
	}
	const apiKey = authGroup.apiKey ?? process.env.ANTHROPIC_API_KEY;
	const oauthToken =
		authGroup.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
	const useOAuth = Boolean(oauthToken && !apiKey);
	// Same beta headers as the full provider — keep behavior consistent so
	// a plugin using the facility gets the same model configuration as an
	// agent-loop call would.
	const betaFeatures = [
		"interleaved-thinking-2025-05-14",
		"context-management-2025-06-27",
		"effort-2025-11-24",
	];
	const timeout = 60 * 60 * 1000;
	if (useOAuth) {
		return {
			client: new Anthropic({
				authToken: oauthToken,
				timeout,
				defaultHeaders: {
					"anthropic-beta": ["oauth-2025-04-20", ...betaFeatures].join(","),
				},
			}),
			useOAuth: true,
		};
	}
	if (apiKey) {
		return {
			client: new Anthropic({
				apiKey,
				timeout,
				defaultHeaders: { "anthropic-beta": betaFeatures.join(",") },
			}),
			useOAuth: false,
		};
	}
	// Fall back to SDK default env resolution. Will 401 at call time if nothing
	// is set — surfaces clearly to the caller.
	return {
		client: new Anthropic({
			timeout,
			defaultHeaders: { "anthropic-beta": betaFeatures.join(",") },
		}),
		useOAuth: false,
	};
}

async function* streamAnthropic(
	client: Anthropic,
	useOAuth: boolean,
	systemPreamble: string | undefined,
	model: string,
	effort: number,
	req: LLMRequest,
): AsyncGenerator<LLMChunk, void> {
	const adapter = createAnthropicAdapter(client, useOAuth, {
		thinkingEffort: effort > 0 ? effort : undefined,
		systemPreamble,
	});
	// Anthropic's MessageParam accepts {role, content: string} natively — no
	// envelope construction needed. Pass the flat role list straight in.
	yield* runAdapterStream(
		adapter,
		{
			model,
			messages: requestToRoleList(req),
			systemPrompt: { stable: req.system ?? "", variable: "" },
			maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
			signal: req.signal,
		},
		extractAnthropicThinking,
		mapStopReasonAnthropic,
	);
}

// ── OpenAI Responses implementation ──

function resolveOpenAIAuth(authGroup: AuthGroup): {
	baseUrl: string;
	authToken: string;
	accountId?: string;
} {
	if (authGroup.provider !== "openai") {
		throw new Error(
			`resolveOpenAIAuth: expected openai auth group, got ${authGroup.provider}`,
		);
	}
	const baseUrl =
		authGroup.baseUrl ??
		process.env.OPENAI_BASE_URL ??
		process.env.OPENAI_API_BASE ??
		"https://api.openai.com/v1";
	const authToken =
		authGroup.apiKey ??
		authGroup.accessToken ??
		process.env.OPENAI_API_KEY ??
		"";
	if (!authToken) {
		console.warn(
			"[llm] OpenAI auth group has no apiKey/accessToken — calls will 401 at the API.",
		);
	}
	return {
		baseUrl,
		authToken,
		accountId: authGroup.accountId,
	};
}

async function* streamOpenAI(
	baseUrl: string,
	authToken: string,
	accountId: string | undefined,
	model: string,
	req: LLMRequest,
): AsyncGenerator<LLMChunk, void> {
	const adapter = createOpenAIResponsesAdapter(baseUrl, authToken, accountId);
	// OpenAI Responses adapter's `callAPI` accepts Matrix's `HistoryMessage`
	// shape which is a superset of `{role, content: string}`. Pass flat role
	// list straight in.
	yield* runAdapterStream(
		adapter,
		{
			model,
			messages: requestToRoleList(req),
			systemPrompt: { stable: req.system ?? "", variable: "" },
			maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
			signal: req.signal,
		},
		extractOpenAIReasoning,
		mapStopReasonOpenAI,
	);
}

// ── LLMClient core ──

/** Discriminated union of provider-specific state for `buildLLMClient`. */
type ProviderState =
	| {
			provider: "anthropic";
			client: Anthropic;
			useOAuth: boolean;
			systemPreamble?: string;
	  }
	| {
			provider: "openai";
			baseUrl: string;
			authToken: string;
			accountId?: string;
	  };

/**
 * Build an `LLMClient` from pre-resolved provider state + model + default effort.
 *
 * This is the single choke point for LLM client behavior — both the public
 * `createLLM` (takes an AuthGroup) and the test-only `_createLLMFromClient`
 * call this.
 */
function buildLLMClient(
	state: ProviderState,
	model: string,
	defaultEffort: number,
): LLMClient {
	function streamInternal(req: LLMRequest): AsyncGenerator<LLMChunk, void> {
		validateRequest(req);
		const effort = req.thinkingEffort ?? defaultEffort;
		if (state.provider === "anthropic") {
			return streamAnthropic(
				state.client,
				state.useOAuth,
				state.systemPreamble,
				model,
				effort,
				req,
			);
		}
		return streamOpenAI(
			state.baseUrl,
			state.authToken,
			state.accountId,
			model,
			req,
		);
	}

	return {
		stream(req) {
			return streamInternal(req);
		},
		async run(req) {
			let text = "";
			let thinking: string | undefined;
			let usage: LLMUsage | undefined;
			let stopReason: "end_turn" | "max_tokens" | "other" | undefined;
			for await (const chunk of streamInternal(req)) {
				if (chunk.type === "final") {
					text = chunk.text;
					thinking = chunk.thinking;
					usage = chunk.usage;
					stopReason = chunk.stopReason;
				}
				// text_delta / thinking_delta are intentionally ignored — the `final`
				// chunk carries the aggregated values already.
			}
			if (!usage || !stopReason) {
				throw new Error(
					"LLM stream ended without a final chunk — this is a bug in the facility",
				);
			}
			return {
				text,
				...(thinking !== undefined ? { thinking } : {}),
				usage,
				stopReason,
			};
		},
	};
}

// ── Public API ──

/**
 * Create a stateless LLM client bound to an auth group + model.
 *
 * The SDK client is constructed once (cheap pooling, connection reuse).
 * Per-call thinking overrides create a fresh adapter instance each call —
 * this is cheap (closure allocation) and lets thinking vary per request.
 *
 * Errors from invalid `authGroup` (unsupported provider) throw here.
 * Missing credentials DO NOT throw here — they surface as 401 on first call,
 * which matches the existing provider factory behavior.
 */
export function createLLM(config: LLMConfig): LLMClient {
	const defaultEffort = config.defaultThinkingEffort ?? 0;

	if (config.authGroup.provider === "anthropic") {
		const model = config.model || DEFAULT_MODEL;
		const { client, useOAuth } = createAnthropicClient(config.authGroup);
		return buildLLMClient(
			{
				provider: "anthropic",
				client,
				useOAuth,
				systemPreamble: config.authGroup.systemPreamble,
			},
			model,
			defaultEffort,
		);
	}
	if (config.authGroup.provider === "openai") {
		const model = config.model || "gpt-4o";
		const { baseUrl, authToken, accountId } = resolveOpenAIAuth(
			config.authGroup,
		);
		return buildLLMClient(
			{ provider: "openai", baseUrl, authToken, accountId },
			model,
			defaultEffort,
		);
	}
	throw new Error(
		// biome-ignore lint/suspicious/noExplicitAny: defensive type assertion
		`createLLM: unsupported provider "${(config.authGroup as any).provider}"`,
	);
}

/** Convenience: `createLLM(config).run(req)` in one call. */
export function runLLM(config: LLMConfig, req: LLMRequest): Promise<LLMResult> {
	return createLLM(config).run(req);
}

/** Convenience: `createLLM(config).stream(req)` in one call. */
export function streamLLM(
	config: LLMConfig,
	req: LLMRequest,
): AsyncIterable<LLMChunk> {
	return createLLM(config).stream(req);
}

/**
 * @internal — test-only factory for injecting a pre-built Anthropic SDK client.
 *
 * The existing `ValidatingMockAPI` mocking strategy replaces
 * `client.messages.stream` directly on a constructed SDK client. Tests use
 * this factory to hand a pre-mocked client to the facility, bypassing
 * `createAnthropicClient`'s credential resolution.
 *
 * Do not use in production code; plugins should always go through `createLLM`.
 */
export function _createLLMFromAnthropicClient(
	client: Anthropic,
	useOAuth: boolean,
	model: string,
	opts?: { systemPreamble?: string; defaultThinkingEffort?: number },
): LLMClient {
	return buildLLMClient(
		{
			provider: "anthropic",
			client,
			useOAuth,
			systemPreamble: opts?.systemPreamble,
		},
		model,
		opts?.defaultThinkingEffort ?? 0,
	);
}
