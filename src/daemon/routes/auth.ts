/**
 * Auth routes for local secret-based authentication.
 *
 * Routes (registerAuthRoutes):
 *   GET  /auth/status   — check auth status
 *   POST /auth/exchange — exchange login token for session token
 *   POST /auth/logout   — no-op (client-side token removal)
 *
 * CLI auto-auth: every CLI request carries a short-lived JWT (5min TTL).
 * Web login: user runs `og sign` → pastes login token → POST /auth/exchange → session token (30d).
 *
 * Auth is enabled when a jwtSecret exists in auth.json (auto-created on first CLI use).
 */

import { join } from "node:path";
import type { Context, Hono, Next } from "hono";
import {
	clearUsedJtis,
	consumeJti,
	hasJwtSecret,
	signSessionToken,
	verifyJWT,
} from "../../auth.ts";
import type { DaemonContext } from "../context.ts";

function getAuthPath(ctx: DaemonContext): string {
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

// ── Rate Limiting ──────────────────────────────────────────────────────────

/** In-memory rate limiter for /auth/exchange (per IP). */
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 5; // 5 failures per minute per IP

function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = rateLimiter.get(ip);
	if (!entry || entry.resetAt < now) {
		rateLimiter.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
		return true;
	}
	if (entry.count >= RATE_LIMIT_MAX) {
		return false;
	}
	entry.count++;
	return true;
}

function recordFailure(ip: string): void {
	const now = Date.now();
	const entry = rateLimiter.get(ip);
	if (!entry || entry.resetAt < now) {
		rateLimiter.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
	} else {
		entry.count++;
	}
}

/** Clear rate limiter state (for testing). */
export function clearRateLimiter(): void {
	rateLimiter.clear();
}

// ── Routes ─────────────────────────────────────────────────────────────────

export function registerAuthRoutes(app: Hono, ctx: DaemonContext) {
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

	// Exchange a login token for a session token
	app.post("/auth/exchange", async (c) => {
		const clientIP =
			c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
			c.req.header("x-real-ip") ??
			"unknown";

		if (!checkRateLimit(clientIP)) {
			return c.json({ error: "Too many requests. Try again later." }, 429);
		}

		const body = (await c.req.json()) as { token?: string };
		if (!body.token) {
			recordFailure(clientIP);
			return c.json({ error: "Missing token" }, 400);
		}

		const authPath = getAuthPath(ctx);
		const payload = await verifyJWT(authPath, body.token);

		if (!payload) {
			recordFailure(clientIP);
			return c.json({ error: "Invalid or expired token" }, 401);
		}

		// Only accept login tokens (sub: "login") with a jti
		if (payload.sub !== "login" || !payload.jti) {
			recordFailure(clientIP);
			return c.json(
				{ error: "Invalid token type. Use a login token from `og sign`." },
				401,
			);
		}

		// Check jti not reused (one-time use)
		if (!consumeJti(payload.jti)) {
			recordFailure(clientIP);
			return c.json({ error: "Token already used" }, 401);
		}

		// Issue long-lived session token
		const sessionToken = await signSessionToken(authPath);
		return c.json({ token: sessionToken });
	});

	// Logout — JWT is stateless, so logout is client-side (remove stored token).
	app.post("/auth/logout", (_c) => {
		return _c.json({ ok: true });
	});
}

// ── Auth Middleware ────────────────────────────────────────────────────────

export function createAuthMiddleware(ctx: DaemonContext) {
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

		// Accept any valid token type (cli, session, login)
		return next();
	};
}

// ── Testing helpers ───────────────────────────────────────────────────────

/** Reset all in-memory auth state (rate limiter + JTIs). For testing only. */
export function resetAuthState(): void {
	clearRateLimiter();
	clearUsedJtis();
}
