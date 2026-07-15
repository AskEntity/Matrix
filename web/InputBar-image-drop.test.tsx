/// <reference lib="dom" />
/**
 * InputBar consumes a one-shot imageDropRequest (files dropped anywhere on the
 * page, routed by Plugin.tsx) and runs them through the SAME handleFileToBase64
 * path as paste / click-upload → a preview thumbnail appears in the composer.
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
	localStorage.clear();
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
	new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type });

async function renderInputBar() {
	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { InputBar } = await import(
		"../.mxd/plugin/web/components/InputBar.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	const render = (props?: {
		imageDropRequest?: { files: File[]; seq: number } | null;
	}) => {
		root.render(
			createElement(
				LocaleProvider,
				null,
				createElement(InputBar, {
					projectId: "proj-1",
					targetNodeId: "node-drop-test",
					nodeMap: new Map(),
					onSend: () => {},
					imageDropRequest: props?.imageDropRequest ?? null,
				}),
			),
		);
	};

	render();
	await waitFor(() =>
		div.querySelector<HTMLTextAreaElement>("textarea.mxd-prompt-input"),
	);
	cleanups.push(() => {
		root.unmount();
		div.remove();
	});
	const previews = () =>
		div.querySelectorAll<HTMLImageElement>(".mxd-image-previews img");
	return { div, previews, rerender: render };
}

describe("InputBar image drop request", () => {
	test("a dropped image request produces a composer preview (data URL)", async () => {
		const { previews, rerender } = await renderInputBar();
		expect(previews()).toHaveLength(0);

		rerender({ imageDropRequest: { files: [imgFile()], seq: 1 } });
		const img = await waitFor(() => previews()[0] ?? null);
		expect(img.src.startsWith("data:image/png;base64,")).toBe(true);
	});

	test("multiple files in one drop → multiple previews", async () => {
		const { previews, rerender } = await renderInputBar();
		rerender({
			imageDropRequest: {
				files: [imgFile("a.png"), imgFile("b.jpg", "image/jpeg")],
				seq: 1,
			},
		});
		await waitFor(() => (previews().length === 2 ? true : null));
	});

	test("seq bump (a second drop) appends more previews", async () => {
		const { previews, rerender } = await renderInputBar();
		rerender({ imageDropRequest: { files: [imgFile()], seq: 1 } });
		await waitFor(() => (previews().length === 1 ? true : null));
		rerender({ imageDropRequest: { files: [imgFile("b.png")], seq: 2 } });
		await waitFor(() => (previews().length === 2 ? true : null));
	});

	test("no request → no previews", async () => {
		const { previews } = await renderInputBar();
		await new Promise((r) => setTimeout(r, 30));
		expect(previews()).toHaveLength(0);
	});
});
