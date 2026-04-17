# Worker Refactor Audit — Consolidated Findings (12 fresh audits)

**Date**: 2026-04-17
**Commit range audited**: `56b2084..HEAD` (~60 commits, 134 files, +13670/-8740)
**Method**: 12 parallel cold-start audits, no fork, no anchoring to prior audits.

Each audit's full report is in its own session JSONL. Audit L also wrote
`AUDIT-L-production-readiness.md` in its worktree.

---

## Overall

The refactor's **core plumbing is sound**: SSE per-project isolation, tool
typing, config CRUD, JSONL event model, auth at the happy path, and all 1839
tests pass. But there are **real gaps** — three CRITICALs with production
impact, several exploitable scopes, and meaningful dead code that violates the
project's "delete until ONE remains" principle.

The most important structural finding: **the daemon/worker split is real and
principled; the worker/plugin split is mostly nominal**. Matrix-specific logic
still lives in `src/` and is re-exported through a 16-line shim at
`.mxd/plugin/runtime.ts`. Memory.md's "runtime is plugin-agnostic" claim is
half-true — the `src/runtime/` *directory* is, but Matrix-specific modules it
imports aren't. User's Matrix-as-runtime-kit vision (draft 01KP24EBPGZWN7R0NBMJM6P507)
currently needs substantial work beyond the rename.

The audit surfaced convergent findings from independent eyes — the same dead
code and the same bugs showed up in multiple audits. That's a strong signal
the items are real, not idiosyncratic.

---

## CRITICAL findings (ship-blockers)

### CR1. Fresh-install cold start is broken — no plugin workers

**Sources**: Audit L (C1), Audit A (H2)

**Scenario**: New user follows README literally (`mxd daemon install` → `mxd init /path`).
Fresh dataDir → `pm.list()` empty → plugin discovery returns zero
registrations → every forwarded endpoint returns 503 "No global plugin worker
available".

**Currently works only because the Matrix repo itself is already a registered
project** — self-bootstrap accident.

**Options**:
- (a) daemon self-registers `.mxd/plugin/` from its working directory if found,
- (b) `mxd daemon install` auto-registers the Matrix repo as a project,
- (c) global plugin location separate from project registration.

### CR2. Shutdown does not flush JSONL writes → lost events + duplicate task_complete on restart

**Source**: Audit C (CRITICAL-1), verified with repro

`emitEvent()` is fire-and-forget. `appInstance.shutdown()` in `src/runtime.ts`
stops agents but never calls `eventStore.flush()`. Worker posts
`shutdown_complete` and is terminated 5s later. Writes queued in the last
hundreds of ms (notably `agent_end` and `done_notified`) never reach disk.

On next startup, `findInterruptedDonePhase2` re-fires Phase 2 because
`done_notified` is gone → duplicate `task_complete` delivered to parent. Lost
tool_result events leave orphaned tool_calls that `buildSessionRepair` then
synthesizes, but the original write is still gone.

Verified: 10 un-awaited `emitEvent` calls → `readFile` returns ENOENT; after
`store.flush()`, all 10 lines present.

**Fix**: `shutdown()` awaits flush on every EventStore in `ctx.eventStores`.
Pair with MEDIUM item: `stopAgent` currently does NOT await the agent loop
promise (unlike `stopTask`). Both need fixing to close the race.

### CR3. Worker init hang blocks daemon startup forever

**Source**: Audit C (CRITICAL-2)

`startWorkerForPlugin` in `src/daemon.ts` awaits a Promise that resolves on
`{type:"ready"}` or rejects on `{type:"error"}`. Neither is sent if the
worker's `import(pluginRuntimePath)` (scope-worker.ts:39) hangs, e.g.
top-level `await` on a network request. **No timeout.** No log, no 503 — the
daemon just hangs on boot. User has to `kill -9` with no explanation.

**Fix**: wrap init Promise in a 30s timeout. On timeout: `worker.terminate()`,
reject with "Worker init timed out", log the plugin that stalled.

### CR4. SSE catch-up: "client ahead of server" returns `[]` instead of triggering full refresh

**Sources**: Audit F (Finding 1), Audit C (CRITICAL-3), Audit B (H1) — all reproduced independently

In `src/daemon.ts`'s `getEventsSince(buffer, lastSeqId)`:
```ts
if (lastSeqId < firstEntry.seqId - 1) return null;  // "too far back" → full refresh
const idx = buffer.findIndex(e => e.seqId > lastSeqId);
if (idx === -1) return [];  // BUG: conflates "up to date" with "ahead"
```

