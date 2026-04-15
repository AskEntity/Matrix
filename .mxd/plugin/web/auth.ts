/**
 * Auth fetch context for plugin.
 * Plugin receives authenticated fetch from daemon shell via React context.
 * Plugin NEVER manages tokens — shell owns auth.
 */
import { createContext, useContext } from "react";

export type AuthFetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const AuthFetchContext = createContext<AuthFetchFn>(globalThis.fetch);

export const AuthFetchProvider = AuthFetchContext.Provider;

/** Hook: get authenticated fetch from shell-provided context. */
export function useAuthFetch(): AuthFetchFn {
	return useContext(AuthFetchContext);
}

/** For SSE EventSource URLs that can't use fetch — shell provides raw token getter. */
export type GetTokenFn = () => string | null;

const GetTokenContext = createContext<GetTokenFn>(() => null);

export const GetTokenProvider = GetTokenContext.Provider;

/** Hook: get raw auth token (for EventSource query params). */
export function useGetToken(): GetTokenFn {
	return useContext(GetTokenContext);
}
