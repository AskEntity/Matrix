/**
 * Sidebar search — debounced API-backed keyword/hybrid search via Orama.
 *
 * Replaces the local substring filter when the user types in the sidebar
 * search box. Results carry exact provenance (which field matched) and a
 * relevance-ranked snippet.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { useAuthFetch } from "./auth.ts";

/** One search hit from the backend (mirrors SearchHit + enriched title). */
export interface SidebarSearchHit {
	taskId: string;
	title: string;
	field: string;
	roundIndex?: number;
	snippet: string;
	score: number;
}

/**
 * Debounced search hook — calls the backend search endpoint after a delay.
 * Returns hits + loading state. Empty query → empty results immediately.
 */
export function useSidebarSearch(
	projectId: string | null,
	query: string,
	debounceMs = 300,
): { hits: SidebarSearchHit[]; loading: boolean } {
	const [hits, setHits] = useState<SidebarSearchHit[]>([]);
	const [loading, setLoading] = useState(false);
	const authFetch = useAuthFetch();
	const abortRef = useRef<AbortController | null>(null);

	const doSearch = useCallback(
		async (q: string) => {
			// Cancel any in-flight request
			abortRef.current?.abort();

			const trimmed = q.trim();
			if (!trimmed || !projectId) {
				setHits([]);
				setLoading(false);
				return;
			}

			const controller = new AbortController();
			abortRef.current = controller;
			setLoading(true);

			try {
				const res = await authFetch(api.search(projectId, trimmed, 20), {
					signal: controller.signal,
				});
				if (!res.ok) {
					setHits([]);
					return;
				}
				const data: SidebarSearchHit[] = await res.json();
				if (!controller.signal.aborted) {
					setHits(data);
				}
			} catch {
				// AbortError or network error — ignore
			} finally {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			}
		},
		[projectId, authFetch],
	);

	useEffect(() => {
		const trimmed = query.trim();
		if (!trimmed) {
			setHits([]);
			setLoading(false);
			return;
		}

		setLoading(true);
		const timer = setTimeout(() => doSearch(query), debounceMs);
		return () => clearTimeout(timer);
	}, [query, debounceMs, doSearch]);

	// Cleanup on unmount
	useEffect(() => {
		return () => abortRef.current?.abort();
	}, []);

	return { hits, loading };
}
