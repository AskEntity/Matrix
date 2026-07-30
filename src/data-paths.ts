/**
 * Canonical resolution of OUR paths: the data dir itself (`resolveDataDir`)
 * and everything built from a `dataRoot` or `projectId` beneath it.
 *
 * Two rules of the same kind, one file, one whole-repo audit each in
 * `data-paths.test.ts`. Imported by plugin.ts, runtime/helpers.ts, config.ts,
 * cli.ts and daemon.ts — everything that decides WHERE our data lives, or
 * constructs a path from `dataRoot` or `projectId`, MUST route through here.
 *
 * Path math + validation, plus the one environment read named below. Nothing
 * else may read `HOME` to find our data.
 *
 * Why this file exists (Audit FU5):
 *
 * Before unification, `.slice(2)` was duplicated in 4 places with no shared
 * validation. `resolveDataRoot(dataDir, projectId, "@/../etc")` was exploitable:
 * `"@/../etc".slice(2) === "/../etc"` → `join(dataDir, "projects", projectId,
 * "/../etc")` normalizes to `dataDir/etc`. Cross-plugin attack was demonstrated.
 *
 * Defence-in-depth:
 *  1. Strict regex at input boundary rejects traversal and absolute-path forms.
 *  2. ONE resolver builds the path — no other codepath may `.slice(2)`.
 *  3. Post-resolve invariant confirms the result still lives under
 *     `<dataDir>/projects/<projectId>/`. Belt-and-braces if regex ever loosens.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * THE data dir. `MXD_DATA_DIR` if set, else `~/.mxd`.
 *
 * ⚠️ This is the ONLY place that reads `HOME` to locate our data, asserted by a
 * whole-repo audit. It exists because the question had FIVE answers: cli.ts and
 * daemon.ts carried this expression character for character, and `config.ts`,
 * `runtime.ts` and cli.ts's `LOG_DIR` each dropped the `MXD_DATA_DIR` half.
 * MEASURED consequence of the config.ts one: with `MXD_DATA_DIR` set, `mxd
 * config auth list` printed the group from `~/.mxd/config.json` while the
 * daemon ran on the group in `$MXD_DATA_DIR/config.json` — so `mxd config set
 * … --global` exited 0 having edited a file nobody reads.
 *
 * ⭐ The two byte-identical duplicates are why the other three could drift:
 * nobody ever had to reconcile them, because there was no one place to
 * reconcile. That is the argument for this function, rather than for correcting
 * three expressions.
 *
 * ⚠️ `||` not `??`, deliberately: it gives POSIX `${MXD_DATA_DIR:-default}`
 * semantics, so `MXD_DATA_DIR=` (exported empty, indistinguishable from unset
 * to a shell) falls back instead of rooting every path at the process cwd.
 *
 * Callers take the value FROM here and pass it down; helpers below stay pure
 * functions of an explicit `dataDir`.
 */
export function resolveDataDir(): string {
	return process.env.MXD_DATA_DIR || join(homedir(), ".mxd");
}

/**
 * `dataRoot` must be `"@"` or `"@/<segment>(/<segment>)*"`, where each segment
 * is `[A-Za-z0-9_-]+`. Rejects `..`, `.`, `/`, empty strings, `@` followed by
 * anything other than `/segment`, and anything with non-ASCII / special chars.
 */
export const DATA_ROOT_PATTERN = /^@(\/[A-Za-z0-9_-]+)*$/;

/**
 * `projectId` must be `[A-Za-z0-9_-]+`. Production IDs are ULIDs which match,
 * but any code that accepts a user-supplied projectId must still validate —
 * the invariant belongs to the data layer, not to "trust the caller".
 */
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate `dataRoot` shape. Throws on malformed.
 *
 * Accepts `undefined` (caller means "default for this plugin" — we don't know
 * the plugin name here, so we don't fill the default; callers that have a
 * manifest pass the result of `effectiveDataRoot` instead).
 */
