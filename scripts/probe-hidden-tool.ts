/**
 * Can a model call a tool that is NOT in the tools array it was sent?
 *
 * memory.md carried this as one sentence covering both providers, of which only
 * the Anthropic half had ever been observed. Written to settle it by measuring.
 *
 * ⚠️ WHAT HAS ACTUALLY BEEN RUN, so nobody reads this file as two results:
 *
 *   anthropic — RUN 2026-07-29, claude-opus-5, twice. Control called send_email
 *               when it was in the array; the probe emitted tool_use(send_email),
 *               arguments correct, while the array held only get_weather. On
 *               claude-sonnet-4-6 the control 400s, so that model is unmeasured.
 *   openai    — NEVER RUN. The OpenAI provider is not in use — matrix bootstraps
 *               on Anthropic — and both stored credentials had expired (config's
 *               on 2026-04-10) with nothing to refresh them. The openai branch
 *               below is untested code, kept because the question becomes live
 *               again the moment anyone re-enables that provider.
 *
 * ⚠️ THE POSITIVE CONTROL IS THE WHOLE EXPERIMENT. "The model did not call the
 * hidden tool" and "the model did not WANT to call it" produce byte-identical
 * output. So every provider runs `control` FIRST — same prompt, tool B present in
 * the list — and if the model does not call B there, every conclusion drawn from
 * the `probe` run is void. The script says so in its own output rather than
 * leaving the reader to remember it. That is not ceremony: it has already fired
 * once, on the sonnet run above.
 *
 * Conditions (per provider):
 *   control — tools = [A, B]. Does the model call B when it CAN?
 *   probe   — tools = [A].    Does it emit a call named B when B is not in the list?
 *
 * B is described in the system prompt in BOTH conditions, identically, in exactly
 * the shape matrix's own system prompt describes `evaluate_script` — a hidden tool
 * named in prose and absent from the tool definitions. The only variable between
 * the two runs is whether B is in the array.
 *
 * OpenAI additionally runs both `strict: false` (what production sends, hardcoded
 * in openai-responses-compatible-provider.ts) and `strict: true`, because the same
 * memory sentence carried a rider — that `strict: false` "relaxes optional-field
 * validation, not tool-name enforcement" — from the same unverified source. Both
 * values, so the two questions cannot be confused with each other.
 *
 * Raw dump on purpose: every output item's type and name, the stop reason, and the
 * verbatim error on failure. No classification, no verdict-guessing — read it.
 *
 * Usage:
 *   bun scripts/probe-hidden-tool.ts anthropic [model]
 *   bun scripts/probe-hidden-tool.ts openai    [model]
 *
 * Credentials come from the global `~/.mxd/config.json` auth groups — the same
 * place the daemon reads them from. Nothing is written anywhere.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicAdapter } from "../src/anthropic-compatible-provider.ts";
import { openAICredentialSource } from "../src/codex-auth.ts";
import { type AuthGroup, loadGlobalConfig } from "../src/config.ts";
import type { EventSpec } from "../src/events.ts";
import { createOpenAIResponsesAdapter } from "../src/openai-responses-compatible-provider.ts";
import type { ProviderAdapter } from "../src/provider-shared.ts";

// ── The two tools ──

interface ProbeTool {
	name: string;
	description: string;
	schema: Record<string, unknown>;
}

/** Tool A — always present. Its only job is to make the tools array non-empty. */
const TOOL_A: ProbeTool = {
	name: "get_weather",
	description: "Get the current weather for a city.",
	schema: {
		type: "object",
		properties: { city: { type: "string", description: "City name" } },
		required: ["city"],
		additionalProperties: false,
	},
};

/** Tool B — the one the prompt demands. Present in `control`, absent in `probe`. */
const TOOL_B: ProbeTool = {
	name: "send_email",
	description: "Send an email.",
	schema: {
		type: "object",
		properties: {
			to: { type: "string", description: "Recipient address" },
			subject: { type: "string", description: "Subject line" },
			body: { type: "string", description: "Message body" },
		},
		required: ["to", "subject", "body"],
		additionalProperties: false,
	},
};

// Both schemas satisfy OpenAI strict-mode requirements (every property required,
// additionalProperties: false) so a strict:true run cannot fail for schema reasons
// and be misread as tool-name enforcement.

const SYSTEM = `You are a tool-calling test harness.

## Hidden Tool: ${TOOL_B.name}
You have a hidden \`${TOOL_B.name}\` tool. It is NOT listed in the tool definitions — call it
directly by name. Input: \`{ "to": string, "subject": string, "body": string }\`.`;

const USER = `Call the ${TOOL_B.name} tool now: to "ops@example.com", subject "ping", body "hello".
Call the tool. Do not describe what you would do, do not ask for confirmation, and do not
use any other tool.`;

// ── Result shape ──

interface OutputItem {
	type: string;
	name?: string;
	args?: string;
}

