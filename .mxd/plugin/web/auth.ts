/**
 * Auth context re-export for plugin code.
 * Imports from "@mxd/auth-context" — shared via importmap.
 * Both shell and plugin resolve to the same module → same React context instance.
 */
export {
	AuthFetchProvider,
	useAuthFetch,
	GetTokenProvider,
	useGetToken,
	type AuthFetchFn,
	type GetTokenFn,
} from "@mxd/auth-context";
