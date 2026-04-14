/**
 * Test: scope worker boots, handles HTTP requests forwarded from "shell".
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../config.ts";
import { ulid } from "../ulid.ts";

/**
 * Helper: send an HTTP request to the worker and get the response.
 * This simulates what the main thread shell would do.
 */
async function workerFetch(
	worker: Worker,
	url: string,
	opts?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
	const id = ulid();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`Worker request timeout: ${url}`)),
			10000,
		);

		const handler = (event: MessageEvent) => {
			if (event.data.type === "http_response" && event.data.id === id) {
				clearTimeout(timeout);
				worker.removeEventListener("message", handler);
				resolve({
					status: event.data.status,
					headers: event.data.headers,
					body: event.data.body,
				});
			}
		};
		worker.addEventListener("message", handler);

		worker.postMessage({
			type: "http_request",
			id,
			method: opts?.method ?? "GET",
			url,
			headers: opts?.headers ?? {},
			body: opts?.body,
		});
	});
}

describe("scope-worker", () => {
	let tempDir: string;
	let dataDir: string;
	let worker: Worker;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "scope-worker-test-"));
		dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig(
			{ ...DEFAULT_CONFIG },
			join(dataDir, "config.json"),
		);

		worker = new Worker(
			new URL("./scope-worker.ts", import.meta.url).href,
		);

		// Wait for loaded
		await new Promise<void>((resolve) => {
			worker.onmessage = (event: MessageEvent) => {
				if (event.data.type === "loaded") resolve();
			};
		});

		// Init and wait for ready
		await new Promise<void>((resolve, reject) => {
			worker.onmessage = (event: MessageEvent) => {
				if (event.data.type === "ready") resolve();
				if (event.data.type === "error") reject(new Error(event.data.message));
			};
			worker.postMessage({
				type: "init",
				dataDir,
				globalConfigPath: join(dataDir, "config.json"),
			});
		});
	});

	afterAll(async () => {
		worker.postMessage({ type: "shutdown" });
		worker.terminate();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("health endpoint works through worker", async () => {
		const res = await workerFetch(worker, "http://localhost/health");
		expect(res.status).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.status).toBe("ok");
		expect(body.version).toBeDefined();
	});

	test("version endpoint works through worker", async () => {
		const res = await workerFetch(worker, "http://localhost/version");
		expect(res.status).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.version).toBeDefined();
		expect(body.projectCount).toBe(0);
	});

	test("projects list works through worker", async () => {
		const res = await workerFetch(worker, "http://localhost/projects");
		expect(res.status).toBe(200);
		const body = JSON.parse(res.body);
		expect(Array.isArray(body)).toBe(true);
	});

	test("stats endpoint works through worker", async () => {
		const res = await workerFetch(worker, "http://localhost/stats");
		expect(res.status).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.uptime).toBeGreaterThanOrEqual(0);
		expect(body.projectCount).toBe(0);
	});

	test("404 for unknown routes", async () => {
		const res = await workerFetch(worker, "http://localhost/nonexistent");
		expect(res.status).toBe(404);
	});
});
