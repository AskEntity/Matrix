/**
 * Tests for `scripts/check-i18n.sh` — the pre-commit i18n gate.
 *
 * This gate spent its life reading `find web -maxdepth 1`: 4 of the repo's 31
 * non-test .tsx files, never once entering `.mxd/plugin/web/` (where most of
 * the product's user-facing strings live), and printing an unqualified
 * "i18n check passed" the whole time. Nothing failed, so nothing said so.
 *
 * The scope is a subtraction now, and these tests are what keeps it one. Each
 * plants a violation somewhere the old scope could not see and asserts the gate
 * goes red — the same standard the sibling data-paths audit is held to. They
 * run against a synthetic tree (cwd = a temp dir), so the fixture's file count
 * is fixed and the assertions do not rot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "check-i18n.sh");
const REPO_ROOT = join(import.meta.dir, "..");

async function runGate(cwd: string) {
	const proc = Bun.spawn(["bash", SCRIPT], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { code, out: stdout + stderr };
}

const CLEAN = `export function A() {
	return <div className="x">{t("some.key")}</div>;
}
`;
const BARE = `export function B() {
	return <div className="x">Bare English Here</div>;
}
`;

describe("check-i18n.sh: scope is a subtraction", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "i18n-gate-"));
		// Scanned (3): shallow, nested, and nested-inside-a-dot-directory.
		await Bun.write(join(dir, "web/A.tsx"), CLEAN);
		await Bun.write(join(dir, "web/components/B.tsx"), CLEAN);
		await Bun.write(join(dir, ".mxd/plugin/web/components/D.tsx"), CLEAN);
		// Subtracted (4): three pruned directories + the *.test.tsx file rule.
		// Every one of these carries a bare string, so a prune that stops
		// working shows up as a violation rather than as silence.
		await Bun.write(join(dir, "web/C.test.tsx"), BARE);
		await Bun.write(join(dir, "node_modules/pkg/E.tsx"), BARE);
		await Bun.write(join(dir, ".worktrees/w/web/F.tsx"), BARE);
		await Bun.write(join(dir, "dist/G.tsx"), BARE);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("a clean tree passes AND says how much it read", async () => {
		const { code, out } = await runGate(dir);
		expect(out).toContain("scanned 3 JSX file(s)");
		expect(code).toBe(0);
	});

	test("catches a bare string under .mxd/plugin/web — the tree the old scope never entered", async () => {
		await Bun.write(join(dir, ".mxd/plugin/web/components/D.tsx"), BARE);
		const { code, out } = await runGate(dir);
		expect(code).toBe(1);
		expect(out).toContain(".mxd/plugin/web/components/D.tsx:2:");
		expect(out).toContain("scanned 3 JSX file(s)");
	});

	test("catches a bare string below web/ — the old scope stopped at maxdepth 1", async () => {
		await Bun.write(join(dir, "web/components/B.tsx"), BARE);
		const { code, out } = await runGate(dir);
		expect(code).toBe(1);
		expect(out).toContain("web/components/B.tsx:2:");
	});

	test("does NOT scan pruned directories or test files", async () => {
		// The guard half: these four all contain bare strings and must stay
		// invisible. Without it, "prune everything" would pass every test above.
		const { code, out } = await runGate(dir);
		expect(code).toBe(0);
		expect(out).not.toContain("E.tsx");
		expect(out).not.toContain("F.tsx");
		expect(out).not.toContain("G.tsx");
		expect(out).not.toContain("C.test.tsx");
	});

	test("scanning zero files is a FAILURE, not a pass", async () => {
		// The scope breaking to nothing must never look like a clean repo —
		// that is the exact shape of the bug this gate had.
		const empty = await mkdtemp(join(tmpdir(), "i18n-gate-empty-"));
		try {
			const { code, out } = await runGate(empty);
			expect(code).toBe(1);
			expect(out).toContain("scanned 0 JSX files");
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});

	// The `(^|[^=])>` guard, mutated in BOTH directions. Too loose and every
	// `=> Promise<void>` is a violation; too tight and the guard silently
	// switches the whole check off. Only the pair pins it.
	test("a TypeScript arrow-function return type is NOT reported", async () => {
		// `) => Promise<void>;` reads as `> Promise<` to the bare-text pattern.
		// Six such lines were the majority of the first widened run's output.
		await Bun.write(
			join(dir, "web/A.tsx"),
			`interface P {\n\tonReorder?: (id: string) => Promise<void>;\n}\nexport function A(p: P) {\n\treturn <div>{p ? null : null}</div>;\n}\n`,
		);
		const { code, out } = await runGate(dir);
		expect(out).not.toContain("BARE STRING");
		expect(code).toBe(0);
	});

	test("real JSX text IS still reported — including at the start of a line", async () => {
		await Bun.write(
			join(dir, "web/A.tsx"),
			`export function A() {\n\treturn <div>Bare English Here</div>;\n}\n`,
		);
		await Bun.write(
			join(dir, "web/components/B.tsx"),
			// `>` in COLUMN 0: the `^` alternative of the guard. A naive `[^=]>`
			// (no `^|`) needs a character before the `>` and drops this line.
			`export function B() {\n\treturn (\n\t\t<div className="x"\n>Bare English Here</div>\n\t);\n}\n`,
		);
		const { code, out } = await runGate(dir);
		expect(code).toBe(1);
		expect(out).toContain("web/A.tsx:2:");
		expect(out).toContain("web/components/B.tsx:4:");
	});
});

/**
 * DEPTH — one form per pair, and the pair is the point.
 *
 * The scope fix left the same defect one axis over: the check knew ONE
 * syntactic form (text between tags on one line) while its output spoke about
 * bare strings in general. Measured on ErrorBoundary.tsx, six user-visible
 * strings, one flagged.
 *
 * Every form below gets a must-flag AND a must-not-flag test. Only the pair
 * pins it: a must-flag test alone is satisfied by a rule so loose it reports
 * every string constant in the file, and the loosening is exactly what a future
 * round does to make a noisy gate quiet again.
 */
