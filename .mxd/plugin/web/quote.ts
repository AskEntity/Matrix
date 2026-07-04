/**
 * Selection → quote-to-input ("Ask Matrix") pure helpers.
 *
 * All logic behind the floating "Ask Matrix" button that doesn't need React
 * or live DOM layout lives here so it can be unit-tested directly:
 *   - selectionQuoteText: validate a Selection against the log container
 *   - toBlockquote / insertQuote: markdown blockquote transform applied to
 *     the InputBar draft
 *   - quoteButtonPosition: floating button placement with viewport clamping
 *
 * Consumers: ActivityLog.tsx (selection detection + button placement),
 * InputBar.tsx (draft insertion).
 */

/** Minimal structural subset of DOM Selection used by selectionQuoteText. */
export interface SelectionLike<N> {
	isCollapsed: boolean;
	rangeCount: number;
	anchorNode: N | null;
	focusNode: N | null;
	toString(): string;
}

/** Minimal structural subset of DOM Node used as the container. */
export interface ContainerLike<N> {
	contains(node: N | null): boolean;
}

/**
 * Extract quotable text from a selection, or null when the selection is not
 * a valid quote source: empty/collapsed, whitespace-only, or not fully
 * contained in the log container (both endpoints must be inside).
 */
export function selectionQuoteText<N>(
	sel: SelectionLike<N> | null,
	container: ContainerLike<N> | null,
): string | null {
	if (!sel || !container) return null;
	if (sel.isCollapsed || sel.rangeCount === 0) return null;
	const text = sel.toString();
	if (!text.trim()) return null;
	if (!container.contains(sel.anchorNode)) return null;
	if (!container.contains(sel.focusNode)) return null;
	return text;
}

/**
 * Convert selected text into a markdown blockquote block.
 * Outer whitespace is trimmed (selections often grab a trailing newline);
 * interior structure is preserved. Interior empty lines become a bare ">"
 * so the blockquote doesn't split into two blocks.
 */
export function toBlockquote(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	return normalized
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
}

/**
 * Prepend the selected text as a blockquote to the current draft, leaving a
 * blank line after the quote so the user types their question below it.
 * Whitespace-only selections leave the draft unchanged.
 */
export function insertQuote(draft: string, selectedText: string): string {
	if (!selectedText.trim()) return draft;
	const quote = toBlockquote(selectedText);
	if (!draft) return `${quote}\n\n`;
	return `${quote}\n\n${draft}`;
}

/** Estimated button size used for viewport clamping (button auto-sizes). */
export const QUOTE_BTN_ESTIMATED_WIDTH = 120;
export const QUOTE_BTN_ESTIMATED_HEIGHT = 30;
const QUOTE_BTN_MARGIN = 8;

export interface RectLike {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/**
 * Compute a fixed-position (viewport coordinates) placement for the quote
 * button: below-right of the selection end, clamped into the viewport.
 * When there's no room below, the button flips above the selection.
 */
export function quoteButtonPosition(
	rect: RectLike,
	viewport: { width: number; height: number },
): { left: number; top: number } {
	let left = rect.right + QUOTE_BTN_MARGIN;
	const maxLeft = viewport.width - QUOTE_BTN_ESTIMATED_WIDTH - QUOTE_BTN_MARGIN;
	if (left > maxLeft) left = maxLeft;
	if (left < QUOTE_BTN_MARGIN) left = QUOTE_BTN_MARGIN;

	let top = rect.bottom + QUOTE_BTN_MARGIN;
	const maxTop =
		viewport.height - QUOTE_BTN_ESTIMATED_HEIGHT - QUOTE_BTN_MARGIN;
	if (top > maxTop) {
		// No room below — flip above the selection.
		top = rect.top - QUOTE_BTN_ESTIMATED_HEIGHT - QUOTE_BTN_MARGIN;
	}
	if (top < QUOTE_BTN_MARGIN) top = QUOTE_BTN_MARGIN;

	return { left, top };
}
