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
					} else {
						isError = true;
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
		};
	}

	private async executeInternal(request: AgentRequest): Promise<AgentResult> {
		const conversation = this.createQuery(request);

		let resultText = "";
		let isError = false;
		let totalCostUsd = 0;
		let numTurns = 0;

		for await (const message of conversation) {
			if (message.type === "result") {
				if (message.subtype === "success") {
					resultText = message.result;
					totalCostUsd = message.total_cost_usd;
					numTurns = message.num_turns;
				} else {
					isError = true;
				}
			}
		}

		return {
			success: !isError,
			output: resultText,
			costUsd: totalCostUsd,
			turns: numTurns,
		};
	}

	private createQuery(request: AgentRequest) {
		const abortController = new AbortController();
		if (request.signal) {
			request.signal.addEventListener("abort", () => abortController.abort());
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
			},
		});
	}
}
