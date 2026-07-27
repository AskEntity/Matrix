/// <reference lib="dom" />
/**
 * A message must carry text — an attachment on its own is not sendable.
 *
 * This is the COMPOSER's half of that rule (the two REST doors are pinned in
 * `src/image-requires-text.test.ts`). Two gates live here and they fail in
 * different ways, so both are tested:
 *
 *   - `canSend` drives the Send button's `disabled` — the mouse path.
 *   - `handleSubmit` re-checks — the Enter path, which never touches the button.
 *
 * Relax only the button and Enter-to-send still fires; relax only the handler
 * and the button silently lies about what it will do.
 *
 * The AFFORDANCE is the third thing pinned, and it is the reason a plain
 * disabled button was not enough: the user has just attached an image and
 * nothing happens. A tooltip would only reach a hover, which the Enter path
 * does not have and a keyboard user never performs — so the hint is always
 * visible, from the moment of attaching.
 *
 * ── Two harness facts, both measured, both non-obvious ──────────────────
 *
 * ⚠️ happy-dom cannot type into a React controlled input (both the native
 * `input` event and the value-setter trick fail to fire `onChange`). So text
 * gets into the composer two other ways, each a real component path: the
 * `localStorage` draft it reads at mount, and a `quoteRequest`.
 *
 * ⚠️ A React `onKeyDown` on a text input does NOT fire under happy-dom unless
 * the element has been FOCUSED first. React's ChangeEventPlugin takes its
 * polyfill branch here and, on any key event, calls `getInstIfValueChanged`
 * with the fiber it recorded at `focusin` — null when nothing was ever
 * focused, and it throws on that before any listener runs. Probed directly:
 * without `.focus()` the handler is never reached; with it, it is.
 * **This is why the "Enter does not send" test carries a positive control** —
 * without one it would pass just as happily on a harness where Enter never
 * reaches the code under test at all.
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

const NODE_ID = "node-image-text";
/** What the user is told to DO, not what is wrong. */
const HINT = "Add some text to send";

const imgFile = (name = "a.png", type = "image/png") =>
	new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type });

async function renderInputBar(opts?: { draft?: string }) {
	// Pin the locale: `getDefaultLocale` otherwise reads navigator.language.
	localStorage.setItem("mxd-locale", "en");
	if (opts?.draft !== undefined) {
		localStorage.setItem(`mxd-prompt-draft:${NODE_ID}`, opts.draft);
	}

	const { createRoot } = await import("react-dom/client");
	const { createElement } = await import("react");
	const { InputBar } = await import(
		"../.mxd/plugin/web/components/InputBar.tsx"
	);
	const { LocaleProvider } = await import("../.mxd/plugin/web/i18n.ts");

	const sent: Array<{
		message: string;
		images?: { base64: string; mediaType: string }[];
	}> = [];

	const div = document.createElement("div");
	document.body.appendChild(div);
	const root = createRoot(div);

	let props: {
		imageDropRequest?: { files: File[]; seq: number } | null;
		quoteRequest?: { text: string; seq: number } | null;
	} = {};

	const render = (next?: Partial<typeof props>) => {
		props = { ...props, ...next };
		root.render(
			createElement(
				LocaleProvider,
				null,
				createElement(InputBar, {
					projectId: "proj-1",
					targetNodeId: NODE_ID,
					nodeMap: new Map(),
					onSend: (
						message: string,
						images?: { base64: string; mediaType: string }[],
					) => {
						sent.push({ message, images });
					},
					imageDropRequest: props.imageDropRequest ?? null,
					quoteRequest: props.quoteRequest ?? null,
				}),
			),
		);
	};

	render();
	const textarea = await waitFor(() =>
		div.querySelector<HTMLTextAreaElement>("textarea.mxd-prompt-input"),
	);
	cleanups.push(() => {
		root.unmount();
		div.remove();
	});

	const sendButton = () =>
		div.querySelector<HTMLButtonElement>("button.mxd-btn-run");
	// ⚠️ A boolean, deliberately. `expect(domNode).toBeNull()` prints the node
	// WITH its React fiber graph on failure — measured here at 182MB of output
	// and a 43-second test, which is how a caught mutation came back looking
	// like a survivor.
	const hintShown = () => div.querySelector(".mxd-image-needs-text") !== null;
	const hintText = () =>
		div.querySelector(".mxd-image-needs-text")?.textContent ?? "";
	const previews = () =>
		div.querySelectorAll<HTMLImageElement>(".mxd-image-previews img");

	/** Attach an image the same way a page-wide drop does. */
	const attachImage = async () => {
		render({ imageDropRequest: { files: [imgFile()], seq: 1 } });
		await waitFor(() => (previews().length === 1 ? true : null));
	};

	/** Put text in the composer through a real component path. */
	const insertText = async (text: string) => {
		render({ quoteRequest: { text, seq: 1 } });
		await waitFor(() => (textarea.value.includes(text) ? true : null));
	};

	/** The Enter path — never goes near the button's `disabled`. */
	const pressEnter = () => {
		textarea.focus(); // load-bearing; see the header note
		textarea.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				shiftKey: false,
				bubbles: true,
				cancelable: true,
			}),
		);
	};

	return {
		div,
		sent,
		sendButton,
		hintShown,
		hintText,
		previews,
		attachImage,
		insertText,
		pressEnter,
	};
}

