/**
 * Web asset builder — compiles shell + plugins into browser-ready JS.
 *
 * Architecture:
 * 1. React vendor ESM: CJS React → ESM shims with explicit named exports
 *    (Bun.build({ splitting: true }) so all shims share one React core chunk)
 * 2. Shell: web/main.tsx → ESM with external React (resolved via importmap)
 * 3. Plugin: Plugin.tsx → ESM with external React (same importmap)
 *
 * importmap in HTML makes shell + plugin resolve "react" to the same vendor URL
 * → single React instance → context sharing works.
 *
 * Failure policy:
 * - Vendor / shared-module / shell build failures always throw (fatal — shell cannot render).
 * - Plugin build failures throw when `scope === "global"` (the daemon has no other UI to fall
 *   back on); for other plugins the failure is recorded on the per-plugin result so `/plugins`
 *   can surface an error badge in the UI instead of showing "Loading plugin..." forever.
 *
 * Shim cleanup (`_vendor_shims/` inside `projectRoot`) is guaranteed via `try { ... } finally`
 * regardless of which step throws.
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const REACT_EXTERNALS = [
	"react",
	"react-dom",
	"react-dom/client",
	"react/jsx-runtime",
	"react/jsx-dev-runtime",
];

/** Shared modules — built once, importmap'd, external in shell + plugin builds. */
const SHARED_MODULES = [
	"@mxd/auth-context", // web/auth-context.ts — single instance for React context
	"@mxd/types", // web/runtime-types.ts — runtime Event, TreeNode, QueueMessage etc.
];

/** Paths to vendor shim source files (written to buildDir at build time). */
const VENDOR_SHIMS: Record<
	string,
	{ importPath: string; hasDefault: boolean }
> = {
	react: { importPath: "react", hasDefault: true },
	"react-dom": { importPath: "react-dom", hasDefault: true },
	"react-dom-client": { importPath: "react-dom/client", hasDefault: false },
	"react-jsx-runtime": { importPath: "react/jsx-runtime", hasDefault: false },
	"react-jsx-dev-runtime": {
		importPath: "react/jsx-dev-runtime",
		hasDefault: false,
	},
};

/** Map from bare specifier → vendor URL path for importmap. */
const IMPORTMAP_ENTRIES: Record<string, string> = {
	react: "/vendor/react.js",
	"react-dom": "/vendor/react-dom.js",
	"react-dom/client": "/vendor/react-dom-client.js",
	"react/jsx-runtime": "/vendor/react-jsx-runtime.js",
	"react/jsx-dev-runtime": "/vendor/react-jsx-dev-runtime.js",
};

export interface PluginBuildOutput {
	/** URL path to compiled plugin JS (only if build succeeded) */
	jsPath?: string;
	/** URL path to plugin CSS (only if a css file was provided) */
	cssPath?: string;
	/** Error message from Bun.build logs (only if build failed non-fatally) */
	buildError?: string;
}

export interface PluginBuildInput {
	name: string;
	webEntry: string;
	cssPath?: string;
	/** Scope of the owning plugin. `"global"` build failures throw. */
	scope: "global" | "project";
}

export interface WebBuildResult {
	/** Directory containing all built assets */
	buildDir: string;
	/** importmap JSON for HTML injection */
	importmap: { imports: Record<string, string> };
	/** URL path to shell entry JS */
	shellEntryPath: string;
	/** Per-plugin build output (JS url, optional CSS url, optional buildError) */
	pluginOutputs: Map<string, PluginBuildOutput>;
	/** URL paths to CSS files (shell + all successfully built plugins) */
	cssPaths: string[];
}

/**
 * Build all web assets: vendor React ESM + shell + plugins.
 * Called at daemon startup. Output is written fresh every time (no cache).
 */
