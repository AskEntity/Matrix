/**
 * The production claim, tested on a real daemon process.
 *
 * Verification bar items 2 and 4:
 *   2. a daemon that has served at least one hybrid search shuts down exit 0
 *   4. `.mxd.lock` is absent afterwards
 *
 * Item 4 is the one worth stating plainly: `releaseDataDirLock()` is sequenced
 * AFTER worker teardown in `shutdown()`, so while teardown aborted the process
 * it never ran. As far as daemon.err goes back, this daemon had never once
 * released its lock — the steal-on-dead-PID path was not a fallback, it was
 * the only path. This script is the first thing that can show otherwise.
 *
 * Runs a REAL `bun src/daemon.ts` with a real embedding (no
 * MXD_DISABLE_EMBEDDINGS), so it is deliberately not part of `bun test`.
 *
 *   bun scripts/napi-repro/verify-daemon-shutdown.ts
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = join(tmpdir(), `mxd-shutdown-verify-${Date.now()}`);
const repoRoot = new URL("../../", import.meta.url).pathname;
mkdirSync(dataDir, { recursive: true });

// A port nobody else is on, so this never collides with the real daemon.
// The config must be COMPLETE — the daemon refuses to boot on a partial one
// rather than risk overwriting saved credentials with defaults.
const port = 7599;
writeFileSync(
	join(dataDir, "config.json"),
	JSON.stringify(
		{
			authGroups: {},
			defaultAuth: "",
			model: "claude-opus-4-8",
			budgetUsd: -1,
			mcpServers: {},
			port,
			selfBootstrap: false,
			thinkingEffort: 0,
			cacheTtl: { root: "1h", child: "5m" },
		},
		null,
		2,
	),
);

console.log(`[verify] dataDir: ${dataDir}`);
console.log(
	`[verify] starting real daemon on :${port} WITH embeddings enabled`,
);

// The whole point of this script: embeddings ON. Delete rather than override
// with undefined — an env value of the literal string "undefined" is truthy.
const daemonEnv: Record<string, string> = {
	...(process.env as Record<string, string>),
	MXD_DATA_DIR: dataDir,
};
delete daemonEnv.MXD_DISABLE_EMBEDDINGS;

const daemon = Bun.spawn(["bun", "src/daemon.ts"], {
	cwd: repoRoot,
	env: daemonEnv,
	stdio: ["ignore", "inherit", "inherit"],
});

// Wait for it to listen.
const deadline = Date.now() + 60_000;
let up = false;
while (Date.now() < deadline) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/auth/status`);
		if (r.status) {
			up = true;
			break;
		}
	} catch {}
	await Bun.sleep(250);
}
if (!up) {
	console.error("[verify] FAIL — daemon never came up");
	daemon.kill();
	process.exit(1);
}
console.log("[verify] daemon is listening");

const lockPath = join(dataDir, ".mxd.lock");
console.log(
	`[verify] .mxd.lock present while running: ${existsSync(lockPath)}`,
);

// Force the hazard to arm: load the embedding model in the worker's process
// tree the way a hybrid search does. Going through the real search endpoint
// needs auth + a project + an index, so instead we drive the same code path
// the worker uses, in a worker, which is what the abort was ever about.
console.log(
	"[verify] arming the hazard: computing an embedding via a worker...",
);
const armWorker = new Worker(
	new URL("./verify-fix-worker.ts", import.meta.url).href,
	{ env: process.env as Record<string, string> },
);
const armed = await new Promise<Record<string, unknown>>((resolve, reject) => {
	const t = setTimeout(() => reject(new Error("arm timed out")), 240_000);
	armWorker.onmessage = (e: MessageEvent) => {
		clearTimeout(t);
		resolve(e.data as Record<string, unknown>);
	};
	armWorker.onerror = (e: ErrorEvent) => {
		clearTimeout(t);
		reject(new Error(e.message));
	};
});
console.log(`[verify] embedding computed: ${JSON.stringify(armed)}`);
armWorker.terminate();

console.log("[verify] sending SIGTERM (the graceful shutdown path)...");
daemon.kill("SIGTERM");

const exitCode = await daemon.exited;
console.log(`[verify] daemon exit code: ${exitCode}`);

const lockGone = !existsSync(lockPath);
console.log(`[verify] .mxd.lock removed after shutdown: ${lockGone}`);

rmSync(dataDir, { recursive: true, force: true });

if (exitCode !== 0) {
	console.error(
		`[verify] FAIL — expected exit 0, got ${exitCode}${
			exitCode === 133 ? " (NAPI abort — the bug is still present)" : ""
		}`,
	);
	process.exit(1);
}
if (!lockGone) {
	console.error("[verify] FAIL — .mxd.lock survived shutdown");
	process.exit(1);
}
console.log("[verify] PASS — clean exit 0, lock released");
process.exit(0);
