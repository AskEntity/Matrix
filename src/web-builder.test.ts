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
 *   - Every built asset is content-hashed and discoverable via the manifest
 *     (`logical URL → hashed URL`).
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

// All built-asset filenames follow `<name>-<hash>.<ext>` where hash is
// Bun.build's 8-char lowercase alphanumeric content hash (or our matching
// manual hash for CSS). This regex locks the shape.
const HASHED_URL = /^\/(?:vendor|app)\/.+-[a-z0-9]{8}\.(?:js|css)$/;

describe("buildWebAssets — happy path", () => {
	let buildDir: string;
	beforeEach(async () => {
		buildDir = await mkdtemp(join(tmpdir(), "webbuild-happy-"));
	});
	afterEach(() => {
		rmSync(buildDir, { recursive: true, force: true });
	});

	test("importmap values are hashed URLs for every React shim + shared module", async () => {
		const res = await buildWebAssets({
			buildDir,
			shellEntry: SHELL_ENTRY,
			shellCssPath: SHELL_CSS,
			plugins: [],
			projectRoot: MATRIX_ROOT,
		});
		// Every importmap entry must be a hashed URL — never the bare logical path.
		for (const [specifier, url] of Object.entries(res.importmap.imports)) {
			expect(url).toMatch(HASHED_URL);
			expect(url).not.toBe(specifier); // can't resolve to itself
			// Regex pattern matches "react", "react-dom", etc., including the
			// hash suffix. "vendor" prefix lives inside the regex.
		}
		// Specific specifiers we depend on
		const keys = Object.keys(res.importmap.imports);
		expect(keys).toContain("react");
		expect(keys).toContain("react-dom");
		expect(keys).toContain("react-dom/client");
		expect(keys).toContain("react/jsx-runtime");
		expect(keys).toContain("react/jsx-dev-runtime");
		expect(keys).toContain("@mxd/auth-context");
		expect(keys).toContain("@mxd/types");
	});

	test("manifest maps every logical asset URL to a hashed output URL", async () => {
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
		// Every expected logical URL is present and maps to a hashed URL.
		const expectedLogical = [
			"/vendor/react.js",
			"/vendor/react-dom.js",
			"/vendor/react-dom-client.js",
			"/vendor/react-jsx-runtime.js",
			"/vendor/react-jsx-dev-runtime.js",
			"/vendor/shared/auth-context.js",
			"/vendor/shared/runtime-types.js",
			"/app/web/main.js",
			"/app/web/styles.css",
			"/app/plugin/matrix/index.js",
			"/app/plugin/matrix/style.css",
		];
		for (const logical of expectedLogical) {
			const hashed = res.manifest[logical];
			expect(hashed, `missing manifest entry for ${logical}`).toBeDefined();
			expect(hashed).toMatch(HASHED_URL);
			expect(hashed).not.toBe(logical); // must actually be different
		}
	});

	test("plugin output is hashed; file exists on disk under hashed name", async () => {
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
		if (!out?.jsPath || !out?.cssPath) {
			throw new Error(
				`Expected plugin outputs with hashed JS+CSS, got ${JSON.stringify(out)}`,
			);
		}
		expect(out.jsPath).toMatch(HASHED_URL);
		expect(out.cssPath).toMatch(HASHED_URL);
		// Strip `/app/` prefix to get the file path under buildDir/app
		const jsFile = out.jsPath.replace(/^\/app\//, "");
		const cssFile = out.cssPath.replace(/^\/app\//, "");
		expect(existsSync(join(buildDir, "app", jsFile))).toBe(true);
		expect(existsSync(join(buildDir, "app", cssFile))).toBe(true);
		// cssPaths includes the hashed plugin css
		expect(res.cssPaths).toContain(out.cssPath);
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

	test("shellEntryPath is a hashed URL (forward slashes, not platform sep)", async () => {
		const res = await buildWebAssets({
			buildDir,
			shellEntry: SHELL_ENTRY,
			plugins: [],
			projectRoot: MATRIX_ROOT,
		});
		expect(res.shellEntryPath).toMatch(/^\/app\/web\/main-[a-z0-9]{8}\.js$/);
		// Must not leak backslashes on any OS
		expect(res.shellEntryPath).not.toContain("\\");
		// Matches manifest lookup
		expect(res.manifest["/app/web/main.js"]).toBe(res.shellEntryPath);
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

	test("two builds of the same input produce identical hashes (determinism)", async () => {
		const buildDir2 = await mkdtemp(join(tmpdir(), "webbuild-det-"));
		try {
			const res1 = await buildWebAssets({
				buildDir,
				shellEntry: SHELL_ENTRY,
				plugins: [],
				projectRoot: MATRIX_ROOT,
			});
			const res2 = await buildWebAssets({
				buildDir: buildDir2,
				shellEntry: SHELL_ENTRY,
				plugins: [],
				projectRoot: MATRIX_ROOT,
			});
			// Shell entry hash must match byte-for-byte
			expect(res1.shellEntryPath).toBe(res2.shellEntryPath);
			// All importmap values must match
			expect(res1.importmap).toEqual(res2.importmap);
			// Resolve the actual on-disk files via manifest and byte-compare
			const shellRel1 = res1.shellEntryPath.replace(/^\/app\//, "");
			const shellRel2 = res2.shellEntryPath.replace(/^\/app\//, "");
			const shell1 = readFileSync(join(buildDir, "app", shellRel1));
			const shell2 = readFileSync(join(buildDir2, "app", shellRel2));
			expect(shell1.equals(shell2)).toBe(true);
		} finally {
			rmSync(buildDir2, { recursive: true, force: true });
		}
	});

	test("changed source produces a different shell hash (cache busts automatically)", async () => {
		// Temporarily write a new file into web/, build against a different
		// shell entry, observe the hash differs.
		const altEntry = join(MATRIX_ROOT, "web", "main-alt-for-test.tsx");
		// Make a minimal tsx that differs from main.tsx — importing the shared
		// modules so the build succeeds end-to-end.
		writeFileSync(altEntry, `export const _ALT_MARKER_${Date.now()} = true;\n`);
		const buildDir2 = await mkdtemp(join(tmpdir(), "webbuild-change-"));
		try {
			const res1 = await buildWebAssets({
				buildDir,
				shellEntry: SHELL_ENTRY,
				plugins: [],
				projectRoot: MATRIX_ROOT,
			});
			const res2 = await buildWebAssets({
				buildDir: buildDir2,
				shellEntry: altEntry,
				plugins: [],
				projectRoot: MATRIX_ROOT,
			});
			// Different source → different shell hash
			expect(res1.shellEntryPath).not.toBe(res2.shellEntryPath);
		} finally {
			rmSync(altEntry, { force: true });
			rmSync(buildDir2, { recursive: true, force: true });
		}
	});

	test("CSS content hash changes when CSS content changes", async () => {
		const cssA = join(MATRIX_ROOT, "web", "_test-styles-a.css");
		const cssB = join(MATRIX_ROOT, "web", "_test-styles-b.css");
		const buildDir2 = await mkdtemp(join(tmpdir(), "webbuild-css-b-"));
		try {
			writeFileSync(cssA, `.a { color: red; }\n`);
			writeFileSync(cssB, `.b { color: blue; }\n`);
			const res1 = await buildWebAssets({
				buildDir,
				shellEntry: SHELL_ENTRY,
				shellCssPath: cssA,
				plugins: [],
				projectRoot: MATRIX_ROOT,
			});
			const res2 = await buildWebAssets({
				buildDir: buildDir2,
				shellEntry: SHELL_ENTRY,
				shellCssPath: cssB,
				plugins: [],
				projectRoot: MATRIX_ROOT,
			});
			const css1 = res1.manifest["/app/web/styles.css"];
			const css2 = res2.manifest["/app/web/styles.css"];
			expect(css1).toMatch(HASHED_URL);
			expect(css2).toMatch(HASHED_URL);
			expect(css1).not.toBe(css2); // different content → different URL
		} finally {
			rmSync(cssA, { force: true });
			rmSync(cssB, { force: true });
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
	test("emits importmap + hashed shell script + hashed CSS links from build result", () => {
		const html = generateIndexHTML({
			buildDir: "/unused",
			importmap: { imports: { react: "/vendor/react-abc12345.js" } },
			shellEntryPath: "/app/web/main-def67890.js",
			pluginOutputs: new Map(),
			cssPaths: [
				"/app/web/styles-ghi12345.css",
				"/app/plugin/matrix/style-jkl67890.css",
			],
			manifest: {},
		});
		expect(html).toContain(`<script type="importmap">`);
		expect(html).toContain(`"react": "/vendor/react-abc12345.js"`);
		expect(html).toContain(
			`<link rel="stylesheet" href="/app/web/styles-ghi12345.css" />`,
		);
		expect(html).toContain(
			`<link rel="stylesheet" href="/app/plugin/matrix/style-jkl67890.css" />`,
		);
		expect(html).toContain(
			`<script type="module" src="/app/web/main-def67890.js"></script>`,
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
