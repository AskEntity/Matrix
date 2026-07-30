#!/usr/bin/env bun
/**
 * Comment-phantom survey: identifier-shaped words that live ONLY in prose.
 *
 * The failure it exists for: a comment names a symbol that no longer has a
 * definition, so `grep <name>` returns hits, every hit is prose, and every hit
 * describes the symbol as if it were running. That is the one variant of dead
 * reference that grep answers with APPARENT CONFIRMATION — a deleted symbol
 * gives zero hits and is caught, an uncalled symbol gives true hits and is
 * merely stale, and this one gives supporting text to whoever looks it up.
 *
 * Method, deliberately dumb (a raw dump, not an analyzer): strip comments from
 * every .ts/.tsx file, extract identifier-shaped candidates FROM the comments,
 * and report those with zero occurrences in the code corpus. The corpus is
 * comment-stripped TS plus the verbatim text of every non-prose tracked file
 * (json/sh/toml/hooks), because a name can be defined outside TS — and `.md` is
 * excluded on purpose, since a name living only in prose is the thing we hunt.
 *
 * Expect heavy false positives (external API names, type names from libs,
 * English compounds). That is the accepted trade: a false positive costs one
 * glance, a false negative is the entire failure this looks for.
 *
 * Controls: pass --plant to inject two identifiers into the LAST file scanned
 * (highest truncation risk) — one that must be reported, one that must not.
 * A survey of 3,000 names that quietly checks 2,999 reports exactly like one
 * that checks all of them.
 *
 * Usage:
 *   bun scripts/comment-phantom-survey.ts            # the list
 *   bun scripts/comment-phantom-survey.ts --plant    # self-test, then the list
 *   bun scripts/comment-phantom-survey.ts --context  # each hit with its lines
 */

import { readFileSync } from "node:fs";
import { $ } from "bun";

const PLANT = process.argv.includes("--plant");
const SHOW_CONTEXT = process.argv.includes("--context");

/**
 * Two reported-if-absent controls and one never-reported twin. Two, because a
 * line comment and a JSDoc block are separate branches of the scanner and the
 * phantoms this hunts live overwhelmingly in the block form — a control that
 * only exercises `//` cannot fail for the reason the survey exists.
 *
 * The names are BUILT AT RUNTIME on purpose. This file is tracked, so it is part
 * of the corpus it searches: a control spelled as a literal here lands in the
 * code text, the phantom check finds it, and both controls report MISSED. That
 * is the safe direction — it fails loudly — but it makes the self-test useless,
 * and it only started happening on the commit that added the script.
 */
const suffix = Date.now().toString(36);
const PLANTED_LINE = `zzSurveyPhantomLine${suffix}`;
const PLANTED_BLOCK = `zzSurveyPhantomBlock${suffix}`;
const PLANTED_REAL = "runChildCore"; // defined in agent-lifecycle.ts

type Span = { text: string; line: number };

/**
 * Split a TS source into comment spans and code text.
 *
 * Crude scanner: strings, template literals and both comment forms. Regex
 * literals are NOT tracked, which can misread a `/…/` body as a comment — that
 * direction only ADDS candidates (a false positive), while the opposite
 * direction would hide a phantom. Choose the erring side deliberately.
 */
function split(src: string): { comments: Span[]; code: string } {
	const comments: Span[] = [];
	const code: string[] = [];
	let i = 0;
	let line = 1;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		const c2 = src[i + 1];
		if (c === "\n") line++;
		if (c === "/" && c2 === "/") {
			const end = src.indexOf("\n", i);
			const stop = end === -1 ? n : end;
			comments.push({ text: src.slice(i + 2, stop), line });
			i = stop;
			continue;
		}
		if (c === "/" && c2 === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end === -1 ? n : end + 2;
			const body = src.slice(i + 2, stop - 2);
			comments.push({ text: body, line });
			line += body.split("\n").length - 1;
			i = stop;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			let j = i + 1;
			while (j < n) {
				if (src[j] === "\\") {
					j += 2;
					continue;
				}
				if (src[j] === quote) break;
				if (src[j] === "\n") line++;
				j++;
			}
			code.push(src.slice(i, j + 1));
			i = j + 1;
			continue;
		}
		code.push(c ?? "");
		i++;
	}
	return { comments, code: code.join("") };
}

