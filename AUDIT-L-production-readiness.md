# Audit L — Production Readiness (Running-the-Daemon)

**Scope**: Does the refactored Matrix actually work end-to-end from cold start?
**Method**: Started daemon in throwaway dataDir (`$(mktemp -d)`, port 17433), exercised HTTP API + CLI + SSE with curl. Did NOT launch paid agents. Worktree untouched except for this report.
**Baseline**: `bun test` → 1839 pass, 4 skip, 12 todo, 0 fail.

## Overall Assessment

**The refactor does NOT ship safely for new users as-is.** Core plumbing works once a plugin is registered — SSE, multi-project isolation, task CRUD, daemon restart with JSONL resume, config CRUD, auth gating. But the **cold-start path is broken**: following the README literally, a brand-new user ends up with a daemon that has no plugin workers and an unusable UI. Two separate bootstrap / atomicity bugs combine to produce partial state, silent security bypass, and confusing error surfaces.

Good news: the JSONL event model, worker/daemon split, and restart semantics are solid. Once plumbing is in place, the system behaves predictably. The failures are at the **edges** — first-run bootstrap, input validation, error plumbing to the REST response, and an auth cache staleness.

---

## Findings

Legend: **C**ritical (can't start / data loss) · **H**igh (visible brokenness) · **M**edium (works-but-ugly) · **L**ow (polish)

---

### C1 — Cold start has no plugin worker; every API forwarded to worker returns 503

**Scenario**: Fresh dataDir, daemon started, no projects registered (the literal README flow: `bun link → mxd daemon install → mxd init /path/to/your/project`).

**Expected**: `mxd init` creates a project and the UI becomes usable — the README promises "mxd init . && mxd send 'Build a REST API'" works.

**Actual**:
```
$ curl /plugins
[]
$ curl /projects/<id>/tasks
{"error":"No global plugin worker available"}   # HTTP 503
```
Every forwarded endpoint returns 503. The web UI renders shell + "Select a scope to load plugin UI" — no way forward. `mxd send` cannot work because the tasks endpoint is dead.

**Root cause**: `src/daemon.ts` discovers plugins by iterating `pm.list()` at startup (line ~411), loading `project.path/.mxd/plugin/index.ts`. On a truly empty dataDir, `pm.list()` is empty → `registeredPlugins = []` → no worker started → `app.all("*")` fallback returns "No global plugin worker available".

The chicken-and-egg: the Matrix plugin lives at `.mxd/plugin/` inside the Matrix repo itself. For the daemon to load it, the Matrix repo must be a registered project. The README doesn't tell the user to register Matrix first, and `mxd daemon install` doesn't self-register.

**Why the user's setup hides it**: on their machine the Matrix repo is already a registered project (self-bootstrap). First-time users don't have that registration, so the chain breaks.

**Impact**: For any fresh install, the product does not work.

**Follow-up**: either (a) daemon self-registers its own `.mxd/plugin/` when run from the Matrix repo, (b) `mxd daemon install` does the registration, or (c) a "global" plugin is shipped separately from any project registration (e.g., a well-known location scanned regardless of pm.list).

---

### C2 — POST /projects is not transactional; partial failure leaves state everywhere

**Scenario**: Send POST /projects with a path that fails during onProjectInit (e.g., `/tmp`, or a read-only path, or any path where `git commit` fails because user.email not set).

**Expected**: Either full success with rollback on failure, or clear transactional behavior.

**Actual**:
```
$ curl -X POST /projects -d '{"path":"/tmp"}'
{"error":"git add .gitignore exited 128"}   # HTTP 409

# But now:
$ ls /tmp/.mxd        # CREATED
/tmp/.mxd/hooks/  /tmp/.mxd/memory.md
$ ls /tmp/.git         # CREATED
HEAD  config  description  hooks  info ...
$ cat projects.json    # PROJECT IS STORED despite "failure"
[..., {"id":"01KPCX15Z9...","path":"/tmp","name":"tmp"}]
```

The same happens for `/this/does/not/exist/at/all` — registered in `projects.json` even though `mkdir` raised EROFS.

**Root cause** (`src/daemon.ts` POST /projects, ~line 566):
```ts
try {
  const project = await pm.init(body.path);     // writes projects.json ✅
  for (const plugin of registeredPlugins...) {
    await plugin.onProjectInit(...)              // may fail partway
  }
  mkdirSync(join(dataDir, "projects", id, "tasks"))  // creates per-project dir
  syncProjects();
  return c.json(project, 201);
} catch (e) {
  return c.json({ error: ... }, 409);            // no rollback
}
```

onProjectInit does: `mkdir(.mxd)` → `writeFile(.mxd/memory.md)` → `createSetupHook` → `git init` → `.gitignore` → `git add` → `git commit` → `excludeWorktrees(.git/info/exclude)`. Any step can fail in the middle. No cleanup. projects.json already has the id.

**Impact**:
1. **Data integrity**: stale projects.json entries accumulate; manual cleanup required.
2. **Security / surprise**: an authenticated POST /projects with an arbitrary path can cause the daemon to create `.mxd/`, `.git/`, and modify `.git/info/exclude` in that path. Side effects from failed registration persist. For users pasting paths from clipboard, a typo like `/tmp` could create real artifacts.
3. **Error message**: "git add .gitignore exited 128" is not actionable.

**Follow-up**:
- Validate the path BEFORE any side effect (check `.git` exists, check user.email configured, dry-run).
- On onProjectInit failure, roll back: `pm.delete(id)`, remove per-project dir, attempt to reverse fs mutations where possible.
- Distinguish "new project, I can create" from "existing project, I'll use as-is" and refuse to mutate paths that look wrong (non-empty, system-owned).

---

### H3 — Auth secret cache: `mxd auth` doesn't lock the running daemon

**Scenario**: Daemon starts without auth.json. User runs `mxd auth <pub_key>` (README flow). Check if daemon now requires auth.

**Expected**: After auth.json is written, `GET /auth/status` returns `enabled:true` and all other routes require a valid token.

**Actual**:
```
# daemon running, no auth.json
$ curl /auth/status
{"enabled":false,"authenticated":true}

# user creates auth.json with valid jwtSecret (simulating mxd auth)
$ cat > auth.json <<< '{"jwtSecret": "..."}'

# daemon STILL returns enabled:false
$ curl /auth/status
{"enabled":false,"authenticated":true}

$ curl /projects        # still open, no token needed
[...]                    # 200 OK
```

Confirmed by restart: after restart, `/auth/status` correctly returns `enabled:true`, and `/projects` without token → 401. So the secret IS valid; the live daemon just doesn't notice.

**Root cause** (`src/auth.ts:30`):
```ts
let authDataCache: AuthData | null = null;

async function readAuthData(path: string): Promise<AuthData> {
  if (authDataCache) return authDataCache;     // module-level cache
  try { authDataCache = { jwtSecret: raw.jwtSecret }; }
  catch { authDataCache = {}; }                 // cached empty on miss
  return authDataCache;
}
```

Module-level cache is set on first `readAuthData(path)` call. If auth.json didn't exist at first read, `authDataCache = {}` is remembered forever. `hasJwtSecret()` returns false thereafter. The auth middleware bypass (`if hasJwtSecret(authPath)`) stays off. Comment says "(for testing)" via `resetAuthDataCache`, but nothing calls it in production.

**Impact** (security):
- User follows README: daemon starts open, browser shows pub key, user runs `mxd auth`, browser authenticates. But the daemon never re-reads auth.json.
- For the duration of that daemon's lifetime, ANY unauthenticated client on the same host can hit /projects, /config/global (including API keys), /events, etc.
- User has the false belief that auth is on because `mxd auth` completed successfully and the browser got a token.

**Follow-up**:
- Drop the module-level cache — file read is cheap at request rate.
- Or watch auth.json for changes and invalidate.
- Or just `stat` the file mtime and recheck when it changes.

---

### H4 — REST `POST /.../message` returns 200 even when agent fails immediately

**Scenario**: Send a message to a root task where auth group is not configured.

**Expected**: 4xx with error (or at minimum, error visible in response).

**Actual**:
```
$ curl -X POST /projects/<id>/tasks/<root>/message -d '{"content":"hello","triggerResume":true}'
{"ok":true,"taskId":"..."}    # HTTP 200

$ curl /projects/<id>/tasks/<root>/events
{..., "type":"error", "message":"Agent error: No auth group configured..."}
{..., "type":"agent_end", "reason":"stopped"}

$ curl /projects/<id>/tasks
[{"id":"...","status":"in_progress","title":"..."}]   # stuck at in_progress
```

The client gets 200 OK, an eventual error is buried in the SSE stream, and the task's status is stuck at `in_progress` even though no agent is running. `GET /projects/<id>/agent/status` → `{"idle":[],"active":[]}`. `POST .../stop` → 404 "No running agent for this task".

**Impact**:
- Callers of REST can't tell if a send succeeded.
- Task tree shows "in_progress" indefinitely — misleading status visibility.
- No programmatic signal that auth is misconfigured.

**Follow-up**:
- POST message should await initial launch attempt and surface launch-time errors synchronously (or queue them and return an event id the caller can poll).
- Agent-launch failures should transition the task to `failed`, not leave it `in_progress`.

---

### H5 — Error messages surfaced to users are raw API blobs

**Scenario**: Auth group configured with a fake API key. Send message.

**Actual** (event stream):
```
{"type":"error","message":"Agent error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"...}}"}
```

Compare to the auth-missing case which gets a curated: `"Agent error: No auth group configured. Add an auth group in Settings > Global > Auth Groups and set defaultAuth."`

**Impact**: The 401 case dumps the raw JSON Anthropic response. For a new user pasting a key with a typo, this is confusing. A curated version ("Your API key is invalid. Re-check in Settings > Global > Auth Groups.") would be better.

**Follow-up**: Classify common agent errors (401, 429, 400 invalid_request) and display curated messages.

---

### M6 — API keys exposed in plaintext in `GET /config/global` and `GET /projects/:id/config/all`

**Scenario**: Configure an auth group, fetch config.

**Actual**:
```
$ curl /config/global
{"authGroups":{"test":{"provider":"anthropic","apiKey":"sk-ant-test"}},...}
```

Plaintext API keys returned. Web UI displays them (the Settings Panel). Anyone with a valid token can read all keys.

**Impact**: If a token leaks (browser extension, shared session), API keys go with it.

**Follow-up**:
- Mask keys in GET response (`sk-ant-...last4`).
- Keep full value server-side; frontend can only PATCH a new value.
- Separate "list keys" (masked) from "edit key" (write-only).

---

### M7 — `mxd daemon install` prints a URL that doesn't match the configured port

**Scenario**: User configured `port: 12345` in `~/.mxd/config.json`. Runs `mxd daemon install`.

**Actual** (`src/cli.ts`):
```ts
console.log(`  URL:   http://localhost:${process.env.PORT ?? "7433"}`);
```

The CLI reads `process.env.PORT` (usually unset) and falls back to 7433. The daemon itself reads `globalConfig.port`. Mismatch — user is told "http://localhost:7433" but daemon is on 12345.

**Follow-up**: Load `globalConfig` in the CLI and print the actual port.

---

### M8 — REST POST /tasks ignores `draft` field

**Scenario**: `POST /projects/<id>/tasks -d '{"title":"x","description":"y","parentId":"...","draft":true}'`

**Expected**: Task created with `status:"draft"`.

**Actual**: Task created with `status:"pending"`. The body schema doesn't include `draft`:
```ts
const body = await c.req.json<{ title; description; parentId?; budgetUsd?; folder? }>();
```

(PATCH does accept `draft`.)

**Follow-up**: Accept `draft` on POST and call `tracker.updateStatus(id, "draft", "user")` if set. Or document that draft-at-creation is unsupported.

---

### M9 — Task stuck at `in_progress` after agent error (persists across `sessions/clear`)

Related to H4. Even calling `POST /projects/<id>/tasks/<id>/sessions/clear` does NOT reset the status:
```
$ curl -X POST .../sessions/clear
{"cleared":true,"taskId":"..."}

$ curl /projects/<id>/tasks
[{"status":"in_progress"}]   # still
```

`sessions/clear` removes the JSONL but doesn't reset the tree node's status. Future restart's `resumeScope` won't pick it up (no JSONL → skipped), so the status stays forever.

**Follow-up**: `sessions/clear` should also reset status to `pending` (or `draft` if the node was created as such).

---

### M10 — Tree-change events are emitted twice per change

SSE shows two events per PATCH (same timestamp, same action, different message ids):
```
id: 5 data: {type:"message","body":{"source":"tree_change","action":"updated",...,"ts":1776402049061}}
id: 6 data: {type:"message","body":{"source":"tree_change","action":"updated",...,"ts":1776402049061}}
```

Doubles the event stream volume for common operations. Cause not investigated — likely two broadcasters attached to the same signal.

**Follow-up**: Dedupe tree-change broadcasts.

---

### L11 — macOS `/tmp` symlink mismatch breaks `mxd send` at default temp dirs

`mxd send` resolves current project via `cwd === p.path || cwd.startsWith(p.path+"/")`. On macOS, `process.cwd()` returns the physical path (`/private/var/folders/.../foo`). `mxd init /var/folders/.../foo` stores the logical path. Mismatch → "No project found for current directory".

Only an issue for paths under `/tmp`, `/var`, `/private/var`. Real dev work under `/Users/...` is fine.

**Follow-up**: `mxd init` could `fs.realpathSync(path)` before storing, or the resolver could normalize both sides.

---

### L12 — Web assets / plugin files have no hot reload

Editing `.mxd/plugin/web/Plugin.tsx` has no effect until daemon restart. No file watcher, no rebuild hook. README says "`bun run --watch src/daemon.ts`" is the dev mode, which restarts the whole process on change — not plugin-local reload.

**Impact**: Plugin developers need full daemon restart per edit. Matrix's self-bootstrap story works because they use `bun run --watch`, but that's not documented for plugin authors.

**Follow-up**: Document the dev story. Optionally watch plugin web files and rebuild.

---

### L13 — Orphaned per-project data dirs accumulate when `projects.json` is hand-edited

When `projects.json` is modified externally (I rewrote it during a test to remove a project), the per-project dir `projects/<id>/` is left on disk. Accumulates with test failures, manual edits, or crashes between `save()` and `mkdir`.

**Follow-up**: On daemon startup, either reconcile (delete orphans) or warn.

---

### L14 — CLI/daemon auth.json path divergence

`mxd auth` writes to `~/.mxd/auth.json` (hard-coded AUTH_JSON_PATH in cli.ts). Daemon reads from `{dataDir}/auth.json`. If the user sets `MXD_DATA_DIR=/other/path`, the two locations diverge silently. In normal use both resolve to `~/.mxd/auth.json` so no symptom.

**Follow-up**: CLI should read the daemon's dataDir (via env or a config lookup) before touching auth.json.

---

## What Works Well

- **SSE** — works, `Last-Event-ID` reconnect correctly replays missed events from ring buffer, per-project isolation (P1 stream doesn't leak P2 events).
- **Multi-project** — 3 projects each with their own Orchestrator and tree, fully isolated.
- **Daemon restart** — with Matrix registered, a restart preserves tree.json, re-reads config, and re-issues the right root nodes. `autoResumeProjects` correctly skips nodes with no JSONL.
- **Auth once enabled** — with auth.json present at startup, `/projects` without a token → 401 is clean, a valid token gets 200, a bogus token gets 401.
- **JSONL event flow** — message → session_config → agent_start → messages_consumed → error → agent_end all show up cleanly in `/events`.
- **Health / shutdown** — `/health` returns JSON, SIGTERM shuts down cleanly, `/restart-daemon` calls `process.exit(0)` correctly (caller re-spawns).
- **Cross-origin input validation** — relative paths rejected, empty path rejected, duplicate path rejected (all with clear messages).
- **Test suite** — `bun test` passes all 1839 tests on this worktree.

---

## Recommended Follow-up Tasks

Ordered by impact:

1. **(C) First-run plugin bootstrap** — daemon must discover a plugin without requiring a pre-registered project. Options: (a) daemon self-registers its own `.mxd/plugin/` when present in its working directory, (b) `mxd daemon install` auto-registers Matrix repo as a project, (c) global plugin location separate from project registration. Pair with a clear "no plugin loaded" UI state explaining the fix.

2. **(C) Transactional POST /projects** — validate path before side effects, roll back on failure. Specifically (a) require `.git` exists and `user.email` configured before `git commit`, (b) on any onProjectInit failure, `pm.delete(id)` + remove data dir + warn about fs mutations.

3. **(H) Auth cache invalidation** — drop `authDataCache`, or re-stat on every request, or watch the file. Current behavior silently disables auth for a live daemon after `mxd auth`.

4. **(H) Synchronous error propagation for POST /message** — await initial launch, return 4xx on launch-time failure (auth missing, worktree unavailable), transition task to `failed` instead of `in_progress`.

5. **(M) Curated agent error surfaces** — classify 401/429/400 from upstream and show user-friendly messages instead of raw JSON blobs.

6. **(M) Mask API keys on GET /config** — never emit plaintext secrets over HTTP. Frontend can PATCH to rotate.

7. **(M) `sessions/clear` should also reset status** — currently leaves the task stuck at `in_progress` with no JSONL.

8. **(M) Dedupe tree-change broadcasts** — investigate why each PATCH emits two identical tree_change messages.

9. **(L) CLI port print, macOS symlink resolution, plugin hot reload documentation, orphan data dir reconciliation, auth.json path alignment.**

---

## Environment

- Worktree: `~/dev/matrix/.worktrees/01KPCW504QRZEE2JEC9XVHAQPN-audit-l-production-readiness-d`
- Commit: `93255aa`
- Throwaway dataDir: `/var/folders/.../mxd-audit-L-XXXX.0smsWjoaaw`
- Port: 17433 (user's real daemon on 7433, untouched)
- User `~/.mxd` never read or written.
- `bun test` baseline: 1839 pass / 4 skip / 12 todo / 0 fail (182s).