describe("composer: an image alone is not sendable", () => {
	test("image attached, no text → Send is disabled and the hint says what to do", async () => {
		const { sendButton, hintShown, hintText, attachImage } =
			await renderInputBar();
		expect(sendButton()?.disabled).toBe(true); // empty composer
		expect(hintShown()).toBe(false);

		await attachImage();

		expect(sendButton()?.disabled).toBe(true);
		await waitFor(hintShown);
		expect(hintText()).toContain(HINT);
	});

	test("image attached, no text → Enter does not send (with a positive control)", async () => {
		// The second gate. The button is disabled, so Enter is the only way to
		// reach handleSubmit — and the only way to notice if the guard there
		// was relaxed.
		const { sent, attachImage, insertText, pressEnter } =
			await renderInputBar();
		await attachImage();

		pressEnter();
		await new Promise((r) => setTimeout(r, 30));
		expect(sent).toHaveLength(0);

		// POSITIVE CONTROL — the negative assertion above is only worth the
		// wiring behind it. Give the same composer text and the same keypress
		// must now send, which proves Enter reaches handleSubmit at all.
		await insertText("now with words");
		pressEnter();
		await waitFor(() => (sent.length === 1 ? true : null));
		expect(sent[0]?.images).toHaveLength(1);
	});

	test("whitespace-only text with an image is still not sendable", async () => {
		const { sendButton, hintShown, sent, attachImage, pressEnter } =
			await renderInputBar({ draft: "   \n  " });
		await attachImage();

		expect(sendButton()?.disabled).toBe(true);
		expect(hintShown()).toBe(true);
		pressEnter();
		await new Promise((r) => setTimeout(r, 30));
		expect(sent).toHaveLength(0);
	});

	test("REGRESSION: text WITH an image sends, and the image rides along", async () => {
		const { sendButton, hintShown, sent, attachImage, pressEnter } =
			await renderInputBar({ draft: "look at this" });
		await attachImage();

		expect(sendButton()?.disabled).toBe(false);
		// Nothing to tell the user — the hint is a prompt to act, not a label.
		expect(hintShown()).toBe(false);

		pressEnter();
		await waitFor(() => (sent.length === 1 ? true : null));
		expect(sent[0]?.message).toBe("look at this");
		expect(sent[0]?.images).toHaveLength(1);
	});

	test("REGRESSION: text with no image still sends", async () => {
		const { sendButton, sent, pressEnter } = await renderInputBar({
			draft: "just words",
		});
		expect(sendButton()?.disabled).toBe(false);

		pressEnter();
		await waitFor(() => (sent.length === 1 ? true : null));
		expect(sent[0]?.message).toBe("just words");
		expect(sent[0]?.images).toBeUndefined();
	});

	test("an empty composer with no image shows no hint", async () => {
		// The hint answers "you attached something and nothing happened". With
		// nothing attached there is no question to answer, and a permanent
		// line under an empty composer is noise.
		const { hintShown, sendButton } = await renderInputBar();
		await new Promise((r) => setTimeout(r, 30));
		expect(hintShown()).toBe(false);
		expect(sendButton()?.disabled).toBe(true);
	});
});
