/**
 * Unit tests for web-builder — covers the failure modes + invariants that the
 * "happy path" ShellApp test cannot exercise.
 *
 * Intent (what we're testing):
 *   - Failures that used to be silent now throw loud.
 *   - `projectRoot` changes do not break output (the daemon's fix is respected).
 *   - Shim cleanup always happens (even on failure).
 *   - Importmap is stable and contains the keys the shell relies on.
 *   - Output is byte-deterministic for the same input.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	buildWebAssets,
	generateBuildErrorHTML,
	generateIndexHTML,
} from "./web-builder.ts";

// ── Test harness ──
// We run all builds against the real Matrix repo root so @mxd/auth-context
// and @mxd/types actually resolve. The `projectRoot` parameter is set by the
// daemon via `new URL("..", import.meta.url)` — we mirror that here.
const MATRIX_ROOT = resolve(new URL("..", import.meta.url).pathname);
const SHELL_ENTRY = join(MATRIX_ROOT, "web", "main.tsx");
const SHELL_CSS = join(MATRIX_ROOT, "web", "styles.css");
const MATRIX_PLUGIN_ENTRY = join(
	MATRIX_ROOT,
	".mxd",
	"plugin",
	"web",
	"Plugin.tsx",
);
const MATRIX_PLUGIN_CSS = join(
	MATRIX_ROOT,
	".mxd",
	"plugin",
	"web",
	"style.css",
);

describe("buildWebAssets — happy path", () => {
	let buildDir: string;
	beforeEach(async () => {
		buildDir = await mkdtemp(join(tmpdir(), "webbuild-happy-"));
	});
	afterEach(() => {
		rmSync(buildDir, { recursive: true, force: true });
	});

	test("importmap contains the keys the shell relies on", async () => {
		const res = await buildWebAssets({
			buildDir,
			shellEntry: SHELL_ENTRY,
			shellCssPath: SHELL_CSS,
			plugins: [],
			projectRoot: MATRIX_ROOT,
		});
		// React externals
		expect(res.importmap.imports.react).toBe("/vendor/react.js");
		expect(res.importmap.imports["react-dom"]).toBe("/vendor/react-dom.js");
		expect(res.importmap.imports["react-dom/client"]).toBe(
			"/vendor/react-dom-client.js",
		);
		expect(res.importmap.imports["react/jsx-runtime"]).toBe(
			"/vendor/react-jsx-runtime.js",
		);
		expect(res.importmap.imports["react/jsx-dev-runtime"]).toBe(
			"/vendor/react-jsx-dev-runtime.js",
		);
		// Shared modules
		expect(res.importmap.imports["@mxd/auth-context"]).toBe(
			"/vendor/shared/auth-context.js",
		);
		expect(res.importmap.imports["@mxd/types"]).toBe(
			"/vendor/shared/runtime-types.js",
		);
	});

	test("plugin output goes to /app/plugin/<name>/ namespace, stable regardless of source path", async () => {
		const res = await buildWebAssets({
			buildDir,
			shellEntry: SHELL_ENTRY,
			shellCssPath: SHELL_CSS,
			plugins: [
				{
					name: "matrix",
					webEntry: MATRIX_PLUGIN_ENTRY,
					cssPath: MATRIX_PLUGIN_CSS,
					scope: "global",
				},
			],
			projectRoot: MATRIX_ROOT,
		});
		const out = res.pluginOutputs.get("matrix");
		expect(out?.jsPath).toBe("/app/plugin/matrix/index.js");
		expect(out?.cssPath).toBe("/app/plugin/matrix/style.css");
		expect(
			existsSync(join(buildDir, "app", "plugin", "matrix", "index.js")),
		).toBe(true);
		expect(
			existsSync(join(buildDir, "app", "plugin", "matrix", "style.css")),
		).toBe(true);
		expect(res.cssPaths).toContain("/app/plugin/matrix/style.css");
	});

	test("plugin without cssPath produces no cssPath in output", async () => {
		const res = await buildWebAssets({
			buildDir,
			shellEntry: SHELL_ENTRY,
			plugins: [
				{ name: "matrix", webEntry: MATRIX_PLUGIN_ENTRY, scope: "global" },
			],
			projectRoot: MATRIX_ROOT,
		});
		const out = res.pluginOutputs.get("matrix");
		expect(out?.jsPath).toBeDefined();
		expect(out?.cssPath).toBeUndefined();
		expect(
			res.cssPaths.find((p) => p.includes("/plugin/matrix/")),
		).toBeUndefined();
	});

	test("shellEntryPath is a URL path (forward slashes, not platform sep)", async () => {
		const res = await buildWebAssets({
			buildDir,
			shellEntry: SHELL_ENTRY,
			plugins: [],
			projectRoot: MATRIX_ROOT,
		});
		expect(res.shellEntryPath).toBe("/app/web/main.js");
		// Must not leak backslashes on any OS
		expect(res.shellEntryPath).not.toContain("\\");
	});

	test("cleans up _vendor_shims dir in projectRoot", async () => {
		const shimDir = join(MATRIX_ROOT, "_vendor_shims");
		await buildWebAssets({
			buildDir,
			shellEntry: SHELL_ENTRY,
			plugins: [],
			projectRoot: MATRIX_ROOT,
		});
		expect(existsSync(shimDir)).toBe(false);
	});

	test("two builds of the same input produce byte-identical shell JS", async () => {
		const buildDir2 = await mkdtemp(join(tmpdir(), "webbuild-det-"));
		try {
			await buildWebAssets({
				buildDir,
				shellEntry: SHELL_ENTRY,
				plugins: [],
				projectRoot: MATRIX_ROOT,
			});
			await buildWebAssets({
				buildDir: buildDir2,
				shellEntry: SHELL_ENTRY,
				plugins: [],
				projectRoot: MATRIX_ROOT,
			});
			const shell1 = readFileSync(join(buildDir, "app", "web", "main.js"));
			const shell2 = readFileSync(join(buildDir2, "app", "web", "main.js"));
			expect(shell1.equals(shell2)).toBe(true);
		} finally {
			rmSync(buildDir2, { recursive: true, force: true });
		}
	});
});

describe("buildWebAssets — failures are loud", () => {
	let buildDir: string;
	let tempRoot: string;

	beforeEach(async () => {
		buildDir = await mkdtemp(join(tmpdir(), "webbuild-fail-"));
		tempRoot = await mkdtemp(join(tmpdir(), "webbuild-root-"));
	});
	afterEach(() => {
		rmSync(buildDir, { recursive: true, force: true });
		rmSync(tempRoot, { recursive: true, force: true });
		// Defense-in-depth: remove any shim leak from the real repo too.
		rmSync(join(MATRIX_ROOT, "_vendor_shims"), {
			recursive: true,
			force: true,
		});
	});

	test("shared module build failure throws (missing @mxd/auth-context source)", async () => {
		// Scaffold a minimal projectRoot that can get PAST the vendor step
		// (symlink node_modules from the real repo) but fails when building
		// web/auth-context.ts — which is missing. Used to be silently logged;
		// the shell then 404'd /vendor/shared/auth-context.js at runtime.
		const fakeWebDir = join(tempRoot, "web");
		mkdirSync(fakeWebDir, { recursive: true });
		writeFileSync(join(fakeWebDir, "main.tsx"), `export default null;\n`);
		// auth-context.ts intentionally missing → shared module build must throw.
		// runtime-types.ts provided so that if @mxd/auth-context is ever
		// reordered, the test still pins the failure on auth-context specifically.
		writeFileSync(
			join(fakeWebDir, "runtime-types.ts"),
			`export type X = never;\n`,
		);
		const { symlinkSync } = await import("node:fs");
		symlinkSync(
			join(MATRIX_ROOT, "node_modules"),
			join(tempRoot, "node_modules"),
			"dir",
		);
		await expect(
			buildWebAssets({
				buildDir,
				shellEntry: join(fakeWebDir, "main.tsx"),
				plugins: [],
				projectRoot: tempRoot,
			}),
		).rejects.toThrow(/Shared module.*auth-context/);
	});

	test("global plugin build failure throws", async () => {
		const brokenPlugin = join(tempRoot, "broken-plugin.tsx");
		writeFileSync(
			brokenPlugin,
			`import {x} from "./does-not-exist"; export const Plugin = () => x;\n`,
		);
		await expect(
			buildWebAssets({
				buildDir,
				shellEntry: SHELL_ENTRY,
				plugins: [{ name: "broken", webEntry: brokenPlugin, scope: "global" }],
				projectRoot: MATRIX_ROOT,
			}),
		).rejects.toThrow(/Plugin "broken".*scope=global.*build failed/);
	});

	test("project-scoped plugin build failure is recorded in pluginOutputs.buildError, not thrown", async () => {
		const brokenPlugin = join(tempRoot, "broken-plugin.tsx");
		writeFileSync(
			brokenPlugin,
			`import {x} from "./does-not-exist"; export const Plugin = () => x;\n`,
		);
		const res = await buildWebAssets({
			buildDir,
			shellEntry: SHELL_ENTRY,
			plugins: [{ name: "broken", webEntry: brokenPlugin, scope: "project" }],
			projectRoot: MATRIX_ROOT,
		});
		const out = res.pluginOutputs.get("broken");
		expect(out).toBeDefined();
		expect(out?.jsPath).toBeUndefined();
		expect(out?.buildError).toMatch(/(does-not-exist|Could not|Bundle|failed)/);
	});

	test("shim dir is cleaned up even when build throws", async () => {
		const fakeWebDir = join(tempRoot, "web");
		mkdirSync(fakeWebDir, { recursive: true });
		writeFileSync(join(fakeWebDir, "main.tsx"), `export default null;\n`);
		await buildWebAssets({
			buildDir,
			shellEntry: join(fakeWebDir, "main.tsx"),
			plugins: [],
			projectRoot: tempRoot,
		}).catch(() => {});
		expect(existsSync(join(tempRoot, "_vendor_shims"))).toBe(false);
	});

	test("shell outside projectRoot is rejected (path traversal guard)", async () => {
		await expect(
			buildWebAssets({
				buildDir,
				// SHELL_ENTRY is under MATRIX_ROOT, but projectRoot is a fresh temp dir.
				shellEntry: SHELL_ENTRY,
				plugins: [],
				projectRoot: tempRoot,
			}),
		).rejects.toThrow();
	});
});

describe("generateIndexHTML", () => {
	test("emits importmap + shell script + CSS links", () => {
		const html = generateIndexHTML({
			buildDir: "/unused",
			importmap: { imports: { react: "/vendor/react.js" } },
			shellEntryPath: "/app/web/main.js",
			pluginOutputs: new Map(),
			cssPaths: ["/app/web/styles.css", "/app/plugin/matrix/style.css"],
		});
		expect(html).toContain(`<script type="importmap">`);
		expect(html).toContain(`"react": "/vendor/react.js"`);
		expect(html).toContain(
			`<link rel="stylesheet" href="/app/web/styles.css" />`,
		);
		expect(html).toContain(
			`<link rel="stylesheet" href="/app/plugin/matrix/style.css" />`,
		);
		expect(html).toContain(
			`<script type="module" src="/app/web/main.js"></script>`,
		);
	});
});

describe("generateBuildErrorHTML", () => {
	test("includes error message in non-production", () => {
		const prevEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";
		try {
			const html = generateBuildErrorHTML(new Error("boom-xyz"));
			expect(html).toContain("boom-xyz");
			expect(html).toContain("Web build failed");
		} finally {
			if (prevEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = prevEnv;
		}
	});

	test("hides error details in production", () => {
		const prevEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "production";
		try {
			const html = generateBuildErrorHTML(new Error("boom-xyz"));
			expect(html).not.toContain("boom-xyz");
			expect(html).toContain("Web build failed");
			expect(html).toContain("Check daemon logs");
		} finally {
			if (prevEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = prevEnv;
		}
	});

	test("escapes HTML in error messages (non-production)", () => {
		const prevEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";
		try {
			const html = generateBuildErrorHTML(
				new Error("<script>alert('xss')</script>"),
			);
			expect(html).not.toContain("<script>alert");
			expect(html).toContain("&lt;script&gt;");
		} finally {
			if (prevEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = prevEnv;
		}
	});
});
