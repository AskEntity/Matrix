/**
 * Test: scope worker boots and initializes runtime.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../config.ts";

describe("scope-worker", () => {
	let tempDir: string;
	let dataDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "scope-worker-test-"));
		dataDir = join(tempDir, ".mxd");
		// Write a minimal global config
		await saveGlobalConfig(
			{ ...DEFAULT_CONFIG },
			join(dataDir, "config.json"),
		);
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("worker boots and signals ready", async () => {
		const worker = new Worker(
			new URL("./scope-worker.ts", import.meta.url).href,
		);

		const messages: Array<{ type: string; [key: string]: unknown }> = [];

		const ready = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error("Worker didn't become ready in 10s")),
				10000,
			);
			worker.onmessage = (event: MessageEvent) => {
				messages.push(event.data);
				if (event.data.type === "ready") {
					clearTimeout(timeout);
					resolve();
				}
				if (event.data.type === "error") {
					clearTimeout(timeout);
					reject(new Error(event.data.message));
				}
			};
		});

		// Wait for "loaded" signal, then send init
		await new Promise<void>((resolve) => {
			const checkLoaded = setInterval(() => {
				if (messages.some((m) => m.type === "loaded")) {
					clearInterval(checkLoaded);
					resolve();
				}
			}, 50);
		});

		worker.postMessage({
			type: "init",
			dataDir,
			globalConfigPath: join(dataDir, "config.json"),
		});

		await ready;

		expect(messages.some((m) => m.type === "loaded")).toBe(true);
		expect(messages.some((m) => m.type === "ready")).toBe(true);

		// Cleanup
		worker.postMessage({ type: "shutdown" });
		worker.terminate();
	}, 15000);
});
