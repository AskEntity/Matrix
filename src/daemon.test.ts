/**
 * Test: daemon pipeline — createDaemon discovers plugins, starts workers, proxies requests.
 *
 * After Audit R7 P1.3 auth is always on. Tests mint a session token at
 * setup and attach it via `authedFetch`. Routes on SKIP_EXACT (/, /auth/status,
 * /vendor, /app) continue to work anonymously; everything else returns 401
 * without a token.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";
import { createTestToken } from "./test-utils/auth-helper.ts";

/** Make a fetch helper that injects a Bearer header on every request. */
function authed(daemon: DaemonInstance, token: string) {
	return (req: Request) => {
		const headers = new Headers(req.headers);
		if (!headers.has("authorization")) {
			headers.set("Authorization", `Bearer ${token}`);
		}
		const next = new Request(req.url, {
			method: req.method,
			headers,
			body:
				req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
		});
		return daemon.fetch(next);
	};
}

describe("daemon without plugins — bare daemon invariant", () => {
	// Invariant: delete .mxd/plugin/ entirely → daemon still starts.
	// Shell shows auth + selector, scope is empty, content shows "no plugin".
	let tempDir: string;
	let dataDir: string;
	let daemon: DaemonInstance;
	let fetch: (req: Request) => Promise<Response>;
	let token: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "daemon-bare-test-"));
		dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		// Mint token BEFORE createDaemon so secretVersion matches.
		token = await createTestToken(join(dataDir, "auth.json"));

		// No projects → no plugin directories → pure bare daemon
		daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
		});
		fetch = authed(daemon, token);
	});

	afterAll(async () => {
		await daemon.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("GET /health → 200 (daemon-owned, not worker-forwarded)", async () => {
		const res = await fetch(new Request("http://localhost/health"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	test("GET /plugins → 200, empty array", async () => {
		const res = await fetch(new Request("http://localhost/plugins"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([]);
	});

	test("GET /auth/status (anonymous) → 200, authenticated:false, enabled:true (Audit R7 P1.3)", async () => {
		// /auth/status is on SKIP_EXACT so the login page can render.
		// Post-P1.3 `enabled` is always true (auth is always on); the field
		// stays for backward compat with older browser bundles.
		const res = await daemon.fetch(new Request("http://localhost/auth/status"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.authenticated).toBe(false);
		expect(body.enabled).toBe(true);
	});

	test("GET /auth/status (with valid token) → authenticated:true", async () => {
		const res = await fetch(new Request("http://localhost/auth/status"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.authenticated).toBe(true);
	});

	test("GET /projects → 200, empty array", async () => {
		const res = await fetch(new Request("http://localhost/projects"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([]);
	});

	test("unhandled bare routes return 404 (no catch-all forwarding)", async () => {
		// With the `/api/<plugin>/*` namespace, unprefixed routes that don't
		// match a daemon handler are 404s — they no longer silently fall
		// through to "whatever global worker happens to be first".
		const res = await fetch(new Request("http://localhost/some/worker/route"));
		expect(res.status).toBe(404);
	});

	test("unknown plugin namespace returns 404", async () => {
		const res = await fetch(
			new Request("http://localhost/api/does-not-exist/anything"),
		);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toContain("does-not-exist");
	});

	test("/version returns 503 when no global worker is running", async () => {
		const res = await fetch(new Request("http://localhost/version"));
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.error).toContain("No global plugin worker");
	});
});

describe("daemon pipeline (legacy)", () => {
	let tempDir: string;
	let dataDir: string;
	let daemon: DaemonInstance;
	let fetch: (req: Request) => Promise<Response>;
	let token: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "daemon-pipeline-test-"));
		dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		token = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
		});
		fetch = authed(daemon, token);
	});

	afterAll(async () => {
		await daemon.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("auth/status (anonymous) → 200, enabled:true (Audit R7 P1.3)", async () => {
		const res = await daemon.fetch(new Request("http://localhost/auth/status"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.enabled).toBe(true);
		expect(body.authenticated).toBe(false);
	});

	test("/plugins returns registered plugins", async () => {
		const res = await fetch(new Request("http://localhost/plugins"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
		// No projects registered in temp dir → no plugins discovered
	});

	test("global config CRUD", async () => {
		// GET
		const getRes = await fetch(new Request("http://localhost/config/global"));
		expect(getRes.status).toBe(200);
		const config = await getRes.json();
		expect(config.budgetUsd).toBe(-1);

		// PATCH
		const patchRes = await fetch(
			new Request("http://localhost/config/global", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ budgetUsd: 50 }),
			}),
		);
		expect(patchRes.status).toBe(200);
		const updated = await patchRes.json();
		expect(updated.budgetUsd).toBe(50);
	});

	test("PATCH /config/global rejects null-delete of required fields (cc#4)", async () => {
		// Seed an auth group so we can prove credentials survive the rejected PATCH.
		const seed = await fetch(
			new Request("http://localhost/config/global", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					authGroups: {
						main: { provider: "anthropic", apiKey: "sk-secret-xyz" },
					},
					defaultAuth: "main",
				}),
			}),
		);
		expect(seed.status).toBe(200);

		// Attempt to delete a required field by sending null — must be rejected.
		// (Pre-fix this wrote an incomplete config that wiped ALL credentials on
		// the next restart.)
		const res = await fetch(
			new Request("http://localhost/config/global", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: null }),
			}),
		);
		expect(res.status).toBe(400);
		const err = (await res.json()) as { error: string };
		expect(err.error).toContain("model");

		// Config is untouched: model still present, credentials preserved.
		const getRes = await fetch(new Request("http://localhost/config/global"));
		const cfg = (await getRes.json()) as {
			model: string;
			authGroups: Record<string, unknown>;
		};
		expect(cfg.model).toBeTruthy();
		expect(cfg.authGroups.main).toBeDefined();
	});

	test("POST /projects handled by daemon (not forwarded to worker)", async () => {
		const res = await fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: "relative-path" }),
			}),
		);
		// Daemon handles project CRUD directly — returns 409 (relative path rejected by pm.init)
		expect(res.status).toBe(409);
	});
});

