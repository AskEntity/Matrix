import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import type { McpServerConfig } from "./config.ts";
import type { ToolDefinition } from "./tool-definition.ts";

/** Handle to a connected MCP server with tool discovery and invocation. */
interface McpServerHandle {
	client: Client;
	transport: StdioClientTransport;
	tools: Array<{
		name: string;
		description?: string;
		inputSchema: Record<string, unknown>;
	}>;
}

/**
 * Connect to a single MCP server via stdio transport.
 * Spawns the server process, performs protocol handshake, and discovers tools.
 */
export async function startMcpServer(
	name: string,
	config: McpServerConfig,
): Promise<McpServerHandle> {
	const transport = new StdioClientTransport({
		command: config.command,
		args: config.args,
		env: {
			...(process.env as Record<string, string>),
			...config.env,
		},
		stderr: "pipe",
	});

	const client = new Client({
		name: `opengraft-${name}`,
		version: "1.0.0",
	});

	await client.connect(transport);

	const result = await client.listTools();
	const tools = result.tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema as Record<string, unknown>,
	}));

	return { client, transport, tools };
}

/**
 * Manages connections to multiple external MCP servers.
 * Discovers tools from each server and routes tool calls to the correct server.
 */
export class McpClientManager {
	private servers = new Map<string, McpServerHandle>();

	/** Connect to all configured MCP servers and discover their tools. */
	async connectAll(configs: Record<string, McpServerConfig>): Promise<void> {
		const entries = Object.entries(configs);
		const results = await Promise.allSettled(
			entries.map(async ([name, config]) => {
				const handle = await startMcpServer(name, config);
				this.servers.set(name, handle);
				return { name, toolCount: handle.tools.length };
			}),
		);

		for (const [i, result] of results.entries()) {
			if (result.status === "rejected") {
				const name = entries[i]?.[0] ?? "unknown";
				console.error(
					`[mcp-client] Failed to connect to MCP server "${name}":`,
					result.reason,
				);
			}
		}
	}

	/**
	 * Get tool definitions for all connected servers, compatible with mcpToolDefs format.
	 * Each server's tools are converted to ToolDefinition[] with handlers that route
	 * calls back to the MCP server.
	 */
	getToolDefs(): Record<string, ToolDefinition[]> {
		const result: Record<string, ToolDefinition[]> = {};

		for (const [serverName, handle] of this.servers) {
			result[serverName] = handle.tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				// Empty Zod shape — providers will use jsonSchema instead
				inputSchema: {} as ZodRawShape,
				jsonSchema: tool.inputSchema,
				handler: async (
					args: Record<string, unknown>,
				): Promise<CallToolResult> => {
					return this.callTool(serverName, tool.name, args);
				},
			}));
		}

		return result;
	}

	/** Route a tool call to the correct MCP server. */
	async callTool(
		serverName: string,
		toolName: string,
		args: unknown,
	): Promise<CallToolResult> {
		const handle = this.servers.get(serverName);
		if (!handle) {
			return {
				content: [
					{
						type: "text",
						text: `MCP server "${serverName}" not connected`,
					},
				],
				isError: true,
			};
		}

		try {
			const result = await handle.client.callTool({
				name: toolName,
				arguments: args as Record<string, unknown>,
			});
			return result as CallToolResult;
		} catch (error) {
			return {
				content: [
					{
						type: "text",
						text: `MCP tool call failed: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
				isError: true,
			};
		}
	}

	/** Disconnect from all MCP servers and clean up processes. */
	async disconnectAll(): Promise<void> {
		const closePromises: Promise<void>[] = [];
		for (const [name, handle] of this.servers) {
			closePromises.push(
				handle.client.close().catch((err) => {
					console.error(
						`[mcp-client] Error closing MCP server "${name}":`,
						err,
					);
				}),
			);
		}
		await Promise.allSettled(closePromises);
		this.servers.clear();
	}

	/** Check if any servers are connected. */
	get hasServers(): boolean {
		return this.servers.size > 0;
	}

	/** Get the names of all connected servers. */
	get serverNames(): string[] {
		return [...this.servers.keys()];
	}
}
