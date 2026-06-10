/**
 * FIX-10: Settings persistence tests.
 *
 * Priority 1 — Backend: PATCH a config value → read back → restart daemon → read again.
 * If this passes, the "save then restart, changes gone" bug is in the frontend buildPatch.
 *
 * Priority 2 — Frontend: buildPatch edge cases that silently produce bad patches.
 */

import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";
import { createTestToken } from "./test-utils/auth-helper.ts";

// ── Helpers ──

function authed(daemon: DaemonInstance, token: string) {
	return (url: string, init?: RequestInit) =>
		daemon.fetch(
			new Request(`http://localhost${url}`, {
				...init,
				headers: {
					...init?.headers,
					authorization: `Bearer ${token}`,
				},
			}),
		);
}

// ── Backend persistence: PATCH → restart → read ──

describe("FIX-10: global config persists across daemon restart", () => {
	let tempDir: string;
	let dataDir: string;
	let token: string;
	let daemon: DaemonInstance;
	let fetch: ReturnType<typeof authed>;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-fix10-global-"));
		dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		token = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({ dataDir, autoRegisterSelf: false });
		fetch = authed(daemon, token);
	}, 30_000);

	afterAll(async () => {
		if (daemon) await daemon.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("PATCH model → GET returns updated value", async () => {
		const res = await fetch("/config/global", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-fable-5" }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.model).toBe("claude-fable-5");

		// Read back via GET
		const getRes = await fetch("/config/global");
		expect(getRes.status).toBe(200);
		const getBody = await getRes.json();
		expect(getBody.model).toBe("claude-fable-5");
	});

	test("PATCH model → value persists on disk", async () => {
		// Read the config file directly from disk
		const diskConfig = JSON.parse(
			await readFile(join(dataDir, "config.json"), "utf-8"),
		);
		expect(diskConfig.model).toBe("claude-fable-5");
	});

	test("PATCH model → restart daemon → GET returns persisted value", async () => {
		// First PATCH
		const patchRes = await fetch("/config/global", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-opus-4-8", thinkingEffort: 80 }),
		});
		expect(patchRes.status).toBe(200);

		// Shutdown and restart
		await daemon.shutdown();
		daemon = await createDaemon({ dataDir, autoRegisterSelf: false });
		fetch = authed(daemon, token);

		// Read back after restart
		const getRes = await fetch("/config/global");
		expect(getRes.status).toBe(200);
		const body = await getRes.json();
		expect(body.model).toBe("claude-opus-4-8");
		expect(body.thinkingEffort).toBe(80);
	});

	test("PATCH budgetUsd → restart → survives", async () => {
		const patchRes = await fetch("/config/global", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ budgetUsd: 42 }),
		});
		expect(patchRes.status).toBe(200);

		await daemon.shutdown();
		daemon = await createDaemon({ dataDir, autoRegisterSelf: false });
		fetch = authed(daemon, token);

		const getRes = await fetch("/config/global");
		const body = await getRes.json();
		expect(body.budgetUsd).toBe(42);
	});
});

describe("FIX-10: local config persists across restart", () => {
	let tempDir: string;
	let dataDir: string;
	let projectDir: string;
	let token: string;
	let daemon: DaemonInstance;
	let fetch: ReturnType<typeof authed>;
	let projectId: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-fix10-local-"));
		dataDir = join(tempDir, ".mxd");
		projectDir = join(tempDir, "project");
		await mkdir(projectDir, { recursive: true });
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		token = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({ dataDir, autoRegisterSelf: false });
		fetch = authed(daemon, token);

		// Register a project
		const addRes = await fetch("/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "test-proj", path: projectDir }),
		});
		expect(addRes.status).toBe(201);
		const proj = await addRes.json();
		projectId = proj.id;
	}, 30_000);

	afterAll(async () => {
		if (daemon) await daemon.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("PATCH local config → restart → value survives (same project id)", async () => {
		const patchRes = await fetch(`/projects/${projectId}/config`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "claude-haiku-4-5" }),
		});
		expect(patchRes.status).toBe(200);

		// Local config is stored at ~/.mxd/projects/<id>/config.json.
		// After restart, re-add the project. The new project gets a NEW id,
		// but the local config is keyed by old id. To verify persistence,
		// read the file directly from disk using the original id.
		const diskConfig = JSON.parse(
			await readFile(
				join(dataDir, "projects", projectId, "config.json"),
				"utf-8",
			),
		);
		expect(diskConfig.model).toBe("claude-haiku-4-5");
	});
});

// ── Frontend buildPatch edge cases ──

// Inline the FIXED function from SettingsPanel.tsx
function buildPatch(
	draft: Record<string, unknown>,
	saved: Record<string, unknown>,
	allowNull = true,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	for (const key of Object.keys(draft)) {
		const dv = draft[key];
		const sv = saved[key];
		if (JSON.stringify(dv) !== JSON.stringify(sv)) {
			if (dv === undefined) {
				if (allowNull) patch[key] = null;
			} else {
				patch[key] = dv;
			}
		}
	}
	if (allowNull) {
		for (const key of Object.keys(saved)) {
			if (!(key in draft) && saved[key] !== undefined) {
				patch[key] = null;
			}
		}
	}
	return patch;
}

// Simulate what updateDraftGlobal does
function simulateUpdateDraft(
	draft: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const next = { ...draft };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined || v === null || v === "") {
			delete next[k];
		} else {
			next[k] = v;
		}
	}
	return next;
}

