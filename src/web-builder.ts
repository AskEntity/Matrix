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
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

export interface WebBuildResult {
	/** Directory containing all built assets */
	buildDir: string;
	/** importmap JSON for HTML injection */
	importmap: { imports: Record<string, string> };
	/** URL path to shell entry JS */
	shellEntryPath: string;
	/** Map of plugin name → compiled JS URL path */
	pluginEntryPaths: Map<string, string>;
	/** URL paths to CSS files */
	cssPaths: string[];
}

/**
 * Build all web assets: vendor React ESM + shell + plugins.
 * Called at daemon startup. Results cached in buildDir.
 */
export async function buildWebAssets(opts: {
	buildDir: string;
	shellEntry: string;
	plugins: Array<{ name: string; webEntry: string; cssPath?: string }>;
	shellCssPath?: string;
	projectRoot: string;
	minify?: boolean;
}): Promise<WebBuildResult> {
	const { buildDir, shellEntry, plugins, projectRoot, minify } = opts;

	// Clean previous build
	try {
		const { rmSync } = await import("node:fs");
		rmSync(buildDir, { recursive: true, force: true });
	} catch {}

	const vendorDir = join(buildDir, "vendor");
	const appDir = join(buildDir, "app");
	mkdirSync(vendorDir, { recursive: true });
	mkdirSync(appDir, { recursive: true });

	// ── Step 1: Build React vendor ESM shims ──
	// Generate shim source files that explicitly destructure named exports
	// (Bun.build's CJS→ESM __reExport doesn't produce static ESM exports)
	// Write shims in project root (not buildDir) so Bun.build can resolve
	// "react" etc. from node_modules. Cleaned up after build.
	const shimDir = join(opts.projectRoot, "_vendor_shims");
	mkdirSync(shimDir, { recursive: true });

	// We need to know the actual export names from each React module
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

	const vendorResult = await Bun.build({
		entrypoints: shimEntrypoints,
		outdir: vendorDir,
		target: "browser",
		format: "esm",
		splitting: true, // Share React core across all shims
		root: shimDir,
		minify,
	});

	if (!vendorResult.success) {
		console.error("[web-builder] Vendor build failed:", vendorResult.logs);
		throw new Error("Vendor build failed");
	}

	// ── Step 1b: Build shared modules (external React, importmap'd) ──
	const sharedEntries = [
		{
			specifier: "@mxd/auth-context",
			entry: join(opts.projectRoot, "web", "auth-context.ts"),
			outName: "auth-context.js",
		},
		{
			specifier: "@mxd/types",
			entry: join(opts.projectRoot, "web", "runtime-types.ts"),
			outName: "runtime-types.js",
		},
	];

	for (const shared of sharedEntries) {
		const result = await Bun.build({
			entrypoints: [shared.entry],
			outdir: join(vendorDir, "shared"),
			target: "browser",
			format: "esm",
			external: REACT_EXTERNALS,
			root: opts.projectRoot,
			naming: shared.outName,
			minify,
		});
		if (!result.success) {
			console.error(
				`[web-builder] Shared module ${shared.specifier} build failed:`,
				result.logs,
			);
		}
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
	const shellResult = await Bun.build({
		entrypoints: [shellEntry],
		outdir: appDir,
		target: "browser",
		format: "esm",
		external: allExternals,
		root: projectRoot,
		minify,
	});

	if (!shellResult.success) {
		console.error("[web-builder] Shell build failed:", shellResult.logs);
		throw new Error("Shell build failed");
	}

	// ── Step 3: Build each plugin (external React) ──
	const pluginEntryPaths = new Map<string, string>();
	for (const plugin of plugins) {
		const pluginResult = await Bun.build({
			entrypoints: [plugin.webEntry],
			outdir: appDir,
			target: "browser",
			format: "esm",
			external: allExternals,
			root: projectRoot,
			minify,
		});

		if (!pluginResult.success) {
			console.error(
				`[web-builder] Plugin "${plugin.name}" build failed:`,
				pluginResult.logs,
			);
			continue;
		}

		// Compute the URL path for the compiled plugin JS
		const relPath = plugin.webEntry
			.replace(projectRoot + "/", "")
			.replace(/\.tsx?$/, ".js");
		pluginEntryPaths.set(plugin.name, `/app/${relPath}`);
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
		if (plugin.cssPath && existsSync(plugin.cssPath)) {
			const relDir = plugin.webEntry
				.replace(projectRoot + "/", "")
				.replace(/\/[^/]+$/, "");
			const cssOutDir = join(appDir, relDir);
			mkdirSync(cssOutDir, { recursive: true });
			copyFileSync(plugin.cssPath, join(cssOutDir, "style.css"));
			cssPaths.push(`/app/${relDir}/style.css`);
		}
	}

	// Compute shell entry URL path
	const shellRelPath = shellEntry
		.replace(projectRoot + "/", "")
		.replace(/\.tsx?$/, ".js");

	// Clean up shim source files (always, even on error)
	try {
		const { rmSync } = await import("node:fs");
		rmSync(shimDir, { recursive: true, force: true });
	} catch {}

	const totalOutputs =
		vendorResult.outputs.length + shellResult.outputs.length + plugins.length;
	console.log(`[web-builder] Built ${totalOutputs} assets → ${buildDir}`);

	return {
		buildDir,
		importmap,
		shellEntryPath: `/app/${shellRelPath}`,
		pluginEntryPaths,
		cssPaths,
	};
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

/** Get named export keys for each React module. */
async function getReactExportNames(): Promise<Record<string, string[]>> {
	const result: Record<string, string[]> = {};
	for (const [, config] of Object.entries(VENDOR_SHIMS)) {
		try {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic require
			const mod = require(config.importPath) as any;
			result[config.importPath] = Object.keys(mod).filter(
				(k) => k !== "default" && /^[a-zA-Z_$]/.test(k),
			);
		} catch {
			result[config.importPath] = [];
		}
	}
	return result;
}
