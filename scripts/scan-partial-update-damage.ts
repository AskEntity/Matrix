/**
 * PROBE (throwaway): did the partial-update bug ever actually fire in production?
 *
 * Damage signature: ONE update_task tool_call whose input carries BOTH a field
 * that lands BEFORE the status check (`parentId`) AND a status the check
 * rejects (`closed` / `failed`). That call reparented the node and told the
 * caller only that status was refused.
 *
 * Secondary (lossy, not damage): any rejected call that also carried title /
 * description / draft / color / metadata — those are AFTER the throw, so they
 * were silently dropped.
 *
 * ⚠️ POSITIVE CONTROL FIRST. "no matches" and "never looked" are the same
 * output, so the scan asserts it can see update_task calls with a parentId at
 * all before it is allowed to report a zero.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const REJECTED = new Set(["closed", "failed"]);
// Fields applied AFTER the status check in updateTaskOp — silently dropped.
const AFTER = ["title", "description", "draft", "color", "metadata"];

let filesRead = 0;
let linesRead = 0;
let updateTaskCalls = 0;
let withParentId = 0; // positive control
let withRejectedStatus = 0;
const damage: string[] = [];
const dropped: string[] = [];

const projRoot = join(homedir(), ".mxd", "projects");
for (const proj of await readdir(projRoot)) {
	const tasksDir = join(projRoot, proj, "plugin", "matrix", "tasks");
	let files: string[];
	try {
		files = await readdir(tasksDir);
	} catch {
		continue;
	}
	for (const f of files) {
		if (!f.endsWith(".jsonl")) continue;
		filesRead++;
		const text = await readFile(join(tasksDir, f), "utf-8");
		for (const line of text.split("\n")) {
			if (!line) continue;
			linesRead++;
			// cheap prefilter, then parse
			if (!line.includes("update_task")) continue;
			let ev: {
				type?: string;
				tool?: string;
				input?: Record<string, unknown>;
				ts?: number;
				taskId?: string;
			};
			try {
				ev = JSON.parse(line);
			} catch {
				continue;
			}
			if (ev.type !== "tool_call") continue;
			if (!ev.tool?.endsWith("update_task")) continue;
			const input = ev.input ?? {};
			updateTaskCalls++;
			const hasParent = input.parentId !== undefined;
			if (hasParent) withParentId++;
			const status = input.status;
			const rejected = typeof status === "string" && REJECTED.has(status);
			if (!rejected) continue;
			withRejectedStatus++;
			const when = ev.ts ? new Date(ev.ts).toISOString() : "?";
			if (hasParent) {
				damage.push(
					`${when}  ${proj}/${f}  target=${String(input.taskId)}  parentId=${String(input.parentId)}  status=${String(status)}`,
				);
			}
			const lost = AFTER.filter((k) => input[k] !== undefined);
			if (lost.length > 0) {
				dropped.push(
					`${when}  ${proj}/${f}  target=${String(input.taskId)}  status=${String(status)}  SILENTLY DROPPED: ${lost.join(", ")}`,
				);
			}
		}
	}
}

console.log(`files=${filesRead}  lines=${linesRead}`);
console.log(`update_task tool_calls seen: ${updateTaskCalls}`);
console.log(`  ...carrying parentId  (POSITIVE CONTROL): ${withParentId}`);
console.log(
	`  ...carrying a rejected status:            ${withRejectedStatus}`,
);

if (updateTaskCalls === 0 || withParentId === 0) {
	console.log(
		"\n⚠️ CONTROL FAILED — the scan never saw the shape it is looking for.",
	);
	console.log(
		"   A zero below would be a fact about this script, not the data.",
	);
	process.exit(1);
}

console.log(
	`\n=== TREE DAMAGE (reparent landed, caller told only about status) ===`,
);
console.log(damage.length === 0 ? "  none" : damage.join("\n"));
console.log(
	`\n=== SILENTLY DROPPED FIELDS (post-throw, lossy but not damage) ===`,
);
console.log(dropped.length === 0 ? "  none" : dropped.join("\n"));