export async function buildWebAssets(opts: {
	buildDir: string;
	shellEntry: string;
	plugins: PluginBuildInput[];
	shellCssPath?: string;
	projectRoot: string;
	minify?: boolean;
}): Promise<WebBuildResult> {
	const { buildDir, shellEntry, plugins, projectRoot, minify } = opts;

	// Clean previous build
	rmSync(buildDir, { recursive: true, force: true });

	const vendorDir = join(buildDir, "vendor");
	const appDir = join(buildDir, "app");
	mkdirSync(vendorDir, { recursive: true });
	mkdirSync(appDir, { recursive: true });

	// Shim source files in project root so Bun.build can resolve "react" etc. from
	// node_modules. Cleaned up in finally below regardless of build outcome.
	const shimDir = join(projectRoot, "_vendor_shims");
	mkdirSync(shimDir, { recursive: true });

	try {
		// ── Step 1: Build React vendor ESM shims ──
		// Generate shim source files that explicitly destructure named exports
		// (Bun.build's CJS→ESM __reExport doesn't produce static ESM exports)
		const reactExportNames = await getReactExportNames();

		for (const [name, config] of Object.entries(VENDOR_SHIMS)) {
			const exports = reactExportNames[config.importPath] ?? [];
			const namedExports = exports.filter((e) => e !== "default");
			let code = `import _M from "${config.importPath}";\n`;
			if (namedExports.length > 0) {
				code += `export const { ${namedExports.join(", ")} } = _M;\n`;
			}
			if (config.hasDefault) {
				code += `export default _M;\n`;
			}
			writeFileSync(join(shimDir, `${name}.ts`), code);
		}

		const shimEntrypoints = Object.keys(VENDOR_SHIMS).map((name) =>
			join(shimDir, `${name}.ts`),
		);

		const vendorResult = await runBuild(
			{
				entrypoints: shimEntrypoints,
				outdir: vendorDir,
				target: "browser",
				format: "esm",
				splitting: true, // Share React core across all shims
				root: shimDir,
				minify,
			},
			"Vendor build",
		);

		// ── Step 1b: Build shared modules (external React, importmap'd) ──
		const sharedEntries = [
			{
				specifier: "@mxd/auth-context",
				entry: join(projectRoot, "web", "auth-context.ts"),
				outName: "auth-context.js",
			},
			{
				specifier: "@mxd/types",
				entry: join(projectRoot, "web", "runtime-types.ts"),
				outName: "runtime-types.js",
			},
		];

		for (const shared of sharedEntries) {
			await runBuild(
				{
					entrypoints: [shared.entry],
					outdir: join(vendorDir, "shared"),
					target: "browser",
					format: "esm",
					external: REACT_EXTERNALS,
					root: projectRoot,
					naming: shared.outName,
					minify,
				},
				`Shared module "${shared.specifier}" build`,
			);
		}

		// Add shared modules to importmap
		const importmap = {
			imports: { ...IMPORTMAP_ENTRIES } as Record<string, string>,
		};
		for (const shared of sharedEntries) {
			importmap.imports[shared.specifier] = `/vendor/shared/${shared.outName}`;
		}

		const allExternals = [...REACT_EXTERNALS, ...SHARED_MODULES];

		// ── Step 2: Build shell (external React + shared modules) ──
		const shellResult = await runBuild(
			{
				entrypoints: [shellEntry],
				outdir: appDir,
				target: "browser",
				format: "esm",
				external: allExternals,
				root: projectRoot,
				minify,
			},
			"Shell build",
		);

		// ── Step 3: Build each plugin into stable /app/plugin/<name>/ namespace ──
		const pluginOutputs = new Map<string, PluginBuildOutput>();
		for (const plugin of plugins) {
			const pluginOutDir = join(appDir, "plugin", plugin.name);
			const entryDir = dirname(plugin.webEntry);

			try {
				await runBuild(
					{
						entrypoints: [plugin.webEntry],
						outdir: pluginOutDir,
						target: "browser",
						format: "esm",
						external: allExternals,
						// root=dirname keeps output flat in pluginOutDir regardless of
						// where the plugin lives on disk — works for plugins outside
						// `projectRoot` (future multi-project plugin support).
						root: entryDir,
						naming: "index.[ext]",
						minify,
					},
					`Plugin "${plugin.name}" build`,
				);
				pluginOutputs.set(plugin.name, {
					jsPath: `/app/plugin/${plugin.name}/index.js`,
				});
			} catch (e) {
				const errorText = e instanceof Error ? e.message : String(e);
				if (plugin.scope === "global") {
					throw new Error(
						`Plugin "${plugin.name}" (scope=global) build failed: ${errorText}`,
					);
				}
				console.error(`[web-builder] Plugin "${plugin.name}" build failed:`, e);
				pluginOutputs.set(plugin.name, { buildError: errorText });
			}
		}

		// ── Step 4: Copy CSS files ──
		const cssPaths: string[] = [];

		if (opts.shellCssPath && existsSync(opts.shellCssPath)) {
			const cssOutDir = join(appDir, "web");
			mkdirSync(cssOutDir, { recursive: true });
			copyFileSync(opts.shellCssPath, join(cssOutDir, "styles.css"));
			cssPaths.push("/app/web/styles.css");
		}

		for (const plugin of plugins) {
			if (!plugin.cssPath || !existsSync(plugin.cssPath)) continue;
			const output = pluginOutputs.get(plugin.name);
			// If JS build failed we skip CSS to avoid orphan stylesheets
			if (!output?.jsPath) continue;
			const pluginOutDir = join(appDir, "plugin", plugin.name);
			mkdirSync(pluginOutDir, { recursive: true });
			copyFileSync(plugin.cssPath, join(pluginOutDir, "style.css"));
			const cssUrl = `/app/plugin/${plugin.name}/style.css`;
			output.cssPath = cssUrl;
			cssPaths.push(cssUrl);
		}

		// Use the shell's original location under `projectRoot` to compute its URL.
		// The `path.relative` call handles absolute paths that are outside
		// `projectRoot` by returning a path with `..` — we reject those (shell MUST
		// live under projectRoot).
		const shellRel = relative(projectRoot, shellEntry);
		if (shellRel.startsWith("..") || shellRel.includes(`..${sep}`)) {
			throw new Error(
				`shellEntry must live under projectRoot, got ${shellEntry} (relative: ${shellRel})`,
			);
		}
		const shellRelPath = shellRel.replace(/\.tsx?$/, ".js");

		const totalOutputs =
			vendorResult.outputs.length + shellResult.outputs.length + plugins.length;
		console.log(`[web-builder] Built ${totalOutputs} assets → ${buildDir}`);

		return {
			buildDir,
			importmap,
			shellEntryPath: `/app/${shellRelPath.split(sep).join("/")}`,
			pluginOutputs,
			cssPaths,
		};
	} finally {
		// Guaranteed cleanup — shim dir lives in projectRoot, we never want it to leak.
		try {
			rmSync(shimDir, { recursive: true, force: true });
		} catch (e) {
			console.error("[web-builder] Failed to clean up shim dir:", e);
		}
	}
}

