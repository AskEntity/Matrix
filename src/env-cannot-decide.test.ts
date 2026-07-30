/**
 * ⭐ Env cannot decide anything — measured AT THE RECEIVER.
 *
 * The other env tests in this repo assert on our own client object: what
 * `client.apiKey` holds, what `authHeaders()` would emit. Those are intermediate
 * observables and one of them is provably vacuous — `client.apiKey` is
 * byte-identical with and without the fix, because the SDK reads
 * ANTHROPIC_API_KEY too. **These tests instead listen on two real sockets and
 * assert what crossed the wire**, which is the only thing that decides whether a
 * user's traffic went where they configured it, carrying what they configured.
 *
 * ## The shape
 *
 * Two real listeners on ephemeral ports.
 *
 * - **Endpoint 1** is what our config names. Requests are supposed to arrive
 *   here, and every case asserts one DID before asserting anything about
 *   endpoint 2 — a fixture that sends nothing at all must not read as a clean
 *   run.
 * - **Endpoint 2** is what the env var names. It exists only to prove nothing
 *   arrives there, and because it is a real server it **captures and testifies**:
 *   method, path and the credential-relevant headers of anything it catches, so a
 *   regression's failure message is the diagnosis rather than
 *   `expected 0, got 1`. It can also catch a leak nobody wrote a case for.
 *
 * Neither endpoint implements any vendor protocol — both record and then answer
 * `400`, a status neither SDK retries. The calls are expected to fail; arrival is
 * the observable. (Deliberate: a wire-level Anthropic mock is a second
 * implementation of somebody else's protocol and belongs in its own task,
 * `01KMNYSM4JBJ3FPZCQPFZF6T3Q`.)
 *
 * ## The doors
 *
 * | door | what it crosses |
 * |---|---|
 * | `check_model` on a temp-dir config | config FILE → loadGlobalConfig → resolveAuthGroup → createProviderFromConfig → SDK → wire |
 * | `createLLM` | auth group → SDK → wire (the plugin facility) |
 * | `streamResponsesAPI` | endpoint + token → SDK → wire (OpenAI) |
 *
 * The first is the one that matters most: it starts from a `config.json` written
 * into an isolated temp dir and read back by the real loader, so nothing in the
 * chain is hand-constructed. What an agent LOOP would add on top — streaming,
 * tool dispatch, the queue — does not touch how the client is built, which is
 * where env would enter. That case is filed on the harness task above.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staticCredential } from "./codex-auth.ts";
import { DEFAULT_CONFIG, type MatrixConfig } from "./config.ts";
import { createLLM } from "./llm.ts";
import { streamResponsesAPI } from "./openai-responses-compatible-provider.ts";
import { createMatrixApp as createApp } from "./test-utils/create-matrix-app.ts";
import { withClientEnv } from "./test-utils/sdk-client-env.ts";
import { TEST_MODEL } from "./test-utils.ts";

/** Headers that decide who is paying, who is asking, and on whose behalf. */
const WATCHED_HEADERS = [
	"authorization",
	"x-api-key",
	"openai-organization",
	"openai-project",
] as const;

interface Received {
	method: string;
	path: string;
	headers: Record<string, string>;
}

interface Endpoint {
	/** Base URL with no trailing slash. */
	url: string;
	received: Received[];
	stop: () => void;
}

function startEndpoint(): Endpoint {
	const received: Received[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const headers: Record<string, string> = {};
			for (const name of WATCHED_HEADERS) {
				const value = req.headers.get(name);
				if (value !== null) headers[name] = value;
			}
			received.push({
				method: req.method,
				path: new URL(req.url).pathname,
				headers,
			});
			// Refuse, so exactly one request happens: neither SDK retries a 400.
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "recorded" },
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		received,
		stop: () => server.stop(true),
	};
}

