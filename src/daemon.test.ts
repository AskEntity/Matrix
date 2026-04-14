/**
 * Test: shell starts worker and proxies HTTP requests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "./config.ts";
import { ulid } from "./ulid.ts";

/**
 * Lightweight shell test: start a worker, proxy requests, check responses.
 * Reuses the same workerFetch pattern from scope-worker.test.ts but
 * structured as "shell creates and manages the worker."
 */
describe("daemon-shell", () => {
	let tempDir: string;
	let dataDir: string;
	let worker: Worker;
	const pending = new Map<
		string,
		{
			resolve: (r: { status: number; headers: Record<string, string>; body: string }) => void;
			reject: (e: Error) => void;
		}
	>();

	async function shellFetch(
		url: string,
		opts?: { method?: string; headers?: Record<string, string>; body?: string },
	): Promise<{ status: number; body: unknown }> {
		const id = ulid();
		const resp = await new Promise<{ status: number; headers: Record<string, string>; body: string }>(
			(resolve, reject) => {
				const timeout = setTimeout(
					() => {
						pending.delete(id);
						reject(new Error(`Shell request timeout: ${url}`));
					},
					10000,
				);
				pending.set(id, {
					resolve: (r) => {
						clearTimeout(timeout);
						pending.delete(id);
						resolve(r);
					},
					reject: (e) => {
						clearTimeout(timeout);
						pending.delete(id);
						reject(e);
					},
				});

				worker.postMessage({
					type: "http_request",
					id,
					method: opts?.method ?? "GET",
					url: `http://localhost${url}`,
					headers: opts?.headers ?? { "content-type": "application/json" },
					body: opts?.body,
				});
			},
		);

		let body: unknown;
		try {
			body = JSON.parse(resp.body);
		} catch {
			body = resp.body;
		}
		return { status: resp.status, body };
	}

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "shell-test-"));
		dataDir = join(tempDir, ".mxd");
		await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

		worker = new Worker(new URL("./runtime/scope-worker.ts", import.meta.url).href);

		worker.onmessage = (event: MessageEvent) => {
			const msg = event.data;
			if (msg.type === "http_response") {
				const p = pending.get(msg.id);
				if (p) p.resolve({ status: msg.status, headers: msg.headers, body: msg.body });
			}
		};

		// Wait for loaded → init → ready
		await new Promise<void>((resolve, reject) => {
			const origHandler = worker.onmessage;
			worker.onmessage = (event: MessageEvent) => {
				const msg = event.data;
				if (msg.type === "loaded") {
					worker.postMessage({
						type: "init",
						dataDir,
						globalConfigPath: join(dataDir, "config.json"),
					});
				}
				if (msg.type === "ready") {
					worker.onmessage = origHandler;
					resolve();
				}
				if (msg.type === "error") reject(new Error(msg.message));
			};
		});
	});

	afterAll(async () => {
		worker.terminate();
		await rm(tempDir, { recursive: true, force: true });
	});

	test("shell proxies /health to worker", async () => {
		const { status, body } = await shellFetch("/health");
		expect(status).toBe(200);
		expect((body as Record<string, unknown>).status).toBe("ok");
	});

	test("shell proxies /version to worker", async () => {
		const { status, body } = await shellFetch("/version");
		expect(status).toBe(200);
		expect((body as Record<string, unknown>).version).toBeDefined();
	});

	test("shell proxies /projects to worker", async () => {
		const { status, body } = await shellFetch("/projects");
		expect(status).toBe(200);
		expect(Array.isArray(body)).toBe(true);
	});

	test("shell proxies POST to worker", async () => {
		// POST /projects with a dummy path — should get a validation error but still 4xx not 5xx
		const { status } = await shellFetch("/projects", {
			method: "POST",
			body: JSON.stringify({ path: "/nonexistent/path/abc" }),
		});
		// Should be 400 or similar — the point is the POST body was forwarded
		expect(status).toBeGreaterThanOrEqual(400);
		expect(status).toBeLessThan(600);
	});

	test("worker events relay to shell via onBroadcast", async () => {
		const events: Array<{ type: string; projectId?: string; event?: unknown }> = [];

		// Listen for sse_event messages alongside http_response
		const origHandler = worker.onmessage;
		worker.onmessage = (event: MessageEvent) => {
			const msg = event.data;
			if (msg.type === "sse_event") {
				events.push(msg);
			}
			// Keep http_response handling for shellFetch
			if (msg.type === "http_response") {
				const p = pending.get(msg.id);
				if (p) p.resolve({ status: msg.status, headers: msg.headers, body: msg.body });
			}
		};

		// Create a project first
		await shellFetch("/projects", {
			method: "POST",
			body: JSON.stringify({ path: tempDir }),
		});

		// Get projects to find the project ID
		const { body: projects } = await shellFetch("/projects");
		const project = (projects as Array<{ id: string }>)[0];
		expect(project).toBeDefined();

		// POST a message to root — this triggers agent start + events broadcast
		await shellFetch(`/projects/${project!.id}/tasks/${project!.id}/message`, {
			method: "POST",
			body: JSON.stringify({ content: "hello" }),
			headers: { "content-type": "application/json" },
		});

		// Wait briefly for events to relay
		await new Promise((r) => setTimeout(r, 500));

		// Restore handler
		worker.onmessage = origHandler;

		// Should have received sse_events from the worker
		expect(events.length).toBeGreaterThan(0);
		expect(events[0]!.type).toBe("sse_event");
		expect(events[0]!.projectId).toBeDefined();
	});
});
