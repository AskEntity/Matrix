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
	const daemon = await createDaemon({ dataDir, autoInitAuth: true, autoRegisterSelf: false });
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

	test("exact skip: POST /auth/logout is public (no token = no-op)", async () => {
		const res = await ctx.daemon.fetch(
			new Request("http://localhost/auth/logout", { method: "POST" }),
		);
		expect(res.status).toBe(200);
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
			autoInitAuth: false,
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

describe("daemon: auto-initialized auth", () => {
	test("createDaemon with autoInitAuth:true creates auth.json if missing", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "daemon-init-test-"));
		const dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		const daemon = await createDaemon({ dataDir, autoInitAuth: true, autoRegisterSelf: false });
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
});
