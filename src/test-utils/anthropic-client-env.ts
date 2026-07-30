/**
 * The env-var fixture for tests about what an Anthropic SDK client ends up
 * holding.
 *
 * Shared rather than copied, because it is consumed at two doors that build an
 * Anthropic client independently — `AnthropicCompatibleProvider`'s constructor
 * and `createAnthropicClient` in `llm.ts` — and two copies of this list would
 * drift: the day someone adds a fourth name to one, the other goes on passing
 * while pinning less than it claims to.
 */

/**
 * Every env name that can change which credential an Anthropic client holds, or
 * which host it talks to.
 *
 * Three are the SDK's own — `@anthropic-ai/sdk`'s client constructor reads
 * ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN for any slot left `undefined`, and
 * ANTHROPIC_BASE_URL as a default parameter. CLAUDE_CODE_OAUTH_TOKEN was ours
 * until 289a3bf2 deleted the read.
 *
 * ANTHROPIC_WEBHOOK_SIGNING_KEY is deliberately absent: the SDK reads it too,
 * and it decides neither a credential nor a destination.
 */
export const ANTHROPIC_CLIENT_ENV = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/**
 * Run `fn` with exactly `vars` set among those names — every other one deleted —
 * restoring all of them afterwards on every path.
 *
 * ⚠️ `fn` must do its work SYNCHRONOUSLY, or start it and be awaited inside the
 * call. Env is read when the client is CONSTRUCTED and nowhere later, so
 * returning a client is the natural unit.
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
 * ANTHROPIC_API_KEY pollutes every later test that builds an Anthropic client,
 * in the direction that makes them look like they work. Verified both ways —
 * absent before stays absent after, and a pre-existing value comes back
 * byte-identical.
 */
export function withClientEnv<T>(
	vars: Partial<Record<(typeof ANTHROPIC_CLIENT_ENV)[number], string>>,
	fn: () => T,
): T {
	const saved = ANTHROPIC_CLIENT_ENV.map(
		(k) => [k, process.env[k]] as const satisfies readonly [string, unknown],
	);
	try {
		for (const k of ANTHROPIC_CLIENT_ENV) delete process.env[k];
		for (const [k, v] of Object.entries(vars)) process.env[k] = v;
		return fn();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}
