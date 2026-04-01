import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadProjectLocalConfig,
	loadProjectRepoConfig,
	type MatrixConfig,
	resolveAuthGroup,
	resolveConfig,
	saveProjectLocalConfig,
} from "./config.ts";

describe("resolveConfig", () => {
	test("local > repo > global for scalar fields", () => {
		const global: MatrixConfig = {
			model: "global-model",
			budgetUsd: 10,
			maxDepth: 3,
		};
		const repo: MatrixConfig = {
			model: "repo-model",
			budgetUsd: 20,
		};
		const local: MatrixConfig = {
			model: "local-model",
		};

		const result = resolveConfig(global, repo, local);
		expect(result.model).toBe("local-model");
		expect(result.budgetUsd).toBe(20);
		expect(result.maxDepth).toBe(3);
	});

	test("empty layers are skipped", () => {
		const global: MatrixConfig = { model: "global-model" };
		const result = resolveConfig(global, {}, {});
		expect(result.model).toBe("global-model");
	});

	test("all empty returns empty config", () => {
		const result = resolveConfig({}, {}, {});
		expect(result).toEqual({});
	});

	test("mcpServers are merged (union), local overrides same-named", () => {
		const global: MatrixConfig = {
			mcpServers: {
				filesystem: { command: "mcp-fs", args: ["--read-only"] },
				search: { command: "mcp-search" },
			},
		};
		const repo: MatrixConfig = {
			mcpServers: {
				database: { command: "mcp-db" },
			},
		};
		const local: MatrixConfig = {
			mcpServers: {
				filesystem: {
					command: "mcp-fs-v2",
					args: ["--rw"],
					env: { HOME: "/tmp" },
				},
			},
		};

		const result = resolveConfig(global, repo, local);
		expect(result.mcpServers).toEqual({
			filesystem: {
				command: "mcp-fs-v2",
				args: ["--rw"],
				env: { HOME: "/tmp" },
			},
			search: { command: "mcp-search" },
			database: { command: "mcp-db" },
		});
	});

	test("authGroups are merged (union), local overrides same-named", () => {
		const global: MatrixConfig = {
			authGroups: {
				work: { provider: "anthropic", anthropicApiKey: "sk-work" },
				personal: { provider: "openai", openaiApiKey: "sk-personal" },
			},
		};
		const local: MatrixConfig = {
			authGroups: {
				work: {
					provider: "anthropic",
					anthropicApiKey: "sk-work-updated",
				},
			},
		};

		const result = resolveConfig(global, {}, local);
		expect(result.authGroups?.work?.anthropicApiKey).toBe("sk-work-updated");
		expect(result.authGroups?.personal?.provider).toBe("openai");
	});

	test("partial configs merge correctly across all layers", () => {
		const global: MatrixConfig = {
			maxDepth: 5,
			clarifyTimeoutMs: 30000,
		};
		const repo: MatrixConfig = {
			childModel: "sonnet",
			mcpServers: { git: { command: "mcp-git" } },
		};
		const local: MatrixConfig = {
			defaultAuth: "team",
			childAuth: "team",
		};

		const result = resolveConfig(global, repo, local);
		expect(result).toEqual({
			maxDepth: 5,
			clarifyTimeoutMs: 30000,
			childModel: "sonnet",
			defaultAuth: "team",
			childAuth: "team",
			mcpServers: { git: { command: "mcp-git" } },
		});
	});

	test("selfBootstrap boolean resolves with local > repo > global priority", () => {
		const global: MatrixConfig = { selfBootstrap: false };
		const repo: MatrixConfig = { selfBootstrap: true };
		const local: MatrixConfig = {};

		// repo wins over global when local is empty
		const result = resolveConfig(global, repo, local);
		expect(result.selfBootstrap).toBe(true);

		// local wins over repo
		const result2 = resolveConfig(global, repo, { selfBootstrap: false });
		expect(result2.selfBootstrap).toBe(false);
	});

	test("thinking config resolves with local > repo > global priority", () => {
		const global: MatrixConfig = { thinking: { budgetTokens: 5000 } };
		const repo: MatrixConfig = { thinking: { budgetTokens: 20000 } };
		const local: MatrixConfig = {};

		// repo wins over global when local is empty
		const result = resolveConfig(global, repo, local);
		expect(result.thinking).toEqual({ budgetTokens: 20000 });

		// local wins over repo
		const result2 = resolveConfig(global, repo, {
			thinking: { budgetTokens: 50000 },
		});
		expect(result2.thinking).toEqual({ budgetTokens: 50000 });

		// undefined when no layer specifies it
		const result3 = resolveConfig({}, {}, {});
		expect(result3.thinking).toBeUndefined();
	});
});

