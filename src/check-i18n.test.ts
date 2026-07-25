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
		expect(out).toContain("across 3 JSX file(s)");
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
