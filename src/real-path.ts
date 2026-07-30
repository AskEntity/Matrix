/**
 * Path identity: is this the same DIRECTORY, whatever it is called.
 *
 * Two questions in this repo need it, and they were answered by two different
 * standards. `bash.ts` asks "which checkout does this cwd belong to" and has
 * always resolved symlinks, because a linked worktree's `.git` is a file and a
 * path-prefix test calls another agent's checkout "inside". `cli.ts` asks "which
 * project is at this path" and compared STRINGS — so a project registered
 * through a symlink answered "No project found for current directory" from
 * inside its own directory, since `process.cwd()` is always the physical path
 * while a registered path is whatever was typed.
 *
 * Same primitive, so one copy. Imports `node:fs` only; never import this from
 * browser code.
 */

import { realpathSync } from "node:fs";

/**
 * realpath, falling back to the literal path when it cannot be resolved.
 *
 * ⚠️ The fallback is the load-bearing half: `realpathSync` THROWS on a path that
 * does not exist, and every caller here is comparing paths rather than reading
 * them — a registered project whose directory has been deleted, or a `--project`
 * argument with a typo in it, must still be comparable. Returning the literal
 * makes those compare exactly as they did before, so the worst case is the old
 * behaviour rather than a crash.
 */
export function realpathOr(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/**
 * Does `dir` name `base`, or something inside it?
 *
 * Both sides go through `realpathOr`, which is the whole point: the caller's two
 * paths come from different places (one from `process.cwd()`, one from a
 * registry file or an argument) and only agree by luck.
 *
 * ⚠️ The `/` in the prefix test is not cosmetic — without it `/foo/bar-baz`
 * counts as inside `/foo/bar`.
 */
export function isSameOrInside(dir: string, base: string): boolean {
	const here = realpathOr(dir);
	const root = realpathOr(base);
	return here === root || here.startsWith(`${root}/`);
}
