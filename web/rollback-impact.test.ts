/**
 * Unit tests for analyzeRollbackImpact — the pure scan that tells the
 * Rewind/Edit confirm dialog which side effects will NOT be undone.
 *
 * Pure module: no DOM, no React, no daemon.
 */

import { describe, expect, test } from "bun:test";
import {
	analyzeRollbackImpact,
	hasSideEffects,
	type ImpactEntry,
} from "../.mxd/plugin/web/rollback-impact.ts";

const TASK = "task-a";

function userMsg(eid: string, taskId = TASK): ImpactEntry {
	return { type: "message", eid, taskId };
}

function toolCall(tool: string, taskId = TASK, eid?: string): ImpactEntry {
	return { type: "tool_call", tool: `mcp__mxd__${tool}`, taskId, eid };
}

function toolPair(tool: string, taskId = TASK): ImpactEntry {
	return { type: "tool_pair", tool: `mcp__mxd__${tool}`, taskId };
}

describe("analyzeRollbackImpact — categories", () => {
	test("write_file / edit_file / bash → filesModified", () => {
		for (const tool of ["write_file", "edit_file", "bash"]) {
			const impact = analyzeRollbackImpact(
				[userMsg("e1"), toolCall(tool)],
				"e1",
			);
			expect(impact.filesModified).toBe(true);
			expect(impact.tasksModified).toBe(false);
			expect(impact.messagesSent).toBe(false);
			expect(impact.otherSideEffects).toBe(false);
			expect(impact.toolNames).toEqual([tool]);
		}
	});

	test("task-tree tools → tasksModified", () => {
		for (const tool of [
			"create_task",
			"update_task",
			"delete_task",
			"close_task",
			"reset_task",
			"reorder_tasks",
			"create_folder",
			"delete_folder",
			"rename_folder",
			"fork_task_context",
		]) {
			const impact = analyzeRollbackImpact(
				[userMsg("e1"), toolCall(tool)],
				"e1",
			);
			expect(impact.tasksModified).toBe(true);
			expect(impact.filesModified).toBe(false);
			expect(impact.messagesSent).toBe(false);
			expect(impact.otherSideEffects).toBe(false);
		}
	});

	test("send_message / send_message_to_project / clarify → messagesSent", () => {
		for (const tool of ["send_message", "send_message_to_project", "clarify"]) {
			const impact = analyzeRollbackImpact(
				[userMsg("e1"), toolCall(tool)],
				"e1",
			);
			expect(impact.messagesSent).toBe(true);
			expect(impact.filesModified).toBe(false);
			expect(impact.tasksModified).toBe(false);
			expect(impact.otherSideEffects).toBe(false);
		}
	});

	test("read-only tools → NO warning at all", () => {
		const entries: ImpactEntry[] = [
			userMsg("e1"),
			toolCall("read_file"),
			toolCall("list_files"),
			toolCall("search"),
			toolCall("get_tree"),
			toolCall("get_task"),
			toolCall("search_tasks"),
			toolCall("list_projects"),
			toolCall("background"),
			toolCall("yield"),
		];
		const impact = analyzeRollbackImpact(entries, "e1");
		expect(hasSideEffects(impact)).toBe(false);
		expect(impact.filesModified).toBe(false);
		expect(impact.tasksModified).toBe(false);
		expect(impact.messagesSent).toBe(false);
		expect(impact.otherSideEffects).toBe(false);
		// …but they're still reported as "what ran here".
		expect(impact.toolNames).toContain("read_file");
		expect(impact.toolNames.length).toBe(9);
	});

	test("pure conversation (no tool calls) → no warnings, no tools", () => {
		const entries: ImpactEntry[] = [
			userMsg("e1"),
			{ type: "assistant_text", taskId: TASK },
			{ type: "thinking", taskId: TASK },
		];
		const impact = analyzeRollbackImpact(entries, "e1");
		expect(hasSideEffects(impact)).toBe(false);
		expect(impact.toolNames).toEqual([]);
	});

	test("unknown / external tool → otherSideEffects (never assumed safe)", () => {
		const impact = analyzeRollbackImpact(
			[
				userMsg("e1"),
				{
					type: "tool_call",
					tool: "mcp__brave-search__brave_web_search",
					taskId: TASK,
				},
			],
			"e1",
		);
		expect(impact.otherSideEffects).toBe(true);
		expect(hasSideEffects(impact)).toBe(true);
		// External name has no mxd prefix — reported verbatim.
		expect(impact.toolNames).toEqual(["mcp__brave-search__brave_web_search"]);
	});

	test("evaluate_script is NOT whitelisted → otherSideEffects", () => {
		const impact = analyzeRollbackImpact(
			[userMsg("e1"), toolCall("evaluate_script")],
			"e1",
		);
		expect(impact.otherSideEffects).toBe(true);
	});

	test("mixed range → every matching category flips", () => {
		const impact = analyzeRollbackImpact(
			[
				userMsg("e1"),
				toolCall("read_file"),
				toolPair("bash"),
				toolCall("create_task"),
				toolCall("send_message"),
			],
			"e1",
		);
		expect(impact.filesModified).toBe(true);
		expect(impact.tasksModified).toBe(true);
		expect(impact.messagesSent).toBe(true);
		expect(impact.otherSideEffects).toBe(false);
		expect(impact.toolNames).toEqual([
			"read_file",
			"bash",
			"create_task",
			"send_message",
		]);
	});
});

