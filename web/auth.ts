/**
 * JWT token management for frontend authentication.
 *
 * Token stored in localStorage. All API calls attach it via Authorization: Bearer header.
 * SSE uses a short-lived (5min) stream token obtained from POST /auth/stream-token
 * — the long-lived session token is never exposed in URLs, proxy logs, or
 * browser history.
 */

const TOKEN_KEY = "mxd-jwt";

/** Store the JWT token after successful authentication. */
export function setToken(token: string): void {
	localStorage.setItem(TOKEN_KEY, token);
}

/** Get the stored JWT token, or null if not authenticated. */
export function getToken(): string | null {
	return localStorage.getItem(TOKEN_KEY);
}

/** Remove the stored JWT token (logout). */
export function clearToken(): void {
	localStorage.removeItem(TOKEN_KEY);
}

/**
 * Authenticated fetch wrapper. Adds Authorization: Bearer header automatically.
 * If the response is 401, clears the token (it's expired or invalid).
 */
export async function authFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const headers = new Headers(init?.headers);
	const token = getToken();
	if (token) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	const res = await fetch(input, { ...init, headers });
	// Only clear the session token when the daemon's OWN auth middleware
	// rejects it (expired, revoked, bad signature). Plugin-worker 401s
	// (e.g. a project-scoped worker not ready, or a plugin route that
	// requires its own auth) must NOT wipe the session — otherwise
	// switching back to another scope forces a full re-login.
	// Daemon auth paths: anything NOT under /api/<plugin>/*.
	if (res.status === 401) {
		const url = typeof input === "string" ? input : input.toString();
		const isPluginRoute = url.startsWith("/api/");
		if (!isPluginRoute) {
			clearToken();
		}
	}
	return res;
}