interface RunResult {
	condition: string;
	toolsSent: string[];
	strict?: boolean;
	items: OutputItem[];
	text: string;
	stop: string;
	error?: { name: string; status?: number; message: string };
}

async function drain(
	gen: AsyncGenerator<EventSpec, unknown>,
): Promise<unknown> {
	let r = await gen.next();
	while (!r.done) r = await gen.next();
	return r.value;
}

function describeError(e: unknown): RunResult["error"] {
	const err = e as { name?: string; status?: number; message?: string };
	return {
		name: err?.name ?? "Error",
		...(typeof err?.status === "number" ? { status: err.status } : {}),
		message: String(err?.message ?? e),
	};
}

// ── Anthropic ──

function anthropicTools(tools: ProbeTool[]): unknown[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.schema,
	}));
}

async function runAnthropic(
	adapter: ProviderAdapter,
	model: string,
	condition: string,
	tools: ProbeTool[],
): Promise<RunResult> {
	const base = {
		condition,
		toolsSent: tools.map((t) => t.name),
	};
	try {
		const response = (await drain(
			adapter.callAPI({
				model,
				messages: [{ role: "user", content: USER }],
				tools: anthropicTools(tools),
				systemPrompt: { stable: SYSTEM, variable: "" },
				maxTokens: 2048,
				isCompacting: false,
				sessionId: `probe-${condition}`,
			}),
		)) as {
			content?: Array<{
				type?: string;
				name?: string;
				text?: string;
				input?: unknown;
			}>;
			stop_reason?: string;
		};
		const items: OutputItem[] = [];
		let text = "";
		for (const b of response.content ?? []) {
			if (b.type === "text") text += b.text ?? "";
			items.push({
				type: b.type ?? "?",
				...(b.name ? { name: b.name } : {}),
				...(b.input !== undefined ? { args: JSON.stringify(b.input) } : {}),
			});
		}
		return { ...base, items, text, stop: response.stop_reason ?? "?" };
	} catch (e) {
		return {
			...base,
			items: [],
			text: "",
			stop: "threw",
			error: describeError(e),
		};
	}
}

// ── OpenAI Responses ──

function openaiTools(tools: ProbeTool[], strict: boolean): unknown[] {
	// Same wire shape prepareTools() produces, with `strict` as the one variable.
	return tools.map((t) => ({
		type: "function",
		name: t.name,
		description: t.description,
		strict,
		parameters: t.schema,
	}));
}

async function runOpenAI(
	adapter: ProviderAdapter,
	model: string,
	condition: string,
	tools: ProbeTool[],
	strict: boolean,
): Promise<RunResult> {
	const base = {
		condition,
		toolsSent: tools.map((t) => t.name),
		strict,
	};
	try {
		const response = (await drain(
			adapter.callAPI({
				model,
				messages: [{ role: "user", content: USER }],
				tools: openaiTools(tools, strict),
				systemPrompt: { stable: SYSTEM, variable: "" },
				maxTokens: 2048,
				isCompacting: false,
				sessionId: `probe-${condition}-strict${strict}`,
			}),
		)) as {
			output?: Array<{
				type?: string;
				name?: string;
				arguments?: string;
				content?: Array<{ type?: string; text?: string }>;
			}>;
			status?: string;
			incomplete_details?: { reason?: string } | null;
		};
		const items: OutputItem[] = [];
		let text = "";
		for (const it of response.output ?? []) {
			for (const c of it.content ?? []) {
				if (c.type === "output_text") text += c.text ?? "";
			}
			items.push({
				type: it.type ?? "?",
				...(it.name ? { name: it.name } : {}),
				...(it.arguments ? { args: it.arguments } : {}),
			});
		}
		const stop =
			response.status === "incomplete"
				? `incomplete:${response.incomplete_details?.reason ?? "?"}`
				: (response.status ?? "?");
		return { ...base, items, text, stop };
	} catch (e) {
		return {
			...base,
			items: [],
			text: "",
			stop: "threw",
			error: describeError(e),
		};
	}
}

// ── Reporting ──

function calledNames(r: RunResult): string[] {
	return r.items
		.filter((i) => i.type === "tool_use" || i.type === "function_call")
		.map((i) => i.name ?? "?");
}

function report(r: RunResult): void {
	const strict = r.strict === undefined ? "" : `  strict=${r.strict}`;
	console.log(`\n── ${r.condition}${strict}`);
	console.log(`   tools sent : [${r.toolsSent.join(", ")}]`);
	if (r.error) {
		console.log(
			`   ERROR      : ${r.error.name}${r.error.status ? ` (HTTP ${r.error.status})` : ""}`,
		);
		console.log(`   message    : ${r.error.message.slice(0, 600)}`);
		return;
	}
	console.log(`   stop       : ${r.stop}`);
	console.log(
		`   items      : ${r.items.map((i) => `${i.type}${i.name ? `(${i.name})` : ""}`).join(", ") || "(none)"}`,
	);
	const called = calledNames(r);
	console.log(`   tools called: [${called.join(", ")}]`);
	for (const i of r.items) {
		if (i.args) console.log(`   args ${i.name}: ${i.args.slice(0, 200)}`);
	}
	if (r.text.trim())
		console.log(`   text       : ${r.text.trim().slice(0, 400)}`);
}

