/**
 * The env-var fixture for tests about what a provider SDK client ends up
 * holding.
 *
 * One list and one helper for both vendors, because this is consumed at four
 * doors that build a client independently — `AnthropicCompatibleProvider`'s
 * constructor, `createAnthropicClient` in `llm.ts`, the `check_model` handler in
 * `runtime.ts`, and `streamResponsesAPI` in the OpenAI provider. Two copies of
 * the list would drift, and the copy that stops pinning a name goes on passing.
 */

/**
 * Every env name that can change which credential a provider client holds, which
 * host it talks to, or who gets billed for the call.
 *
 * All of them are read by the SDKs themselves, as DEFAULT PARAMETERS or as an
 * `=== undefined` fallback, which is why a slot we leave out is a slot the
 * environment fills. `CLAUDE_CODE_OAUTH_TOKEN` is the one exception: it was ours
 * until 289a3bf2 deleted the read, and it stays here so a revert of that line is
 * still pinned.
 *
 * ⚠️ `ANTHROPIC_WEBHOOK_SIGNING_KEY` and `OPENAI_WEBHOOK_SECRET` are
 * deliberately absent. Both SDKs read them; neither decides a credential, a host
 * or an attribution for us, and we do not use webhooks.
 */
export const SDK_CLIENT_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
	"OPENAI_ORG_ID",
	"OPENAI_PROJECT_ID",
] as const;

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as PromiseLike<unknown>).then === "function"
	);
}

/**
 * Run `fn` with exactly `vars` set among those names — every other one deleted —
 * restoring all of them afterwards on every path.
 *
 * If `fn` returns a promise the restore is deferred until it settles, because env
 * has to still be in place when the client is CONSTRUCTED.
 *
 * ⭐ CORRECTION to the note written here one day earlier, which said the deferral
 * "changes no outcome" because all four doors built their client in the
 * SYNCHRONOUS PREFIX of the call. It is LOAD-BEARING as of the change that made
 * `streamResponsesAPI` hand the credential SOURCE to the SDK: that generator now
 * awaits `credentials()` for the account-id header before `new OpenAI(...)`, so
 * its door sits in the fragile row. MEASURED both ways, with the org/project
 * `null`s deleted so production really does leak: deferral intact → the door
 * test is RED and names the two shell headers; deferral removed → the same
 * vulnerable production is GREEN. **The future-proofing became the only thing
 * keeping that test able to fail, one day after it was written off as
 * theoretical** — which is the argument for building it, not against it.
 * `sdk-client-env.test.ts` pins both halves.
 *
 * ⚠️ Both SDKs snapshot `globalThis.fetch` in their constructor
 * (`this.fetch = options.fetch ?? getDefaultFetch()`), so a test that also
 * intercepts fetch must install the stub BEFORE the client is built. Get that
 * order wrong and the call goes to the real api.openai.com / api.anthropic.com
 * and reports an empty header set — a clean-looking false negative. Measured,
 * from a probe that did exactly that.
 *
 * Deleting the ones we are not setting is not tidiness, and it is MEASURED
 * rather than reasoned: with both `??`s restored — the shape an actual revert of
 * 289a3bf2 has, since the two lines went together — and this loop removed, the
 * CLAUDE_CODE_OAUTH_TOKEN test PASSES on a machine whose shell holds
 * ANTHROPIC_API_KEY, and fails with the loop in place. `useOAuth =
 * Boolean(oauthToken && !apiKey)`, so an ambient key suppresses the branch the
 * test is watching for. (Restoring only the oauth line is red either way,
 * because then nothing reads ANTHROPIC_API_KEY at all.) A fixture has to pin
 * every input the branch reads, or its redness depends on whose shell it ran in
 * — and matrix developers plausibly do hold that variable.
 *
 * Restoring is equally load-bearing in the other direction: a leaked
 * ANTHROPIC_API_KEY pollutes every later test that builds a client, in the
 * direction that makes them look like they work. Verified both ways — absent
 * before stays absent after, and a pre-existing value comes back byte-identical.
 */
export function withClientEnv<T>(
	vars: Partial<Record<(typeof SDK_CLIENT_ENV)[number], string>>,
	fn: () => T,
): T {
	const saved = SDK_CLIENT_ENV.map(
		(k) => [k, process.env[k]] as const satisfies readonly [string, unknown],
	);
	const restore = () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};
	let deferred = false;
	try {
		for (const k of SDK_CLIENT_ENV) delete process.env[k];
		for (const [k, v] of Object.entries(vars)) process.env[k] = v;
		const out = fn();
		if (isThenable(out)) {
			deferred = true;
			return Promise.resolve(out).finally(restore) as T;
		}
		return out;
	} finally {
		if (!deferred) restore();
	}
}
