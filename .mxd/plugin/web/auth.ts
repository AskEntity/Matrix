/**
 * Auth context re-export for plugin code.
 * The REAL definitions live in web/auth-context.ts (shell owns them).
 * Plugin code imports from this file for convenience — same React context instance.
 */
export {
	AuthFetchProvider,
	useAuthFetch,
	GetTokenProvider,
	useGetToken,
	type AuthFetchFn,
	type GetTokenFn,
} from "../../../web/auth-context.ts";
