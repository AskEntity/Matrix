/**
 * Tests for `.hooks/pre-commit` — the repo's ONLY gate runner. There is no CI
 * (`.github/`, `.gitlab-ci.yml`: both absent), so whatever this hook does not
 * check is not checked anywhere.
 *
 * It runs a SMOKE SUBSET of the suite, and that is a legitimate performance
 * trade — a full `bun test` is ~260-300s per commit. What was not legitimate is
 * what the subset did next: it named five test files, ran four, and printed
 * "All checks passed."
 *
 * `src/direct-provider.test.ts` was deleted on 2026-03-12, four days after
 * being added to that list, and the hook named it for the following 4.5 months.
 * `bun test` skips a path that does not exist and still exits 0, so nothing
 * anywhere said so.
 *
 * That is the sharp form of the addition-list defect. The usual story is "an
 * addition list fails to cover NEW code"; this one silently stopped covering
 * the code it explicitly NAMED, so even its own stated scope was fiction. The
 * runner's tolerance of a missing path is what made it silent — which gives the
 * family a second rule worth as much as the finding:
 *
 *   An addition list must FAIL when a listed item is absent. A checker that
 *   shrugs at a missing entry cannot tell "we chose not to check this" from
 *   "this evaporated".
 *
 * A named-but-missing file is precisely the condition nobody will think to
 * re-verify, so it is pinned here rather than only implemented in the hook.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const HOOK = join(REPO_ROOT, ".hooks", "pre-commit");

/** The test files the hook names, parsed out of the hook itself. */
function smokeTestList(hookSource: string): string[] {
	const block = /SMOKE_TESTS="([^"]*)"/.exec(hookSource)?.[1] ?? "";
	return block.split(/\s+/).filter(Boolean);
}

describe(".hooks/pre-commit: the smoke list cannot drain silently", () => {
	const source = readFileSync(HOOK, "utf-8");

	test("every test file the hook names actually exists", () => {
		// The drain, caught in the suite rather than only at commit time. This
		// is the assertion that would have gone red in March 2026 instead of
		// nobody noticing until July.
		const named = smokeTestList(source);
		expect(named.length).toBeGreaterThan(0);
		const missing = named.filter((f) => !existsSync(join(REPO_ROOT, f)));
		expect(missing).toEqual([]);
	});

	test("a named-but-missing file fails the hook, before it runs anything expensive", async () => {
		// The guard half, executed rather than inferred. It must fire BEFORE
		// typecheck: a broken list is a fact about the list, and spending 7s to
		// discover it teaches people to skip the hook.
		const dir = await mkdtemp(join(tmpdir(), "hook-drain-"));
		try {
			const mutated = join(dir, "pre-commit");
			const named = smokeTestList(source)[0];
			expect(named).toBeDefined();
			await Bun.write(
				mutated,
				source.replace(String(named), "src/deleted-four-months-ago.test.ts"),
			);
			const proc = Bun.spawn(["sh", mutated], {
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
			});
			const code = await proc.exited;
			const out =
				(await new Response(proc.stdout).text()) +
				(await new Response(proc.stderr).text());

			expect(code).toBe(1);
			expect(out).toContain("src/deleted-four-months-ago.test.ts");
			// Bailed early: never reached the first expensive step.
			expect(out).not.toContain("Running typecheck");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("the counts in the output are COMPUTED, never written down", () => {
		// A literal "5 of 140" is indistinguishable from a true one the day it
		// stops being true — the same drained rot, in the sentence that exists
		// to describe the scope. `RAN` must come from the list and `TOTAL` from
		// git, so a re-narrowing prints itself in front of whoever commits next.
		expect(source).toMatch(/RAN=\$\(echo \$SMOKE_TESTS \| wc -w/);
		expect(source).toMatch(/TOTAL=\$\(git ls-files/);

		// Anchor on `echo "` — the header comment quotes the old unqualified
		// sentence to explain why it is gone, and an unanchored match finds the
		// prose about the thing instead of the thing.
		const summary = /echo "All checks passed[^\n]*/.exec(source)?.[0] ?? "";
		expect(summary).toContain("$RAN");
		expect(summary).toContain("$TOTAL");
		// And no hardcoded ratio anywhere in the hook.
		expect(source).not.toMatch(/\d+ of \d+ test files/);
	});

	test("the hook still runs the gates whose own tests it also runs", () => {
		// Self-referential on purpose: a hook that runs a gate but not the
		// gate's own test can print that gate's "passed" while the gate is dead.
		// The data-paths audit was proven dead this morning by planting a
		// violation and getting 54 pass / 0 fail.
		expect(source).toContain("bash scripts/check-i18n.sh");
		const named = smokeTestList(source);
		expect(named).toContain("src/check-i18n.test.ts");
		expect(named).toContain("src/data-paths.test.ts");
	});
});