Trigger: every daemon restart while any SSE client is connected. Daemon
restarts with seqId counter = 0. Client reconnects with `Last-Event-ID: 500`
(from before restart). `findIndex` returns -1 → returns `[]` → `catchUpDone=true`
→ full-initial-state fallback is skipped. Client stays stuck on pre-restart state.

Also trigger: malicious/corrupted Last-Event-ID header (`9999999`).

**Fix**: `if (lastSeqId > currentCounter) return null;` → routes through full
refresh. Consider epoch-prefixing seqIds (`<startupTs>-<seq>`) so cross-restart
comparison is definitive.

---

## HIGH findings (exploitable or visibly wrong)

### H1. Auth skip uses prefix match on `/auth/` instead of exact paths

**Sources**: Audit J (H1), Audit G (low), probed

`skipAuth` is true when `path.startsWith("/auth/")`. Only `/auth/status` and
`/auth/logout` exist on daemon. Any future worker route under `/auth/*` would
be reachable without auth. Verified: `GET /auth/bogus` on daemon with jwtSecret
returns 503 (not 401) — confirming auth did NOT fire.

**Fix**: exact equality check on `/auth/status` and `/auth/logout`.

### H2. Destructive orchestrator tools skip `checkPermission`

**Source**: Audit G (H1)

`close_task`, `delete_task`, `reset_task`, and non-reparent paths of
`update_task` — none call `checkPermission(auth, "subtree", ...)`. Inconsistent
with `reorder_tasks` and `fork_task_context` which DO check.

Impact: a bug or hallucination in one agent can destroy sibling or parent
worktrees + JSONL sessions (deleteTaskOp does cleanupTaskResources).
Non-recoverable. Folder ops also unscoped.

**Fix**: add `checkPermission(auth, "subtree", {taskId})` to each handler.

### H3. Default daemon bind is `0.0.0.0` + open during pre-`mxd auth` window

**Source**: Audit G (H2)

`Bun.serve` sets no `hostname` → binds `*:7433`. Fresh install has
`hasJwtSecret=false` until `mxd auth` runs. Any LAN-adjacent host can hit the
open daemon in the meantime.

**Fix**: default `hostname: "127.0.0.1"` unless `MXD_BIND_HOST` explicitly set.
Consider auto-generating `jwtSecret` at first daemon startup so the bootstrap
window closes.

### H4. Auth cache staleness — `mxd auth` does not activate auth on running daemon

**Source**: Audit L (H3), verified with repro

`src/auth.ts` module-level `authDataCache`. On first `readAuthData` miss (no
auth.json), caches `{}`. `hasJwtSecret` returns false thereafter. User runs
`mxd auth` → file written → daemon never re-reads.

**User-visible**: user believes they've secured the daemon (browser login
works, token granted). But the live daemon continues to serve any
unauthenticated client on the same host — until next restart.

**Fix**: drop module-level cache (file read is cheap per request), OR
stat-mtime-and-recheck, OR watch auth.json. `resetAuthDataCache` exists but
has no production caller.

### H5. `dataRoot` path traversal escapes data dir, allows cross-plugin write

**Sources**: Audit H (F1), Audit C (H4) — both verified with executable repro

`resolveDataRoot` does `join(dataDir, "projects", projectId, dataRoot.slice(2))`.
`dataRoot: "@/../etc"` → `slice(2) = "/../etc"` → joins to `/etc`. Normalized
by `join` but not BOUND to stay under `projects/<id>/`.

Confirmed cross-plugin attack:
```
plugin in project A, dataRoot: "@/../<projectB-id>"
→ writes to projects/<projectB-id>/tasks/
```

Also `projectId` with `..` not validated (currently safe only because all IDs
are ULID).

Currently impact zero — Matrix is the only plugin, dataRoot `"@"`. First
third-party plugin surfaces this as RCE-adjacent.

**Fix**: post-join invariant check — resolved path MUST `startsWith(join(dataDir,
"projects", projectId))`. Also validate `dataRoot` matches `/^@(\/[a-zA-Z0-9_-]+)*$/`.

### H6. Half-applied fix: `projectDebugDir` call site missing `dataRoot` arg

**Source**: Audit H (F4)

