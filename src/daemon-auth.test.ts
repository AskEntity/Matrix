/**
 * Integration tests for daemon's auth middleware, SSE stream tokens,
 * API-key masking, and logout-all revocation.
 *
 * Each test sets up a daemon with `autoInitAuth: true` (production
 * behavior) and an explicit auth.json so we can control tokens.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureAuthInitialized,
	signSessionToken,
	signStreamToken,
} from "./auth.ts";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";

interface TestCtx {
	daemon: DaemonInstance;
	tempDir: string;
	dataDir: string;
	authPath: string;
	sessionToken: string;
}

async function setup(): Promise<TestCtx> {
	const tempDir = await mkdtemp(join(tmpdir(), "daemon-auth-test-"));
	const dataDir = join(tempDir, ".mxd");
	const authPath = join(dataDir, "auth.json");
	await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
	await ensureAuthInitialized(authPath);
	const sessionToken = await signSessionToken(authPath);
	const daemon = await createDaemon({
		dataDir,
		autoRegisterSelf: false,
	});
	return { daemon, tempDir, dataDir, authPath, sessionToken };
}

async function teardown(ctx: TestCtx) {
	await ctx.daemon.shutdown();
	await rm(ctx.tempDir, { recursive: true, force: true });
}

describe("daemon auth middleware: skip rules", () => {
	let ctx: TestCtx;
	beforeEach(async () => {
		ctx = await setup();
	});
	afterEach(() => teardown(ctx));

	test("exact skip: GET /auth/status is public", async () => {
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/auth/status"),
		);
		expect(res.status).toBe(200);
	});

	test("POST /auth/logout rejects anonymous callers (Audit R7 P1.1)", async () => {
		// Previously `/auth/logout` was on SKIP_EXACT — a drive-by page could
		// hit the endpoint without any auth and force a secretVersion bump,
		// logging every active user out. Now the auth middleware rejects
		// anonymous POSTs with 401 and the secretVersion stays put.
		const beforeVersion = (
			JSON.parse(
				await (await import("node:fs/promises")).readFile(
					ctx.authPath,
					"utf-8",
				),
			) as { secretVersion: number }
		).secretVersion;

		const res = await ctx.daemon.fetch(
			new Request("http://localhost/auth/logout", { method: "POST" }),
		);
		expect(res.status).toBe(401);

		const afterVersion = (
			JSON.parse(
				await (await import("node:fs/promises")).readFile(
					ctx.authPath,
					"utf-8",
				),
			) as { secretVersion: number }
		).secretVersion;
		expect(afterVersion).toBe(beforeVersion);
	});

	test("prefix-match is NOT accepted: /auth/bogus → 401", async () => {
		// Previously `startsWith("/auth/")` would skip auth for any path
		// under `/auth/*`. Regression guard — Audit J H1.
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/auth/bogus"),
		);
		expect(res.status).toBe(401);
	});

	test("/ is public (SPA root)", async () => {
		const res = await ctx.daemon.fetch(new Request("http://localhost/"));
		expect(res.status).toBe(200);
	});

	test("static /vendor/ and /app/ are public (compiled bundles)", async () => {
		const v = await ctx.daemon.fetch(new Request("http://localhost/vendor/x"));
		const a = await ctx.daemon.fetch(new Request("http://localhost/app/y"));
		// Neither is 401 — just 404 for missing files
		expect(v.status).not.toBe(401);
		expect(a.status).not.toBe(401);
	});
});

describe("daemon auth middleware: Bearer scheme", () => {
	let ctx: TestCtx;
	beforeEach(async () => {
		ctx = await setup();
	});
	afterEach(() => teardown(ctx));

	test("lowercase `bearer` is accepted (RFC 7235)", async () => {
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/projects", {
				headers: { Authorization: `bearer ${ctx.sessionToken}` },
			}),
		);
		expect(res.status).toBe(200);
	});

	test("mixed-case `BeArEr` is accepted", async () => {
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/projects", {
				headers: { Authorization: `BeArEr ${ctx.sessionToken}` },
			}),
		);
		expect(res.status).toBe(200);
	});

	test("missing token → 401", async () => {
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/projects"),
		);
		expect(res.status).toBe(401);
	});

	test("wrong scheme rejected (Basic)", async () => {
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/projects", {
				headers: { Authorization: `Basic ${ctx.sessionToken}` },
			}),
		);
		expect(res.status).toBe(401);
	});
});

describe("daemon auth middleware: /events subject restriction", () => {
	let ctx: TestCtx;
	beforeEach(async () => {
		ctx = await setup();
	});
	afterEach(() => teardown(ctx));

	test("/events rejects a session token (stream-only endpoint)", async () => {
		const res = await ctx.daemon.fetch(
			new Request(
				`http://localhost/events?projectId=p&token=${encodeURIComponent(ctx.sessionToken)}`,
			),
		);
		expect(res.status).toBe(401);
	});

	test("/events accepts a stream token", async () => {
		const streamTok = await signStreamToken(ctx.authPath);
		const res = await ctx.daemon.fetch(
			new Request(
				`http://localhost/events?projectId=p&token=${encodeURIComponent(streamTok)}`,
			),
		);
		// 200 (SSE stream); we don't read the body here
		expect(res.status).toBe(200);
		// Clean up the open stream so the test can exit
		if (res.body) await res.body.cancel();
	});

	test("REST endpoint rejects a stream token", async () => {
		const streamTok = await signStreamToken(ctx.authPath);
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/projects", {
				headers: { Authorization: `Bearer ${streamTok}` },
			}),
		);
		expect(res.status).toBe(401);
	});
});

describe("daemon auth: /auth/stream-token", () => {
	let ctx: TestCtx;
	beforeEach(async () => {
		ctx = await setup();
	});
	afterEach(() => teardown(ctx));

	test("POST /auth/stream-token requires a session token", async () => {
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/auth/stream-token", {
				method: "POST",
			}),
		);
		expect(res.status).toBe(401);
	});

	test("POST /auth/stream-token returns a valid stream token", async () => {
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/auth/stream-token", {
				method: "POST",
				headers: { Authorization: `Bearer ${ctx.sessionToken}` },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { token: string };
		expect(typeof body.token).toBe("string");

		// Verify the returned token works on /events
		const streamRes = await ctx.daemon.fetch(
			new Request(
				`http://localhost/events?projectId=p&token=${encodeURIComponent(body.token)}`,
			),
		);
		expect(streamRes.status).toBe(200);
		if (streamRes.body) await streamRes.body.cancel();
	});
});

describe("daemon auth: POST /auth/logout revokes all tokens", () => {
	let ctx: TestCtx;
	beforeEach(async () => {
		ctx = await setup();
	});
	afterEach(() => teardown(ctx));

	test("logout bumps secretVersion → old session token rejected", async () => {
		// Before logout, token works
		const before = await ctx.daemon.fetch(
			new Request("http://localhost/projects", {
				headers: { Authorization: `Bearer ${ctx.sessionToken}` },
			}),
		);
		expect(before.status).toBe(200);

		// Logout (with old token — middleware accepts, handler rotates)
		const logoutRes = await ctx.daemon.fetch(
			new Request("http://localhost/auth/logout", {
				method: "POST",
				headers: { Authorization: `Bearer ${ctx.sessionToken}` },
			}),
		);
		expect(logoutRes.status).toBe(200);
		const body = (await logoutRes.json()) as { secretVersion: number };
		expect(body.secretVersion).toBe(2);

		// After logout, same token rejected
		const after = await ctx.daemon.fetch(
			new Request("http://localhost/projects", {
				headers: { Authorization: `Bearer ${ctx.sessionToken}` },
			}),
		);
		expect(after.status).toBe(401);

		// A freshly-signed token (after bump) still works
		const fresh = await signSessionToken(ctx.authPath);
		const after2 = await ctx.daemon.fetch(
			new Request("http://localhost/projects", {
				headers: { Authorization: `Bearer ${fresh}` },
			}),
		);
		expect(after2.status).toBe(200);
	});
});

describe("daemon: config masks API keys", () => {
	let ctx: TestCtx;
	beforeEach(async () => {
		ctx = await setup();
		// Seed a config with api keys — overwrite what setup() wrote.
		await writeFile(
			join(ctx.dataDir, "config.json"),
			JSON.stringify({
				...DEFAULT_CONFIG,
				authGroups: {
					anth: {
						provider: "anthropic",
						apiKey: "sk-ant-secret-1234567890abcdef",
						oauthToken: "oauth-abc-1234567890",
					},
					oai: {
						provider: "openai",
						apiKey: "sk-oai-secret-abcdef",
						accessToken: "access-xyz-1234",
						refreshToken: "refresh-xyz-1234",
					},
				},
			}),
		);
		// Restart daemon to pick up new config
		await ctx.daemon.shutdown();
		ctx.daemon = await createDaemon({
			dataDir: ctx.dataDir,
		});
	});
	afterEach(() => teardown(ctx));

	test("GET /config/global masks apiKey / oauthToken / accessToken / refreshToken", async () => {
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/config/global", {
				headers: { Authorization: `Bearer ${ctx.sessionToken}` },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as typeof DEFAULT_CONFIG;
		const anth = body.authGroups.anth;
		if (anth?.provider !== "anthropic") throw new Error("expected anthropic");
		expect(anth.apiKey).toContain("…");
		expect(anth.apiKey).not.toContain("secret");
		expect(anth.oauthToken).toContain("…");
		expect(anth.oauthToken).not.toContain("1234567890");

		const oai = body.authGroups.oai;
		if (oai?.provider !== "openai") throw new Error("expected openai");
		expect(oai.apiKey).toContain("…");
		expect(oai.apiKey).not.toContain("secret");
		expect(oai.accessToken).toContain("…");
		expect(oai.refreshToken).toContain("…");
	});

	test("PATCH /config/global preserves plaintext when client echoes masked value", async () => {
		// Simulate frontend: GET → edit something else → PATCH with whole authGroups
		const getRes = await ctx.daemon.fetch(
			new Request("http://localhost/config/global", {
				headers: { Authorization: `Bearer ${ctx.sessionToken}` },
			}),
		);
		const masked = (await getRes.json()) as typeof DEFAULT_CONFIG;

		// PATCH back with masked values (user didn't touch credentials)
		const patchRes = await ctx.daemon.fetch(
			new Request("http://localhost/config/global", {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${ctx.sessionToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ authGroups: masked.authGroups }),
			}),
		);
		expect(patchRes.status).toBe(200);

		// Inspect stored config (read file directly to bypass mask)
		const { readFile } = await import("node:fs/promises");
		const raw = JSON.parse(
			await readFile(join(ctx.dataDir, "config.json"), "utf-8"),
		) as typeof DEFAULT_CONFIG;
		const anth = raw.authGroups.anth;
		if (anth?.provider !== "anthropic") throw new Error("expected anthropic");
		// Plaintext was preserved
		expect(anth.apiKey).toBe("sk-ant-secret-1234567890abcdef");
		expect(anth.oauthToken).toBe("oauth-abc-1234567890");
	});

	test("PATCH /config/global overwrites when client sends a new value", async () => {
		// User types a fresh API key in the UI.
		const getRes = await ctx.daemon.fetch(
			new Request("http://localhost/config/global", {
				headers: { Authorization: `Bearer ${ctx.sessionToken}` },
			}),
		);
		const masked = (await getRes.json()) as typeof DEFAULT_CONFIG;

		const updated = {
			...masked,
			authGroups: {
				...masked.authGroups,
				anth: {
					...masked.authGroups.anth,
					apiKey: "sk-ant-brand-new-1234567890abcd",
				},
			},
		};
		await ctx.daemon.fetch(
			new Request("http://localhost/config/global", {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${ctx.sessionToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ authGroups: updated.authGroups }),
			}),
		);

		const { readFile } = await import("node:fs/promises");
		const raw = JSON.parse(
			await readFile(join(ctx.dataDir, "config.json"), "utf-8"),
		) as typeof DEFAULT_CONFIG;
		const anth = raw.authGroups.anth;
		if (anth?.provider !== "anthropic") throw new Error("expected anthropic");
		expect(anth.apiKey).toBe("sk-ant-brand-new-1234567890abcd");
	});
});

describe("daemon: auto-initialized auth (Audit R7 P1.3 — always on)", () => {
	test("createDaemon creates auth.json if missing, rejects anonymous", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "daemon-init-test-"));
		const dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		// After P1.3, `autoInitAuth` no longer exists — auth is ALWAYS on.
		const daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
		});
		try {
			// auth.json should exist now with a jwtSecret
			const { readFile } = await import("node:fs/promises");
			const raw = JSON.parse(
				await readFile(join(dataDir, "auth.json"), "utf-8"),
			);
			expect(typeof raw.jwtSecret).toBe("string");
			expect(typeof raw.secretVersion).toBe("number");

			// And any unauthenticated request is rejected
			const res = await daemon.fetch(new Request("http://localhost/projects"));
			expect(res.status).toBe(401);
		} finally {
			await daemon.shutdown();
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("createDaemon with an already-initialized auth.json preserves it", async () => {
		// Idempotency check — pre-existing auth.json is not overwritten.
		const tempDir = await mkdtemp(join(tmpdir(), "daemon-init-existing-"));
		const dataDir = join(tempDir, ".mxd");
		const authPath = join(dataDir, "auth.json");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		await ensureAuthInitialized(authPath);
		const { readFile } = await import("node:fs/promises");
		const before = await readFile(authPath, "utf-8");

		const daemon = await createDaemon({ dataDir, autoRegisterSelf: false });
		try {
			const after = await readFile(authPath, "utf-8");
			expect(after).toEqual(before);
		} finally {
			await daemon.shutdown();
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test("corrupt auth.json → createDaemon fails to boot (loud, not silent)", async () => {
		// Pre-P1.3, a corrupt auth.json would silently read as empty, and the
		// middleware's `!hasJwtSecret` branch would serve every request
		// unauthenticated. After P1.3 that fallback is gone; readAuthData
		// throws, ensureAuthInitialized can't complete, daemon fails to boot.
		const tempDir = await mkdtemp(join(tmpdir(), "daemon-corrupt-auth-"));
		const dataDir = join(tempDir, ".mxd");
		const authPath = join(dataDir, "auth.json");
		const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
		await mk(dataDir, { recursive: true });
		await wf(authPath, "{not json", "utf-8");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		try {
			await expect(
				createDaemon({ dataDir, autoRegisterSelf: false }),
			).rejects.toThrow(/not valid JSON/);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("daemon: PATCH /projects/:id/config rejects credential fields (Audit R7 P1.4)", () => {
	let ctx: TestCtx;
	let projectId: string;

	beforeEach(async () => {
		ctx = await setup();
		// Register a project so PATCH /projects/:id/config has a target.
		const { mkdir, writeFile: wf } = await import("node:fs/promises");
		const projectPath = join(ctx.tempDir, "proj");
		await mkdir(projectPath, { recursive: true });
		await mkdir(join(ctx.dataDir, "projects"), { recursive: true });
		projectId = "proj-1";
		await wf(
			join(ctx.dataDir, "projects.json"),
			JSON.stringify([
				{
					id: projectId,
					name: "proj",
					path: projectPath,
					createdAt: new Date().toISOString(),
				},
			]),
		);
		// Restart daemon so project is loaded.
		await ctx.daemon.shutdown();
		ctx.daemon = await createDaemon({
			dataDir: ctx.dataDir,
			autoRegisterSelf: false,
		});
	});
	afterEach(() => teardown(ctx));

	test("PATCH /projects/:id/config rejects authGroups with 400", async () => {
		const res = await ctx.daemon.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${ctx.sessionToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					authGroups: {
						evil: { provider: "anthropic", apiKey: "sk-ant-attacker" },
					},
				}),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("authGroups");
		expect(body.error).toContain("global");
	});

	test("PATCH /projects/:id/config rejects defaultAuth with 400", async () => {
		const res = await ctx.daemon.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${ctx.sessionToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ defaultAuth: "evil" }),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("defaultAuth");
	});

	test("PATCH /projects/:id/config/repo rejects authGroups with 400", async () => {
		const res = await ctx.daemon.fetch(
			new Request(`http://localhost/projects/${projectId}/config/repo`, {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${ctx.sessionToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					authGroups: {
						evil: { provider: "openai", apiKey: "sk-oai-attacker" },
					},
				}),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("authGroups");
	});

	test("PATCH /projects/:id/config/repo rejects defaultAuth with 400", async () => {
		const res = await ctx.daemon.fetch(
			new Request(`http://localhost/projects/${projectId}/config/repo`, {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${ctx.sessionToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ defaultAuth: "evil" }),
			}),
		);
		expect(res.status).toBe(400);
	});

	test("PATCH /projects/:id/config still accepts non-credential fields (regression guard)", async () => {
		// Non-credential patches must keep working.
		const res = await ctx.daemon.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: {
					Authorization: `Bearer ${ctx.sessionToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ budgetUsd: 42 }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { budgetUsd: number };
		expect(body.budgetUsd).toBe(42);
	});

	test("GET /projects/:id/config/all masks authGroups in every layer (Audit R7 P1.4)", async () => {
		// Simulate a malicious actor writing authGroups directly to the
		// on-disk repo config file (bypassing our PATCH guard). The GET
		// endpoint MUST still mask the value — defense in depth.
		const { writeFile: wf } = await import("node:fs/promises");
		const { mkdir: mk } = await import("node:fs/promises");
		const repoConfigPath = join(ctx.tempDir, "proj", ".mxd", "config.json");
		await mk(join(ctx.tempDir, "proj", ".mxd"), { recursive: true });
		await wf(
			repoConfigPath,
			JSON.stringify({
				authGroups: {
					evil: {
						provider: "anthropic",
						apiKey: "sk-ant-injected-plaintext-0123456789",
					},
				},
			}),
		);
		const localConfigPath = join(
			ctx.dataDir,
			"projects",
			projectId,
			"config.json",
		);
		await mk(join(ctx.dataDir, "projects", projectId), { recursive: true });
		await wf(
			localConfigPath,
			JSON.stringify({
				authGroups: {
					evil2: {
						provider: "openai",
						apiKey: "sk-oai-injected-plaintext-0123456789",
					},
				},
			}),
		);

		const res = await ctx.daemon.fetch(
			new Request(`http://localhost/projects/${projectId}/config/all`, {
				headers: { Authorization: `Bearer ${ctx.sessionToken}` },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			repo: { authGroups?: Record<string, { apiKey?: string }> };
			local: { authGroups?: Record<string, { apiKey?: string }> };
		};
		// repo layer — injected plaintext is masked
		const repoEvil = body.repo.authGroups?.evil;
		expect(repoEvil?.apiKey).toBeDefined();
		expect(repoEvil?.apiKey).not.toContain("injected");
		expect(repoEvil?.apiKey).toContain("…");
		// local layer — same
		const localEvil2 = body.local.authGroups?.evil2;
		expect(localEvil2?.apiKey).toBeDefined();
		expect(localEvil2?.apiKey).not.toContain("injected");
		expect(localEvil2?.apiKey).toContain("…");
	});

	test("GET /projects/:id/config masks authGroups if injected", async () => {
		const { writeFile: wf } = await import("node:fs/promises");
		const { mkdir: mk } = await import("node:fs/promises");
		const localConfigPath = join(
			ctx.dataDir,
			"projects",
			projectId,
			"config.json",
		);
		await mk(join(ctx.dataDir, "projects", projectId), { recursive: true });
		await wf(
			localConfigPath,
			JSON.stringify({
				authGroups: {
					evil: {
						provider: "anthropic",
						apiKey: "sk-ant-injected-plaintext-0123456789",
					},
				},
			}),
		);

		const res = await ctx.daemon.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				headers: { Authorization: `Bearer ${ctx.sessionToken}` },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			authGroups?: Record<string, { apiKey?: string }>;
		};
		const evil = body.authGroups?.evil;
		expect(evil?.apiKey).toBeDefined();
		expect(evil?.apiKey).not.toContain("injected");
		expect(evil?.apiKey).toContain("…");
	});
});
