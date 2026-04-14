/**
 * JWT token management for frontend authentication.
 *
 * Token stored in localStorage. All API calls attach it via Authorization: Bearer header.
 * SSE EventSource passes token as query param (can't set custom headers).
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
	if (res.status === 401) {
		clearToken();
	}
	return res;
}
