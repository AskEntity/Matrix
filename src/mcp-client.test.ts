import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpClientManager } from "./mcp-client.ts";

// Mock MCP SDK client and transport
const mockListTools = mock(() =>
	Promise.resolve({
		tools: [
			{
				name: "search",
				description: "Search for something",
				inputSchema: {
					type: "object" as const,
					properties: { query: { type: "string" } },
					required: ["query"],
				},
			},
			{
				name: "list",
				description: "List items",
				inputSchema: {
					type: "object" as const,
					properties: {},
				},
			},
		],
	}),
);

const mockCallTool = mock(
	(params: { name: string; arguments: Record<string, unknown> }) => {
		return Promise.resolve({
			content: [{ type: "text", text: `result for ${params.name}` }],
			isError: false,
		} as CallToolResult);
	},
);

const mockClose = mock(() => Promise.resolve());
const mockConnect = mock(() => Promise.resolve());

// Mock the MCP SDK modules
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class MockClient {
		connect = mockConnect;
		listTools = mockListTools;
		callTool = mockCallTool;
		close = mockClose;
	},
}));

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: class MockTransport {},
}));

describe("McpClientManager", () => {
	let manager: McpClientManager;

	beforeEach(() => {
		manager = new McpClientManager();
		mockListTools.mockClear();
		mockCallTool.mockClear();
		mockClose.mockClear();
		mockConnect.mockClear();
	});

	afterEach(async () => {
		await manager.disconnectAll();
	});

	test("connectAll connects to servers and discovers tools", async () => {
		await manager.connectAll({
			github: { command: "mcp-github", args: ["--token", "xxx"] },
		});

		expect(mockConnect).toHaveBeenCalledTimes(1);
		expect(mockListTools).toHaveBeenCalledTimes(1);
		expect(manager.hasServers).toBe(true);
		expect(manager.serverNames).toEqual(["github"]);
	});

	test("getToolDefs returns ToolDefinition[] per server", async () => {
		await manager.connectAll({
			github: { command: "mcp-github" },
		});

		const defs = manager.getToolDefs();
		expect(Object.keys(defs)).toEqual(["github"]);

		const githubTools = defs.github;
		expect(githubTools).toHaveLength(2);
		expect(githubTools?.[0]?.name).toBe("search");
		expect(githubTools?.[0]?.description).toBe("Search for something");
		expect(githubTools?.[0]?.jsonSchema).toEqual({
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		});
		expect(githubTools?.[1]?.name).toBe("list");
	});

	test("tool handler calls through to MCP server", async () => {
		await manager.connectAll({
			github: { command: "mcp-github" },
		});

		const defs = manager.getToolDefs();
		const searchTool = defs.github?.[0];
		expect(searchTool).toBeDefined();

		const result = await searchTool?.handler({ query: "test" }, {});
		expect(result).toEqual({
			content: [{ type: "text", text: "result for search" }],
			isError: false,
		});
		expect(mockCallTool).toHaveBeenCalledWith({
			name: "search",
			arguments: { query: "test" },
		});
	});

	test("callTool returns error for unknown server", async () => {
		const result = await manager.callTool("unknown", "search", {});
		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ type: string; text: string }>)[0]
			?.text;
		expect(text).toContain("not connected");
	});

	test("callTool returns error when MCP call fails", async () => {
		await manager.connectAll({
			github: { command: "mcp-github" },
		});

		mockCallTool.mockRejectedValueOnce(new Error("Connection lost"));

		const result = await manager.callTool("github", "search", {
			query: "test",
		});
		expect(result.isError).toBe(true);
		const text = (result.content as Array<{ type: string; text: string }>)[0]
			?.text;
		expect(text).toContain("Connection lost");
	});

	test("connectAll handles server connection failures gracefully", async () => {
		mockConnect.mockRejectedValueOnce(new Error("spawn failed"));

		// Should not throw — logs error and continues
		await manager.connectAll({
			broken: { command: "nonexistent-server" },
		});

		// The failed server should not be in the map
		expect(manager.hasServers).toBe(false);
	});

	test("connectAll connects multiple servers", async () => {
		await manager.connectAll({
			github: { command: "mcp-github" },
			slack: { command: "mcp-slack" },
		});

		expect(manager.hasServers).toBe(true);
		expect(manager.serverNames).toContain("github");
		expect(manager.serverNames).toContain("slack");

		const defs = manager.getToolDefs();
		expect(Object.keys(defs)).toHaveLength(2);
	});

	test("disconnectAll closes all connections", async () => {
		await manager.connectAll({
			github: { command: "mcp-github" },
			slack: { command: "mcp-slack" },
		});

		await manager.disconnectAll();

		expect(mockClose).toHaveBeenCalledTimes(2);
		expect(manager.hasServers).toBe(false);
	});

	test("empty getToolDefs when no servers connected", () => {
		const defs = manager.getToolDefs();
		expect(Object.keys(defs)).toHaveLength(0);
	});
});
