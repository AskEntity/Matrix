/**
 * Budget management: threshold checks and warning emission.
 * Used by the run loop to warn agents when they approach or exceed their budget.
 */
import type { Event } from "./events.ts";

/**
 * Check budget and inject warnings at 80% and 100% thresholds.
 * Returns warning events and the warning text to inject, if any.
 */
export function checkBudget(
	budgetUsd: number,
	runningCost: number,
): { warning: string; ratio: number } | null {
	const ratio = runningCost / budgetUsd;
	if (ratio >= 1.0) {
		return {
			warning: `⚠️ Budget exceeded (${runningCost.toFixed(4)} / ${budgetUsd.toFixed(2)} budget). Call done() now.`,
			ratio,
		};
	}
	if (ratio >= 0.8) {
		return {
			warning: `⚠️ Warning: task has used ${Math.round(ratio * 100)}% of its ${budgetUsd.toFixed(2)} budget (${runningCost.toFixed(4)} spent). Wrap up soon.`,
			ratio,
		};
	}
	return null;
}

/**
 * Emit a budget warning event.
 */
export function recordBudgetWarning(
	emit: ((event: Event) => void) | undefined,
	warning: string,
	taskId = "",
): void {
	if (emit) {
		emit({
			type: "budget_warning",
			warning,
			taskId,
			ts: Date.now(),
		});
	}
}
