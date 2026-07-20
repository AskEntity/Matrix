/**
 * DonePayload — the SINGLE source of truth for Matrix's done() content.
 *
 * `status` (passed/failed) is a RUNTIME control bit (routes the node to
 * verify/failed) and is NOT part of this struct. Everything the agent reports
 * as content lives here, and this SAME struct is a `resultRounds` element on the
 * node — done() ↔ resultRound is 1:1 by construction, not by hand-synced shapes.
 *
 * Add/remove a done content field → change THIS ONE schema. The done() tool
 * params (via `donePayloadSchema.shape`), the TS type (`z.infer`), the stored
 * round shape (`TaskNode.resultRounds`), and the payload the runtime hands to
 * the plugin's onDone all follow automatically. No fan-out.
 *
 * This file imports ONLY zod so it can be imported by both the runtime type
 * layer (`types.ts`) and the tool layer (`orchestrator-tools.ts`) without cycles.
 */
import { z } from "zod";

/**
 * The stored/round shape. The done() tool declares `result` required-non-empty;
 * `parseDonePayload` normalizes a raw done input into this always-present shape.
 * Agents fold lessons/pitfalls into the `result` narrative directly.
 */
export const donePayloadSchema = z.object({
	result: z.string(),
});

/** Matrix's done content == a resultRounds element. Derived from the schema. */
export type DonePayload = z.infer<typeof donePayloadSchema>;

/**
 * Rebuild a `DonePayload` from a raw done() tool_call input (the exact object
 * the agent passed to done(), read back from JSONL). This is the ONE place raw
 * input → round normalization happens — add a content field to
 * `donePayloadSchema` and normalize it here (only).
 *
 * ONLY Matrix calls this, from its `onDone` hook: the runtime hands the done
 * input to onDone as an opaque record and never itself reads the round shape
 * (that would leak round structure into the plugin-agnostic layer).
 * Missing / malformed `result` normalizes to `""`.
 */
export function parseDonePayload(
	input: Record<string, unknown> | undefined,
): DonePayload {
	return {
		result: typeof input?.result === "string" ? input.result : "",
	};
}
