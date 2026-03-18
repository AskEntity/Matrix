/**
 * Auth routes for WebAuthn/Passkey authentication.
 *
 * Login routes (main port): /auth/status, /auth/login/options, /auth/login/verify, /auth/logout
 * Registration routes (admin port): /auth/register/options, /auth/register/verify, /auth/credentials
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
import { getCookie, setCookie } from "hono/cookie";
import {
	addCredential,
	createSession,
	getAndRemoveChallenge,
	getCredentials,
	hasCredentials,
	removeCredential,
	removeSession,
	storeChallenge,
	updateCredentialCounter,
	verifySession,
} from "../../auth.ts";
import type { WebAuthnConfig } from "../../config.ts";
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
	return `${url.protocol}//${url.host}`;
}

// ── Login Routes (Main Port) ───────────────────────────────────────────────

export function registerAuthRoutes(app: Hono, ctx: DaemonContext) {
	// Check auth status
	app.get("/auth/status", async (c) => {
		const config = getAuthConfig(ctx);
		const authPath = getAuthPath(ctx);
		const hasCreds = await hasCredentials(authPath);
		const token = getCookie(c, "og_session") ?? "";
		const authenticated = token ? await verifySession(authPath, token) : false;

		return c.json({
			enabled: config.enabled ?? false,
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

	// Verify authentication response
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

			// Create session
			const token = await createSession(authPath);
			setCookie(c, "og_session", token, {
				httpOnly: true,
				secure: true,
				sameSite: "Strict",
				path: "/",
				maxAge: 30 * 24 * 60 * 60, // 30 days
			});

			return c.json({ verified: true });
		} catch (err) {
			return c.json(
				{ error: err instanceof Error ? err.message : "Verification failed" },
				400,
			);
		}
	});

	// Logout
	app.post("/auth/logout", async (c) => {
		const authPath = getAuthPath(ctx);
		const token = getCookie(c, "og_session");
		if (token) {
			await removeSession(authPath, token);
		}
		setCookie(c, "og_session", "", {
			httpOnly: true,
			secure: true,
			sameSite: "Strict",
			path: "/",
			maxAge: 0,
		});
		return c.json({ ok: true });
	});
}

// ── Registration Routes (Admin Port) ──────────────────────────────────────

export function registerAdminAuthRoutes(app: Hono, ctx: DaemonContext) {
	// Check if credentials exist
	app.get("/auth/credentials", async (c) => {
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
		const authPath = getAuthPath(ctx);
		const existingCredentials = await getCredentials(authPath);

		const config = getAuthConfig(ctx);
		const rpID = config.rpID ?? "localhost";
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
		const authPath = getAuthPath(ctx);
		const body = (await c.req.json()) as RegistrationResponseJSON;

		const config = getAuthConfig(ctx);
		const rpID = config.rpID ?? "localhost";
		const origin = `${c.req.raw.url.startsWith("https") ? "https" : "http"}://localhost:${config.adminPort ?? 7434}`;

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
				{ error: err instanceof Error ? err.message : "Verification failed" },
				400,
			);
		}
	});

	// Delete a credential
	app.delete("/auth/credentials/:id", async (c) => {
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
		const config = getAuthConfig(ctx);

		// Auth disabled — pass through
		if (!config.enabled) return next();

		// Skip auth for localhost
		const host = c.req.header("host") ?? "";
		if (
			host.startsWith("localhost") ||
			host.startsWith("127.0.0.1") ||
			host.startsWith("[::1]")
		) {
			return next();
		}

		// Skip auth endpoints themselves
		if (c.req.path.startsWith("/auth/")) return next();

		// Check session cookie
		const cookieHeader = c.req.header("cookie") ?? "";
		const token = parseCookieValue(cookieHeader, "og_session");

		if (!token) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const authPath = getAuthPath(ctx);
		const valid = await verifySession(authPath, token);
		if (!valid) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		return next();
	};
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseCookieValue(
	cookieHeader: string,
	name: string,
): string | undefined {
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
	return match?.[1];
}

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
