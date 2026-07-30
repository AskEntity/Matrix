/**
 * PROBE: how much owed work is buried in `done()` result rounds with no node?
 *
 * A result round is append-only history. It can RECORD a request — "root should
 * retitle this", "left for root to decide", "out of scope, but someone needs to"
 * — and nothing executes it, nothing marks it as owed, and nothing turns red
 * when it is ignored. See memory.md § "A request inside a done() result is owed
 * to nobody".
 *
 * This measures the BACKLOG that predates the rule. No test can pin accumulated
 * history, which is the whole reason this file is committed rather than thrown
 * away (memory.md § "Which probes get committed").
 *
 * OUTPUT IS A RAW DUMP ON PURPOSE. It classifies nothing beyond "this sentence
 * names an actor who is not the author" and "this round also names a task id
 * somewhere". Adjudicate by reading; every heuristic added here is a branch
 * built for an imagined need.
 *
 * POSITIVE CONTROL FIRST, and it refuses a verdict without one. "No matches"
 * and "never looked" are byte-identical, and this scanner's premises have both
 * failed before in this repo: tree.json's `nodes` is an ARRAY, so Object.entries
 * hands back indices, and a probe that believed it reported the same answer for
 * all 551 tasks.
 *
 *   bun scripts/scan-unowned-requests.ts [--dump]
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataDir } from "../src/data-paths.ts";

/** Sentences that name an actor who is not the author. */
const REQUEST =
	/\bfor root\b|\broot (should|needs|must|will need|has to)\b|\b(someone|somebody|whoever|the next person)\b[^.]{0,60}?\b(should|needs|must)\b|\bshould be [a-z]+(ed|d)\b|\bI (could not|couldn't|was refused)\b|\bout of scope\b|\b(left|leaving|leave) (it |this |them )?(to|for) (root|the parent|whoever|someone)\b|应该|留给|需要有人/i;

/** A request that became a node says so by naming one. */
const NAMES_A_NODE =
	/\b(filed|file|filing|created|draft|task)\b[^.\n]{0,40}?`?01[0-9A-HJKMNP-TV-Z]{24}/i;

/**
 * Two rounds known to carry an unowned request, both verified by hand on
 * 2026-07-30. If the scan cannot see these it cannot report a zero.
 */
const CONTROLS: Array<[string, string]> = [
	["01KYJ4E7JERXZFJCQDB5SB9GQ6", "TWO THINGS FOR ROOT"],
	["01KYT790CAXBMW3X5VV9J3JYSV", "WANTED TO CHANGE, DID NOT"],
];

const dump = process.argv.includes("--dump");

type Hit = {
	id: string;
	title: string;
	round: number;
	owned: boolean;
	lines: string[];
};

let treesRead = 0;
let tasksSeen = 0;
let rounds = 0;
let chars = 0;
const hits: Hit[] = [];
const controlsSeen = new Set<string>();

const projRoot = join(resolveDataDir(), "projects");
for (const proj of await readdir(projRoot)) {
	const pluginRoot = join(projRoot, proj, "plugin");
	let plugins: string[];
	try {
		plugins = await readdir(pluginRoot);
	} catch {
		continue;
	}
	for (const plugin of plugins) {
		let raw: string;
		try {
			raw = await readFile(join(pluginRoot, plugin, "tree.json"), "utf8");
		} catch {
			continue;
		}
		const tree = JSON.parse(raw);
		// PREMISE, asserted rather than assumed: nodes is an array of ULID-keyed nodes.
		if (!Array.isArray(tree.nodes))
			throw new Error(`PREMISE FAILED: nodes is not an array in ${plugin}`);
		treesRead++;
		for (const node of tree.nodes) {
			tasksSeen++;
			if (!Array.isArray(node.resultRounds)) continue;
			if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(node.id ?? "")) {
				throw new Error(
					`PREMISE FAILED: non-ULID node id ${JSON.stringify(node.id)}`,
				);
			}
			node.resultRounds.forEach((r: { result?: string }, i: number) => {
				const text = r.result ?? "";
				rounds++;
				chars += text.length;
				for (const [id, needle] of CONTROLS) {
					if (node.id === id && text.includes(needle)) controlsSeen.add(id);
				}
				const sentences = text
					.split(/(?<=[.!?。])\s+|\n\n/)
					.filter((s) => REQUEST.test(s));
				if (sentences.length === 0) return;
				hits.push({
					id: node.id,
					title: node.title ?? "",
					round: i,
					owned: NAMES_A_NODE.test(text),
					lines: sentences.map((s) => s.replace(/\s+/g, " ").slice(0, 240)),
				});
			});
		}
	}
}

const missing = CONTROLS.filter(([id]) => !controlsSeen.has(id));
if (missing.length > 0) {
	console.error(
		`REFUSING A VERDICT — positive control(s) not found: ${missing.map(([id]) => id).join(", ")}`,
	);
	console.error(
		"The scan could not see rounds it is known to contain, so a count here means nothing.",
	);
	process.exit(1);
}

if (dump) {
	for (const h of hits) {
		console.log(
			`\n### ${h.id} r${h.round} ${h.owned ? "[names a node]" : "[NAMES NO NODE]"} ${h.title}`,
		);
		for (const l of h.lines) console.log(`   • ${l}`);
	}
	console.log("");
}

const unowned = hits.filter((h) => !h.owned);
console.log(`positive controls: ${CONTROLS.length}/${CONTROLS.length} found`);
console.log(
	`trees read: ${treesRead}, tasks: ${tasksSeen}, result rounds: ${rounds} (${chars} chars)`,
);
console.log(`rounds carrying request-shaped prose: ${hits.length}`);
console.log(
	`  ...that also name a task id somewhere: ${hits.length - unowned.length}`,
);
console.log(`  ...that name no task id at all:        ${unowned.length}`);
console.log(
	"\nSCOPE: matched by sentence shape, not by meaning. 'names a task id' is a proxy for owned —" +
		"\nthe id may be unrelated to the request. Read the hits (--dump); do not quote these counts" +
		"\nas adjudicated findings.",
);
