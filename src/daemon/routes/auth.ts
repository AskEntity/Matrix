/**
 * Auth routes for WebAuthn/Passkey authentication.
 *
 * Routes (registerAuthRoutes):
 *   /auth/status, /auth/login/options, /auth/login/verify, /auth/logout
 *   /auth/register/options, /auth/register/verify (blocked when enforced)
 *   /auth/credentials, DELETE /auth/credentials/:id (blocked when enforced)
 *
 * Post-auth: JWT tokens (stateless, survives daemon restarts).
 * Frontend sends JWT via Authorization: Bearer header.
 * SSE passes token as query param (?token=...).
 */

import { join } from "node:path";
import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Context, Hono, Next } from "hono";
import {
	addCredential,
	getAndRemoveChallenge,
	getCredentials,
	hasCredentials,
	removeCredential,
	signJWT,
	storeChallenge,
	updateCredentialCounter,
	verifyJWT,
} from "../../auth.ts";
import { isAuthEnforced, type WebAuthnConfig } from "../../config.ts";
import type { DaemonContext } from "../context.ts";

function getAuthPath(ctx: DaemonContext): string {
	return join(ctx.config.dataDir, "auth.json");
}

function getAuthConfig(ctx: DaemonContext): WebAuthnConfig {
	return ctx.globalConfig.auth ?? {};
}

function resolveRpID(ctx: DaemonContext, requestHost: string): string {
	const config = getAuthConfig(ctx);
	if (config.rpID) return config.rpID;
	// Strip port from host
	return requestHost.replace(/:\d+$/, "");
}

function resolveRpName(ctx: DaemonContext): string {
	return getAuthConfig(ctx).rpName ?? "OpenGraft";
}

