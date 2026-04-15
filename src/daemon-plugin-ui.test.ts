/**
 * Test: daemon plugin UI — actually serves and renders in browser.
 * Uses createDaemon + Bun.serve on a test port, then Chrome DevTools to verify.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";

describe("daemon plugin UI e2e", () => {
	let tempDir: string;
	let daemon: DaemonInstance;
	let server: ReturnType<typeof Bun.serve>;
	const TEST_PORT = 17433; // test-only port

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "daemon-ui-e2e-"));
		const dataDir = join(tempDir, ".mxd");
		const projectPath = join(tempDir, "test-project");

		// Create project with plugin
		await mkdir(join(projectPath, ".mxd", "plugin", "web"), { recursive: true });
		await writeFile(
			join(projectPath, ".mxd", "plugin", "index.ts"),
			`export default { name: "test-plugin", scope: "global", web: "./web/App.tsx" };`,
		);
		await writeFile(
			join(projectPath, ".mxd", "plugin", "web", "App.tsx"),
			`export function App() { return <div id="plugin-root">Plugin Loaded</div>; }`,
		);

		// Register project + config (no auth — fresh dataDir has no jwt secret)
		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([{
				id: "p1", name: "test-project", path: projectPath,
				createdAt: new Date().toISOString(),
			}]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		daemon = await createDaemon({ dataDir });

		// Start HTTP server on test port
		server = Bun.serve({
			port: TEST_PORT,
			fetch: daemon.fetch,
		});
	});

	afterAll(async () => {
		server?.stop();
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("health endpoint accessible via HTTP", async () => {
		const res = await fetch(`http://localhost:${TEST_PORT}/health`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
	});

	test("/plugins returns discovered plugin", async () => {
		const res = await fetch(`http://localhost:${TEST_PORT}/plugins`);
		expect(res.status).toBe(200);
		const plugins = await res.json();
		expect(plugins.length).toBe(1);
		expect(plugins[0].name).toBe("test-plugin");
		expect(plugins[0].webComponentPath).toBeDefined();
	});

	test("auth not required (fresh dataDir, no jwt secret)", async () => {
		const res = await fetch(`http://localhost:${TEST_PORT}/auth/status`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.authenticated).toBe(true);
		expect(body.enabled).toBe(false);
	});

	test("projects accessible through daemon", async () => {
		const res = await fetch(`http://localhost:${TEST_PORT}/projects`);
		expect(res.status).toBe(200);
		const projects = await res.json();
		expect(projects.length).toBeGreaterThan(0);
	});
});
