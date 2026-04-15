/**
 * Test: daemon + Matrix plugin — can see task tree via API,
 * shell renders plugin selector via renderToString.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../src/config.ts";
import { createDaemon, type DaemonInstance } from "../src/daemon.ts";
import { LoginPage } from "./LoginPage.tsx";

describe("daemon + Matrix plugin visible", () => {
	let daemon: DaemonInstance;
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "visible-test-"));
		const dataDir = join(tempDir, ".mxd");
		const matrixPath = resolve(".");

		await mkdir(join(dataDir, "projects"), { recursive: true });
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{ id: "m1", name: "matrix", path: matrixPath, createdAt: "2026-01-01" },
			]),
		);
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));
		daemon = await createDaemon({ dataDir });
	}, 15000);

	afterAll(async () => {
		await daemon?.shutdown();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("health works", async () => {
		const res = await daemon.fetch(new Request("http://localhost/health"));
		expect(res.status).toBe(200);
	});

	test("Matrix plugin discovered", () => {
		expect(daemon.plugins.find((p) => p.name === "matrix")).toBeDefined();
	});

	test("task tree has Orchestrator", async () => {
		const res = await daemon.fetch(new Request("http://localhost/projects/m1/tasks"));
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.nodes[0].title).toBe("Orchestrator");
	});

	test("/plugins returns matrix with web path", async () => {
		const res = await daemon.fetch(new Request("http://localhost/plugins"));
		const plugins = await res.json();
		expect(plugins[0].name).toBe("matrix");
		expect(plugins[0].webComponentPath).toContain("App.tsx");
	});

	test("LoginPage renders", () => {
		const html = renderToString(<LoginPage onAuthenticated={() => {}} />);
		expect(html).toContain("Matrix");
	});
});
