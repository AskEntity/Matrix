/**
 * Auth routes for local secret-based authentication.
 *
 * Routes (registerAuthRoutes):
 *   GET  /auth/status   — check auth status
 *   POST /auth/logout   — no-op (client-side token removal)
 *
 * CLI auto-auth: every CLI request carries a short-lived JWT (5min TTL).
 * Web login: challenge-response — browser generates RSA-OAEP keypair,
 * CLI encrypts session JWT (30d) with the public key, browser decrypts locally.
 *
 * Auth is enabled when a jwtSecret exists in auth.json (auto-created on first CLI use).
 */

import { join } from "node:path";
import type { Context, Hono, Next } from "hono";
import { hasJwtSecret, verifyJWT } from "../../auth.ts";
import type { RuntimeContext } from "../context.ts";

function getAuthPath(ctx: RuntimeContext): string {
	return join(ctx.config.dataDir, "auth.json");
}

/** Extract JWT from Authorization: Bearer header or query param. */
function extractToken(c: Context): string | null {
	// Try Authorization header first
	const authHeader = c.req.header("authorization");
	if (authHeader?.startsWith("Bearer ")) {
		return authHeader.slice(7);
	}
	// Fall back to query param (for SSE EventSource which can't set headers)
	const queryToken = c.req.query("token");
	if (queryToken) return queryToken;
	return null;
}

// ── Routes ─────────────────────────────────────────────────────────────────

export function registerAuthRoutes(app: Hono, ctx: RuntimeContext) {
	// Check auth status
	app.get("/auth/status", async (c) => {
		const authPath = getAuthPath(ctx);
		const hasSecret = await hasJwtSecret(authPath);
		const token = extractToken(c);
		const hasValidToken = token
			? (await verifyJWT(authPath, token)) !== null
			: false;
		// Authenticated if: valid JWT, or no jwtSecret yet (first-run, CLI hasn't been used)
		const authenticated = hasValidToken || !hasSecret;

		return c.json({
			enabled: hasSecret,
			authenticated,
		});
	});

	// Logout — JWT is stateless, so logout is client-side (remove stored token).
	app.post("/auth/logout", (_c) => {
		return _c.json({ ok: true });
	});
}

// ── Auth Middleware ────────────────────────────────────────────────────────

export function createAuthMiddleware(ctx: RuntimeContext) {
	return async (c: Context, next: Next) => {
		// Skip auth endpoints themselves
		if (c.req.path.startsWith("/auth/")) return next();

		// Allow SPA static assets through so LoginPage can render
		if (c.req.path === "/" || c.req.path.startsWith("/web/")) return next();

		// If no jwtSecret exists yet, pass through (auth not initialized)
		const authPath = getAuthPath(ctx);
		if (!(await hasJwtSecret(authPath))) return next();

		// Check JWT from Authorization header or query param (SSE)
		const token = extractToken(c);

		if (!token) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const payload = await verifyJWT(authPath, token);
		if (!payload) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		// Accept any valid token type (cli, session)
		return next();
	};
}

// ── Testing helpers ───────────────────────────────────────────────────────

/** Reset all in-memory auth state. For testing only. */
export function resetAuthState(): void {
	// No-op — rate limiter and JTI tracking removed with challenge-response auth
}