/** Flatten Bun.build logs into a short human-readable string. */
function formatBuildLogs(logs: readonly unknown[]): string {
	if (!logs || logs.length === 0) return "(no build logs)";
	return logs
		.map((l) => {
			if (typeof l === "string") return l;
			const obj = l as { message?: string; toString?: () => string };
			return obj.message ?? String(l);
		})
		.join("; ");
}

/**
 * Wrap `Bun.build` so both failure shapes bubble up as a single loud error:
 *   (a) Bun.build threw (e.g. unresolvable import) — rethrow with context prefix
 *   (b) Bun.build returned `{ success: false, logs }` — throw with logs
 */
async function runBuild(
	config: Parameters<typeof Bun.build>[0],
	label: string,
): Promise<Awaited<ReturnType<typeof Bun.build>>> {
	let result: Awaited<ReturnType<typeof Bun.build>>;
	try {
		result = await Bun.build(config);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new Error(`${label} failed: ${message}`);
	}
	if (!result.success) {
		throw new Error(`${label} failed: ${formatBuildLogs(result.logs)}`);
	}
	return result;
}

/**
 * Generate the HTML string for the root page.
 * Includes importmap, CSS links, and shell entry script.
 */
export function generateIndexHTML(build: WebBuildResult): string {
	const cssLinks = build.cssPaths
		.map((p) => `  <link rel="stylesheet" href="${p}" />`)
		.join("\n");

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Matrix</title>
  <script type="importmap">
  ${JSON.stringify(build.importmap, null, 2)}
  </script>
${cssLinks}
</head>
<body>
  <div id="root" style="height:100dvh;display:flex;flex-direction:column;overflow:hidden"></div>
  <script type="module" src="${build.shellEntryPath}"></script>
</body>
</html>`;
}

/**
 * Generate a diagnostic fallback HTML page when the build itself fails.
 *
 * In non-production, shows the actual error so the developer doesn't have to
 * tail daemon logs. In production, hides the error (may contain internal paths)
 * but keeps enough context to indicate the daemon is up but the UI is broken.
 */
export function generateBuildErrorHTML(err: unknown): string {
	const isProd = process.env.NODE_ENV === "production";
	const message = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error ? err.stack : undefined;
	const body = isProd
		? `<h1>Web build failed</h1><p>Check daemon logs for details.</p>`
		: `<h1>Web build failed</h1><p><strong>${escapeHtml(message)}</strong></p>` +
			(stack ? `<pre>${escapeHtml(stack)}</pre>` : "");
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Matrix — build failed</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2em auto; padding: 0 1em; color: #eee; background: #111; }
    pre { background: #000; padding: 1em; overflow-x: auto; border: 1px solid #333; }
    h1 { color: #f85149; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** Get named export keys for each React module. Throws if a module cannot be required. */
async function getReactExportNames(): Promise<Record<string, string[]>> {
	const result: Record<string, string[]> = {};
	for (const [, config] of Object.entries(VENDOR_SHIMS)) {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic require
		const mod = require(config.importPath) as any;
		result[config.importPath] = Object.keys(mod).filter(
			(k) => k !== "default" && /^[a-zA-Z_$]/.test(k),
		);
	}
	return result;
}