/**
 * ⚠️ Both endpoints are asserted in ONE `toEqual`, and that is a requirement
 * rather than a style choice.
 *
 * The two properties we need are "a request really arrived at the target" (or a
 * fixture that sends nothing reads as a clean run) and "the decoy testifies to
 * whatever it caught" (or a regression's message is `expected 0, got 1` and the
 * next person rebuilds the scenario to learn what leaked). Written as two
 * sequential `expect`s the first failure aborts the test and the decoy's evidence
 * is never printed — MEASURED: the first version of this file did exactly that,
 * and a leak of every request to the decoy reported only `Expected: 1 Received: 0`.
 *
 * One assertion over both sides gives a diff carrying the whole picture: what the
 * target got, what the decoy got, headers included. It also catches a leak nobody
 * wrote a case for, because the header map is compared whole.
 */
function wire(target: Endpoint, decoy: Endpoint) {
	return { target: target.received, decoy: decoy.received };
}

/** Every env name pointed somewhere it must never be followed. */
function shellFullOfEnv(decoyUrl: string) {
	return {
		ANTHROPIC_API_KEY: "sk-ant-shell-key-should-never-be-sent",
		ANTHROPIC_AUTH_TOKEN: "shell-auth-token-should-never-be-sent",
		ANTHROPIC_BASE_URL: decoyUrl,
		CLAUDE_CODE_OAUTH_TOKEN: "shell-oauth-should-never-be-sent",
		OPENAI_API_KEY: "sk-openai-shell-key-should-never-be-sent",
		OPENAI_BASE_URL: decoyUrl,
		OPENAI_ORG_ID: "org-shell-should-never-be-sent",
		OPENAI_PROJECT_ID: "proj-shell-should-never-be-sent",
	} as const;
}