describe("check-i18n.sh: depth — every form, pinned both ways", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "i18n-depth-"));
		await Bun.write(join(dir, "web/Keep.tsx"), CLEAN);
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function gateOn(src: string) {
		await Bun.write(join(dir, "web/Probe.tsx"), src);
		return runGate(dir);
	}

	test("multiline-text: JSX text on its own line IS reported", async () => {
		// Structurally invisible to any single-line `>text<` pattern — the tag
		// closes on the previous line. Three of the repo's 26 real hits are this.
		const { code, out } = await gateOn(
			`export function P() {\n\treturn (\n\t\t<div className="x">\n\t\t\tMatrix is running in production mode.\n\t\t</div>\n\t);\n}\n`,
		);
		expect(out).toContain("[multiline-text]");
		expect(code).toBe(1);
	});

	test("multiline-text: prose in a comment is NOT reported", async () => {
		// The form matches a bare line of English, and a doc comment is bare
		// lines of English. Without the `>`-terminated-previous-line rule and
		// the comment skip, every block comment in the repo reports.
		const { out, code } = await gateOn(
			`/**\n * Renders the thing.\n * Something else entirely here.\n */\nexport function P() {\n\treturn <div>{t("a.b")}</div>;\n}\n`,
		);
		expect(out).not.toContain("BARE STRING");
		expect(code).toBe(0);
	});

	test("visible-prop: title/alt/placeholder/aria-label ARE reported", async () => {
		for (const attr of ["title", "alt", "placeholder", "aria-label"]) {
			const { out } = await gateOn(
				`export function P() {\n\treturn <img ${attr}="Kill process" />;\n}\n`,
			);
			expect(out).toContain("[visible-prop]");
		}
	});

	test("visible-prop: aria-label is NOT treated as SVG geometry", async () => {
		// It sat in the SVG skip list next to viewBox and strokeWidth, so an
		// accessibility string a screen reader speaks — precisely a string that
		// must be translated — was skipped as if it were a path coordinate.
		const { out, code } = await gateOn(
			`export function P() {\n\treturn <button type="button" aria-label="Remove image" />;\n}\n`,
		);
		expect(out).toContain("[visible-prop]");
		expect(code).toBe(1);
	});

	test("visible-prop: a prop already routed through t() is NOT reported", async () => {
		const { out, code } = await gateOn(
			`export function P() {\n\treturn <img alt={t("image.alt")} title={t("image.title")} />;\n}\n`,
		);
		expect(out).not.toContain("BARE STRING");
		expect(code).toBe(0);
	});

	test("rendered-expression: a ternary producing text IS reported", async () => {
		const { out, code } = await gateOn(
			`export function P({ loading }: { loading: boolean }) {\n\treturn <div>{loading ? "Verifying…" : "Login"}</div>;\n}\n`,
		);
		expect(out).toContain("[rendered-expression]");
		expect(code).toBe(1);
	});

	test("rendered-expression: CSS values, class names and i18n keys are NOT reported", async () => {
		// This is the whole precision argument in one fixture. Unfiltered, the
		// ternary form ran at 32% precision on the real repo and these were the
		// false positives. If this test ever goes red, the filter loosened.
		const { out, code } = await gateOn(
			`export function P({ on, danger }: { on: boolean; danger: boolean }) {\n` +
				`\tconst s = { visibility: on ? "visible" : "hidden" };\n` +
				`\tconst c = danger ? "mxd-btn-stop" : "mxd-btn-primary";\n` +
				`\tconst r = on ? "rotate(90deg)" : "rotate(0deg)";\n` +
				`\tconst k = t(on ? "rollback.rewindTitle" : "rollback.editTitle");\n` +
				`\treturn <div className={c} style={s}>{k}{r}</div>;\n}\n`,
		);
		expect(out).not.toContain("BARE STRING");
		expect(code).toBe(0);
	});

	test("a single lowercase word with no space is NOT reported — the known recall gap", async () => {
		// Deliberate and characterised rather than discovered later: the rule is
		// "starts with a capital OR contains a space", which is what buys the
		// precision above. alt="attached" is a real bare string this gate misses.
		// Pinned so that widening it is a decision someone makes on purpose,
		// with the false-positive rate in hand, rather than a silent drift.
		const { out, code } = await gateOn(
			`export function P() {\n\treturn <img alt="attached" />;\n}\n`,
		);
		expect(out).not.toContain("BARE STRING");
		expect(code).toBe(0);
	});

	test("the form count is reported, so a narrowing of DEPTH is as visible as one of SCOPE", async () => {
		// The file count made a re-narrowed scope visible. Depth needs the same
		// detector or it is the identical defect one axis over.
		const { out } = await runGate(dir);
		expect(out).toMatch(/for \d+ (bare-string )?form\(s\)/);
	});
});

