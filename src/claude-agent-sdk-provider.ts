import { randomUUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
	AgentEvent,
	AgentProvider,
	AgentRequest,
	AgentSession,
} from "./agent-provider.ts";
import { formatQueueMessage, toRawMessage } from "./agent-tools.ts";
import { MessageQueue } from "./message-queue.ts";
import type { AgentResult } from "./types.ts";

/**
 * Phase 0 agent provider: delegates to Claude Code Agent SDK.
 * The SDK spawns a Claude Code subprocess that has full tool access
 * (file editing, terminal, search, etc).
 */
export class ClaudeAgentSdkProvider implements AgentProvider {
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
					// Drain queue after each assistant turn (cancellation point)
					if (request.queue && request.queue.pending > 0) {
						const msgs = request.queue
							.drain()
							.filter((m) => m.source !== "compact");
						if (msgs.length > 0) {
							const formatted = msgs.map(formatQueueMessage).join("\n");
							yield {
								type: "queue_message" as const,
								messages: formatted,
								rawMessages: msgs.map(toRawMessage),
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

	startSession(request: AgentRequest): AgentSession {
		const conversation = this.createQuery(request);
		const sessionId = request.resumeSessionId ?? randomUUID();
		const queue = request.queue ?? new MessageQueue();

		// Create a message queue for injecting messages via streamInput
		const messageQueue: SDKUserMessage[] = [];
		let messageResolve: (() => void) | null = null;
		let closed = false;

		// Async iterable that yields messages as they're pushed
		const messageStream: AsyncIterable<SDKUserMessage> = {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<SDKUserMessage>> {
						while (!closed) {
							if (messageQueue.length > 0) {
								const msg = messageQueue.shift() as SDKUserMessage;
								return { value: msg, done: false };
							}
							await new Promise<void>((resolve) => {
								messageResolve = resolve;
							});
						}
						return {
							value: undefined as unknown as SDKUserMessage,
							done: true,
						};
					},
				};
			},
		};

		// Start streaming input in the background
		conversation.streamInput(messageStream);

		async function* eventStream(): AsyncGenerator<AgentEvent, AgentResult> {
			let resultText = "";
			let isError = false;
			let totalCostUsd = 0;
			let numTurns = 0;
			let finalSessionId = "";

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
						// Drain queue after each assistant turn and inject into conversation
						if (queue.pending > 0) {
							const msgs = queue.drain().filter((m) => m.source !== "compact");
							if (msgs.length === 0) continue;
							const formatted = msgs.map(formatQueueMessage).join("\n");
							yield {
								type: "queue_message" as const,
								messages: formatted,
								rawMessages: msgs.map(toRawMessage),
							};
							const sdkMsg: SDKUserMessage = {
								type: "user",
								message: {
									role: "user",
									content: `[Messages received while you were working:]\n${formatted}`,
								},
								parent_tool_use_id: null,
								priority: "now",
								session_id: sessionId,
							};
							messageQueue.push(sdkMsg);
							if (messageResolve) {
								messageResolve();
								messageResolve = null;
							}
						}
						break;
					}
					case "result": {
						if (message.subtype === "success") {
							resultText = message.result;
							totalCostUsd = message.total_cost_usd;
							numTurns = message.num_turns;
							finalSessionId = message.session_id;
						} else {
							isError = true;
							finalSessionId = message.session_id;
							yield {
								type: "error",
								message: `Agent error: ${message.subtype}`,
							};
						}
						break;
					}
				}
			}

			closed = true;
			if (messageResolve) messageResolve();

			return {
				success: !isError,
				output: resultText,
				costUsd: totalCostUsd,
				turns: numTurns,
				sessionId: finalSessionId || undefined,
			};
		}

		return {
			sessionId,
			events: eventStream(),
			queue,
			async sendMessage(text: string): Promise<void> {
				if (closed) return;
				const msg: SDKUserMessage = {
					type: "user",
					message: { role: "user", content: text },
					parent_tool_use_id: null,
					priority: "now",
					session_id: sessionId,
				};
				messageQueue.push(msg);
				if (messageResolve) {
					messageResolve();
					messageResolve = null;
				}
			},
			stop() {
				closed = true;
				queue.close();
				if (messageResolve) messageResolve();
				conversation.close();
			},
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
