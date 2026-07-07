/**
 * Sidebar search/filter toggle state — a pure reducer so the toggle behaviour
 * is race-free by construction and testable without a DOM.
 *
 * WHY a reducer (not two independent `useState`s + blur handler):
 * The old design split "is the input open?" (Plugin) from "does the input clear
 * on close?" (TaskTree's blur/Escape handlers). Clicking the toggle button while
 * the input was focused fired the input's `blur` (which closed it) BEFORE the
 * button's `onClick` toggle ran — so the toggle read `open === false` and flipped
 * it back to `true`. Net effect: click-to-close re-opened the input ("又弹出来").
 *
 * Making open+query one atomic state with a single set of transitions removes the
 * competing mutation entirely: the button dispatches `toggle`, Escape dispatches
 * `close`, and there is no blur-driven close to race against.
 *
 * Invariant: a closed panel always has an empty query, so the tree is never left
 * silently narrowed by a now-hidden input.
 */

export type FilterState = {
	/** Whether the search/filter input is expanded (visible + focusable). */
	open: boolean;
	/** Current substring filter query. Always "" while `open` is false. */
	query: string;
};

export type FilterAction =
	| { type: "toggle" }
	| { type: "close" }
	| { type: "setQuery"; query: string };

export const INITIAL_FILTER_STATE: FilterState = { open: false, query: "" };

export function filterReducer(
	state: FilterState,
	action: FilterAction,
): FilterState {
	switch (action.type) {
		case "toggle":
			// Opening preserves the (already-empty) query; closing clears it.
			return state.open
				? { open: false, query: "" }
				: { open: true, query: state.query };
		case "close":
			return { open: false, query: "" };
		case "setQuery":
			// Ignore query updates while closed — the input is only interactable
			// when open. Keeps the "closed ⟹ empty query" invariant airtight.
			return state.open ? { ...state, query: action.query } : state;
	}
}
