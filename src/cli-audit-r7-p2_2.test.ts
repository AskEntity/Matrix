/**
 * Audit R7 P2.2 — `mxd watch` mints a stream token before connecting.
 *
 * After Audit R7 P1.3 auth is always on; `/events` middleware accepts
 * only `sub=stream` JWTs. The CLI's own CLI-subject token is rejected
 * (401), so the old `mxd watch` 401-looped. Fix: mirror the shell's
 * useSSE pattern — POST `/auth/stream-token` with the CLI Bearer to
 * receive a 5min stream token, then use it as `?token=` on `/events`.
 * Reconnect re-POSTs so we never reuse a stale/revoked token.
 *
 * Spawning the CLI as a subprocess exercises the real module-load path;
 * a fake daemon observes the exact HTTP trace the CLI produces.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAuthInitialized } from "./auth.ts";

const CLI_PATH = new URL("./cli.ts", import.meta.url).pathname;

describe("P2.2: `mxd watch` mints stream token before opening /events", () => {
	let dataDir: string;
	let fakeHome: string;
	let server: ReturnType<typeof Bun.serve> | null = null;

	beforeEach(async () => {
		// Two tmpdirs: one is MXD_DATA_DIR (holds auth.json so the CLI
		// can sign a cli-subject token); the other is HOME/cwd (the fake
		// project the daemon registers, so resolveCurrentProject matches).
		//
		// macOS gotcha: `mkdtemp("/var/folders/…")` returns an unresolved
		// symlink path, but `process.cwd()` inside the spawned CLI returns
		// the resolved `/private/var/folders/…` form. Our CLI's
		// resolveCurrentProject() does a string compare of cwd against
		// each project's registered path — so we must register the
		// project with the REALPATH, else the match fails and the CLI
		// exits 1 before ever hitting the stream-token flow.
		dataDir = realpathSync(await mkdtemp(join(tmpdir(), "mxd-p22-data-")));
		fakeHome = realpathSync(await mkdtemp(join(tmpdir(), "mxd-p22-home-")));
		// Pre-initialize auth.json so the CLI's `getCLIToken()` returns
		// a non-null token — otherwise `fetchStreamToken()` bails before
		// even making a POST and the test can't observe the intended
		// behavior.
		await ensureAuthInitialized(join(dataDir, "auth.json"));
	});

	afterEach(async () => {
		server?.stop();
		server = null;
		await rm(dataDir, { recursive: true, force: true });
		await rm(fakeHome, { recursive: true, force: true });
	});

	/**
	 * Spin up a fake daemon that records every incoming request and
	 * allows the test to control the SSE stream lifecycle.
	 *
	 * Returns:
	 *  - `url`: daemon URL to pass to CLI via MXD_DAEMON_URL
	 *  - `requests`: live array of requests the CLI has made (path+query+method)
	 *  - `streamTokensIssued`: every stream-token string returned by a POST
	 */
	function startFakeDaemon(opts: {
		/** If true, /events returns 401 unless ?token matches the last issued stream token. */
		strictStreamAuth?: boolean;
		/** Called once for each /events connection; receives a `close` hook. */
		onEventsConnect?: (close: () => void) => void;
	}): {
		url: string;
		requests: Array<{
			method: string;
			pathname: string;
			token: string | null;
			authHeader: string | null;
		}>;
		streamTokensIssued: string[];
	} {
		const requests: Array<{
			method: string;
			pathname: string;
			token: string | null;
			authHeader: string | null;
		}> = [];
		const streamTokensIssued: string[] = [];
		const projectId = "p22-project";

		server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				requests.push({
					method: req.method,
					pathname: url.pathname,
					token: url.searchParams.get("token"),
					authHeader: req.headers.get("authorization"),
				});

				if (url.pathname === "/projects") {
					// resolveCurrentProject walks cwd → matches the project
					// whose path is the cwd or an ancestor. We spawn CLI with
					// cwd=fakeHome and register a project at fakeHome.
					return Response.json([
						{
							id: projectId,
							name: "p22",
							path: fakeHome,
							pathExists: true,
						},
					]);
				}

				if (req.method === "POST" && url.pathname === "/auth/stream-token") {
					// Mint a unique, deterministic token we can echo-check.
					// Using a predictable value (not a real JWT) is fine —
					// the test daemon also validates it on the next step,
					// so a CLI that skips this POST can't accidentally pass.
					const token = `stream-token-${streamTokensIssued.length + 1}`;
					streamTokensIssued.push(token);
					return Response.json({ token });
				}

				if (url.pathname === "/events") {
					const queryToken = url.searchParams.get("token");
					if (opts.strictStreamAuth) {
						// Accept ONLY the most recently issued stream token.
						// A CLI that bypasses the POST will send either no
						// ?token= or its cli-subject JWT — neither matches.
						const latest = streamTokensIssued[streamTokensIssued.length - 1];
						if (!latest || queryToken !== latest) {
							return new Response("Unauthorized", { status: 401 });
						}
					}

					let closed = false;
					const body = new ReadableStream({
						start(controller) {
							const encoder = new TextEncoder();
							// Emit one orchestration_started SSE event so the
							// CLI prints something visible — test 1 and test 3
							// detect success by scanning stdout for this.
							controller.enqueue(
								encoder.encode(
									`data: ${JSON.stringify({
										type: "orchestration_started",
									})}\n\n`,
								),
							);
							const close = () => {
								if (closed) return;
								closed = true;
								try {
									controller.close();
								} catch {
									/* already closed */
								}
							};
							opts.onEventsConnect?.(close);
						},
						cancel() {
							closed = true;
						},
					});
					return new Response(body, {
						headers: {
							"content-type": "text/event-stream",
							"cache-control": "no-cache",
						},
					});
				}

				return new Response("not found", { status: 404 });
			},
		});
		if (server.port === undefined) throw new Error("no port");
		return {
			url: `http://localhost:${server.port}`,
			requests,
			streamTokensIssued,
		};
	}

	/** Spawn `mxd watch` with cwd=fakeHome so resolveCurrentProject finds p22-project. */
	function spawnWatch(daemonUrl: string): ReturnType<typeof Bun.spawn> {
		return Bun.spawn(["bun", CLI_PATH, "watch"], {
			cwd: fakeHome,
			env: {
				...process.env,
				MXD_DAEMON_URL: daemonUrl,
				MXD_DATA_DIR: dataDir,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
	}

	/** Drain the process's stdout until a marker substring appears or the deadline hits. */
	async function drainUntil(
		proc: ReturnType<typeof Bun.spawn>,
		marker: string,
		timeoutMs: number,
	): Promise<string> {
		const stdout = proc.stdout as ReadableStream<Uint8Array>;
		const reader = stdout.getReader();
		const decoder = new TextDecoder();
		let out = "";
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			// Race read() against a timeout so we don't hang forever if
			// the CLI never writes anything.
			const result = await Promise.race([
				reader.read().then((r) => ({ kind: "read" as const, r })),
				new Promise<{ kind: "timeout" }>((r) =>
					setTimeout(() => r({ kind: "timeout" }), Math.min(remaining, 250)),
				),
			]);
			if (result.kind === "timeout") continue;
			if (result.r.done) break;
			out += decoder.decode(result.r.value, { stream: true });
			if (out.includes(marker)) break;
		}
		return out;
	}

	test("first connect: POST /auth/stream-token THEN GET /events?token=<streamToken>", async () => {
		// Happy path. Fake daemon records every request; we read stdout
		// until the CLI prints the SSE event ("Started"), then kill and
		// inspect the request log.
		const closes: Array<() => void> = [];
		const daemon = startFakeDaemon({
			onEventsConnect: (close) => {
				closes.push(close);
			},
		});

		const proc = spawnWatch(daemon.url);
		const out = await drainUntil(proc, "Started", 2000);
		for (const c of closes) c();
		proc.kill();
		await proc.exited;

		// The SSE event reached the CLI → end-to-end auth flow worked.
		expect(out).toContain("Started");

		// Filter out the initial `/projects` lookups (resolveCurrentProject
		// calls it). Only the auth + events hops matter for ordering.
		const authFlow = daemon.requests.filter(
			(r) => r.pathname === "/auth/stream-token" || r.pathname === "/events",
		);
		// First two auth-flow entries: POST /auth/stream-token, then GET /events.
		expect(authFlow[0]).toMatchObject({
			method: "POST",
			pathname: "/auth/stream-token",
		});
		expect(authFlow[1]).toMatchObject({
			method: "GET",
			pathname: "/events",
		});
		// The `?token=` on /events is exactly the token the POST returned
		// — not the CLI's own JWT. This is the single-line mutation guard:
		// if fetchStreamToken is bypassed, this assertion fails.
		const issuedToken = daemon.streamTokensIssued[0];
		expect(issuedToken).toBeTruthy();
		expect(authFlow[1]?.token).toBe(issuedToken ?? null);

		// Defence-in-depth: the CLI MUST NOT put the long-lived Bearer in
		// the URL. The POST carries it as Authorization header — the GET's
		// query token is the short-lived stream token only.
		expect(authFlow[0]?.authHeader).toMatch(/^Bearer /);
	});

	test("reconnect: server closes stream → CLI re-POSTs /auth/stream-token for a fresh token", async () => {
		// Server closes the stream immediately after the first SSE
		// event. CLI's reconnect loop engages; we expect a SECOND POST
		// for a fresh stream token (not reuse of the first).
		const closes: Array<() => void> = [];
		const daemon = startFakeDaemon({
			onEventsConnect: (close) => {
				closes.push(close);
				// Small delay so the SSE event enqueues before close.
				setTimeout(() => close(), 20);
			},
		});

		const proc = spawnWatch(daemon.url);
		// Backoff on first reconnect is 2^1 = 2s; wait 3.5s to cover
		// cold-start + at least one reconnect attempt.
		await drainUntil(proc, "Reconnecting in", 3500);
		// Give the reconnect time to actually happen (the stdout message
		// is printed BEFORE the backoff sleep completes).
		await new Promise((r) => setTimeout(r, 2500));
		proc.kill();
		await proc.exited;
		for (const c of closes) c();

		// At least 2 stream tokens were issued — one for each connect.
		// Reusing an old token is NOT OK: they expire in 5min, and a
		// logout-all may have invalidated the first by now.
		expect(daemon.streamTokensIssued.length).toBeGreaterThanOrEqual(2);

		// Check the token-per-connect invariant: each GET /events uses
		// the most recently issued token, and consecutive GETs use
		// different tokens.
		const authFlow = daemon.requests.filter(
			(r) => r.pathname === "/auth/stream-token" || r.pathname === "/events",
		);
		const posts = authFlow.filter((r) => r.method === "POST");
		const gets = authFlow.filter((r) => r.method === "GET");
		expect(posts.length).toBeGreaterThanOrEqual(2);
		expect(gets.length).toBeGreaterThanOrEqual(2);
		expect(gets[0]?.token).not.toBe(gets[1]?.token);
		expect(gets[0]?.token).toBe(daemon.streamTokensIssued[0]);
		expect(gets[1]?.token).toBe(daemon.streamTokensIssued[1]);
	});

	test("mutation proof: strict /events requires the stream token → a CLI that skips the POST never prints the SSE event", async () => {
		// Strict mode: /events ONLY accepts the most recently issued
		// stream token. If the CLI bypasses the POST (regression), it
		// sends either no ?token= or a cli-subject JWT, neither matches
		// the strict check, and the stream 401s — CLI never prints
		// "Started". This test pins the end-to-end auth handshake.
		const closes: Array<() => void> = [];
		const daemon = startFakeDaemon({
			strictStreamAuth: true,
			onEventsConnect: (close) => {
				closes.push(close);
				// Keep the stream open — we want the CLI to print
				// "Started" on success. Kill at test end.
			},
		});

		const proc = spawnWatch(daemon.url);
		const out = await drainUntil(proc, "Started", 2000);
		proc.kill();
		await proc.exited;
		for (const c of closes) c();

		// With the fix: POST issued, stream token returned, GET matches
		// → SSE flows → CLI prints "Started".
		// Without the fix: no POST → /events 401 → no SSE → no "Started".
		// A mutation that breaks fetchStreamToken flips this assertion.
		expect(out).toContain("Started");
		expect(daemon.streamTokensIssued.length).toBeGreaterThanOrEqual(1);
	});
});
