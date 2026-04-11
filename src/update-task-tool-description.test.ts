/**
 * Tests that the update_task tool description teaches agents the correct
 * mental model for editing the description field: "treat it like a file,"
 * with edit_file's old_string/new_string semantics for surgical edits.
 *
 * WHY: the surgical edit mode uses `string.replace(old_description,
 * new_description)`, which is semantically identical to edit_file's
 * old_string/new_string. Without a clear mental model in the tool
 * description, agents misuse it as "overwrite the leading chunk," which
 * leaves the trailing content silently stacked after the replacement.
 * This test guards the key phrases that anchor the mental model so future
 * refactors cannot silently erase them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestratorTools } from "./orchestrator-tools.ts";
import { resetResourceRegistry } from "./resource-registry.ts";
import { TaskTracker } from "./task-tracker.ts";
import { initMockResourceRegistry } from "./test-utils.ts";

describe("update_task tool description mental model", () => {
	let tempDir: string;
	let tracker: TaskTracker;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-update-task-desc-"));
		tracker = new TaskTracker(join(tempDir, "tree.json"));
	});

	afterEach(async () => {
		resetResourceRegistry();
		await rm(tempDir, { recursive: true, force: true });
	});

	function getUpdateTaskTool() {
		const { auth } = initMockResourceRegistry({
			tracker,
			projectId: "test-project",
			projectPath: tempDir,
			taskId: null,
		});
		const { toolDefs } = createOrchestratorTools(auth, "test-project", null);
		const tool = toolDefs.find((t) => t.name === "update_task");
		if (!tool) throw new Error("update_task tool not found");
		return tool;
	}

	test("main description anchors the 'treat description like a file' model", () => {
		const tool = getUpdateTaskTool();
		const desc = tool.description;

		// The core mental model: description field behaves like a file.
		expect(desc).toContain("like a file");

		// Full rewrite vs surgical edit — two modes, clearly named.
		expect(desc).toContain("full rewrite");
		expect(desc).toContain("ENTIRE");

		// Reference to edit_file so agents can transfer known semantics.
		expect(desc).toContain("edit_file");
		expect(desc).toContain("old_string");
		expect(desc).toContain("new_string");

		// Byte-identical guarantee for the non-matching tail.
		expect(desc).toContain("byte-identical");

		// Disambiguation guidance and combinability rule.
		expect(desc).toContain("unique");
		expect(desc).toContain("Cannot combine");
	});

	test("`description` param description says it replaces the ENTIRE field", () => {
		const tool = getUpdateTaskTool();
		const schema = tool.jsonSchema as {
			properties: Record<string, { description?: string }>;
		};
		const descParam = schema.properties.description?.description ?? "";

		expect(descParam).toContain("ENTIRE");
		expect(descParam).toContain("full rewrite");
		// Points agents toward the safer surgical mode for local edits.
		expect(descParam).toContain("old_description");
	});

	test("`old_description` param description explains substring semantics", () => {
		const tool = getUpdateTaskTool();
		const schema = tool.jsonSchema as {
			properties: Record<string, { description?: string }>;
		};
		const oldDescParam = schema.properties.old_description?.description ?? "";

		// Exact substring + uniqueness requirement.
		expect(oldDescParam).toContain("substring");
		expect(oldDescParam).toContain("unique");

		// Byte-identical guarantee for the tail.
		expect(oldDescParam).toContain("byte-identical");

		// Reference to edit_file semantics.
		expect(oldDescParam).toContain("edit_file");
		expect(oldDescParam).toContain("old_string");
	});

	test("`new_description` param description aligns with edit_file new_string", () => {
		const tool = getUpdateTaskTool();
		const schema = tool.jsonSchema as {
			properties: Record<string, { description?: string }>;
		};
		const newDescParam = schema.properties.new_description?.description ?? "";

		expect(newDescParam).toContain("edit_file");
		expect(newDescParam).toContain("new_string");
		expect(newDescParam).toContain("old_description");
	});
});
