import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
	AgentEvent,
	AgentProvider,
	AgentRequest,
} from "./agent-provider.ts";
import type { AgentResult } from "./types.ts";

/**
 * Phase 0 agent provider: delegates to Claude Code Agent SDK.
 * The SDK spawns a Claude Code subprocess that has full tool access
 * (file editing, terminal, search, etc).
 */
export class ClaudeCodeProvider implements AgentProvider {
	readonly name = "claude-code";

	async execute(request: AgentRequest): Promise<AgentResult> {
		return this.executeInternal(request);
	}

	async *stream(
		request: AgentRequest,
	): AsyncGenerator<AgentEvent, AgentResult> {
		const conversation = this.createQuery(request);

		let resultText = "";
		let isError = false;
		let totalCostUsd = 0;
		let numTurns = 0;
		let sessionId = "";

		for await (const message of conversation) {
			switch (message.type) {
				case "assistant": {
					for (const block of message.message.content) {
						if (block.type === "text") {
							resultText = block.text;
							yield { type: "text", content: block.text };
						} else if (block.type === "tool_use") {
							yield {
								type: "tool_use",
								tool: block.name,
								input: block.input as Record<string, unknown>,
							};
						}
					}
					break;
				}
				case "result": {
					if (message.subtype === "success") {
						resultText = message.result;
						totalCostUsd = message.total_cost_usd;
						numTurns = message.num_turns;
						sessionId = message.session_id;
					} else {
						isError = true;
						sessionId = message.session_id;
						yield {
							type: "error",
							message: `Agent error: ${message.subtype}`,
						};
					}
					break;
				}
			}
		}

		return {
			success: !isError,
			output: resultText,
			costUsd: totalCostUsd,
			turns: numTurns,
			sessionId: sessionId || undefined,
		};
	}

	private async executeInternal(request: AgentRequest): Promise<AgentResult> {
		const conversation = this.createQuery(request);

		let resultText = "";
		let isError = false;
		let totalCostUsd = 0;
		let numTurns = 0;
		let sessionId = "";

		for await (const message of conversation) {
			if (message.type === "result") {
				if (message.subtype === "success") {
					resultText = message.result;
					totalCostUsd = message.total_cost_usd;
					numTurns = message.num_turns;
					sessionId = message.session_id;
				} else {
					isError = true;
					sessionId = message.session_id;
				}
			}
		}

		return {
			success: !isError,
			output: resultText,
			costUsd: totalCostUsd,
			turns: numTurns,
			sessionId: sessionId || undefined,
		};
	}

	private createQuery(request: AgentRequest) {
		const abortController = new AbortController();
		if (request.signal) {
			request.signal.addEventListener("abort", () => abortController.abort());
		}

		// Strip CLAUDECODE env var to allow spawning from within a Claude Code session.
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (key !== "CLAUDECODE" && value !== undefined) {
				env[key] = value;
			}
		}

		return query({
			prompt: request.prompt,
			options: {
				cwd: request.cwd,
				systemPrompt: request.systemPrompt ?? undefined,
				maxTurns: request.maxTurns,
				abortController,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				env,
				// Session management: resume previous conversation or start new
				...(request.resumeSessionId ? { resume: request.resumeSessionId } : {}),
				// MCP servers: in-process tool servers for orchestration
				...(request.mcpServers ? { mcpServers: request.mcpServers } : {}),
				// Model selection
				...(request.model ? { model: request.model } : {}),
			},
		});
	}
}
