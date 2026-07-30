/**
 * AUDIT (keep): has any commit ever shipped with a Task-Id that git cannot read?
 *
 * Damage signature: `Task-Id:` is present in `%B` but
 * `%(trailers:key=Task-Id,valueonly)` is empty. The id is there, so anything
 * that greps the message scores the commit as healthy; every correct consumer
 * uses git's parser and gets nothing. **The grep-shaped audit is both easier to
 * write and wrong in the reassuring direction**, which is the entire reason this
 * file exists rather than a one-liner.
 *
 * Three causes are known, all of them `git interpret-trailers` disagreeing with
 * the reader about where a commit message ENDS: MERGE_MSG's missing trailing
 * newline, a `---` divider line in the body, and an empty message. The hook
 * guards all three. A FOURTH would ship in silence — no test can fail for a
 * commit that is already made, which is why this is committed and the shape
 * probes were not.
 *
 * ⚠️ POSITIVE CONTROL FIRST, and it exercises this file's own detector: a
 * scratch repo is built with one good commit, one commit carrying the damage
 * signature, and one with no trailer at all. Unless the detector finds exactly
 * that, the audit refuses to report on the real repo — "zero damage" and "the
 * detector is broken" are otherwise the same output.
 *
 * Usage: bun scripts/audit-task-id-trailers.ts [repo-path]
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const US = "\x1f";
const RS = "\x1e";

async function git(args: string[], cwd: string): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	return new Response(proc.stdout).text();
}

interface Scan {
	/** Task-Id present and readable by git's own parser. */
	readable: number;
	/**
	 * No `Task-Id:` line in the message. That is the whole claim — this counter
	 * must never be labelled with a CAUSE, because the scan tests none.
	 *
	 * ⚠️ It was labelled `(pre-migration)` and that was already false when
	 * written: it also holds every merge root makes on main, since a clean
	 * `--no-ff` merge runs no hook. Caught by root's own merge moving the number
	 * seconds after this file landed. The failure is the one this file's own
	 * docstring warns about — an explanation the detector never tested, offered
	 * in the reassuring direction.
	 */
	noTrailer: number;
	/** THE DAMAGE: in %B, invisible to the parser. */
	unreadable: { sha: string; subject: string }[];
}

async function scan(repo: string): Promise<Scan> {
	const log = await git(
		["log", `--format=%H${US}%(trailers:key=Task-Id,valueonly)${US}%B${RS}`],
		repo,
	);
	const out: Scan = { readable: 0, noTrailer: 0, unreadable: [] };
	for (const rec of log.split(RS)) {
		const trimmed = rec.replace(/^\n+/, "");
		if (!trimmed) continue;
		const [sha, parsed, body] = trimmed.split(US);
		if (!sha || body === undefined) continue;
		const inBody = body.split("\n").some((l) => l.startsWith("Task-Id:"));
		if (!inBody) out.noTrailer++;
		else if (parsed?.trim()) out.readable++;
		else {
			out.unreadable.push({
				sha,
				subject: body.split("\n")[0] ?? "",
			});
		}
	}
	return out;
}

async function positiveControl(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "audit-trailer-control-"));
	try {
		await git(["init", "-q", "."], dir);
		await git(["config", "user.email", "control@test"], dir);
		await git(["config", "user.name", "Control"], dir);

		const commit = async (name: string, message: string) => {
			await writeFile(join(dir, name), `${name}\n`);
			await writeFile(join(dir, "MSG"), message);
			await git(["add", name], dir);
			await git(["commit", "-q", "-F", "MSG"], dir);
		};
		await commit("good.txt", "good commit\n\nTask-Id: 01GOOD\n");
		// The damage: `---` ends the message, so the trailer above it is not a
		// trailer. This is the exact shape the hook's --no-divider flag prevents.
		await commit(
			"broken.txt",
			"broken commit\n\nTask-Id: 01BROKEN\n\n---\n\nnote below the divider\n",
		);
		await commit("plain.txt", "no trailer at all\n");

		const got = await scan(dir);
		const ok =
			got.readable === 1 && got.noTrailer === 1 && got.unreadable.length === 1;
		if (!ok) {
			throw new Error(
				`positive control FAILED — detector saw readable=${got.readable} ` +
					`noTrailer=${got.noTrailer} unreadable=${got.unreadable.length}, ` +
					"expected 1/1/1. Not reporting on the real repo.",
			);
		}
		console.log("positive control OK — the detector can see the damage shape.");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

await positiveControl();

const repo = process.argv[2] ?? process.cwd();
const result = await scan(repo);
console.log(`\nrepo: ${repo}`);
console.log(`  readable by git's parser: ${result.readable}`);
console.log(`  no Task-Id in the message: ${result.noTrailer}`);
console.log(`  UNREADABLE (the damage):   ${result.unreadable.length}`);
// Say what is IN that bucket without claiming the scan sorted it: everything
// the hook did not stamp. It grows with every merge root makes, so a reader
// watching the number needs to know that is expected, not decay.
console.log(
	"    (that bucket is every commit the hook did not stamp — everything\n" +
		"     predating the mechanism, plus root's merges on main, which run no hook)",
);
for (const c of result.unreadable) {
	console.log(`     ${c.sha.slice(0, 8)}  ${c.subject}`);
}
if (result.unreadable.length > 0) process.exitCode = 1;