describe("analyzeRollbackImpact — range", () => {
	test("tool calls BEFORE the target are ignored", () => {
		const impact = analyzeRollbackImpact(
			[
				toolCall("bash"),
				toolCall("create_task"),
				userMsg("e2"),
				toolCall("read_file"),
			],
			"e2",
		);
		expect(impact.filesModified).toBe(false);
		expect(impact.tasksModified).toBe(false);
		expect(impact.toolNames).toEqual(["read_file"]);
	});

	test("target eid not found → empty impact (claims nothing)", () => {
		const impact = analyzeRollbackImpact(
			[userMsg("e1"), toolCall("bash")],
			"nope",
		);
		expect(hasSideEffects(impact)).toBe(false);
		expect(impact.toolNames).toEqual([]);
	});

	test("entries from ANOTHER task in the range are skipped", () => {
		const impact = analyzeRollbackImpact(
			[
				userMsg("e1", "task-a"),
				toolCall("bash", "task-b"),
				toolCall("read_file", "task-a"),
			],
			"e1",
		);
		expect(impact.filesModified).toBe(false);
		expect(impact.toolNames).toEqual(["read_file"]);
	});

	test("entries with unknown taskId are kept (never silently dropped)", () => {
		const impact = analyzeRollbackImpact(
			[userMsg("e1", "task-a"), { type: "tool_call", tool: "mcp__mxd__bash" }],
			"e1",
		);
		expect(impact.filesModified).toBe(true);
	});

	test("dedupes repeated tools, keeps first-call order", () => {
		const impact = analyzeRollbackImpact(
			[
				userMsg("e1"),
				toolCall("bash"),
				toolCall("read_file"),
				toolPair("bash"),
				toolCall("read_file"),
			],
			"e1",
		);
		expect(impact.toolNames).toEqual(["bash", "read_file"]);
	});

	test("tool_pair entries count the same as tool_call", () => {
		const impact = analyzeRollbackImpact(
			[userMsg("e1"), toolPair("write_file")],
			"e1",
		);
		expect(impact.filesModified).toBe(true);
	});

	test("empty tool name is ignored", () => {
		const impact = analyzeRollbackImpact(
			[userMsg("e1"), { type: "tool_call", taskId: TASK }],
			"e1",
		);
		expect(impact.toolNames).toEqual([]);
		expect(hasSideEffects(impact)).toBe(false);
	});
});
