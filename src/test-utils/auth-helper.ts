/**
 * Test-side token minting — after P1.3 every test daemon runs with auth ON
 * (no `autoInitAuth: false` escape hatch). Tests that want to hit protected
 * endpoints mint a token with this helper and attach it via Authorization
 * header on every `daemon.fetch` call.
 *
 * Usage:
 *   ```ts
 *   const token = await createTestToken(authPath); // default sub="session"
 *   const res = await daemon.fetch(
 *     new Request("http://localhost/projects", {
 *       headers: { Authorization: `Bearer ${token}` },
 *     }),
 *   );
 *   ```
 */

import {
	ensureAuthInitialized,
	type JWTSubject,
	signCLIToken,
	signSessionToken,
	signStreamToken,
} from "../auth.ts";

/**
 * Initialize auth.json at `authPath` (idempotent) and return a freshly-signed
 * token for the given subject. Session tokens have 30d TTL, CLI/stream 5min.
 *
 * The helper ensures auth is initialized before signing — callers don't have
 * to `await ensureAuthInitialized` separately.
 */
export async function createTestToken(
	authPath: string,
	opts: { sub?: JWTSubject } = {},
): Promise<string> {
	await ensureAuthInitialized(authPath);
	const sub = opts.sub ?? "session";
	switch (sub) {
		case "session":
			return signSessionToken(authPath);
		case "cli":
			return signCLIToken(authPath);
		case "stream":
			return signStreamToken(authPath);
	}
}

/**
 * Build a headers object with a Bearer token attached. Preserves any other
 * headers the caller passed in, same shape as RequestInit.headers.
 */
export function withAuth(
	token: string,
	extra?: HeadersInit,
): Record<string, string> {
	const out: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (extra) {
		const h = new Headers(extra);
		h.forEach((v, k) => {
			out[k] = v;
		});
	}
	return out;
}
