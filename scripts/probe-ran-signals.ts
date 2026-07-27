/**
 * One-off probe: do the three candidate "did this task ever execute" signals
 * agree on real data?
 *
 * Signals:
 *   A. resultRounds?.length  — "did it REPORT?"
 *   B. costUsd > 0           — "did it SPEND?"
 *   C. session JSONL exists  — "did it ever HAVE a session?"
 *
 * Run: bun scripts/probe-ran-signals.ts
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { projectTasksDir, projectTreeJsonPath } from "../src/data-paths.ts";

const dataDir = join(homedir(), ".mxd");
const projectId = process.argv[2] ?? "01KN0H3365HN9W560R7WC3XQ10";
const dataRoot = "@/plugin/matrix";

const tree = JSON.parse(
	readFileSync(projectTreeJsonPath(dataDir, projectId, dataRoot), "utf-8"),
) as { nodes: Array<Record<string, unknown>> };
const tasksDir = projectTasksDir(dataDir, projectId, dataRoot);

// Instrument check: `nodes` is an ARRAY. Reading it as a keyed object hands
// back indices as ids, every existsSync misses, and the probe reports a
// confident "0 sessions exist" — which is what happened on the first run.
if (!Array.isArray(tree.nodes)) throw new Error("tree.nodes is not an array");
{
	const sample = tree.nodes.find((n) => n.type === "task");
	if (!sample || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(String(sample.id)))
		throw new Error(`node id does not look like a ULID: ${sample?.id}`);
}

type Row = {
	id: string;
	status: string;
	a: boolean;
	b: boolean;
	c: boolean;
	bytes: number;
	title: string;
};
const rows: Row[] = [];

for (const n of tree.nodes) {
	if (n.type !== "task") continue;
	const id = String(n.id);
	const jsonl = join(tasksDir, `${id}.jsonl`);
	const exists = existsSync(jsonl);
	rows.push({
		id,
		status: String(n.status ?? "unknown"),
		a: Array.isArray(n.resultRounds) && n.resultRounds.length > 0,
		b: typeof n.costUsd === "number" && n.costUsd > 0,
		c: exists,
		bytes: exists ? statSync(jsonl).size : 0,
		title: String(n.title ?? "").slice(0, 50),
	});
}

console.log(`total tasks: ${rows.length}`);

// Per-status breakdown.
const byStatus = new Map<string, Row[]>();
for (const r of rows) {
	const list = byStatus.get(r.status) ?? [];
	list.push(r);
	byStatus.set(r.status, list);
}
console.log("\nstatus            n    A:rounds  B:cost>0  C:jsonl");
for (const [status, list] of [...byStatus].sort()) {
	console.log(
		`${status.padEnd(14)} ${String(list.length).padStart(4)}  ${String(
			list.filter((r) => r.a).length,
		).padStart(8)}  ${String(list.filter((r) => r.b).length).padStart(
			8,
		)}  ${String(list.filter((r) => r.c).length).padStart(7)}`,
	);
}

// Disagreements: where do the three signals split?
const combos = new Map<string, Row[]>();
for (const r of rows) {
	const k = `${r.a ? "A" : "-"}${r.b ? "B" : "-"}${r.c ? "C" : "-"}`;
	const list = combos.get(k) ?? [];
	list.push(r);
	combos.set(k, list);
}
console.log("\ncombo (A=rounds B=cost C=jsonl):");
for (const [k, list] of [...combos].sort()) {
	console.log(`  ${k}  n=${String(list.length).padStart(4)}`);
}

// The interesting cell: closed tasks, split by each signal.
const closed = rows.filter((r) => r.status === "closed");
console.log(`\nCLOSED tasks: ${closed.length}`);
console.log(`  A (has result rounds): ${closed.filter((r) => r.a).length}`);
console.log(`  B (costUsd > 0):       ${closed.filter((r) => r.b).length}`);
console.log(`  C (jsonl exists):      ${closed.filter((r) => r.c).length}`);

// Where C and A disagree on closed tasks — these are the tasks that ran but
// never reported, or reported but lost their log.
const cNotA = closed.filter((r) => r.c && !r.a);
const aNotC = closed.filter((r) => r.a && !r.c);
console.log(`\n  closed, jsonl but NO rounds (ran, never done()): ${cNotA.length}`);
for (const r of cNotA.slice(0, 10))
	console.log(`     ${r.id} ${r.bytes}B  "${r.title}"`);
console.log(`  closed, rounds but NO jsonl (log gone): ${aNotC.length}`);
for (const r of aNotC.slice(0, 10))
	console.log(`     ${r.id} "${r.title}"`);

// Never-ran closed tasks by every signal.
const neverRan = closed.filter((r) => !r.a && !r.b && !r.c);
console.log(`\n  closed with NO signal at all (never executed): ${neverRan.length}`);
for (const r of neverRan.slice(0, 10)) console.log(`     ${r.id} "${r.title}"`);

// How small can an existing jsonl be? A session that launched and died
// immediately still writes agent_start.
const tiny = rows.filter((r) => r.c && r.bytes < 2000);
console.log(`\n  jsonl smaller than 2000B: ${tiny.length}`);
for (const r of tiny.slice(0, 10))
	console.log(`     ${r.id} ${r.bytes}B ${r.status} "${r.title}"`);

// Per-status combo table + the union.
console.log("\nper-status combos:");
for (const [status, list] of [...byStatus].sort()) {
	const c = new Map<string, number>();
	for (const r of list) {
		const k = `${r.a ? "A" : "-"}${r.b ? "B" : "-"}${r.c ? "C" : "-"}`;
		c.set(k, (c.get(k) ?? 0) + 1);
	}
	console.log(`  ${status.padEnd(12)} ${[...c].sort().map(([k, v]) => `${k}=${v}`).join("  ")}`);
}
console.log("\nthe disagreeing tasks:");
for (const r of rows) {
	const k = `${r.a ? "A" : "-"}${r.b ? "B" : "-"}${r.c ? "C" : "-"}`;
	if (k === "-B-" || k === "--C" || k === "A--" || k === "AB-")
		console.log(`  ${k} ${r.status.padEnd(12)} ${r.id} "${r.title}"`);
}
const union = rows.filter((r) => r.a || r.b || r.c);
console.log(`\nUNION (a||b||c) ran: ${union.length} of ${rows.length}`);
for (const [status, list] of [...byStatus].sort())
	console.log(
		`  ${status.padEnd(12)} ran=${list.filter((r) => r.a || r.b || r.c).length}/${list.length}`,
	);
console.log(
	`\nif A alone were the signal, closed tasks mislabeled "never ran": ${
		closed.filter((r) => !r.a && (r.b || r.c)).length
	} of ${closed.filter((r) => r.a || r.b || r.c).length} that did run`,
);
