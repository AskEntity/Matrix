/**
 * Who moved the activity log?
 *
 * The scroll offset of one element is written by six different places in this
 * codebase plus the browser itself, and every scroll complaint so far has
 * started with a user who could describe the movement but not its cause. The
 * expensive part of diagnosing those has never been the fix — it has been
 * working out which writer fired, which took a full survey of the subsystem
 * each time.
 *
 * This records that. Every programmatic write goes through
 * `attributeScrollWrite`, and while tracing is on a per-frame sampler notices
 * any movement that no writer claimed — which is the browser: a clamp when the
 * content shrinks, or a scroll-anchoring adjustment, neither of which is
 * distinguishable from a user scroll by looking at events.
 *
 * OFF by default and free when off: one boolean check per write, no sampler,
 * no allocation. Turn it on in the browser console:
 *
 *     localStorage.setItem("mxd-debug-scroll", "true"); location.reload();
 *     __mxdScrollTrace()        // the ring buffer, newest last
 *     console.table(__mxdScrollTrace())
 *
 * Reading it: `who` is the writer, or "external" for movement nobody claimed.
 * `from`/`to` are the offset either side of the write, and `range` is
 * scrollHeight - clientHeight at that moment — a shrinking range is what turns
 * an ordinary-looking scroll event into a clamp (see scroll.ts).
 */

/** Every programmatic writer of the activity log's scroll offset. */
export type ScrollWriter =
	/** New entries arrived while following. */
	| "follow-content"
	/** Streaming growth with no new entry — the MutationObserver path. */
	| "follow-stream"
	/** Explicit "take me to the newest" — the ↓ and Follow buttons, rollback. */
	| "jump-request"
	/** Keeping the reading position while older history is prepended. */
	| "load-older-anchor"
	/** Keeping the reading position while the lazy window renders more. */
	| "lazy-render-anchor"
	/** Jumping to a specific entry after a cross-task navigation. */
	| "navigate-entry"
	/** That navigation failed to find its target and fell back to the bottom. */
	| "navigate-fallback"
	/** Jumping back to the message loaded in the composer for editing. */
	| "edit-indicator";

export type ScrollTraceEntry = {
	/** ms since page load. */
	t: number;
	who: ScrollWriter | "external";
	from: number;
	to: number;
	/** scrollHeight - clientHeight when the movement was observed. */
	range: number;
	/** For "external": the best guess at which browser behavior did it. */
	detail?: string;
};

const STORAGE_KEY = "mxd-debug-scroll";
const MAX_ENTRIES = 300;

let enabledCache: boolean | null = null;
const trace: ScrollTraceEntry[] = [];

/** Read once per page load — this is checked on every scroll write. */
function isEnabled(): boolean {
	if (enabledCache === null) {
		try {
			enabledCache = localStorage.getItem(STORAGE_KEY) === "true";
		} catch {
			enabledCache = false;
		}
		if (enabledCache) {
			(globalThis as unknown as Record<string, unknown>).__mxdScrollTrace =
				() => [...trace];
			console.info(
				"[mxd] scroll attribution on — call __mxdScrollTrace() to read it",
			);
		}
	}
	return enabledCache;
}

function push(entry: ScrollTraceEntry): void {
	trace.push(entry);
	if (trace.length > MAX_ENTRIES) trace.shift();
}

/**
 * Run a scroll write, tagged with who is doing it.
 *
 * `apply` must be the whole write — including `scrollIntoView`, which moves the
 * offset without ever naming it. Behaviour is identical when tracing is off.
 */
export function attributeScrollWrite(
	el: HTMLElement | null | undefined,
	who: ScrollWriter,
	apply: () => void,
): void {
	if (!el || !isEnabled()) {
		apply();
		return;
	}
	const from = el.scrollTop;
	apply();
	push({
		t: Math.round(performance.now()),
		who,
		from,
		to: el.scrollTop,
		range: el.scrollHeight - el.clientHeight,
	});
}

/**
 * Watch for movement no writer claimed, one sample per frame.
 *
 * A per-frame poll rather than a scroll listener because the interesting case
 * does not fire one: a scroll-anchoring adjustment silently rewrites the offset
 * to hold the visible content still when something above it changes size, and
 * that is invisible to every event listener.
 *
 * Returns a stop function; a no-op (and no sampler) when tracing is off.
 */
export function startScrollAttributionSampler(
	getEl: () => HTMLElement | null,
): () => void {
	if (!isEnabled()) return () => {};
	let last = getEl()?.scrollTop ?? 0;
	let running = true;
	const tick = () => {
		if (!running) return;
		const el = getEl();
		if (el) {
			const now = el.scrollTop;
			if (Math.abs(now - last) > 0.5) {
				const claimed = trace[trace.length - 1];
				const isOurEcho =
					claimed &&
					claimed.who !== "external" &&
					Math.abs(claimed.to - now) < 1;
				if (!isOurEcho) {
					const range = el.scrollHeight - el.clientHeight;
					push({
						t: Math.round(performance.now()),
						who: "external",
						from: last,
						to: now,
						range,
						detail:
							now > last
								? "user scrolled down, or content grew above the viewport"
								: range < last
									? "clamped — the range shrank below the offset"
									: "user scrolled up, or scroll anchoring adjusted",
					});
				}
				last = now;
			} else {
				last = now;
			}
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	return () => {
		running = false;
	};
}

/** Test seam: forget the cached flag and the recorded trace. */
export function _resetScrollAttribution(): void {
	enabledCache = null;
	trace.length = 0;
}

/** Test seam: read the trace without going through the global. */
export function _getScrollTrace(): ScrollTraceEntry[] {
	return [...trace];
}