describe("daemon with matrix plugin", () => {
	let tempDir: string;
	let dataDir: string;
	let projectPath: string;
	let daemon: DaemonInstance;
	let fetch: (req: Request) => Promise<Response>;
	let token: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "daemon-matrix-test-"));
		dataDir = join(tempDir, ".mxd");
		projectPath = join(tempDir, "test-project");

		// Create a project with a matrix-like plugin
		await mkdir(join(projectPath, ".mxd", "plugin"), { recursive: true });
		await writeFile(
			join(projectPath, ".mxd", "plugin", "index.ts"),
			`export default { name: "test-matrix", scope: "global" };`,
			"utf-8",
		);

		// Register the project in daemon's project manager
		await mkdir(join(dataDir, "projects"), { recursive: true });
		const projectId = "test-project-id";
		const projectsMeta = [
			{
				id: projectId,
				name: "test-project",
				path: projectPath,
				createdAt: new Date().toISOString(),
			},
		];
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify(projectsMeta),
			"utf-8",
		);

		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		token = await createTestToken(join(dataDir, "auth.json"));
		daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
		});
		fetch = authed(daemon, token);
	});

	afterAll(async () => {
		await daemon.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("discovers plugin from registered project", async () => {
		expect(daemon.plugins.length).toBe(1);
		expect(daemon.plugins[0]?.name).toBe("test-matrix");
		expect(daemon.plugins[0]?.scope).toBe("global");
	});

	test("/plugins returns discovered plugin", async () => {
		const res = await fetch(new Request("http://localhost/plugins"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.length).toBe(1);
		expect(body[0].name).toBe("test-matrix");
	});

	test("worker started for global plugin — version returns counts", async () => {
		// /version is forwarded to worker (unlike /health which is daemon-owned)
		// This actually verifies the worker is running and responding
		const res = await fetch(new Request("http://localhost/version"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(typeof body.nodeCount).toBe("number");
	});
});

describe("daemon startup — dataRoot hardening (Audit FU5)", () => {
	// Each case sets up its own temp project with a specific plugin manifest
	// and verifies createDaemon either throws (malformed) or succeeds (legal).
	async function setupProject(manifest: string): Promise<{
		tempDir: string;
		dataDir: string;
		cleanup: () => Promise<void>;
	}> {
		const tempDir = await mkdtemp(join(tmpdir(), "daemon-fu5-test-"));
		const dataDir = join(tempDir, ".mxd");
		const projectPath = join(tempDir, "proj");

		await mkdir(join(projectPath, ".mxd", "plugin"), { recursive: true });
		await writeFile(
			join(projectPath, ".mxd", "plugin", "index.ts"),
			manifest,
			"utf-8",
		);
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: "p1",
					name: "proj",
					path: projectPath,
					createdAt: new Date().toISOString(),
				},
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		return {
			tempDir,
			dataDir,
			cleanup: async () => {
				await rm(tempDir, { recursive: true, force: true });
			},
		};
	}

	test("manifest with traversal dataRoot '@/../etc' → createDaemon throws", async () => {
		const ctx = await setupProject(
			`export default { name: "evil", scope: "global", dataRoot: "@/../etc" };`,
		);
		try {
			await expect(
				createDaemon({ dataDir: ctx.dataDir, autoRegisterSelf: false }),
			).rejects.toThrow(/Invalid dataRoot/);
		} finally {
			await ctx.cleanup();
		}
	});

	test("manifest with no-prefix dataRoot 'foo' → createDaemon throws", async () => {
		const ctx = await setupProject(
			`export default { name: "bad", scope: "global", dataRoot: "foo" };`,
		);
		try {
			await expect(
				createDaemon({ dataDir: ctx.dataDir, autoRegisterSelf: false }),
			).rejects.toThrow(/Invalid dataRoot/);
		} finally {
			await ctx.cleanup();
		}
	});

	test("manifest with empty dataRoot '' → createDaemon throws", async () => {
		const ctx = await setupProject(
			`export default { name: "empty", scope: "global", dataRoot: "" };`,
		);
		try {
			await expect(
				createDaemon({ dataDir: ctx.dataDir, autoRegisterSelf: false }),
			).rejects.toThrow(/Invalid dataRoot/);
		} finally {
			await ctx.cleanup();
		}
	});

	test("manifest with absolute dataRoot '/etc' → createDaemon throws", async () => {
		const ctx = await setupProject(
			`export default { name: "abs", scope: "global", dataRoot: "/etc" };`,
		);
		try {
			await expect(
				createDaemon({ dataDir: ctx.dataDir, autoRegisterSelf: false }),
			).rejects.toThrow(/Invalid dataRoot/);
		} finally {
			await ctx.cleanup();
		}
	});

	test("manifest with legal '@' → daemon starts", async () => {
		const ctx = await setupProject(
			`export default { name: "ok", scope: "global", dataRoot: "@" };`,
		);
		try {
			const daemon = await createDaemon({
				dataDir: ctx.dataDir,
				autoRegisterSelf: false,
			});
			expect(daemon.plugins.length).toBe(1);
			await daemon.shutdown();
		} finally {
			await ctx.cleanup();
		}
	});
});

describe("createDaemon — corrupt global config never wipes credentials (cc#4)", () => {
	test("incomplete config (missing required field) → createDaemon throws, on-disk config preserved", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-corrupt-cfg-"));
		const dataDir = join(tempDir, ".mxd");
		await mkdir(dataDir, { recursive: true });
		// A config that EXISTS, carries credentials, but is missing required
		// fields (the exact shape PATCH null-delete used to produce).
		const corrupt = JSON.stringify({
			authGroups: { main: { provider: "anthropic", apiKey: "sk-secret-abc" } },
		});
		await writeFile(join(dataDir, "config.json"), corrupt, "utf-8");

		// Must FAIL boot — not silently boot with empty DEFAULT_CONFIG.
		await expect(
			createDaemon({ dataDir, autoRegisterSelf: false }),
		).rejects.toThrow(/global config/i);

		// On-disk config is untouched — credentials preserved for the operator.
		const onDisk = JSON.parse(
			await readFile(join(dataDir, "config.json"), "utf-8"),
		) as { authGroups: { main: { apiKey: string } } };
		expect(onDisk.authGroups.main.apiKey).toBe("sk-secret-abc");

		await rm(tempDir, { recursive: true, force: true });
	});

	test("corrupt JSON config → createDaemon throws", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "mxd-corrupt-json-"));
		const dataDir = join(tempDir, ".mxd");
		await mkdir(dataDir, { recursive: true });
		await writeFile(join(dataDir, "config.json"), "{ not valid json", "utf-8");

		await expect(
			createDaemon({ dataDir, autoRegisterSelf: false }),
		).rejects.toThrow(/global config/i);

		await rm(tempDir, { recursive: true, force: true });
	});
});