/**
 * THE RATCHET — the gate is correct and the repo cannot pass it today.
 *
 * Failing every commit until a translation project finishes is not strictness:
 * it is a gate that gets --no-verify'd, which leaves no trace. So the baseline
 * permits the measured debt, fails on any rise, and REWRITES ITSELF DOWNWARD on
 * any fall. That last part is the one that matters — see the test for it.
 */
describe("check-i18n.sh: the baseline ratchet", () => {
	let dir: string;
	const BASELINE = "scripts/i18n-baseline.txt";

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "i18n-ratchet-"));
		await Bun.write(join(dir, "web/A.tsx"), CLEAN);
		await Bun.write(join(dir, "web/B.tsx"), BARE);
		await Bun.write(join(dir, "web/C.tsx"), BARE);
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("no baseline file means ZERO permitted debt", async () => {
		// An unmeasured tree does not get a free allowance. This default is also
		// what keeps every other test in this file strict.
		const { code, out } = await runGate(dir);
		expect(code).toBe(1);
		expect(out).toContain("baseline of 0");
	});

	test("count equal to the baseline passes, and says how much debt is known", async () => {
		await Bun.write(join(dir, BASELINE), "2\n");
		const { code, out } = await runGate(dir);
		expect(code).toBe(0);
		expect(out).toContain("2 known bare string(s), 0 new");
	});

	test("one new string above the baseline FAILS and names it", async () => {
		await Bun.write(join(dir, BASELINE), "2\n");
		await Bun.write(join(dir, "web/D.tsx"), BARE);
		const { code, out } = await runGate(dir);
		expect(code).toBe(1);
		expect(out).toContain("web/D.tsx");
		expect(out).toContain("This change added 1.");
	});

	test("a FALLING count rewrites the baseline file downward", async () => {
		// The load-bearing half. A baseline only a human remembers to lower is a
		// number that quietly stops being true — fix ten strings against a stale
		// 26 and ten new ones land unnoticed. That is the silent-drain rot this
		// whole round exists to close, and shipping it inside the fix for it
		// would have been the joke writing itself.
		await Bun.write(join(dir, BASELINE), "9\n");
		const { code, out } = await runGate(dir);
		expect(code).toBe(0);
		expect(out).toContain("baseline lowered: 9 -> 2");
		expect((await Bun.file(join(dir, BASELINE)).text()).trim()).toBe("2");
	});

	test("the lowered baseline is immediately tighter — the ratchet cannot slip back", async () => {
		await Bun.write(join(dir, BASELINE), "9\n");
		await runGate(dir); // lowers 9 -> 2
		await Bun.write(join(dir, "web/D.tsx"), BARE); // 2 -> 3
		const { code, out } = await runGate(dir);
		expect(code).toBe(1);
		expect(out).toContain("baseline of 2");
	});
});

describe("check-i18n.sh: against the real repo", () => {
	test("reads more than the top level of web/", async () => {
		// Non-rotting form of "the scope did not get re-narrowed": both sides
		// are measured. `find web -maxdepth 1` — the old scope — would make
		// these two numbers equal.
		const topLevelWeb = readdirSync(join(REPO_ROOT, "web")).filter(
			(f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"),
		).length;
		expect(topLevelWeb).toBeGreaterThan(0);

		// Matches both the pass ("scanned N") and fail ("across N") wording, so
		// this measures COVERAGE regardless of whether the repo is currently
		// clean — the two are independent questions.
		const { out } = await runGate(REPO_ROOT);
		const scanned = Number(
			/(?:scanned|across) (\d+) JSX file/.exec(out)?.[1] ?? -1,
		);
		expect(scanned).toBeGreaterThan(topLevelWeb);
	});
});
