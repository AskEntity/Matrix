/**
 * Version + git-hash identity — shared by daemon and worker.
 *
 * Read once at module load. Same values across daemon and runtime imports
 * within a single process. Re-read on restart (including after code changes).
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const VERSION: string = pkg.version;

function readGitHash(): string {
	try {
		const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
		if (result.exitCode === 0) {
			return new TextDecoder().decode(result.stdout).trim();
		}
	} catch {
		// git not available or not a git repo — fall through
	}
	return "unknown";
}

export const GIT_HASH: string = readGitHash();
