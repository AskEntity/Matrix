/**
 * Cache audit — makes a real API call with countTokens to check cache behavior.
 * Also analyzes what a REAL API call would look like at different conversation points.
 * Usage: bun run src/_cache_audit.ts [sessionId]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { eventsToAnthropicMessages } from "./anthropic-compatible-provider.ts";
import { loadGlobalConfig, resolveAuthGroup } from "./config.ts";
import type { Event } from "./events.ts";
import { buildSystemPrompt } from "./system-prompts.ts";

const globalConfig = await loadGlobalConfig();
const authGroup = resolveAuthGroup(globalConfig);
const oauthToken = authGroup?.claudeOauthToken;
const apiKey = authGroup?.anthropicApiKey;
const useOAuth = Boolean(oauthToken && !apiKey);

let client: Anthropic;
if (useOAuth) {
	client = new Anthropic({
		authToken: oauthToken,
		defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
	});
} else if (apiKey) {
	client = new Anthropic({ apiKey });
} else {
	console.error("No auth configured");
	process.exit(1);
}

const sessionDir = `${process.env.HOME}/.opengraft/sessions/b3d7a1f3-6f5b-4dd7-a046-55591a8c7d02`;

// Analyze ALL recent sessions
const files = readdirSync(sessionDir)
	.filter((f) => f.endsWith(".events.jsonl") && !f.includes(".debug"))
	.map((f) => ({
		sid: f.replace(".events.jsonl", ""),
		path: `${sessionDir}/${f}`,
		mtime: statSync(`${sessionDir}/${f}`).mtimeMs,
		size: statSync(`${sessionDir}/${f}`).size,
	}))
	.sort((a, b) => b.mtime - a.mtime)
	.slice(0, 8);

function trimOrphanTail(msgs: MessageParam[]): MessageParam[] {
	let result = [...msgs];
	while (result.length > 0) {
		const last = result[result.length - 1]!;
		if (last.role === "assistant") {
			const content = last.content;
			if (
				Array.isArray(content) &&
				content.some((b: { type: string }) => b.type === "tool_use")
			) {
				result = result.slice(0, -1);
				continue;
			}
		}
		break;
	}
	// Ensure last message is user (API requirement)
	while (result.length > 0 && result[result.length - 1]!.role !== "user") {
		result = result.slice(0, -1);
	}
	return result;
}

console.log("=== Token audit across sessions ===\n");

for (const file of files) {
	const lines = readFileSync(file.path, "utf-8").trim().split("\n");
	const events: Event[] = lines.map((l) => JSON.parse(l));

	let lastCompact = -1;
	for (let i = 0; i < events.length; i++) {
		if (events[i]!.type === "compact_marker") lastCompact = i;
	}
	const activeEvents = events.slice(lastCompact + 1);
	const rawMessages = eventsToAnthropicMessages(activeEvents) as MessageParam[];
	const messages = trimOrphanTail(rawMessages);

	if (messages.length < 2) continue;

	const sp = buildSystemPrompt();
	const systemPrompt = `${sp.stable}\n\n${sp.variable}`;

	try {
		const result = await client.messages.countTokens({
			model: "claude-sonnet-4-6",
			system: [{ type: "text", text: systemPrompt }],
			messages,
			tools: [],
		});

		// Count content by type
		let toolResultChars = 0;
		let toolUseChars = 0;
		let textChars = 0;
		let userStringChars = 0;

		for (const msg of messages) {
			if (typeof msg.content === "string") {
				userStringChars += msg.content.length;
			} else if (Array.isArray(msg.content)) {
				for (const b of msg.content) {
					if (b.type === "text") textChars += b.text.length;
					else if (b.type === "tool_use")
						toolUseChars += JSON.stringify(b.input).length;
					else if (b.type === "tool_result") {
						const c =
							typeof b.content === "string"
								? b.content.length
								: JSON.stringify(b.content).length;
						toolResultChars += c;
					}
				}
			}
		}
		const totalChars =
			toolResultChars + toolUseChars + textChars + userStringChars;

		console.log(
			`${file.sid.slice(0, 22).padEnd(22)} ${String(messages.length).padStart(4)} msgs  ${String(result.input_tokens.toLocaleString()).padStart(9)} tok  ${String((file.size / 1024).toFixed(0) + "KB").padStart(7)}  tr=${((toolResultChars / totalChars) * 100).toFixed(0)}% tu=${((toolUseChars / totalChars) * 100).toFixed(0)}% txt=${((textChars / totalChars) * 100).toFixed(0)}% usr=${((userStringChars / totalChars) * 100).toFixed(0)}%`,
		);
	} catch (e: unknown) {
		const err = e as Error;
		console.log(
			`${file.sid.slice(0, 22).padEnd(22)} ERROR: ${err.message?.slice(0, 80)}`,
		);
	}
}