`src/runtime/agent-lifecycle.ts:982` calls
`projectDebugDir(ctx.config.dataDir, project.id)` with 2 args. The function
accepts an optional 3rd `dataRoot` (added in commit 3d6332c). Call site never
updated. Debug snapshots always land at the Matrix dataRoot regardless of
plugin's configured dataRoot.

**Fix**: pass `plugin.manifest.dataRoot` (or equivalent) as 3rd arg.

### H7. `POST /projects` not transactional

**Source**: Audit L (C2), verified

`pm.init(path)` writes projects.json → `onProjectInit` can fail anywhere
(mkdir, git commit fails on missing user.email, etc.). No rollback.

Confirmed: passing `/tmp` creates `/tmp/.mxd/`, `/tmp/.git/`, modifies
`/tmp/.git/info/exclude`, AND stores the project in projects.json — despite
returning 409.

**Fix**: validate path before any side effect (`.git` exists, user.email
configured, dir writable). On failure, `pm.delete(id)` + attempt fs rollback.

### H8. `forwardToWorker` 60s timeout < `yield_external` 120s max

**Source**: Audit I (CRITICAL-1 of its own scale)

Daemon's HTTP→worker timeout is 60s. Worker's `yield_external` tool blocks up
to 120s. Result: silent 504s after 60s, late `http_response` posts arrive to
an evicted pending Map entry (discarded), client never learns the tool
finished. No diagnostic.

**Fix**: align timeouts. Either increase daemon to >= max-yield timeout, or
make daemon's timeout configurable per-endpoint.

### H9. Theme switching is end-to-end broken

**Source**: Audit E (E1)

`ShellApp.tsx:260-261` hardcodes `theme="dark"` and `onThemeChange={() => {}}`
when rendering `SettingsPanel`. Theme buttons render correctly, click fires
the no-op, nothing changes. Plugin reads `localStorage["mxd-theme"]` once at
mount; even `localStorage` is never updated.

Any "click theme button → assert changed" test would have caught this.
ShellApp has zero React-level tests.

**Fix**: wire theme state into shell, persist to localStorage, broadcast via
`storage` event or shared context; plugin subscribes.

### H10. Plugin boundary is nominal — Matrix logic in `src/`, not `.mxd/plugin/`