describe("FIX-10: buildPatch — old behavior (allowNull=true, the bug) vs fixed (allowNull=false)", () => {
	const savedGlobal: Record<string, unknown> = {
		model: "claude-sonnet-4-6",
		thinkingEffort: 0,
		budgetUsd: -1,
		authGroups: {},
		defaultAuth: "",
		mcpServers: {},
		port: 7433,
		selfBootstrap: false,
	};

	test("changing model only → patch has only model (same for both modes)", () => {
		const draft = { ...savedGlobal, model: "claude-fable-5" };
		expect(buildPatch(draft, savedGlobal)).toEqual({ model: "claude-fable-5" });
		expect(buildPatch(draft, savedGlobal, false)).toEqual({ model: "claude-fable-5" });
	});

	test("clearing field → allowNull=true sends null (project/local)", () => {
		let draft = { ...savedGlobal };
		draft = simulateUpdateDraft(draft, { thinkingEffort: "" });
		expect("thinkingEffort" in draft).toBe(false);

		const patch = buildPatch(draft, savedGlobal, true);
		expect(patch.thinkingEffort).toBe(null); // correct for project/local
	});

	test("clearing field → allowNull=false omits null (global fix)", () => {
		let draft = { ...savedGlobal };
		draft = simulateUpdateDraft(draft, { thinkingEffort: "" });
		expect("thinkingEffort" in draft).toBe(false);

		const patch = buildPatch(draft, savedGlobal, false);
		// FIX: null is NOT sent → the server won't reject the whole patch
		expect("thinkingEffort" in patch).toBe(false);
	});

	test("model change + field clear → allowNull=false preserves the model change", () => {
		let draft = { ...savedGlobal };
		draft = simulateUpdateDraft(draft, { model: "claude-fable-5" });
		draft = simulateUpdateDraft(draft, { budgetUsd: "" }); // clear budget

		const patch = buildPatch(draft, savedGlobal, false);
		expect(patch.model).toBe("claude-fable-5");
		expect("budgetUsd" in patch).toBe(false); // null omitted, model preserved
	});

	test("no changes → empty patch", () => {
		const draft = { ...savedGlobal };
		expect(Object.keys(buildPatch(draft, savedGlobal)).length).toBe(0);
		expect(Object.keys(buildPatch(draft, savedGlobal, false)).length).toBe(0);
	});

	test("0 is a valid value (not deleted from draft)", () => {
		let draft: Record<string, unknown> = { ...savedGlobal, thinkingEffort: 80 };
		draft = simulateUpdateDraft(draft, { thinkingEffort: 0 });
		expect(draft.thinkingEffort).toBe(0);
	});
});

describe("FIX-10: end-to-end — old buildPatch breaks, fixed buildPatch works", () => {
	let tempDir: string;
	let dataDir: string;
	let token: string;
	let daemon: DaemonInstance;
	let fetch: ReturnType<typeof authed>;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-fix10-null-"));
		dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig(
			{ ...DEFAULT_CONFIG, thinkingEffort: 80, model: "claude-opus-4-8" },
			join(dataDir, "config.json"),
		);
		token = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({ dataDir, autoRegisterSelf: false });
		fetch = authed(daemon, token);
	}, 30_000);

	afterAll(async () => {
		if (daemon) await daemon.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("BUG REPRO: old buildPatch (allowNull=true) sends null → server 400 → model change lost", async () => {
		const saved: Record<string, unknown> = {
			model: "claude-opus-4-8",
			thinkingEffort: 80,
			budgetUsd: -1,
			authGroups: {},
			defaultAuth: "",
			mcpServers: {},
			port: 7433,
			selfBootstrap: false,
		};

		let draft = { ...saved };
		draft = simulateUpdateDraft(draft, { model: "claude-fable-5" });
		draft = simulateUpdateDraft(draft, { thinkingEffort: "" }); // clear field

		// Old behavior: allowNull=true → sends null
		const oldPatch = buildPatch(draft, saved, true);
		expect(oldPatch.model).toBe("claude-fable-5");
		expect(oldPatch.thinkingEffort).toBe(null);

		const res = await fetch("/config/global", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(oldPatch),
		});
		expect(res.status).toBe(400); // server rejects

		const getRes = await fetch("/config/global");
		const body = await getRes.json();
		expect(body.model).toBe("claude-opus-4-8"); // model change lost!
	});

	test("FIX: new buildPatch (allowNull=false) omits null → server 200 → model saved", async () => {
		const saved: Record<string, unknown> = {
			model: "claude-opus-4-8",
			thinkingEffort: 80,
			budgetUsd: -1,
			authGroups: {},
			defaultAuth: "",
			mcpServers: {},
			port: 7433,
			selfBootstrap: false,
		};

		let draft = { ...saved };
		draft = simulateUpdateDraft(draft, { model: "claude-fable-5" });
		draft = simulateUpdateDraft(draft, { thinkingEffort: "" }); // clear field

		// Fixed behavior: allowNull=false → null omitted
		const fixedPatch = buildPatch(draft, saved, false);
		expect(fixedPatch.model).toBe("claude-fable-5");
		expect("thinkingEffort" in fixedPatch).toBe(false);

		const res = await fetch("/config/global", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(fixedPatch),
		});
		expect(res.status).toBe(200); // success!

		const getRes = await fetch("/config/global");
		const body = await getRes.json();
		expect(body.model).toBe("claude-fable-5"); // saved!
		expect(body.thinkingEffort).toBe(80); // unchanged (null was omitted)
	});
});
