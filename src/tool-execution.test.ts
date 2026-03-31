import { describe, expect, test } from "bun:test";
import { __testOnly } from "./tool-execution.ts";

describe("normalizeToolInput", () => {
	test("drops empty string fields so optional params behave as omitted", () => {
		expect(
			__testOnly.normalizeToolInput({
				taskId: "task-1",
				parentId: "",
				old_description: "",
				new_description: "",
			}),
		).toEqual({ taskId: "task-1" });
	});

	test("preserves boolean false so false is not treated as omitted", () => {
		expect(
			__testOnly.normalizeToolInput({
				persistent: false,
				draft: false,
			}),
		).toEqual({ persistent: false, draft: false });
	});
});
