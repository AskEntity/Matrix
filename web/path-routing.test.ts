/// <reference lib="dom" />
/**
 * Task Y unit tests for the path-routing utility functions.
 *
 * These are the single source of truth for "parse URL path" and "build
 * URL path". Shell and plugin share them; if either layer's behavior
 * drifts, these tests pin the pure form.
 */

import { describe, expect, test } from "bun:test";
import { buildPath, parsePath } from "./path-routing.ts";

describe("parsePath", () => {
	test("'/' → all-null", () => {
		expect(parsePath("/")).toEqual({
			projectId: null,
			pluginScope: null,
			pluginPath: "",
		});
	});

	test("'' (empty) → all-null", () => {
		expect(parsePath("")).toEqual({
			projectId: null,
			pluginScope: null,
			pluginPath: "",
		});
	});

	test("'/proj' → projectId only", () => {
		expect(parsePath("/proj")).toEqual({
			projectId: "proj",
			pluginScope: null,
			pluginPath: "",
		});
	});

	test("'/proj/' (trailing slash, no scope) → projectId only", () => {
		expect(parsePath("/proj/")).toEqual({
			projectId: "proj",
			pluginScope: null,
			pluginPath: "",
		});
	});

	test("'/proj/matrix' → projectId + scope", () => {
		expect(parsePath("/proj/matrix")).toEqual({
			projectId: "proj",
			pluginScope: "matrix",
			pluginPath: "",
		});
	});

	test("'/proj/matrix/' → same as above (trailing slash collapses)", () => {
		expect(parsePath("/proj/matrix/")).toEqual({
			projectId: "proj",
			pluginScope: "matrix",
			pluginPath: "",
		});
	});

	test("'/proj/matrix/task123' → projectId + scope + pluginPath", () => {
		expect(parsePath("/proj/matrix/task123")).toEqual({
			projectId: "proj",
			pluginScope: "matrix",
			pluginPath: "task123",
		});
	});

	test("'/proj/matrix/task123/sub/deeper' → pluginPath preserves nested form", () => {
		expect(parsePath("/proj/matrix/task123/sub/deeper")).toEqual({
			projectId: "proj",
			pluginScope: "matrix",
			pluginPath: "task123/sub/deeper",
		});
	});

	test("double slashes → treated as empty segments (filtered)", () => {
		expect(parsePath("//proj//matrix//task")).toEqual({
			projectId: "proj",
			pluginScope: "matrix",
			pluginPath: "task",
		});
	});

	test("ULID-format projectId and taskId", () => {
		expect(
			parsePath(
				"/01KN0H3365HN9W560R7WC3XQ10/matrix/01KPGSJNKG08CWNPZCQ9YY51C3",
			),
		).toEqual({
			projectId: "01KN0H3365HN9W560R7WC3XQ10",
			pluginScope: "matrix",
			pluginPath: "01KPGSJNKG08CWNPZCQ9YY51C3",
		});
	});

	test("UUID-format taskId (legacy) survives unchanged — no hyphen-split", () => {
		expect(
			parsePath("/proj/matrix/ea053810-fdba-4c90-9e0c-e7b22bcb5c68"),
		).toEqual({
			projectId: "proj",
			pluginScope: "matrix",
			pluginPath: "ea053810-fdba-4c90-9e0c-e7b22bcb5c68",
		});
	});
});

describe("buildPath", () => {
	test("empty pluginPath → trailing slash", () => {
		expect(buildPath("proj", "matrix", "")).toBe("/proj/matrix/");
	});

	test("taskId only", () => {
		expect(buildPath("proj", "matrix", "task123")).toBe("/proj/matrix/task123");
	});

	test("nested pluginPath passes through verbatim", () => {
		expect(buildPath("proj", "matrix", "task/sub")).toBe(
			"/proj/matrix/task/sub",
		);
	});

	test("round-trip: parse ∘ build = identity for the round-trip cases we care about", () => {
		// For the two canonical URL shapes we produce, parse(build(x)) = x.
		const cases: Array<{
			projectId: string;
			pluginScope: string;
			pluginPath: string;
		}> = [
			{ projectId: "proj", pluginScope: "matrix", pluginPath: "" },
			{ projectId: "proj", pluginScope: "matrix", pluginPath: "task123" },
			{
				projectId: "01KN0H",
				pluginScope: "matrix",
				pluginPath: "ea053810-fdba-4c90-9e0c-e7b22bcb5c68",
			},
		];
		for (const c of cases) {
			const url = buildPath(c.projectId, c.pluginScope, c.pluginPath);
			expect(parsePath(url)).toEqual(c);
		}
	});
});
