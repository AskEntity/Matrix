#!/usr/bin/env bun
/**
 * Is `updateTaskOp` still all-or-nothing? Run it and read the answer.
 *
 *   bun run scripts/probe-update-task-partial.ts
 *
 * ── What this measured, before it was a regression demo ────────────────────
 *
 * `updateTaskOp` used to VALIDATE AND APPLY IN ONE PASS, in function-body
 * order, throwing partway. `parentId` sat above the status check and `title`
 * below it, so `{parentId, title, status:"closed"}` reparented the node,
 * dropped the title, and reported only that status was refused. A caller
 * reading that error would reasonably retry the whole call — replaying a
 * reparent that had already happened.
 *
 * The second half is what made it worse than a partial update. No tracker
 * mutator saves; only the `tracker.save()` at the END of updateTaskOp does. So
 * the applied half lived in MEMORY ONLY and tree.json still held the old
 * value — until some completely unrelated operation's save() published it, or
 * a restart evaporated it. Section 3 below is that exact sequence.
 *
 * ── Why it is still here ──────────────────────────────────────────────────
 *
 * Because the interesting states are ones no unit test can show you at once:
 * memory and disk side by side, and a THIRD party's save committing a change
 * nobody asked for. It exits non-zero if any of it regresses, so it stays a
 * measurement rather than a story about one.
 *
 * A note for whoever reads the output: `update_task changed nothing` and
 * `Cannot set status to "closed"` appearing below are the PASSING result.
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateTaskOp } from "../src/task-operations.ts";
import { TaskTracker } from "../src/task-tracker.ts";

const dir = await mkdtemp(join(tmpdir(), "probe-update-"));
const treePath = join(dir, "tree.json");
const tracker = new TaskTracker(treePath);
await tracker.load("main");

const root = tracker.rootNodeId;
const oldParent = tracker.addChild(root, "old parent", "d");
const newParent = tracker.addChild(root, "new parent", "d");
const victim = tracker.addChild(oldParent.id, "ORIGINAL TITLE", "d");
await tracker.save();

// A one-shot diagnostic on a throwaway tree: there is no index to keep in
// step, which is the whole reason `dataPaths: null` is honest here. See the
// exemption row in src/task-index-coverage.test.ts.
const callbacks = {
	broadcastTree: () => {},
	projectPath: dir,
	dataPaths: null,
};

const failures: string[] = [];
function check(what: string, ok: boolean, detail: string) {
	console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}${ok ? "" : ` — ${detail}`}`);
	if (!ok) failures.push(what);
}

async function onDisk(id: string) {
	const raw = JSON.parse(await readFile(treePath, "utf-8")) as {
		nodes: Array<{ id: string; title: string; parentId: string | null }>;
	};
	const n = raw.nodes.find((x) => x.id === id);
	return { title: n?.title, parentId: n?.parentId };
}

// ── 1. a refused field takes the whole call down with it ───────────────────
console.log(
	"\n1. {parentId, title, status:'closed'} — the combination that broke",
);
let threw = "";
try {
	await updateTaskOp(
		tracker,
		victim.id,
		{ parentId: newParent.id, title: "NEW TITLE", status: "closed" },
		"agent",
		callbacks,
	);
} catch (e) {
	threw = (e as Error).message;
}
console.log(`   error: ${threw}`);
check("the call was refused", threw !== "", "it succeeded");
check(
	"the error mentions the OTHER fields, not just status",
	threw.includes("title") && threw.includes("parentId"),
	"it names only the field it rejected — the original complaint",
);
check(
	"parentId did NOT land in memory",
	tracker.get(victim.id)?.parentId === oldParent.id,
	`parentId is ${tracker.get(victim.id)?.parentId}`,
);
check(
	"title did NOT land in memory",
	tracker.getTask(victim.id)?.title === "ORIGINAL TITLE",
	`title is ${tracker.getTask(victim.id)?.title}`,
);
check(
	"the old parent still lists it as a child",
	tracker.get(oldParent.id)?.children.includes(victim.id) === true,
	"reparent rewrites BOTH children arrays — a half-move tears the tree",
);

// ── 2. memory and disk agree ───────────────────────────────────────────────
console.log("\n2. memory vs tree.json");
const mem = {
	title: tracker.getTask(victim.id)?.title,
	parentId: tracker.get(victim.id)?.parentId,
};
const disk = await onDisk(victim.id);
console.log(`   memory: ${JSON.stringify(mem)}`);
console.log(`   disk  : ${JSON.stringify(disk)}`);
check(
	"they agree",
	mem.title === disk.title && mem.parentId === disk.parentId,
	"a field landed in memory that tree.json has never seen",
);

// ── 3. an unrelated later save must not publish an abandoned change ────────
console.log("\n3. someone else, elsewhere, saves");
const before = await onDisk(victim.id);
await updateTaskOp(
	tracker,
	root,
	{ title: "unrelated rename of a different node" },
	"agent",
	callbacks,
);
const after = await onDisk(victim.id);
console.log(`   victim on disk before: ${JSON.stringify(before)}`);
console.log(`   victim on disk after : ${JSON.stringify(after)}`);
check(
	"the unrelated save did not commit the abandoned reparent",
	before.parentId === after.parentId,
	"a third party's save() published a change its caller was told was refused",
);

// ── 4. a call that asks for nothing ────────────────────────────────────────
console.log("\n4. updateTaskOp(id, {}) — nothing to change");
let emptyThrew = "";
try {
	await updateTaskOp(tracker, victim.id, {}, "agent", callbacks);
} catch (e) {
	emptyThrew = (e as Error).message;
}
console.log(`   error: ${emptyThrew || "(none — it reported success)"}`);
check(
	"refused instead of reporting success",
	emptyThrew !== "",
	"a no-op that reports success is indistinguishable from a real update",
);

console.log(
	failures.length === 0
		? "\nAll checks passed (4 sections, 9 checks)."
		: `\n${failures.length} REGRESSED: ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