function resolveOrigin(req: Request): string {
	const url = new URL(req.url);
	// Respect X-Forwarded-Proto from reverse proxies (CF Tunnel, nginx, etc.)
	const proto =
		req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
	const host = req.headers.get("host") ?? url.host;
	return `${proto}://${host}`;
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

// ── Login Routes (Main Port) ───────────────────────────────────────────────

export function registerAuthRoutes(app: Hono, ctx: DaemonContext) {
	// Check auth status
	app.get("/auth/status", async (c) => {
		const config = getAuthConfig(ctx);
		const enforced = isAuthEnforced(config);
		const authPath = getAuthPath(ctx);
		const hasCreds = await hasCredentials(authPath);
		const token = extractToken(c);
		const hasValidToken = token
			? (await verifyJWT(authPath, token)) !== null
			: false;
		// Authenticated if: valid JWT, or no credentials registered yet (first-run)
		const authenticated = hasValidToken || !hasCreds;

		return c.json({
			enabled: hasCreds,
			enforced,
			hasCredentials: hasCreds,
			authenticated,
		});
	});

	// Generate authentication options
	app.post("/auth/login/options", async (c) => {
		const authPath = getAuthPath(ctx);
		const credentials = await getCredentials(authPath);

		if (credentials.length === 0) {
			return c.json({ error: "No credentials registered" }, 400);
		}

		const host = c.req.header("host") ?? "localhost";
		const rpID = resolveRpID(ctx, host);

		const options = await generateAuthenticationOptions({
			rpID,
			allowCredentials: credentials.map((c) => ({
				id: c.credentialID,
				transports: c.transports,
			})),
			userVerification: "preferred",
		});

		// Store challenge for verification
		storeChallenge(`login:${options.challenge}`, options.challenge);

		return c.json(options);
	});

	// Verify authentication response — returns JWT token
	app.post("/auth/login/verify", async (c) => {
		const authPath = getAuthPath(ctx);
		const body = (await c.req.json()) as AuthenticationResponseJSON;
		const credentials = await getCredentials(authPath);

		const credential = credentials.find(
			(cred) => cred.credentialID === body.id,
		);
		if (!credential) {
			return c.json({ error: "Credential not found" }, 400);
		}

		const host = c.req.header("host") ?? "localhost";
		const rpID = resolveRpID(ctx, host);
		const origin = resolveOrigin(c.req.raw);

		try {
			const verification = await verifyAuthenticationResponse({
				response: body,
				expectedChallenge: (challenge: string) => {
					const stored = getAndRemoveChallenge(`login:${challenge}`);
					return stored !== null;
				},
				expectedOrigin: origin,
				expectedRPID: [rpID],
				credential: {
					id: credential.credentialID,
					publicKey: base64urlToUint8Array(credential.publicKey),
					counter: credential.counter,
					transports: credential.transports,
				},
			});

			if (!verification.verified) {
				return c.json({ error: "Verification failed" }, 400);
			}

			// Update counter
			await updateCredentialCounter(
				authPath,
				credential.credentialID,
				verification.authenticationInfo.newCounter,
			);

			// Issue JWT token
			const token = await signJWT(authPath, credential.credentialID);

			return c.json({ verified: true, token });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : "Verification failed" },
				400,
			);
		}
	});

	// Logout — JWT is stateless, so logout is client-side (remove stored token).
	// This endpoint exists for API consistency; it's a no-op on the server.
	app.post("/auth/logout", (_c) => {
		return _c.json({ ok: true });
	});

	// ── Registration routes (blocked when enforced, unless no credentials exist) ──

	/** Registration is allowed when auth is NOT enforced, or when no credentials exist (prevent lockout). */
	async function isRegistrationBlocked(): Promise<boolean> {
		if (!isAuthEnforced(getAuthConfig(ctx))) return false;
		// Allow registration even when enforced if no credentials exist yet (first-time setup)
		const authPath = getAuthPath(ctx);
		return hasCredentials(authPath);
	}

	// List credentials
	app.get("/auth/credentials", async (c) => {
		if (await isRegistrationBlocked()) {
			return c.json(
				{
					error:
						"Registration not available when auth is enforced. Use admin port or disable enforcement.",
				},
				403,
			);
		}
		const authPath = getAuthPath(ctx);
		const creds = await getCredentials(authPath);
		return c.json({
			count: creds.length,
			credentials: creds.map((cr) => ({
				id: cr.credentialID,
				createdAt: cr.createdAt,
			})),
		});
	});

	// Generate registration options
	app.post("/auth/register/options", async (c) => {
		if (await isRegistrationBlocked()) {
			return c.json(
				{
					error:
						"Registration not available when auth is enforced. Use admin port or disable enforcement.",
				},
				403,
			);
		}
		const authPath = getAuthPath(ctx);
		const existingCredentials = await getCredentials(authPath);

		const host = c.req.header("host") ?? "localhost";
		const rpID = resolveRpID(ctx, host);
		const rpName = resolveRpName(ctx);

		const options = await generateRegistrationOptions({
			rpName,
			rpID,
			userName: "admin",
			userDisplayName: "OpenGraft Admin",
			excludeCredentials: existingCredentials.map((c) => ({
				id: c.credentialID,
				transports: c.transports,
			})),
			authenticatorSelection: {
				residentKey: "preferred",
				userVerification: "preferred",
			},
			attestationType: "none",
		});

		// Store challenge for verification
		storeChallenge(`register:${options.challenge}`, options.challenge);

		return c.json(options);
	});

	// Verify registration response
	app.post("/auth/register/verify", async (c) => {
		if (await isRegistrationBlocked()) {
			return c.json(
				{
					error:
						"Registration not available when auth is enforced. Use admin port or disable enforcement.",
				},
				403,
			);
		}
		const authPath = getAuthPath(ctx);
		const body = (await c.req.json()) as RegistrationResponseJSON;

		const host = c.req.header("host") ?? "localhost";
		const rpID = resolveRpID(ctx, host);
		const origin = resolveOrigin(c.req.raw);

		try {
			const verification = await verifyRegistrationResponse({
				response: body,
				expectedChallenge: (challenge: string) => {
					const stored = getAndRemoveChallenge(`register:${challenge}`);
					return stored !== null;
				},
				expectedOrigin: origin,
				expectedRPID: rpID,
			});

			if (!verification.verified || !verification.registrationInfo) {
				return c.json({ error: "Verification failed" }, 400);
			}

			const { credential } = verification.registrationInfo;

			await addCredential(authPath, {
				credentialID: credential.id,
				publicKey: uint8ArrayToBase64url(credential.publicKey),
				counter: credential.counter,
				transports: credential.transports,
				createdAt: new Date().toISOString(),
			});

			return c.json({ verified: true });
		} catch (err) {
			return c.json(
				{
					error: err instanceof Error ? err.message : "Verification failed",
				},
				400,
			);
		}
	});

	// Delete a credential
	app.delete("/auth/credentials/:id", async (c) => {
		if (await isRegistrationBlocked()) {
			return c.json(
				{
					error:
						"Credential management not available when auth is enforced. Use admin port.",
				},
				403,
			);
		}
		const authPath = getAuthPath(ctx);
		const credId = c.req.param("id");
		const removed = await removeCredential(authPath, credId);
		if (!removed) {
			return c.json({ error: "Credential not found" }, 404);
		}
		return c.json({ ok: true });
	});
}

// ── Auth Middleware ────────────────────────────────────────────────────────

export function createAuthMiddleware(ctx: DaemonContext) {
	return async (c: Context, next: Next) => {
		// Auth is ALWAYS checked when credentials exist.
		// The `enforced` flag only controls whether new passkey registration is allowed.

		// Skip auth endpoints themselves (login, register guards are per-route)
		if (c.req.path.startsWith("/auth/")) return next();

		// Allow SPA static assets through so LoginPage can render
		if (c.req.path === "/" || c.req.path.startsWith("/web/")) return next();

		// If no credentials registered yet, pass through (can't authenticate without passkeys)
		const authPath = getAuthPath(ctx);
		if (!(await hasCredentials(authPath))) return next();

		// Check JWT from Authorization header or query param (SSE)
		const token = extractToken(c);

		if (!token) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const payload = await verifyJWT(authPath, token);
		if (!payload) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		return next();
	};
}

// ── Helpers ────────────────────────────────────────────────────────────────

function base64urlToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
	const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
	const pad = base64.length % 4;
	const padded = pad ? base64 + "=".repeat(4 - pad) : base64;
	const binary = atob(padded);
	const buf = new ArrayBuffer(binary.length);
	const bytes = new Uint8Array(buf);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function uint8ArrayToBase64url(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] ?? 0);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
