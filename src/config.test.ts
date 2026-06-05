import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG,
	loadGlobalConfig,
	loadProjectLocalConfig,
	loadProjectRepoConfig,
	type MatrixConfig,
	type ProjectConfig,
	resolveAuthGroup,
	resolveConfig,
	saveGlobalConfig,
	saveProjectLocalConfig,
} from "./config.ts";

describe("resolveConfig", () => {
	test("overlay overrides base for scalar fields", () => {
		const base = { ...DEFAULT_CONFIG, model: "global-model", budgetUsd: 10 };
		const repo: ProjectConfig = { model: "repo-model", budgetUsd: 20 };
		const local: ProjectConfig = { model: "local-model" };

		const result = resolveConfig(base, repo, local);
		expect(result.model).toBe("local-model");
		expect(result.budgetUsd).toBe(20);
	});

	test("empty overlays keep base values", () => {
		const base = { ...DEFAULT_CONFIG, model: "global-model" };
		const result = resolveConfig(base, {}, {});
		expect(result.model).toBe("global-model");
	});

	test("default config produces valid full config", () => {
		const result = resolveConfig(DEFAULT_CONFIG);
		expect(result).toEqual(DEFAULT_CONFIG);
	});

	test("mcpServers are merged (union), later overlays override same-named", () => {
		const base: MatrixConfig = {
			...DEFAULT_CONFIG,
			mcpServers: {
				filesystem: { command: "mcp-fs", args: ["--read-only"] },
				search: { command: "mcp-search" },
			},
		};
		const repo: ProjectConfig = {
			mcpServers: { database: { command: "mcp-db" } },
		};
		const local: ProjectConfig = {
			mcpServers: {
				filesystem: {
					command: "mcp-fs-v2",
					args: ["--rw"],
					env: { HOME: "/tmp" },
				},
			},
		};

		const result = resolveConfig(base, repo, local);
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

	test("authGroups are global-only (not overridable by project config)", () => {
		const base: MatrixConfig = {
			...DEFAULT_CONFIG,
			authGroups: {
				work: { provider: "anthropic", apiKey: "sk-work" },
				personal: { provider: "openai", apiKey: "sk-personal" },
			},
		};

		// Project overlays can't have authGroups — they pass through from base
		const result = resolveConfig(base, { model: "test" });
		expect(result.authGroups.work?.provider).toBe("anthropic");
		expect(result.authGroups.personal?.provider).toBe("openai");
	});

	test("partial overlays merge correctly across all layers", () => {
		const base: MatrixConfig = {
			...DEFAULT_CONFIG,
		};
		const repo: ProjectConfig = {
			childModel: "sonnet",
			mcpServers: { git: { command: "mcp-git" } },
		};
		const local: ProjectConfig = {
			defaultAuth: "team",
			childAuth: "team",
		};

		const result = resolveConfig(base, repo, local);
		expect(result.childModel).toBe("sonnet");
		expect(result.defaultAuth).toBe("team");
		expect(result.childAuth).toBe("team");
		expect(result.mcpServers).toEqual({ git: { command: "mcp-git" } });
	});

	test("selfBootstrap boolean resolves with later overlay winning", () => {
		const base = { ...DEFAULT_CONFIG, selfBootstrap: false };
		const repo: ProjectConfig = { selfBootstrap: true };

		// repo wins over base
		const result = resolveConfig(base, repo);
		expect(result.selfBootstrap).toBe(true);

		// local wins over repo
		const result2 = resolveConfig(base, repo, { selfBootstrap: false });
		expect(result2.selfBootstrap).toBe(false);
	});

	test("thinkingEffort resolves with later overlay winning", () => {
		const base = { ...DEFAULT_CONFIG, thinkingEffort: 50 };
		const repo: ProjectConfig = { thinkingEffort: 75 };

		const result = resolveConfig(base, repo);
		expect(result.thinkingEffort).toBe(75);

		const result2 = resolveConfig(base, repo, { thinkingEffort: 100 });
		expect(result2.thinkingEffort).toBe(100);

		// 0 = disabled
		const result3 = resolveConfig(base, { thinkingEffort: 0 });
		expect(result3.thinkingEffort).toBe(0);
	});

	test("cacheTtl shallow merges correctly", () => {
		const base = {
			...DEFAULT_CONFIG,
			cacheTtl: { root: "1h" as const, child: "1h" as const },
		};
		const result = resolveConfig(base);
		expect(result.cacheTtl).toEqual({ root: "1h", child: "1h" });

		// local overrides
		const local: ProjectConfig = {
			cacheTtl: { root: "5m", child: "5m" },
		};
		const result2 = resolveConfig(base, {}, local);
		expect(result2.cacheTtl).toEqual({ root: "5m", child: "5m" });

		// partial cacheTtl overlay merges with base
		const partial: ProjectConfig = {
			cacheTtl: { root: "1h", child: "5m" },
		};
		const result3 = resolveConfig(base, partial);
		expect(result3.cacheTtl).toEqual({ root: "1h", child: "5m" });
	});

	test("childAuth 'parent' is a valid value", () => {
		const base = { ...DEFAULT_CONFIG, childAuth: "parent" as const };
		const result = resolveConfig(base);
		expect(result.childAuth).toBe("parent");

		// Override with specific auth group
		const result2 = resolveConfig(base, { childAuth: "team-auth" });
		expect(result2.childAuth).toBe("team-auth");
	});

	test("budgetUsd -1 means unlimited", () => {
		const result = resolveConfig(DEFAULT_CONFIG);
		expect(result.budgetUsd).toBe(-1);

		const result2 = resolveConfig(DEFAULT_CONFIG, { budgetUsd: 50 });
		expect(result2.budgetUsd).toBe(50);
	});
});

describe("resolveAuthGroup", () => {
	const config: MatrixConfig = {
		...DEFAULT_CONFIG,
		defaultAuth: "default-group",
		authGroups: {
			"default-group": {
				provider: "anthropic",
				apiKey: "sk-default",
			},
			"openai-group": {
				provider: "openai",
				apiKey: "sk-openai",
				baseUrl: "https://api.openai.com/v1",
			},
		},
	};

	test("resolves by explicit name", () => {
		const group = resolveAuthGroup(config, "openai-group");
		expect(group).toEqual({
			provider: "openai",
			apiKey: "sk-openai",
			baseUrl: "https://api.openai.com/v1",
		});
	});

	test("preserves OpenAI OAuth-style tokens", () => {
		const cfg: MatrixConfig = {
			...DEFAULT_CONFIG,
			authGroups: {
				openai: {
					provider: "openai",
					accessToken: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
					refreshToken: "refresh-token",
					accountId: "account_123",
				},
			},
		};
		expect(resolveAuthGroup(cfg, "openai")).toEqual({
			provider: "openai",
			accessToken: "eyJhbGciOiJIUzI1NiJ9.payload.sig",
			refreshToken: "refresh-token",
			accountId: "account_123",
		});
	});

	test("resolves default when no name given", () => {
		const group = resolveAuthGroup(config);
		expect(group?.provider).toBe("anthropic");
		if (group?.provider === "anthropic") {
			expect(group.apiKey).toBe("sk-default");
		}
	});

	test("returns null for nonexistent group", () => {
		expect(resolveAuthGroup(config, "nonexistent")).toBeNull();
	});

	test("returns null when no defaultAuth and no name", () => {
		expect(
			resolveAuthGroup({ ...DEFAULT_CONFIG, defaultAuth: "" }, undefined),
		).toBeNull();
	});

	test("returns null when authGroup missing from groups", () => {
		const cfg: MatrixConfig = {
			...DEFAULT_CONFIG,
			defaultAuth: "missing",
		};
		expect(resolveAuthGroup(cfg)).toBeNull();
	});

	test("anthropic auth group includes systemPreamble", () => {
		const cfg: MatrixConfig = {
			...DEFAULT_CONFIG,
			authGroups: {
				claude: {
					provider: "anthropic",
					oauthToken: "tok",
					systemPreamble: "You are a test agent.",
				},
			},
		};
		const group = resolveAuthGroup(cfg, "claude");
		expect(group?.provider).toBe("anthropic");
		if (group?.provider === "anthropic") {
			expect(group.systemPreamble).toBe("You are a test agent.");
		}
	});

	test("systemPreamble undefined when not set", () => {
		const cfg: MatrixConfig = {
			...DEFAULT_CONFIG,
			authGroups: {
				claude: { provider: "anthropic", apiKey: "sk-test" },
			},
		};
		const group = resolveAuthGroup(cfg, "claude");
		if (group?.provider === "anthropic") {
			expect(group.systemPreamble).toBeUndefined();
		}
	});

	test("systemPreamble not available on openai auth group", () => {
		const cfg: MatrixConfig = {
			...DEFAULT_CONFIG,
			authGroups: {
				openai: { provider: "openai", apiKey: "sk-test" },
			},
		};
		const group = resolveAuthGroup(cfg, "openai");
		expect(group?.provider).toBe("openai");
		expect("systemPreamble" in (group ?? {})).toBe(false);
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
		const config: ProjectConfig = { model: "test-model" };
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
		const config: ProjectConfig = { budgetUsd: 42 };
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
		const config: ProjectConfig = {
			model: "claude-4",
			mcpServers: { test: { command: "test-cmd" } },
		};

		await saveProjectLocalConfig(tmpDir, projectId, config);
		const loaded = await loadProjectLocalConfig(tmpDir, projectId);
		expect(loaded.model).toBe("claude-4");
		expect(loaded.mcpServers?.test?.command).toBe("test-cmd");
	});
});

// ── loadGlobalConfig: distinguish "fresh install" from "corrupt config" ──
// (cc#4 defense-in-depth) A missing file is a fresh install → defaults. But a
// file that exists yet is corrupt/incomplete must throw — silently returning
// defaults would let the next save overwrite real credentials with nothing.

describe("loadGlobalConfig", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "mxd-gconfig-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("missing file → returns DEFAULT_CONFIG (fresh install)", async () => {
		const loaded = await loadGlobalConfig(join(tmpDir, "config.json"));
		expect(loaded).toEqual(DEFAULT_CONFIG);
	});

	test("complete config → loaded as-is", async () => {
		const path = join(tmpDir, "config.json");
		await saveGlobalConfig({ ...DEFAULT_CONFIG, model: "custom-model" }, path);
		const loaded = await loadGlobalConfig(path);
		expect(loaded.model).toBe("custom-model");
	});

	test("config missing a required field → throws (does NOT return defaults)", async () => {
		const path = join(tmpDir, "config.json");
		// Has credentials but is missing required fields (e.g. `model`).
		await writeFile(
			path,
			JSON.stringify({
				authGroups: {
					main: { provider: "anthropic", apiKey: "sk-secret-123" },
				},
			}),
		);
		await expect(loadGlobalConfig(path)).rejects.toThrow(
			/missing required fields/i,
		);
	});

	test("corrupt JSON → throws (does NOT silently return defaults)", async () => {
		const path = join(tmpDir, "config.json");
		await writeFile(path, "{ this is not valid json ");
		await expect(loadGlobalConfig(path)).rejects.toThrow(/not valid JSON/i);
	});
});