export function validateDataRoot(dataRoot: string | undefined): void {
	if (dataRoot === undefined) return;
	if (!DATA_ROOT_PATTERN.test(dataRoot)) {
		throw new Error(
			`Invalid dataRoot "${dataRoot}": must match /^@(\\/[A-Za-z0-9_-]+)*$/. ` +
				`Examples: "@" (project root), "@/plugin/foo" (subdirectory).`,
		);
	}
}

/**
 * Validate `projectId` shape. Throws on malformed.
 *
 * Rejects `..`, `/`, `\\`, empty strings, and any character outside
 * `[A-Za-z0-9_-]`. Production IDs are ULIDs which match.
 */
export function validateProjectId(projectId: string): void {
	if (!PROJECT_ID_PATTERN.test(projectId)) {
		throw new Error(
			`Invalid projectId "${projectId}": must match /^[A-Za-z0-9_-]+$/`,
		);
	}
}

/**
 * The ONE canonical resolver. Builds the absolute path of a plugin's data
 * root within a specific project.
 *
 * - `"@"` (or omitted) → `{dataDir}/projects/{projectId}/`
 * - `"@/plugin/foo"` → `{dataDir}/projects/{projectId}/plugin/foo/`
 *
 * Validates inputs, then asserts the post-resolve path still lives under
 * `{dataDir}/projects/{projectId}/`. Throws if anything is off.
 *
 * All downstream path builders (`projectTasksDir`, `projectDebugDir`,
 * `getTracker`) MUST call this. No other code may construct a path by
 * slicing dataRoot.
 */
export function resolveDataRoot(
	dataDir: string,
	projectId: string,
	dataRoot?: string,
): string {
	validateProjectId(projectId);
	validateDataRoot(dataRoot);

	const projectRoot = join(dataDir, "projects", projectId);
	if (!dataRoot || dataRoot === "@") return projectRoot;

	// Strip the leading "@/" — regex guarantees shape "@/<segment>(/<segment>)*".
	const relative = dataRoot.slice(2);
	const resolved = join(projectRoot, relative);

	// Post-resolve invariant: resolved MUST be inside projectRoot.
	// `join` normalizes `..`; if a traversal somehow slipped past the regex,
	// this catches it before any filesystem op uses the bad path.
	if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}/`)) {
		throw new Error(
			`dataRoot "${dataRoot}" resolved outside project root: ` +
				`"${resolved}" not inside "${projectRoot}".`,
		);
	}
	return resolved;
}

/**
 * Directory containing a project's task JSONL event files, respecting the
 * plugin's dataRoot. Built on top of {@link resolveDataRoot}.
 */
export function projectTasksDir(
	dataDir: string,
	projectId: string,
	dataRoot?: string,
): string {
	return join(resolveDataRoot(dataDir, projectId, dataRoot), "tasks");
}

/**
 * Directory containing a project's debug snapshots, respecting the plugin's
 * dataRoot. Built on top of {@link resolveDataRoot}.
 */
export function projectDebugDir(
	dataDir: string,
	projectId: string,
	dataRoot?: string,
): string {
	return join(resolveDataRoot(dataDir, projectId, dataRoot), "debug");
}

/**
 * Absolute path to a project's `tree.json`, respecting the plugin's dataRoot.
 * Built on top of {@link resolveDataRoot}.
 *
 * For Matrix (dataRoot `"@/plugin/matrix"`) this returns
 * `<dataDir>/projects/<id>/plugin/matrix/tree.json`.
 */
export function projectTreeJsonPath(
	dataDir: string,
	projectId: string,
	dataRoot?: string,
): string {
	return join(resolveDataRoot(dataDir, projectId, dataRoot), "tree.json");
}

/**
 * Absolute path to a project's search index (`index.msp`), respecting the
 * plugin's dataRoot. Built on top of {@link resolveDataRoot}, so it sits in the
 * SAME directory as `tree.json` — for Matrix (dataRoot `"@/plugin/matrix"`)
 * this returns `<dataDir>/projects/<id>/plugin/matrix/index.msp`.
 *
 * The `.msp` extension reflects the Orama binary (msgpack) persistence format.
 */
export function projectIndexDbPath(
	dataDir: string,
	projectId: string,
	dataRoot?: string,
): string {
	return join(resolveDataRoot(dataDir, projectId, dataRoot), "index.msp");
}
