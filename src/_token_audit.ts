/**
 * Token audit script — analyzes actual API token consumption using official countTokens API.
 * Usage: bun run src/_token_audit.ts [sessionId]
 * Defaults to the investigation task session if no sessionId provided.
 */

import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import { loadGlobalConfig, resolveAuthGroup } from "./config.ts";
import type { Event } from "./events.ts";
import { buildSystemPrompt } from "./system-prompts.ts";
import { stripMcpPrefix } from "./tool-names.ts";

// Read auth from config (supports OAuth)
const globalConfig = await loadGlobalConfig();
const authGroup = resolveAuthGroup(globalConfig);
const apiKey = authGroup?.anthropicApiKey;
const oauthToken = authGroup?.claudeOauthToken;
const useOAuth = Boolean(oauthToken && !apiKey);

let client: Anthropic;
if (useOAuth) {
	client = new Anthropic({
		authToken: oauthToken,
		defaultHeaders: {
			"anthropic-beta": "oauth-2025-04-20",
		},
	});
} else if (apiKey) {
	client = new Anthropic({ apiKey });
} else {
	console.error("No API key or OAuth token found in config");
	process.exit(1);
}

const sessionDir = `${process.env.HOME}/.mxd/sessions/b3d7a1f3-6f5b-4dd7-a046-55591a8c7d02`;
const sid = process.argv[2] || "01KMXGHDB3C4AYJ38FAKSG9ETX";

const path = `${sessionDir}/${sid}.events.jsonl`;
const lines = readFileSync(path, "utf-8").trim().split("\n");
const events: Event[] = lines.map((l) => JSON.parse(l));

let lastCompact = -1;
for (let i = 0; i < events.length; i++) {
	if (events[i]?.type === "compact_marker") lastCompact = i;
}
const activeEvents = events.slice(lastCompact + 1);
let messages = eventsToAnthropicMessages(activeEvents) as MessageParam[];

// Trim trailing orphan: if last message is assistant with tool_use, remove it
// (current session still running, last tool_call has no result yet)
while (messages.length > 0) {
	const last = messages[messages.length - 1];
	if (!last) break;
	if (last.role === "assistant") {
		const content = last.content;
		if (
			Array.isArray(content) &&
			content.some((b: { type: string }) => b.type === "tool_use")
		) {
			messages = messages.slice(0, -1);
			continue;
		}
	}
	break;
}

const sp = buildSystemPrompt();
const systemPrompt = `${sp.stable}\n\n${sp.variable}`;

console.log(`Session: ${sid}`);
console.log(`Active events: ${activeEvents.length}`);
console.log(`API messages: ${messages.length}`);
console.log(`System prompt: ${systemPrompt.length} chars`);

// Count tokens for full conversation using official API
try {
	const fullResult = await client.messages.countTokens({
		model: "claude-sonnet-4-6",
		system: [{ type: "text", text: systemPrompt }],
		messages,
		tools: [],
	});
	console.log(
		`\n✅ Official token count: ${fullResult.input_tokens.toLocaleString()}`,
	);

	// Incremental: count at various message slice points to see growth
	// Only slice at points where the last message is a user message (valid API state)
	console.log(`\n=== Token growth over conversation ===`);
	const validSlicePoints: number[] = [];
	for (let i = 1; i <= messages.length; i++) {
		const msg = messages[i - 1];
		if (msg?.role === "user") {
			validSlicePoints.push(i);
		}
	}
	// Sample ~10 points evenly
	const step = Math.max(1, Math.floor(validSlicePoints.length / 10));
	const sampledPoints = validSlicePoints.filter(
		(_, i) => i % step === 0 || i === validSlicePoints.length - 1,
	);
	for (const n of sampledPoints) {
		try {
			const slice = messages.slice(0, n);
			const result = await client.messages.countTokens({
				model: "claude-sonnet-4-6",
				system: [{ type: "text", text: systemPrompt }],
				messages: slice,
				tools: [],
			});
			const perMsg = Math.round(result.input_tokens / n);
			console.log(
				`  First ${String(n).padStart(4)} msgs: ${String(result.input_tokens.toLocaleString()).padStart(10)} tokens  (${perMsg}/msg avg)`,
			);
		} catch {
			// Skip invalid slices
		}
	}

	// Analyze large messages
	console.log(`\n=== Messages > 5000 chars ===`);
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (!msg) continue;
		let chars = 0;
		const parts: string[] = [];

		if (typeof msg.content === "string") {
			chars = msg.content.length;
			parts.push(`string(${chars})`);
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "text") {
					chars += block.text.length;
					parts.push(`text(${block.text.length})`);
				} else if (block.type === "tool_use") {
					const inputLen = JSON.stringify(block.input).length;
					chars += inputLen;
					parts.push(`tool_use:${stripMcpPrefix(block.name)}(${inputLen})`);
				} else if (block.type === "tool_result") {
					const c =
						typeof block.content === "string"
							? block.content.length
							: JSON.stringify(block.content).length;
					chars += c;
					parts.push(`tool_result(${c})`);
				}
			}
		}

		if (chars > 5000) {
			console.log(
				`  msg[${String(i).padStart(3)}] ${msg.role.padEnd(10)} ${String(chars).padStart(7)} chars  ${parts.join(", ").slice(0, 120)}`,
			);
		}
	}

	// Summary by role
	let userChars = 0;
	let assistantChars = 0;
	for (const msg of messages) {
		let chars = 0;
		if (typeof msg.content === "string") {
			chars = msg.content.length;
		} else if (Array.isArray(msg.content)) {
			for (const b of msg.content) {
				if ("text" in b && typeof b.text === "string") chars += b.text.length;
				else if ("content" in b && typeof b.content === "string")
					chars += b.content.length;
				else if ("input" in b) chars += JSON.stringify(b.input).length;
			}
		}
		if (msg.role === "user") userChars += chars;
		else assistantChars += chars;
	}

	console.log(`\n=== Summary ===`);
	console.log(`User content: ${(userChars / 1024).toFixed(0)}KB`);
	console.log(`Assistant content: ${(assistantChars / 1024).toFixed(0)}KB`);
	console.log(
		`Total content: ${((userChars + assistantChars) / 1024).toFixed(0)}KB`,
	);
	console.log(
		`Token/char ratio: ${(fullResult.input_tokens / (userChars + assistantChars)).toFixed(2)} tokens/char`,
	);
} catch (e: unknown) {
	const err = e as Error;
	console.error(`Error: ${err.message}`);
}
