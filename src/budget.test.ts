import { describe, expect, mock, test } from "bun:test";
import { checkBudget, recordBudgetWarning } from "./budget.ts";
import type { Event } from "./events.ts";

describe("checkBudget", () => {
	test("returns null when ratio < 0.8", () => {
		expect(checkBudget(10, 7.99)).toBeNull();
		expect(checkBudget(10, 0)).toBeNull();
		expect(checkBudget(10, 5)).toBeNull();
	});

	test("returns warning at exactly 80%", () => {
		const result = checkBudget(10, 8);
		expect(result).not.toBeNull();
		expect(result!.ratio).toBe(0.8);
		expect(result!.warning).toContain("80%");
		expect(result!.warning).toContain("10.00");
		expect(result!.warning).toContain("8.0000");
		expect(result!.warning).toContain("Wrap up soon");
	});

	test("returns warning between 80% and 100%", () => {
		const result = checkBudget(10, 9);
		expect(result).not.toBeNull();
		expect(result!.ratio).toBe(0.9);
		expect(result!.warning).toContain("90%");
		expect(result!.warning).toContain("Wrap up soon");
	});

	test("returns exceeded message at exactly 100%", () => {
		const result = checkBudget(10, 10);
		expect(result).not.toBeNull();
		expect(result!.ratio).toBe(1.0);
		expect(result!.warning).toContain("Budget exceeded");
		expect(result!.warning).toContain("done()");
	});

	test("returns exceeded message when over 100%", () => {
		const result = checkBudget(10, 15);
		expect(result).not.toBeNull();
		expect(result!.ratio).toBe(1.5);
		expect(result!.warning).toContain("Budget exceeded");
	});

	test("budget 0 → ratio is Infinity → exceeded", () => {
		const result = checkBudget(0, 5);
		expect(result).not.toBeNull();
		expect(result!.ratio).toBe(Number.POSITIVE_INFINITY);
		expect(result!.warning).toContain("Budget exceeded");
	});

	test("boundary: ratio just below 0.8 returns null", () => {
		expect(checkBudget(10, 7.999)).toBeNull();
	});

	test("boundary: ratio just above 0.8 returns warning", () => {
		const result = checkBudget(10, 8.001);
		expect(result).not.toBeNull();
		expect(result!.warning).toContain("Wrap up soon");
	});

	test("warning message includes budget and spent amounts", () => {
		const result = checkBudget(2.5, 2.1);
		expect(result).not.toBeNull();
		expect(result!.warning).toContain("2.50"); // budget
		expect(result!.warning).toContain("2.1000"); // spent
	});

	test("exceeded message includes budget and spent amounts", () => {
		const result = checkBudget(1.0, 1.5);
		expect(result).not.toBeNull();
		expect(result!.warning).toContain("1.00"); // budget
		expect(result!.warning).toContain("1.5000"); // spent
	});
});

describe("recordBudgetWarning", () => {
	test("calls emit with correct event shape", () => {
		const emitFn = mock((event: Event) => {});
		recordBudgetWarning(emitFn, "⚠️ Budget exceeded", "task-123");

		expect(emitFn).toHaveBeenCalledTimes(1);
		const event = emitFn.mock.calls[0]![0] as Event & {
			type: "budget_warning";
			warning: string;
			taskId: string;
		};
		expect(event.type).toBe("budget_warning");
		expect(event.warning).toBe("⚠️ Budget exceeded");
		expect(event.taskId).toBe("task-123");
		expect(event.ts).toBeGreaterThan(0);
	});

	test("no-op when emit is undefined", () => {
		// Should not throw
		recordBudgetWarning(undefined, "⚠️ Budget exceeded", "task-123");
	});

	test("uses empty string as default taskId", () => {
		const emitFn = mock((event: Event) => {});
		recordBudgetWarning(emitFn, "warning text");

		const event = emitFn.mock.calls[0]![0] as Event & { taskId: string };
		expect(event.taskId).toBe("");
	});
});
