import { describe, expect, it } from "bun:test";
import { formatHashString, parseHashString } from "./hash-routing.ts";

describe("parseHashString", () => {
	it("empty hash → empty object", () => {
		expect(parseHashString("")).toEqual({});
		expect(parseHashString("#")).toEqual({});
	});

	it("projectId only", () => {
		expect(parseHashString("#proj-1")).toEqual({ projectId: "proj-1" });
	});

	it("projectId + taskId", () => {
		expect(parseHashString("#proj-1/task-abc")).toEqual({
			projectId: "proj-1",
			taskId: "task-abc",
		});
	});

	it("projectId + taskId + entry=ts", () => {
		expect(parseHashString("#proj-1/task-abc/entry=1712345678900")).toEqual({
			projectId: "proj-1",
			taskId: "task-abc",
			entryTs: 1712345678900,
		});
	});

	it("hash with no leading #", () => {
		// parseHashString is tolerant — callers may pass either form
		expect(parseHashString("proj-1/task-abc")).toEqual({
			projectId: "proj-1",
			taskId: "task-abc",
		});
	});

	it("ignores unknown entry= value (non-numeric)", () => {
		// Keep projectId and taskId; drop entryTs when parse fails
		expect(parseHashString("#proj-1/task-abc/entry=notanumber")).toEqual({
			projectId: "proj-1",
			taskId: "task-abc",
		});
	});

	it("ignores segment without entry= prefix", () => {
		expect(parseHashString("#proj-1/task-abc/something-else")).toEqual({
			projectId: "proj-1",
			taskId: "task-abc",
		});
	});

	it("accepts ulid-style taskIds containing no slashes", () => {
		expect(parseHashString("#p/01KNF4N4C3XPVWH1YKJ233SVNK")).toEqual({
			projectId: "p",
			taskId: "01KNF4N4C3XPVWH1YKJ233SVNK",
		});
	});

	it("accepts entry=0 (epoch — edge case)", () => {
		expect(parseHashString("#p/t/entry=0")).toEqual({
			projectId: "p",
			taskId: "t",
			entryTs: 0,
		});
	});
});

describe("formatHashString", () => {
	it("no project → empty", () => {
		expect(formatHashString("", null, null)).toBe("");
	});

	it("project only", () => {
		expect(formatHashString("proj-1", null, null)).toBe("#proj-1");
	});

	it("project + task", () => {
		expect(formatHashString("proj-1", "task-abc", "root-id")).toBe(
			"#proj-1/task-abc",
		);
	});

	it("project + taskId equal to rootNodeId → drops task (shows orchestrator)", () => {
		expect(formatHashString("proj-1", "root-id", "root-id")).toBe("#proj-1");
	});

	it("project only when task is null", () => {
		expect(formatHashString("proj-1", null, "root-id")).toBe("#proj-1");
	});
});

describe("round-trip parseHashString ∘ formatHashString", () => {
	it("project + task round-trips", () => {
		const hash = formatHashString("proj-1", "task-abc", "root");
		expect(parseHashString(hash)).toEqual({
			projectId: "proj-1",
			taskId: "task-abc",
		});
	});
});