describe("resolveAuthGroup", () => {
	const config: MatrixConfig = {
		defaultAuth: "default-group",
		authGroups: {
			"default-group": {
				provider: "anthropic",
				anthropicApiKey: "sk-default",
			},
			"openai-group": {
				provider: "openai",
				openaiApiKey: "sk-openai",
				openaiBaseUrl: "https://api.openai.com/v1",
			},
		},
	};

	test("resolves by explicit name", () => {
		const group = resolveAuthGroup(config, "openai-group");
		expect(group).toEqual({
			provider: "openai",
			openaiApiKey: "sk-openai",
			openaiBaseUrl: "https://api.openai.com/v1",
		});
	});

	test("preserves OpenAI OAuth-style tokens", () => {
		const cfg: MatrixConfig = {
			authGroups: {
				openai: {
					provider: "openai",
					openaiAccessToken: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
					openaiRefreshToken: "refresh-token",
					openaiAccountId: "account_123",
				},
			},
		};
		expect(resolveAuthGroup(cfg, "openai")).toEqual({
			provider: "openai",
			openaiAccessToken: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
			openaiRefreshToken: "refresh-token",
			openaiAccountId: "account_123",
		});
	});

	test("resolves default when no name given", () => {
		const group = resolveAuthGroup(config);
		expect(group?.provider).toBe("anthropic");
		expect(group?.anthropicApiKey).toBe("sk-default");
	});

	test("returns null for nonexistent group", () => {
		expect(resolveAuthGroup(config, "nonexistent")).toBeNull();
	});

	test("returns null when no defaultAuth and no name", () => {
		expect(resolveAuthGroup({}, undefined)).toBeNull();
	});

	test("returns null when no authGroups defined", () => {
		const cfg: MatrixConfig = { defaultAuth: "missing" };
		expect(resolveAuthGroup(cfg)).toBeNull();
	});
});

describe("file loading", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "mxd-config-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("loadProjectRepoConfig reads from .mxd/config.json", async () => {
		const projectPath = join(tmpDir, "my-project");
		const configDir = join(projectPath, ".mxd");
		await mkdir(configDir, { recursive: true });
		const config: MatrixConfig = { model: "test-model" };
		await writeFile(join(configDir, "config.json"), JSON.stringify(config));

		const loaded = await loadProjectRepoConfig(projectPath);
		expect(loaded.model).toBe("test-model");
	});

	test("loadProjectRepoConfig returns empty for missing file", async () => {
		const loaded = await loadProjectRepoConfig(join(tmpDir, "nonexistent"));
		expect(loaded).toEqual({});
	});

	test("loadProjectLocalConfig reads from dataDir/projects/<id>/config.json", async () => {
		const projectId = "abc-123";
		const configDir = join(tmpDir, "projects", projectId);
		await mkdir(configDir, { recursive: true });
		const config: MatrixConfig = { budgetUsd: 42 };
		await writeFile(join(configDir, "config.json"), JSON.stringify(config));

		const loaded = await loadProjectLocalConfig(tmpDir, projectId);
		expect(loaded.budgetUsd).toBe(42);
	});

	test("loadProjectLocalConfig returns empty for missing file", async () => {
		const loaded = await loadProjectLocalConfig(tmpDir, "nonexistent-id");
		expect(loaded).toEqual({});
	});

	test("saveProjectLocalConfig creates directories and writes config", async () => {
		const projectId = "new-project";
		const config: MatrixConfig = {
			model: "claude-4",
			mcpServers: { test: { command: "test-cmd" } },
		};

		await saveProjectLocalConfig(tmpDir, projectId, config);
		const loaded = await loadProjectLocalConfig(tmpDir, projectId);
		expect(loaded.model).toBe("claude-4");
		expect(loaded.mcpServers?.test?.command).toBe("test-cmd");
	});
});
