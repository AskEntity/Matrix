/// <reference lib="dom" />
/**
 * useWindowFileDrop — the page-wide drop hook. Drives an overlay flag and
 * forwards dropped image files, while STRICTLY ignoring internal HTML5 drags
 * (the red line: task-tree / tab reorder must keep working).
 *
 * Events are dispatched on document.body with bubbles:true so they exercise the
 * real capture (overlay) + bubble (attach/preventDefault) window listeners.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
	GlobalRegistrator.register();
	(
		globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
	).IS_REACT_ACT_ENVIRONMENT = false;
});

afterAll(async () => {
	await new Promise((r) => setTimeout(r, 20));
	GlobalRegistrator.unregister();
});

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

async function waitFor<T>(
	fn: () => T,
	timeoutMs = 1000,
): Promise<NonNullable<T>> {
	const start = Date.now();
	for (;;) {
		const value = fn();
		if (value) return value as NonNullable<T>;
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 5));
	}
}

const imgFile = (name = "a.png", type = "image/png") =>
	new File([new Uint8Array([137, 80, 78, 71])], name, { type });

/** Dispatch a synthetic DragEvent on document.body (bubbles to window). */
function dispatchDrag(
	type: string,
	dt: { types: string[]; files: File[] },
): Event {
	const ev = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(ev, "dataTransfer", {
		value: { types: dt.types, files: dt.files, dropEffect: "" },
	});
	document.body.dispatchEvent(ev);
	return ev;
}

async function renderProbe() {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { useWindowFileDrop } = await import("../.mxd/plugin/web/file-drop.ts");

	const dropped: File[][] = [];
	function Probe() {
		const dragging = useWindowFileDrop((files) => dropped.push(files));
		return createElement("div", {
			"data-testid": "probe",
			"data-dragging": String(dragging),
		});
	}

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);
	root.render(createElement(Probe));
	const probe = await waitFor(() =>
		div.querySelector<HTMLElement>('[data-testid="probe"]'),
	);
	cleanups.push(() => {
		root.unmount();
		div.remove();
	});
	return {
		dropped,
		dragging: () => probe.getAttribute("data-dragging"),
	};
}

describe("useWindowFileDrop", () => {
	test("shows the overlay while an image file is dragged over the page", async () => {
		const { dragging } = await renderProbe();
		expect(dragging()).toBe("false");
		dispatchDrag("dragenter", { types: ["Files"], files: [] });
		await waitFor(() => dragging() === "true");
	});

	test("drop attaches image files, hides overlay, suppresses browser default", async () => {
		const { dropped, dragging } = await renderProbe();
		dispatchDrag("dragenter", { types: ["Files"], files: [] });
		await waitFor(() => dragging() === "true");

		const file = imgFile();
		const ev = dispatchDrag("drop", { types: ["Files"], files: [file] });

		// preventDefault + attach are synchronous inside the listener.
		expect(ev.defaultPrevented).toBe(true);
		expect(dropped).toHaveLength(1);
		expect(dropped[0]?.[0]).toBe(file);
		// Overlay hidden again after the drop.
		await waitFor(() => dragging() === "false");
	});

	test("dragover with files calls preventDefault and sets dropEffect=copy", async () => {
		await renderProbe();
		const ev = dispatchDrag("dragover", { types: ["Files"], files: [] });
		expect(ev.defaultPrevented).toBe(true);
		expect(
			(ev as unknown as { dataTransfer: DataTransfer }).dataTransfer.dropEffect,
		).toBe("copy");
	});

	test("RED LINE: internal HTML5 drag (text/plain) is never intercepted", async () => {
		const { dropped, dragging } = await renderProbe();
		// dragover: default NOT prevented → the browser/tree owns the drag.
		const over = dispatchDrag("dragover", { types: ["text/plain"], files: [] });
		expect(over.defaultPrevented).toBe(false);
		// dragenter: overlay must NOT appear for an internal drag.
		dispatchDrag("dragenter", { types: ["text/plain"], files: [] });
		await new Promise((r) => setTimeout(r, 30));
		expect(dragging()).toBe("false");
		// drop: not intercepted, nothing attached.
		const drop = dispatchDrag("drop", {
			types: ["text/plain"],
			files: [imgFile()],
		});
		expect(drop.defaultPrevented).toBe(false);
		expect(dropped).toHaveLength(0);
	});

	test("drop with only non-image files: default suppressed, nothing attached", async () => {
		const { dropped, dragging } = await renderProbe();
		dispatchDrag("dragenter", { types: ["Files"], files: [] });
		await waitFor(() => dragging() === "true");
		const ev = dispatchDrag("drop", {
			types: ["Files"],
			files: [new File([], "notes.txt", { type: "text/plain" })],
		});
		expect(ev.defaultPrevented).toBe(true); // still stop the browser opening it
		expect(dropped).toHaveLength(0); // but nothing to attach
		await waitFor(() => dragging() === "false");
	});

	test("enter/leave counter keeps the overlay until the last leave", async () => {
		const { dragging } = await renderProbe();
		dispatchDrag("dragenter", { types: ["Files"], files: [] });
		dispatchDrag("dragenter", { types: ["Files"], files: [] });
		await waitFor(() => dragging() === "true");
		dispatchDrag("dragleave", { types: ["Files"], files: [] });
		await new Promise((r) => setTimeout(r, 30));
		expect(dragging()).toBe("true"); // depth still 1
		dispatchDrag("dragleave", { types: ["Files"], files: [] });
		await waitFor(() => dragging() === "false");
	});

	test("listeners are removed on unmount (no attach after teardown)", async () => {
		const { dropped } = await renderProbe();
		// Unmount now (pop the cleanup we just registered).
		cleanups.pop()?.();
		dispatchDrag("drop", { types: ["Files"], files: [imgFile()] });
		await new Promise((r) => setTimeout(r, 30));
		expect(dropped).toHaveLength(0);
	});
});
