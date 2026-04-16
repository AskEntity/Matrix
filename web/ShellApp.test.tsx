/// <reference lib="dom" />
/**
 * Web UI tests — happy-dom environment.
 * Run via: bun test --preload web/test-setup.ts web/ShellApp.test.tsx
 * or via: bun run test (package.json compound script).
 *
 * NOTE: happy-dom can't handle BunFile responses or dynamic import() of URLs.
 * File-serving tests are in src/daemon-integration.test.ts (normal Bun env).
 */
import "./test-setup.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../src/config.ts";
import { createDaemon, type DaemonInstance } from "../src/daemon.ts";

describe("daemon web build pipeline", () => {
	let daemon: DaemonInstance;
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ui-test-"));
		const dataDir = join(tempDir, ".mxd");

		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{ id: "m1", name: "matrix", path: resolve("."), createdAt: "2026-01-01" },
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		daemon = await createDaemon({ dataDir });
	}, 15000);

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("root HTML includes importmap + shell entry + CSS", async () => {
		const res = await daemon.fetch(new Request("http://localhost/"));
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("importmap");
		expect(html).toContain("/vendor/react.js");
		expect(html).toContain("/app/web/main.js");
		expect(html).toContain("stylesheet");
	});

	test("plugins endpoint returns compiled JS path", async () => {
		const res = await daemon.fetch(new Request("http://localhost/plugins"));
		const plugins = await res.json();
		const matrix = plugins.find((p: { name: string }) => p.name === "matrix");
		expect(matrix).toBeDefined();
		expect(matrix.webComponentPath).toMatch(/^\/app\/.*\.js$/);
		expect(matrix.webComponentPath).not.toContain(".tsx");
	});

	test("vendor and app routes return 200 for built assets", async () => {
		// Vendor React
		const vendorRes = await daemon.fetch(new Request("http://localhost/vendor/react.js"));
		expect(vendorRes.status).toBe(200);

		// Shell JS
		const shellRes = await daemon.fetch(new Request("http://localhost/app/web/main.js"));
		expect(shellRes.status).toBe(200);

		// Plugin JS
		const pluginsRes = await daemon.fetch(new Request("http://localhost/plugins"));
		const plugins = await pluginsRes.json();
		const matrix = plugins.find((p: { name: string }) => p.name === "matrix");
		const pluginRes = await daemon.fetch(new Request(`http://localhost${matrix.webComponentPath}`));
		expect(pluginRes.status).toBe(200);
	});

	test("nonexistent built asset returns 404", async () => {
		const res = await daemon.fetch(new Request("http://localhost/app/nonexistent.js"));
		expect(res.status).toBe(404);
	});
});
