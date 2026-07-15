import { useEffect, useRef, useState } from "react";

/**
 * A `DataTransfer`-shaped view sufficient for drop-routing decisions. Real
 * `DataTransfer` satisfies it structurally; tests pass a plain stub (happy-dom
 * synthetic DragEvents don't carry a faithful DataTransfer).
 */
export interface DragDataView {
	types: readonly string[] | DOMStringList;
	files: FileList | File[];
}

/**
 * True iff the drag carries EXTERNAL FILES (`dataTransfer.types` includes
 * "Files"). This is THE gate that separates a file drag from an internal
 * HTML5 element drag: the task-tree reorder/reparent drags and the tab-bar
 * reorder set `dataTransfer.setData("text/plain", …)` — their `types` is
 * `["text/plain"]`, never "Files". Gating every global handler on "Files"
 * guarantees the page-wide drop NEVER intercepts an internal drag, so
 * task-tree reorder keeps working.
 */
export function isFileDrag(dt: DragDataView | null | undefined): boolean {
	if (!dt) return false;
	return Array.from(dt.types).includes("Files");
}

/** The image `File`s in a drag payload (mediaType starts with "image/"). */
export function extractImageFiles(dt: DragDataView | null | undefined): File[] {
	if (!dt) return [];
	return Array.from(dt.files).filter((f) => f.type.startsWith("image/"));
}

/**
 * Page-wide image drop: drop an image ANYWHERE on the window and it is
 * forwarded to `onImageFiles` (which routes it into the composer's existing
 * attachment flow), instead of the browser navigating to / opening the file.
 *
 * Returns `isDragging` — true while an external file is dragged over the page —
 * so the caller can render a "drop to attach" overlay.
 *
 * ── Why window listeners (not a wrapping <div>) ──
 * "Anywhere on the page" = the whole viewport regardless of DOM structure
 * (sidebar, activity log, footer). Window listeners cover it without changing
 * layout or CSS.
 *
 * ── Two-concern split: FUNCTIONAL (bubble) vs VISUAL (capture) ──
 * FUNCTIONAL — `dragover`/`drop` on the BUBBLE phase: preventDefault (suppress
 * the browser's open-the-file default + allow the drop) and attach image
 * files. Bubble phase is deliberate: InputBar's own composer `onDrop` calls
 * `stopPropagation`, so a drop landing ON the composer is handled there and
 * this window `drop` does NOT also fire → no double-attach. Drops elsewhere
 * aren't stopped, bubble up to window, and attach here.
 *
 * VISUAL — `dragenter`/`dragleave` counter + `drop` reset on the CAPTURE
 * phase: drives the overlay show/hide. Capture is deliberate: it fires before
 * any inner bubble-phase handler, so InputBar's `stopPropagation` on the
 * composer's drag/drop cannot desync the counter or leave the overlay stuck
 * (a composer drop still triggers the capture `drop` reset).
 *
 * Every handler gates on `isFileDrag`, so internal HTML5 drags pass through
 * completely untouched (the red line: task-tree reorder must keep working).
 */
export function useWindowFileDrop(
	onImageFiles: (files: File[]) => void,
): boolean {
	const [isDragging, setIsDragging] = useState(false);
	// Latest callback held in a ref so the window listeners subscribe ONCE and
	// never go stale (mirrors the ActivityLog onAtBottomChange pattern).
	const onImageFilesRef = useRef(onImageFiles);
	onImageFilesRef.current = onImageFiles;

	useEffect(() => {
		// Nesting depth of file-drag enters minus leaves; overlay shows while >0.
		let depth = 0;
		const enter = () => {
			depth += 1;
			setIsDragging(true);
		};
		const leave = () => {
			depth = Math.max(0, depth - 1);
			if (depth === 0) setIsDragging(false);
		};
		const reset = () => {
			depth = 0;
			setIsDragging(false);
		};

		// FUNCTIONAL (bubble): allow the drop + suppress the browser default.
		const onDragOver = (e: DragEvent) => {
			if (!isFileDrag(e.dataTransfer)) return;
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		};
		// FUNCTIONAL (bubble): attach image files dropped OUTSIDE the composer.
		const onDrop = (e: DragEvent) => {
			if (!isFileDrag(e.dataTransfer)) return;
			e.preventDefault();
			const images = extractImageFiles(e.dataTransfer);
			if (images.length > 0) onImageFilesRef.current(images);
		};
		// VISUAL (capture): overlay state, immune to inner stopPropagation.
		const onDragEnterCapture = (e: DragEvent) => {
			if (isFileDrag(e.dataTransfer)) enter();
		};
		const onDragLeaveCapture = (e: DragEvent) => {
			if (isFileDrag(e.dataTransfer)) leave();
		};
		const onDropCapture = (e: DragEvent) => {
			if (isFileDrag(e.dataTransfer)) reset();
		};

		window.addEventListener("dragover", onDragOver);
		window.addEventListener("drop", onDrop);
		window.addEventListener("dragenter", onDragEnterCapture, true);
		window.addEventListener("dragleave", onDragLeaveCapture, true);
		window.addEventListener("drop", onDropCapture, true);
		return () => {
			window.removeEventListener("dragover", onDragOver);
			window.removeEventListener("drop", onDrop);
			window.removeEventListener("dragenter", onDragEnterCapture, true);
			window.removeEventListener("dragleave", onDragLeaveCapture, true);
			window.removeEventListener("drop", onDropCapture, true);
		};
	}, []);

	return isDragging;
}