/** camelCase, PascalCase-with-internal-cap, snake_case. Never a bare word. */
const CANDIDATE =
	/\b(?:[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)+|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;

const files = (await $`git ls-files`.text()).split("\n").filter(Boolean);
const tsFiles = files.filter((f) => /\.tsx?$/.test(f)).sort();
const otherFiles = files.filter((f) => /\.(json|sh|toml|ya?ml|txt)$/.test(f));
const hooks = files.filter((f) => f.startsWith(".hooks/") && !f.includes("."));

const corpus: string[] = [];
/** candidate → where it was seen in comments */
const seen = new Map<string, { file: string; line: number; text: string }[]>();

const lastTs = tsFiles[tsFiles.length - 1];
for (const f of tsFiles) {
	let src = readFileSync(f, "utf8");
	if (PLANT && f === lastTs) {
		src += `\n/**\n * survey control: ${PLANTED_BLOCK} must be reported.\n */\n`;
		src += `// survey control: ${PLANTED_LINE} must be reported, ${PLANTED_REAL} must not.\n`;
	}
	const { comments, code } = split(src);
	corpus.push(code);
	for (const span of comments) {
		const lines = span.text.split("\n");
		for (const [k, text] of lines.entries()) {
			for (const m of text.matchAll(CANDIDATE)) {
				const list = seen.get(m[0]) ?? [];
				list.push({ file: f, line: span.line + k, text: text.trim() });
				seen.set(m[0], list);
			}
		}
	}
}
for (const f of [...otherFiles, ...hooks]) corpus.push(readFileSync(f, "utf8"));

const codeText = corpus.join("\n");
const inCode = new Set<string>();
for (const m of codeText.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g))
	inCode.add(m[0]);

const phantoms = [...seen.entries()]
	.filter(([name]) => !inCode.has(name))
	.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

if (PLANT) {
	const line = phantoms.some(([n]) => n === PLANTED_LINE);
	const block = phantoms.some(([n]) => n === PLANTED_BLOCK);
	const twin = phantoms.some(([n]) => n === PLANTED_REAL);
	console.log(`controls (planted at the end of ${lastTs}):`);
	console.log(
		`  ${PLANTED_BLOCK} (JSDoc): ${block ? "REPORTED ✓" : "MISSED ✗"}`,
	);
	console.log(`  ${PLANTED_LINE} (line): ${line ? "REPORTED ✓" : "MISSED ✗"}`);
	console.log(
		`  ${PLANTED_REAL} (real, must stay silent): ${twin ? "REPORTED ✗" : "silent ✓"}`,
	);
	if (!line || !block || twin) process.exit(1);
	console.log("");
}

/**
 * A `biome-ignore` line is a DIRECTIVE, not prose: the name in it is read by a
 * tool, and a reader chasing a symbol never lands there. Measured, they were 98
 * of the hits and every one of the eight names they carry appears in NO other
 * kind of comment — so left inline they are the first thing anyone scanning the
 * list meets. Partitioned rather than dropped, because a rule name biome stopped
 * recognising is a suppression that silently stopped suppressing.
 */
const isDirective = (text: string) => text.trim().startsWith("biome-ignore");
const prose = phantoms.filter(([, hits]) =>
	hits.some((h) => !isDirective(h.text)),
);
const directives = phantoms.filter(([, hits]) =>
	hits.every((h) => isDirective(h.text)),
);

console.log(
	`${tsFiles.length} ts files · ${seen.size} distinct candidates in comments · ${phantoms.length} with no occurrence in code\n`,
);
const show = ([name, hits]: (typeof phantoms)[number]) => {
	console.log(`${name}  (${hits.length})`);
	if (SHOW_CONTEXT)
		for (const h of hits) console.log(`    ${h.file}:${h.line}: ${h.text}`);
	else console.log(`    ${hits.map((h) => `${h.file}:${h.line}`).join(" ")}`);
};
for (const p of prose) show(p);
console.log(
	`\n── ${directives.length} more appear ONLY in biome-ignore directives ──`,
);
for (const p of directives) show(p);
