import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	configFieldRefusal,
	DEFAULT_CONFIG,
	GLOBAL_ONLY_FIELDS,
	type LocalConfig,
	loadGlobalConfig,
	loadProjectLocalConfig,
	loadProjectRepoConfig,
	type MatrixConfig,
	type RepoConfig,
	resolveAuthGroup,
	resolveConfig,
	saveGlobalConfig,
	saveProjectLocalConfig,
	saveProjectRepoConfig,
} from "./config.ts";

describe("resolveConfig", () => {
	test("overlay overrides base for scalar fields", () => {
		const base = { ...DEFAULT_CONFIG, model: "global-model", budgetUsd: 10 };
		const repo: RepoConfig = { budgetUsd: 20 };
		const local: LocalConfig = { model: "local-model" };

		const result = resolveConfig(base, repo, local);
		expect(result.model).toBe("local-model");
		expect(result.budgetUsd).toBe(20);
	});

	test("the later layer wins where both may set the field", () => {
		const base = { ...DEFAULT_CONFIG, budgetUsd: 10 };
		expect(
			resolveConfig(base, { budgetUsd: 20 }, { budgetUsd: 30 }).budgetUsd,
		).toBe(30);
		// Absent in the later layer = inherit, so repo's value survives.
		expect(resolveConfig(base, { budgetUsd: 20 }, {}).budgetUsd).toBe(20);
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
		const repo: RepoConfig = {
			mcpServers: { database: { command: "mcp-db" } },
		};
		const local: LocalConfig = {
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

	test("authGroups pass through from global — no project layer has the field", () => {
		const base: MatrixConfig = {
			...DEFAULT_CONFIG,
			authGroups: {
				work: { provider: "anthropic", apiKey: "sk-work" },
				personal: { provider: "openai", apiKey: "sk-personal" },
			},
		};

		const result = resolveConfig(
			base,
			{ budgetUsd: 5 },
			{ defaultAuth: "personal" },
		);
		expect(result.authGroups.work?.provider).toBe("anthropic");
		expect(result.authGroups.personal?.provider).toBe("openai");
		// ⚠️ Read that as a claim about the TYPES and nothing more. `resolveConfig`
		// spreads the keys an object REALLY has, so an `authGroups` that got past
		// the loaders would replace the whole table — it is not in the shallow-merge
		// set. What makes it unreachable is the projection at the read boundary,
		// measured against a real file under "layer field sets" below. This test
		// cannot see that difference and must not be read as covering it.
	});

	test("partial overlays merge correctly across all layers", () => {
		const base: MatrixConfig = {
			...DEFAULT_CONFIG,
		};
		const repo: RepoConfig = {
			mcpServers: { git: { command: "mcp-git" } },
		};
		const local: LocalConfig = {
			defaultAuth: "team",
		};

		const result = resolveConfig(base, repo, local);
		expect(result.defaultAuth).toBe("team");
		expect(result.mcpServers).toEqual({ git: { command: "mcp-git" } });
	});

	test("selfBootstrap boolean resolves with later overlay winning", () => {
		const base = { ...DEFAULT_CONFIG, selfBootstrap: false };
		const repo: RepoConfig = { selfBootstrap: true };

		// repo wins over base
		const result = resolveConfig(base, repo);
		expect(result.selfBootstrap).toBe(true);

		// local wins over repo
		const result2 = resolveConfig(base, repo, { selfBootstrap: false });
		expect(result2.selfBootstrap).toBe(false);
	});

	test("thinkingEffort resolves with later overlay winning", () => {
		const base = { ...DEFAULT_CONFIG, thinkingEffort: 50 };
		const repo: RepoConfig = { thinkingEffort: 75 };

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
		const local: LocalConfig = {
			cacheTtl: { root: "5m", child: "5m" },
		};
		const result2 = resolveConfig(base, {}, local);
		expect(result2.cacheTtl).toEqual({ root: "5m", child: "5m" });

		// partial cacheTtl overlay merges with base
		const partial: RepoConfig = {
			cacheTtl: { root: "1h", child: "5m" },
		};
		const result3 = resolveConfig(base, partial);
		expect(result3.cacheTtl).toEqual({ root: "1h", child: "5m" });
	});

	test("budgetUsd -1 means unlimited", () => {
		const result = resolveConfig(DEFAULT_CONFIG);
		expect(result.budgetUsd).toBe(-1);

		const result2 = resolveConfig(DEFAULT_CONFIG, { budgetUsd: 50 });
		expect(result2.budgetUsd).toBe(50);
	});

	// `DEFAULT_CONFIG.model` is "" since there is no default model any more. The
	// worry that motivated these two: the overlay rule is `value !== undefined`,
	// so "" IS an overriding value — could a fresh install's empty model clobber a
	// project's choice? Measured, not assumed: no, because at all three
	// production call sites (daemon.ts, runtime/helpers.ts, cli.ts) the global
	// layer is the BASE and only repo/local are overlays. The empty string cannot
	// travel upward. Pinning the direction so a call site that passes the global
	// config as an overlay reddens here.
	test("an empty base model is overridden by a project layer, not the reverse", () => {
		expect(DEFAULT_CONFIG.model).toBe("");

		const fresh = resolveConfig(
			DEFAULT_CONFIG,
			{},
			{ model: "claude-sonnet-4-6" },
		);
		expect(fresh.model).toBe("claude-sonnet-4-6");

		// The local layer is the only project layer with a `model` field at all —
		// the repo layer has none, so there is no repo-over-local case to test.
		expect(
			resolveConfig(DEFAULT_CONFIG, {}, { model: "local-model" }).model,
		).toBe("local-model");
	});

	test('a local overlay carrying model "" DOES override — a visible empty, not a silent substitute', () => {
		// `""` overrides because the overlay rule is `value !== undefined`.
		// ⚠️ CORRECTION to what this test used to say: it named a hand-written
		// `.mxd/config.json` as the way in. That is the REPO layer, which no longer
		// has a `model` field — the file can carry the key and the loader drops it.
		// The reachable route is the LOCAL file (`<dataDir>/projects/<id>/config.json`),
		// which is per-machine and trusted. Recorded as the mechanism it is rather
		// than endorsed: with the model fallbacks deleted the consequence is an
		// empty model name reaching the API — a failure the user can see and
		// attribute — where it used to be a silent switch to DEFAULT_MODEL.
		const base = { ...DEFAULT_CONFIG, model: "claude-sonnet-4-6" };
		expect(resolveConfig(base, {}, { model: "" }).model).toBe("");
		// undefined is the "not set" signal, and it does NOT override.
		expect(resolveConfig(base, {}, { model: undefined }).model).toBe(
			"claude-sonnet-4-6",
		);
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

	test("anthropic auth group includes baseUrl", () => {
		const cfg: MatrixConfig = {
			...DEFAULT_CONFIG,
			authGroups: {
				claude: {
					provider: "anthropic",
					apiKey: "sk-test",
					baseUrl: "https://proxy.example.com",
				},
			},
		};
		const group = resolveAuthGroup(cfg, "claude");
		expect(group?.provider).toBe("anthropic");
		if (group?.provider === "anthropic") {
			expect(group.baseUrl).toBe("https://proxy.example.com");
		}
	});

	test("baseUrl undefined when not set", () => {
		const cfg: MatrixConfig = {
			...DEFAULT_CONFIG,
			authGroups: {
				claude: { provider: "anthropic", apiKey: "sk-test" },
			},
		};
		const group = resolveAuthGroup(cfg, "claude");
		if (group?.provider === "anthropic") {
			expect(group.baseUrl).toBeUndefined();
		}
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
		const config: RepoConfig = { budgetUsd: 7 };
		await writeFile(join(configDir, "config.json"), JSON.stringify(config));

		const loaded = await loadProjectRepoConfig(projectPath);
		expect(loaded.budgetUsd).toBe(7);
	});

	test("loadProjectRepoConfig returns empty for missing file", async () => {
		const loaded = await loadProjectRepoConfig(join(tmpDir, "nonexistent"));
		expect(loaded).toEqual({});
	});

	test("loadProjectLocalConfig reads from dataDir/projects/<id>/config.json", async () => {
		const projectId = "abc-123";
		const configDir = join(tmpDir, "projects", projectId);
		await mkdir(configDir, { recursive: true });
		const config: LocalConfig = { budgetUsd: 42 };
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
		const config: LocalConfig = {
			model: "claude-4",
			mcpServers: { test: { command: "test-cmd" } },
		};

		await saveProjectLocalConfig(tmpDir, projectId, config);
		const loaded = await loadProjectLocalConfig(tmpDir, projectId);
		expect(loaded.model).toBe("claude-4");
		expect(loaded.mcpServers?.test?.command).toBe("test-cmd");
	});
});

// ── Layer field sets ──
//
// The repo layer is `<projectPath>/.mxd/config.json`: git-tracked, so it ARRIVES
// WITH A CLONE. There is no write moment to guard on that route, which is why
// the field set is enforced where the bytes are read. These tests are the
// measured version of that: they write files by hand — the only thing a clone
// does — and ask what survives.
//
// ⚠️ Both directions are asserted deliberately. A projection that dropped
// everything would pass every "the untrusted field is gone" test, so each of
// those has a sibling asserting the layer's own fields still arrive.

describe("layer field sets", () => {
	let tmpDir: string;
	let projectPath: string;
	const projectId = "proj-1";

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "mxd-layer-test-"));
		projectPath = join(tmpDir, "repo");
		await mkdir(join(projectPath, ".mxd"), { recursive: true });
		await mkdir(join(tmpDir, "projects", projectId), { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	async function writeRepoFile(raw: Record<string, unknown>): Promise<void> {
		await writeFile(
			join(projectPath, ".mxd", "config.json"),
			JSON.stringify(raw),
		);
	}

	async function writeLocalFile(raw: Record<string, unknown>): Promise<void> {
		await writeFile(
			join(tmpDir, "projects", projectId, "config.json"),
			JSON.stringify(raw),
		);
	}

	test("a cloned repo config cannot choose the model, the auth group or the credentials", async () => {
		// This is the whole task, as a file. Every field below is one the repo
		// author would otherwise have picked for every agent run the user makes.
		await writeRepoFile({
			model: "claude-opus-5",
			defaultAuth: "my-expensive",
			authGroups: {
				"my-cheap": { provider: "anthropic", apiKey: "sk-THEIRS" },
			},
		});
		const mine: MatrixConfig = {
			...DEFAULT_CONFIG,
			model: "claude-sonnet-4-6",
			defaultAuth: "my-cheap",
			authGroups: {
				"my-cheap": { provider: "anthropic", oauthToken: "tok-MINE" },
				"my-expensive": { provider: "anthropic", apiKey: "sk-MINE" },
			},
		};

		const repo = await loadProjectRepoConfig(projectPath);
		expect(repo).toEqual({});

		const resolved = resolveConfig(mine, repo, {});
		expect(resolved.model).toBe("claude-sonnet-4-6");
		expect(resolved.defaultAuth).toBe("my-cheap");
		// ⭐ The one that matters most: `authGroups` is not in resolveConfig's
		// shallow-merge set, so a surviving repo `authGroups` would have replaced
		// the WHOLE table — the user's own group name pointing at someone else's
		// endpoint, and `maskConfig` showing it as asterisks.
		const cheap = resolved.authGroups["my-cheap"];
		expect(cheap?.provider).toBe("anthropic");
		expect(cheap && "oauthToken" in cheap ? cheap.oauthToken : null).toBe(
			"tok-MINE",
		);
		expect(JSON.stringify(resolved)).not.toContain("THEIRS");
	});

	test("the repo layer keeps every field it does have", async () => {
		// The positive control for the test above: a projection that returned `{}`
		// unconditionally would pass it and fail here.
		await writeRepoFile({
			budgetUsd: 25,
			selfBootstrap: true,
			thinkingEffort: 40,
			mcpServers: { git: { command: "mcp-git" } },
			cacheTtl: { root: "5m", child: "5m" },
		});
		expect(await loadProjectRepoConfig(projectPath)).toEqual({
			budgetUsd: 25,
			selfBootstrap: true,
			thinkingEffort: 40,
			mcpServers: { git: { command: "mcp-git" } },
			cacheTtl: { root: "5m", child: "5m" },
		});
	});

	test("the local layer keeps model and defaultAuth — it never enters a repo", async () => {
		await writeLocalFile({
			model: "claude-opus-5",
			defaultAuth: "work",
			budgetUsd: 3,
		});
		expect(await loadProjectLocalConfig(tmpDir, projectId)).toEqual({
			model: "claude-opus-5",
			defaultAuth: "work",
			budgetUsd: 3,
		});
	});

	test("neither project layer can carry authGroups or port", async () => {
		const globalOnly = {
			authGroups: { evil: { provider: "openai", apiKey: "sk-THEIRS" } },
			port: 9999,
		};
		await writeRepoFile({ ...globalOnly, budgetUsd: 1 });
		await writeLocalFile({ ...globalOnly, budgetUsd: 2 });
		expect(await loadProjectRepoConfig(projectPath)).toEqual({ budgetUsd: 1 });
		expect(await loadProjectLocalConfig(tmpDir, projectId)).toEqual({
			budgetUsd: 2,
		});
	});

	test("a key that is not a config field at all is dropped too", async () => {
		// A typo'd key used to sit in the file doing nothing, forever, in silence.
		await writeRepoFile({ modle: "claude-opus-5", budgetUsd: 4 });
		expect(await loadProjectRepoConfig(projectPath)).toEqual({ budgetUsd: 4 });
	});

	test("a prototype-chain name in the file reaches neither the result nor its prototype", async () => {
		// `JSON.parse` gives `__proto__` as an OWN key, and assigning it onto a
		// fresh object runs the setter. The field-set lookup is what stops it, and
		// it only stops it because it asks `Object.hasOwn` — a bare lookup answers
		// `CONFIG_FIELD_LAYERS["__proto__"]` with `Object.prototype`, which is
		// truthy, and lands on the wrong branch by accident rather than on the
		// right one by construction.
		await writeFile(
			join(projectPath, ".mxd", "config.json"),
			'{"__proto__":{"polluted":true},"constructor":1,"budgetUsd":6}',
		);
		const loaded = await loadProjectRepoConfig(projectPath);
		expect(loaded).toEqual({ budgetUsd: 6 });
		expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype);
		expect((loaded as Record<string, unknown>).polluted).toBeUndefined();
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	test("dropping a key is REPORTED, not silent", async () => {
		// Without this, the only difference between "ignored" and "took effect" is
		// invisible to whoever hand-wrote the field.
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			await writeRepoFile({ model: "claude-opus-5" });
			await loadProjectRepoConfig(projectPath);
		} finally {
			console.warn = original;
		}
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("model");
		expect(warnings[0]).toContain(join(projectPath, ".mxd", "config.json"));
		// The reason travels with the report — the same sentence the write doors
		// answer with.
		expect(warnings[0]).toContain("git-tracked");
	});

	test("a repo write normalizes the file to the layer's field set", async () => {
		// Consequence worth stating rather than discovering: the loader strips and
		// the saver writes what it was given, so the next repo-config write removes
		// a stale `model` from a git-tracked file. That is the intended direction —
		// the key was doing nothing — and it shows up as an ordinary diff.
		await writeRepoFile({ model: "claude-opus-5", budgetUsd: 8 });
		const loaded = await loadProjectRepoConfig(projectPath);
		await saveProjectRepoConfig(projectPath, { ...loaded, budgetUsd: 9 });
		const onDisk = JSON.parse(
			await readFile(join(projectPath, ".mxd", "config.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(onDisk).toEqual({ budgetUsd: 9 });
	});
});

describe("configFieldRefusal", () => {
	test("a field the layer has is not refused", () => {
		expect(configFieldRefusal("repo", "budgetUsd")).toBeNull();
		expect(configFieldRefusal("local", "budgetUsd")).toBeNull();
		expect(configFieldRefusal("local", "model")).toBeNull();
		expect(configFieldRefusal("local", "defaultAuth")).toBeNull();
	});

	test("the repo refusal names TRUST, not scope", () => {
		// The distinction the whole boundary rests on: `model` and `defaultAuth`
		// ARE settable per project — just not from the layer that arrives with a
		// clone. A "global only" wording would send the user to the wrong place.
		for (const key of ["model", "defaultAuth"]) {
			const refusal = configFieldRefusal("repo", key);
			expect(refusal).toContain(key);
			expect(refusal).toContain("git-tracked");
			expect(refusal).not.toContain("only be set in global");
		}
	});

	test("a global-only field is refused on both layers, as global-only", () => {
		for (const layer of ["repo", "local"] as const) {
			for (const key of GLOBAL_ONLY_FIELDS) {
				expect(configFieldRefusal(layer, key)).toContain(
					"only be set in global config",
				);
			}
		}
	});

	test("a non-field is refused as a non-field", () => {
		expect(configFieldRefusal("repo", "modle")).toContain("not a config field");
		expect(configFieldRefusal("local", "__proto__")).toContain(
			"not a config field",
		);
	});

	test("every MatrixConfig field is classified, and global-only is derived", () => {
		// The `satisfies Record<keyof MatrixConfig, …>` on the table catches an
		// unclassified field at compile time; this catches it if that constraint is
		// ever loosened, and states the partition in one readable place.
		const fields = Object.keys(DEFAULT_CONFIG);
		const repoOk = fields.filter((k) => configFieldRefusal("repo", k) === null);
		const localOk = fields.filter(
			(k) => configFieldRefusal("local", k) === null,
		);
		for (const key of fields) {
			expect(configFieldRefusal("repo", key) ?? "").not.toContain(
				"not a config field",
			);
		}
		expect(new Set<string>(GLOBAL_ONLY_FIELDS)).toEqual(
			new Set(
				fields.filter((k) => !repoOk.includes(k) && !localOk.includes(k)),
			),
		);
		// Repo ⊆ local: the repo layer is the narrower of the two, always.
		expect(repoOk.filter((k) => !localOk.includes(k))).toEqual([]);
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
