/**
 * Auth context re-export for plugin code.
 * Imports from "@mxd/auth-context" — shared via importmap.
 * Both shell and plugin resolve to the same module → same React context instance.
 */
export {
	type AuthFetchFn,
	AuthFetchProvider,
	type GetTokenFn,
	GetTokenProvider,
	useAuthFetch,
	useGetToken,
} from "@mxd/auth-context";
