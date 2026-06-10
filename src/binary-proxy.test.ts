/**
 * FIX-9: Binary response proxy — daemon↔worker postMessage corrupts binary bodies.
 *
 * Bug: scope-worker.ts uses `response.text()` for buffered responses. Bytes >0x7F
 * get UTF-8 decoded into U+FFFD replacement chars. All plugin binary file serving
 * (MP3, images, PDFs) is broken.
 *
 * TDD: write the failing test, see it fail, then fix scope-worker.ts + daemon.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { createDaemon, type DaemonInstance } from "./daemon.ts";
import { createTestToken } from "./test-utils/auth-helper.ts";

describe("FIX-9: binary response proxy", () => {
	let daemon: DaemonInstance;
	let tempDir: string;
	let sessionToken: string;
	let projectId: string;

	// Binary payload: bytes 0x00–0xFF covering the full byte range.
	// Bytes >0x7F are the ones that get corrupted by UTF-8 text decoding.
	const BINARY_PAYLOAD = new Uint8Array(256);
	for (let i = 0; i < 256; i++) BINARY_PAYLOAD[i] = i;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "fix9-binary-proxy-"));
		const dataDir = join(tempDir, ".mxd");
		const authPath = join(dataDir, "auth.json");
		const projectPath = join(tempDir, "test-project");

		// Create project with a plugin that serves binary content
		await mkdir(join(projectPath, ".mxd", "plugin"), { recursive: true });

		// Plugin manifest
		await writeFile(
			join(projectPath, ".mxd", "plugin", "index.ts"),
			`export default { name: "test-binary", scope: "global", runtime: "runtime.ts" };`,
			"utf-8",
		);

		// Plugin runtime: registers a route that returns raw binary bytes
		await writeFile(
			join(projectPath, ".mxd", "plugin", "runtime.ts"),
			`
export function registerRoutes(app, ctx) {
	// Route that returns a binary response with bytes 0x00–0xFF
	app.get("/binary-test", (c) => {
		const buf = new Uint8Array(256);
		for (let i = 0; i < 256; i++) buf[i] = i;
		return new Response(buf.buffer, {
			status: 200,
			headers: {
				"content-type": "application/octet-stream",
				"content-length": "256",
			},
		});
	});

	// Route that returns a small PNG-like header (realistic binary with 0x89 first byte)
	app.get("/binary-png-header", (c) => {
		// Real PNG signature: 137 80 78 71 13 10 26 10
		const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
		return new Response(png.buffer, {
			status: 200,
			headers: { "content-type": "image/png" },
		});
	});

	// Route that returns pure ASCII (should still work fine)
	app.get("/text-test", (c) => {
		return new Response("hello world", {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
	});
}
`,
			"utf-8",
		);

		// Register project
		await mkdir(join(dataDir, "projects"), { recursive: true });
		projectId = "fix9-test-project";
		await writeFile(
			join(dataDir, "projects.json"),
			JSON.stringify([
				{
					id: projectId,
					name: "fix9-project",
					path: projectPath,
					createdAt: new Date().toISOString(),
				},
			]),
			"utf-8",
		);

		await saveGlobalConfig(
			{ ...DEFAULT_CONFIG },
			join(dataDir, "config.json"),
		);

		sessionToken = await createTestToken(authPath);

		daemon = await createDaemon({
			dataDir,
			autoRegisterSelf: false,
		});
	}, 30_000);

	afterAll(async () => {
		if (daemon) await daemon.shutdown();
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
	});

	function authedRequest(url: string, init?: RequestInit): Request {
		return new Request(url, {
			...init,
			headers: {
				...init?.headers,
				Authorization: `Bearer ${sessionToken}`,
			},
		});
	}

	test("binary response with bytes 0x00–0xFF is byte-identical through proxy", async () => {
		const res = await daemon.fetch(
			authedRequest("http://localhost/api/test-binary/binary-test"),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/octet-stream");

		const body = new Uint8Array(await res.arrayBuffer());
		expect(body.length).toBe(256);

		// The critical assertion: every byte must be preserved, especially >0x7F
		expect(body).toEqual(BINARY_PAYLOAD);
	});

	test("PNG header bytes survive proxy (0x89 first byte is the classic failure)", async () => {
		const res = await daemon.fetch(
			authedRequest("http://localhost/api/test-binary/binary-png-header"),
		);
		expect(res.status).toBe(200);

		const body = new Uint8Array(await res.arrayBuffer());
		// Real PNG signature: 137(0x89) 80(P) 78(N) 71(G) 13(CR) 10(LF) 26(SUB) 10(LF)
		expect(body).toEqual(
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
	});

	test("text responses still work correctly", async () => {
		const res = await daemon.fetch(
			authedRequest("http://localhost/api/test-binary/text-test"),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("hello world");
	});
});