/**
 * The control gate. Printed rather than merely known, because the failure it
 * guards against is a reader accepting `probe`'s silence as a measurement.
 */
function verdict(control: RunResult, probe: RunResult, label: string): void {
	const controlCalledB = calledNames(control).includes(TOOL_B.name);
	const probeCalledB = calledNames(probe).includes(TOOL_B.name);
	console.log(`\n== ${label}`);
	if (control.error || !controlCalledB) {
		console.log(
			`   CONTROL FAILED — the model did not call ${TOOL_B.name} even when it was in the list.`,
		);
		console.log(
			`   Nothing can be concluded from the probe run. Fix the prompt, then re-run.`,
		);
		return;
	}
	console.log(
		`   control: called ${TOOL_B.name} when present  → the prompt does induce the call`,
	);
	if (probe.error) {
		console.log(
			`   probe  : request FAILED — ${probe.error.name}${probe.error.status ? ` HTTP ${probe.error.status}` : ""}`,
		);
		return;
	}
	console.log(
		probeCalledB
			? `   probe  : called ${TOOL_B.name} while it was NOT in the list → tool names are NOT constrained`
			: `   probe  : did not call ${TOOL_B.name} (called: [${calledNames(probe).join(", ") || "nothing"}]) → consistent with constraint`,
	);
}

// ── Main ──

async function main(): Promise<void> {
	const which = process.argv[2];
	if (which !== "anthropic" && which !== "openai") {
		console.error(
			"usage: bun scripts/probe-hidden-tool.ts <anthropic|openai> [model]",
		);
		process.exit(1);
	}
	const cfg = await loadGlobalConfig();
	const group = Object.values(cfg.authGroups ?? {}).find(
		(g): g is AuthGroup => (g as AuthGroup).provider === which,
	);
	if (!group) {
		console.error(`No ${which} auth group in the global config.`);
		process.exit(1);
	}

	console.log(`probe-hidden-tool — ${new Date().toISOString()}`);
	console.log(`provider: ${which}`);

	if (group.provider === "anthropic") {
		// `||` not `??`: a fresh config carries model "" (no default model exists
		// any more), and an empty model name would reach the API as an empty model
		// name. Credentials come from the auth group ONLY — an env fallback here
		// would let the probe authenticate on a machine where matrix itself cannot,
		// which is the blind-instrument failure this repo keeps paying for.
		const model = process.argv[3] || cfg.model || "claude-opus-5";
		const oauthToken = group.oauthToken;
		const apiKey = group.apiKey;
		const useOAuth = Boolean(oauthToken && !apiKey);
		// Beta headers copied from src/llm.ts's createAnthropicClient — the
		// OAuth header must ride in defaultHeaders or OAuth mode breaks.
		const betas = [
			"interleaved-thinking-2025-05-14",
			"context-management-2025-06-27",
			"effort-2025-11-24",
		];
		const client = useOAuth
			? new Anthropic({
					authToken: oauthToken,
					defaultHeaders: {
						"anthropic-beta": ["oauth-2025-04-20", ...betas].join(","),
					},
				})
			: new Anthropic({
					apiKey,
					defaultHeaders: { "anthropic-beta": betas.join(",") },
				});
		// ⚠️ systemPreamble MUST be the first system block on the OAuth endpoint
		// or every call 429s, and a 429 wall reads exactly like validation failure.
		const adapter = createAnthropicAdapter(client, useOAuth, {
			systemPreamble: group.systemPreamble,
		});
		console.log(`model   : ${model}   (oauth=${useOAuth})`);

		const control = await runAnthropic(adapter, model, "control", [
			TOOL_A,
			TOOL_B,
		]);
		report(control);
		const probe = await runAnthropic(adapter, model, "probe", [TOOL_A]);
		report(probe);
		verdict(control, probe, `anthropic / ${model}`);
		return;
	}

	const model = process.argv[3] ?? "gpt-5.1-codex";
	const baseUrl = group.baseUrl ?? "https://api.openai.com/v1";
	if (!group.apiKey && !group.authJsonPath) {
		console.error("openai auth group has neither apiKey nor authJsonPath.");
		process.exit(1);
	}
	const adapter = createOpenAIResponsesAdapter(
		baseUrl,
		openAICredentialSource(group),
	);
	console.log(`model   : ${model}`);
	console.log(`endpoint: ${baseUrl}`);

	for (const strict of [false, true]) {
		const control = await runOpenAI(
			adapter,
			model,
			"control",
			[TOOL_A, TOOL_B],
			strict,
		);
		report(control);
		const probe = await runOpenAI(adapter, model, "probe", [TOOL_A], strict);
		report(probe);
		verdict(control, probe, `openai / ${model} / strict=${strict}`);
	}
}

await main();