**Sources**: Audit A (C1), Audit K (#5)

`.mxd/plugin/runtime.ts` is a 16-line shim. `buildMatrixScopeOpts` and every
Matrix-specific module (`system-prompts`, `orchestrator-tools`,
`worktree-manager`, `work-context`, `compaction`, `TaskNode`, `MatrixConfig`)
live under `src/`. Worker loader has dead Matrix-specific fallback
`pluginMod.buildMatrixScopeOpts ?? pluginMod.buildScopeOpts ?? pluginMod.default`.

User's Matrix-as-runtime-kit vision currently needs: honest rename ("runtime
IS Matrix's runtime") OR physical extraction of Matrix-specific code into
`.mxd/plugin/runtime/`.

### H11. Shell visually depends on plugin's CSS (and breaks without it)

**Source**: Audit E (E3)

`web/styles.css` (313 lines) defines only `.mxd-shell-*` and `.mxd-login-*`.
Shell components use `mxd-header`, `mxd-btn`, `mxd-spinner`, etc. — defined
ONLY in `.mxd/plugin/web/style.css`. Shell also consumes 21 CSS custom
properties (`--accent`, `--bg-base`, …) — defined ONLY in plugin's `:root`.

With no matrix plugin loaded, shell header/login page are unstyled.
Matrix-as-runtime-kit vision requires fixing this.

### H12. No client→worker abort propagation + streams never time out

**Source**: Audit I (H1, H2)

Client fetch aborted → daemon drops pending Map entry, never sends
`http_request_abort` to worker. Worker keeps reading response body into a
dead controller. SSE streams have no timeout after `stream_start` — a hung
worker holds `stream:id` forever.

**Fix**: daemon→worker abort message; worker mirrors as Hono `req.signal`.
Stream-level timeout with keepalive.

---

## MEDIUM (correctness debt + cleanup)

### M1. Dead code in runtime (delete until ONE remains)

- Worker-side SSE ring buffer + seqId counter (`src/runtime/event-system.ts:13-73`) — all dead, authoritative version is in daemon. Audit F, K, C converge.
- `/web/*` static route in `src/runtime.ts:325` — no callers, hardcoded `.mxd/plugin/`. Audit A, K, J converge.
- `_isYield: true` in tool prefab — never read. Audit K.
- `buildMatrixScopeOpts ?? ...` fallback in scope-worker — always misses. Audit A, K.
- `worker-api.ts` 6 of 8 types never imported. Audit I, K.
- `@mxd/types` importmap entry — plugin has own duplicate of types, never imports. Audit D, E.
- `persistent-queue.ts` — bypasses unified storage layout, no callers. Audit H.
- `scope: "project"` plugin variant declared but never implemented. Audit A, E, H.
- `web/components/icons.tsx` is byte-identical to `.mxd/plugin/web/components/icons.tsx`. Audit E.
- `family` PermissionMode — no call sites. Audit G.

### M2. Duplicated `dataRoot.slice(2)` in 4 places (never calls `resolveDataRoot`)

**Sources**: Audit K (#16), Audit H (F7)

`src/plugin.ts:88` (resolveDataRoot — tests only) + 3 inline reimplementations
in `src/runtime/helpers.ts`. `resolveDataRoot` is exported but unused in
production. Must all be patched in lockstep for any traversal fix.

### M3. Web-builder silent failures produce broken UI

**Sources**: Audit D (H2, H3), Audit K (#8-10), Audit C (HIGH-2)

- Shared module build fails → log + continue → browser 404 on `/vendor/shared/auth-context.js` → ShellApp module never executes → blank page.
- Plugin TSX compile fails → `continue` → plugin disappears from `/plugins`, UI shows "Select scope" with no error.
- `getReactExportNames` try/catch swallows → shim exports `[]` → `import { useState }` returns undefined.
- "Web build failed" fallback HTML gives zero diagnostic.
- `_vendor_shims/` cleanup not in `finally` → leaks to CWD on any throw. `projectRoot = resolve(".")` makes this CWD-dependent.

### M4. REST POST /.../message returns 200 even when agent fails

**Sources**: Audit L (H4), Audit C (M5)

Task gets stuck at `in_progress` with no active agent and no way to reset via
`stop` (404) or `sessions/clear` (JSONL cleared, status untouched).
Agent-launch failures should transition to `failed`, not leave `in_progress`.

### M5. i18n duplicated across shell and plugin with separate React contexts

**Source**: Audit E (E2)

`web/i18n.ts` (697 lines) and `.mxd/plugin/web/i18n.ts` (700 lines) differ by
one key. Both call `createContext()` → two separate contexts. Locale switch
in shell doesn't reach plugin until page reload.

### M6. tracker.save() is non-atomic

**Source**: Audit H (F10)

`writeFile(treePath, JSON.stringify(data))` truncates then writes. Process
crash mid-write corrupts the tree — the single source of truth. No temp +
rename.

**Fix**: temp-file + rename (POSIX atomic).

### M7. No filesystem daemon lock

**Source**: Audit H (F9)

Two daemons on different ports with the same `MXD_DATA_DIR` silently coexist
and race on projects.json, tree.json, JSONL files.

**Fix**: `.mxd.lock` with PID at startup.

### M8. Worker crash auto-restart has no backoff

**Sources**: Audit C (HIGH-1), Audit J (noted), converges with others

Fixed 2s restart, no attempt counter, no circuit break. Deterministic crash =
infinite loop + autoResume racing itself.

**Fix**: exponential backoff (2, 4, 8, 16, 30s cap), max retries, SSE-broadcast
circuit-break error.

### M9. Concurrent POST /projects loses project from disk

**Source**: Audit C (MEDIUM-3)

`pm.init` has no mutex; last-writer-wins on overlapping `save()` awaits.
Scripted automation can silently lose a registration while the per-project
dir exists on disk.

**Fix**: serialize `pm.init` via async queue.

### M10. Stream error signaling missing

**Sources**: Audit K (#11), Audit I (H2, L4)

If `reader.read()` throws mid-stream in `scope-worker.ts`, the main thread
sees `stream_end` indistinguishable from clean completion. The SSE client
gets a silent close.

**Fix**: `http_response_stream_error` message type with error text;
controller.error() on the main thread.

### M11. check_model query-param semantics disagree

**Source**: Audit J (M1)

- `daemon.ts`: `if (c.req.query("check_model"))` (truthy)
- `runtime.ts`: `=== "true"` (strict)

Request `?check_model=0` → daemon forwards, worker refuses, caller gets basic
health without knowing.

### M12. Malformed-JSON bodies produce 500 instead of 400

**Source**: Audit J (M2)

`PATCH /config/global` + others: `await c.req.json()` throws, Hono default
maps to 500. Client-visible.

---

## LOW (naming, docs, polish)

- Multiple stale JSDocs / comments (Audit K — 7 specific items)
- API keys plaintext in `GET /config` response (Audit L — M6)
- Tree-change events emitted twice per change (Audit L — M10)
- `sessions/clear` doesn't reset task status (Audit L — M9)
- `mxd daemon install` prints wrong port if configured (Audit L — M7)
- No tests for: ShellApp.tsx, worker crash/restart, streaming, web-builder (Audit B)
- `resource-registry` module-level singleton works but is thread-fragile (Audit A)
- `@mxd/i18n` as shared module would deduplicate (Audit E)
- HTML `<title>Matrix</title>` + login branding hardcoded (Audit E)
- memory.md references deleted `storage-migration.ts` (Audit H)
- `scope` terminology overloaded 5 different ways (Audit A)
- `DaemonConfig` naming inverted — refers to worker's config (Audit A)
- Triple JSON serialize on every broadcast event (Audit F — Finding 4)

---

## What works well

- **SSE per-project isolation** verified by multiple audits.
- **Multi-project isolation** (3 projects, each with their own orchestrator, zero cross-contamination).
- **Daemon restart + JSONL resume** with existing sessions.
- **Auth once enabled** (401 clean, 200 with token).
- **JSONL event flow** readable end-to-end.
- **Input validation** (relative/empty/duplicate project paths rejected).
- **1839 tests passing, 0 failing** across the refactor.
- **Typed `SyncMap`** for sync postMessages.
- **Happy-path REST CRUD** end-to-end.
- **Importmap + shared-module react singleton** (verified: `r1 === r2` across multiple imports in browser).
- **`stripEventForUI`** consistently applied.

---

## Test coverage gaps (from Audit B)

**Decorative tests** that pass regardless of correctness:
- `ShellApp.test.tsx` "Plugin renders Orchestrator" polls but never asserts "Orchestrator"; final assertions only check `text.length > 50`.
- Importmap substring match → typo'd key still passes.
- Vendor/app 200-status tests → empty or broken JS still passes.

**Production paths with zero coverage**:
- SSE ring buffer + Last-Event-ID catch-up (CR4 would have been caught).
- Worker→shell SSE relay (prior test deleted, never replaced).
- Worker crash + auto-restart.
- Worker streaming-response protocol.
- Worker forwarding timeout.
- DELETE /projects stops running agents (test skipped "MOVED to daemon tests", never re-added — H6 regression enabler).
- Auth middleware 401 paths.
- Web-build failure modes.
- Plugin load failure isolation.
- dataRoot collision at daemon startup.
- Config sync to workers.
- ShellApp.tsx itself (232 lines, zero coverage).
- ProjectStore (new code, no direct unit tests).

Audit B proposed 18 concrete Tier-1/2/3 adversarial tests.

---

## Convergence evidence

Multiple independent eyes flagged the same items — high confidence these are
real:

| Item | Flagged by |
|------|-----------|
| Dead `/web/*` route in runtime.ts | A, K, J |
| Worker-side SSE ring buffer dead | F, K, C |
| `buildMatrixScopeOpts` dead fallback | A, K |
| `dataRoot` path traversal | H, C |
| Silent web-builder failures | D, K, C |
| Stream error signaling missing | K, I |
| SSE seqId reset / catch-up bug | F, C, B |
| Shutdown lost events | C (uniquely caught, replicable) |
| Plugin boundary nominal | A, K, E |
| `projectDebugDir` half-applied fix | H (uniquely caught) |
| dataRoot `.slice(2)` duplicated 4× | K, H |
| Worker init no timeout | C (uniquely caught) |
| Auth staleness | L (uniquely caught, with repro) |
| POST /projects non-transactional | L (uniquely caught, with repro) |
| `scope: "project"` declared but not implemented | A, E, H |

Unique catches (one auditor independently found) that matter most:
- **C1 shutdown flush bug** (Audit C, verified repro)
- **C2 init hang** (Audit C)
- **H4 auth staleness** (Audit L, verified repro)
- **H6 projectDebugDir** (Audit H)
- **H9 theme no-op** (Audit E)
- **H8 timeout mismatch** (Audit I)
