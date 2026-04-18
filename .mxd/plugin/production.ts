/**
 * Production-mode predicate — matrix plugin's opinion on what "production" means.
 *
 * A matrix project is in "production mode" when both:
 *   1. The project IS the matrix install root (npm-distributed location)
 *   2. The install root has NO git history (no .git, not a developer clone)
 *
 * In this state, matrix should NOT mutate the project:
 *   - onProjectInit skips memory.md/.gitignore/hooks/git init
 *   - Plugin UI renders a "please select a different project" page
 *   - Agent-invoking endpoints reject (403)
 *
 * Pure function — same inputs always produce same output. No filesystem,
 * no persistence, no marker file. Re-evaluated every time production state
 * is queried, so globalContext updates immediately take effect.
 *
 * Browser-safe — used by both the plugin runtime (worker) and the plugin
 * web UI (browser). That means no `node:path` imports; path comparison
 * only does trailing-slash normalization.
 */

export interface GlobalContextFacts {
	installRoot: string;
	gitHash: string | null;
	version: string;
}

function stripTrailingSlash(p: string): string {
	return p.replace(/\/+$/, "");
}

export function isProductionProject(
	projectPath: string,
	globalContext: GlobalContextFacts,
): boolean {
	return (
		stripTrailingSlash(projectPath) ===
			stripTrailingSlash(globalContext.installRoot) && !globalContext.gitHash
	);
}
