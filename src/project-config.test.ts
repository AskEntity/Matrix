import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadProjectConfig,
	mergeProjectConfig,
	saveProjectConfig,
} from "./project-config.ts";

describe("project-config", () => {
	let dataDir: string;
	const projectId = "test-project";

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "og-config-test-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	test("load returns empty object when no config exists", async () => {
		const config = await loadProjectConfig(dataDir, projectId);
		expect(config).toEqual({});
	});

	test("save and load round-trip", async () => {
		const config = { model: "claude-sonnet-4-6", budgetUsd: 1.5 };
		await saveProjectConfig(dataDir, projectId, config);
		const loaded = await loadProjectConfig(dataDir, projectId);
		expect(loaded).toEqual(config);
	});

	test("merge adds new keys", async () => {
		await saveProjectConfig(dataDir, projectId, { model: "claude-sonnet-4-6" });
		const result = await mergeProjectConfig(dataDir, projectId, {
			childModel: "claude-haiku-4",
		});
		expect(result).toEqual({
			model: "claude-sonnet-4-6",
			childModel: "claude-haiku-4",
		});
	});

	test("merge overwrites existing keys", async () => {
		await saveProjectConfig(dataDir, projectId, { model: "old-model" });
		const result = await mergeProjectConfig(dataDir, projectId, {
			model: "new-model",
		});
		expect(result.model).toBe("new-model");
	});

	test("merge removes keys set to null", async () => {
		await saveProjectConfig(dataDir, projectId, {
			model: "claude-sonnet-4-6",
			budgetUsd: 2,
		});
		const result = await mergeProjectConfig(dataDir, projectId, {
			budgetUsd: null as unknown as undefined,
		});
		expect(result).toEqual({ model: "claude-sonnet-4-6" });
	});

	test("merge on empty config creates new config", async () => {
		const result = await mergeProjectConfig(dataDir, projectId, {
			model: "claude-sonnet-4-6",
			provider: "anthropic",
		});
		expect(result).toEqual({
			model: "claude-sonnet-4-6",
			provider: "anthropic",
		});
	});

	test("maxDepth round-trips through save and load", async () => {
		const config = { maxDepth: 5 };
		await saveProjectConfig(dataDir, projectId, config);
		const loaded = await loadProjectConfig(dataDir, projectId);
		expect(loaded.maxDepth).toBe(5);
	});
});