describe("env cannot decide the endpoint or the credential (receiver-side)", () => {
	let target: Endpoint;
	let decoy: Endpoint;
	let tmpDir: string;

	beforeAll(async () => {
		target = startEndpoint();
		decoy = startEndpoint();
		tmpDir = await mkdtemp(join(tmpdir(), "mxd-env-receiver-"));
	});

	afterAll(async () => {
		target.stop();
		decoy.stop();
		await rm(tmpDir, { recursive: true, force: true });
	});

	function reset() {
		target.received.length = 0;
		decoy.received.length = 0;
	}

	// ── Door 1: a real config file, read by the real loader ──

	/**
	 * Write a global config into the temp dir and bring up the runtime on it, the
	 * way the daemon does: `loadGlobalConfig(ctx.config.globalConfigPath)`. No
	 * `initialConfig`, so the auth group the session uses is the one on disk.
	 */
	async function appOnConfigFile(config: MatrixConfig) {
		const dataDir = await mkdtemp(join(tmpDir, "datadir-"));
		const globalConfigPath = join(dataDir, "config.json");
		await writeFile(globalConfigPath, JSON.stringify(config, null, 2));
		const harness = createApp({ dataDir, globalConfigPath });
		// The real load path, the same call the daemon makes.
		await harness.loadConfig();
		return harness;
	}

	function anthropicConfig(group: {
		apiKey?: string;
		oauthToken?: string;
		baseUrl?: string;
	}): MatrixConfig {
		return {
			...DEFAULT_CONFIG,
			model: TEST_MODEL,
			authGroups: { probe: { provider: "anthropic", ...group } },
			defaultAuth: "probe",
		};
	}

	test("case 1 — configured baseUrl wins: the request lands at 1, and 2 catches nothing", async () => {
		reset();
		const harness = await appOnConfigFile(
			anthropicConfig({ apiKey: "configured-api-key", baseUrl: target.url }),
		);
		await withClientEnv(shellFullOfEnv(decoy.url), () =>
			harness.app.request("/health?check_model=true"),
		);

		expect(wire(target, decoy)).toEqual({
			target: [
				{
					method: "POST",
					path: "/v1/messages",
					headers: { "x-api-key": "configured-api-key" },
				},
			],
			decoy: [],
		});
	});

	test("case 3 — the configured credential is the only one on the wire", async () => {
		reset();
		// An OAuth group with ANTHROPIC_API_KEY in the shell. This is the
		// combination that used to send BOTH `authorization` and `x-api-key`, which
		// the API rejects — so the OAuth path was unusable for anyone who had ever
		// exported that variable.
		const harness = await appOnConfigFile(
			anthropicConfig({
				oauthToken: "configured-oauth-token",
				baseUrl: target.url,
			}),
		);
		await withClientEnv(shellFullOfEnv(decoy.url), () =>
			harness.app.request("/health?check_model=true"),
		);

		expect(wire(target, decoy)).toEqual({
			target: [
				{
					method: "POST",
					path: "/v1/messages",
					headers: { authorization: "Bearer configured-oauth-token" },
				},
			],
			decoy: [],
		});
	});

	test("case 3b — the apiKey branch: x-api-key only, never the shell's bearer", async () => {
		reset();
		const harness = await appOnConfigFile(
			anthropicConfig({ apiKey: "configured-api-key", baseUrl: target.url }),
		);
		await withClientEnv(shellFullOfEnv(decoy.url), () =>
			harness.app.request("/health?check_model=true"),
		);

		expect(wire(target, decoy)).toEqual({
			target: [
				{
					method: "POST",
					path: "/v1/messages",
					headers: { "x-api-key": "configured-api-key" },
				},
			],
			decoy: [],
		});
	});

	/**
	 * Case 2 — no `baseUrl` configured at all.
	 *
	 * ⚠️ Our own default is `https://api.anthropic.com`, a real host, so this is
	 * the one case that cannot be purely receiver-side: left alone it would make a
	 * genuine outbound call. A GLOBAL fetch stub is not an option either — it would
	 * make the decoy unreachable, and then "the decoy caught nothing" is a
	 * tautology rather than evidence.
	 *
	 * So the stub refuses EXACTLY ONE host and forwards everything else to the real
	 * fetch. The decoy keeps its teeth: in the failure direction the request really
	 * would reach it and it really would testify. And the assertion is two POSITIVE
	 * facts — the blocked request targeted `api.anthropic.com`, and the decoy caught
	 * nothing — because "the decoy is silent" alone also passes when nothing was
	 * sent at all.
	 */
	test("case 2 — no baseUrl configured: we target the default host, not the env's", async () => {
		reset();
		const harness = await appOnConfigFile(
			anthropicConfig({ apiKey: "configured-api-key" }),
		);

		const realFetch = globalThis.fetch;
		const blocked: string[] = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const request = new Request(input, init);
			const origin = new URL(request.url).origin;
			if (origin !== "https://api.anthropic.com") {
				// Transparent for every other host — that is what keeps the decoy live.
				return realFetch(input as Parameters<typeof realFetch>[0], init);
			}
			blocked.push(origin);
			return new Response(
				JSON.stringify({ type: "error", error: { message: "blocked" } }),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;
		try {
			await withClientEnv(shellFullOfEnv(decoy.url), () =>
				harness.app.request("/health?check_model=true"),
			);
		} finally {
			globalThis.fetch = realFetch;
		}

		// Both facts in one assertion, for the reason `wire` explains: a request
		// happened and was aimed at our default host, and the decoy — reachable
		// throughout — caught nothing.
		expect({ blocked, decoy: decoy.received }).toEqual({
			blocked: ["https://api.anthropic.com"],
			decoy: [],
		});
	});

	// ── Door 2: the plugin facility ──

	/** One `createLLM(...).run()` with a shell full of env, swallowing the 400. */
	async function facilityCall(group: {
		apiKey?: string;
		oauthToken?: string;
		baseUrl?: string;
	}): Promise<unknown> {
		let error: unknown;
		await withClientEnv(shellFullOfEnv(decoy.url), async () => {
			const llm = createLLM({
				authGroup: { provider: "anthropic", ...group },
				model: TEST_MODEL,
			});
			await llm.run({ user: "hi" }).catch((e) => {
				error = e;
			});
		});
		return error;
	}

	test("createLLM: the configured apiKey goes to the configured host, alone", async () => {
		reset();
		await facilityCall({ apiKey: "configured-api-key", baseUrl: target.url });

		expect(wire(target, decoy)).toEqual({
			target: [
				{
					method: "POST",
					path: "/v1/messages",
					headers: { "x-api-key": "configured-api-key" },
				},
			],
			decoy: [],
		});
	});

	test("createLLM: the OAuth branch sends one credential, not two", async () => {
		reset();
		await facilityCall({
			oauthToken: "configured-oauth-token",
			baseUrl: target.url,
		});

		expect(wire(target, decoy)).toEqual({
			target: [
				{
					method: "POST",
					path: "/v1/messages",
					headers: { authorization: "Bearer configured-oauth-token" },
				},
			],
			decoy: [],
		});
	});

	test("createLLM: a credential-less group sends nothing, and says what is missing", async () => {
		reset();
		// Positive control, in the same test: the very same door DOES reach the
		// endpoint when a credential is configured. Without it, "nothing arrived"
		// is also what a broken fixture produces.
		await facilityCall({ apiKey: "configured-api-key", baseUrl: target.url });
		expect(target.received.length).toBe(1);

		reset();
		const error = await facilityCall({ baseUrl: target.url });
		expect(String(error)).toContain("Could not resolve authentication method");
		expect(wire(target, decoy)).toEqual({ target: [], decoy: [] });
	});

	/**
	 * An EMPTY credential is "none", not a credential of length zero.
	 *
	 * `""` is reachable: it is what a hand-edited `config.json` holds after someone
	 * clears the field, and it is how the global config layer spells "not chosen".
	 *
	 * ⚠️ This test does NOT distinguish `apiKey || null` from `apiKey ?? null`, and
	 * the reason is worth more than the test. I wrote it believing it would — that
	 * `??` would put `""` in the slot and send `x-api-key: ""` — and the mutation
	 * SURVIVED. Measured: the SDK builds that header and then `validateHeaders`
	 * refuses anyway, so `""` and `null` are the same outcome for that slot and the
	 * mutant is equivalent rather than uncaught. The asymmetry is on the OTHER slot:
	 * `authToken: ""` emits `Authorization: Bearer` with nothing after it and the
	 * request IS sent. Unreachable through our code — `useOAuth` requires a truthy
	 * oauthToken — which is why this asserts the guarantee that IS ours rather than
	 * pinning the SDK's behaviour.
	 */
	test("an empty-string credential is none, not an empty credential", async () => {
		reset();
		const error = await facilityCall({ apiKey: "", baseUrl: target.url });
		expect(String(error)).toContain("Could not resolve authentication method");
		expect(wire(target, decoy)).toEqual({ target: [], decoy: [] });
	});

	// ── Door 3: OpenAI ──

	test("streamResponsesAPI: no org, no project, no shell key, no shell host", async () => {
		reset();
		await withClientEnv(shellFullOfEnv(decoy.url), async () => {
			const gen = streamResponsesAPI({
				endpoint: `${target.url}/v1/responses`,
				credentials: staticCredential("configured-token"),
				body: {
					model: "gpt-4.1-mini",
					instructions: "test",
					input: [],
					tools: [],
					stream: true,
					store: false,
				} as Parameters<typeof streamResponsesAPI>[0]["body"],
				maxRetries: 0,
			});
			await (async () => {
				let next = await gen.next();
				while (!next.done) next = await gen.next();
			})().catch(() => {});
		});

		// The org/project leak happens at HEADER CONSTRUCTION, not at a constructor
		// field, so a receiver is the only thing that can see it.
		expect(wire(target, decoy)).toEqual({
			target: [
				{
					method: "POST",
					path: "/v1/responses",
					headers: { authorization: "Bearer configured-token" },
				},
			],
			decoy: [],
		});
	});
});
