#!/usr/bin/env bun
/**
 * Meta-daemon — the main entry point.
 *
 * Responsibilities:
 * - HTTP server
 * - Auth middleware
 * - Plugin discovery (scans projects for .mxd/plugin/index.ts)
 * - Worker management (start/stop scope workers)
 * - SSE relay (worker events → browser)
 * - Global config + plugin registry endpoints
 *
 * Does NOT own: RuntimeContext, trackers, eventStores, agent lifecycle, tools.
 * Those live in the worker.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
	bumpSecretVersion,
	ensureAuthInitialized,
	signStreamToken,
	verifyJWT,
} from "./auth.ts";
import {
	type AuthGroup,
	loadGlobalConfig,
	type MatrixConfig,
	saveGlobalConfig,
} from "./config.ts";
import {
	checkDataRootCollisions,
	effectiveDataRoot,
	type PluginManifest,
	validatePluginManifest,
} from "./plugin.ts";
import { pluginApiPrefix } from "./plugin-url.ts";
import { ProjectManager } from "./project-manager.ts";
import type { SyncMap } from "./runtime/worker-api.ts";
import { ulid } from "./ulid.ts";
import { GIT_HASH, VERSION } from "./version.ts";

// ── SSE ring-buffer helpers (daemon-only) ──

/**
 * An SSE ring-buffer entry. Exported shape for tests; all consumers share
 * `{ seqId, data }` so a generic `{ seqId: number }` is enough for the
 * stale-ahead algorithm below.
 */
export interface SSERingEntry {
	seqId: number;
	data: string;
}

/**
 * Return events the client missed, or `null` if the buffer can't serve
 * the client's position (gap too large, or stale-ahead from a previous
 * daemon epoch). Returning `null` tells the caller to send the full
 * initial state; returning `[]` means the client is up to date.
 *
 * Stale-ahead: when a client's `lastSeqId` is greater than anything we
 * currently hold (e.g. daemon restarted and `sseSeqCounters` reset to 0
 * while the browser still has `Last-Event-ID: 5000`), `findIndex` can't
 * find a matching entry and used to return `[]` — the UI would then
 * believe it was caught up and never refresh. The explicit
 * `lastSeqId > lastEntry.seqId` check forces the initial-state recovery
 * path on every restart-ahead case.
 *
 * Pure function — exported so the stale-ahead invariant is unit-testable
 * without spinning up a daemon.
 */
export function getEventsSinceFromBuffer<T extends { seqId: number }>(
	buffer: T[] | undefined,
	lastSeqId: number,
): T[] | null {
	if (!buffer || buffer.length === 0) return null;
	const firstEntry = buffer[0];
	const lastEntry = buffer[buffer.length - 1];
	if (!firstEntry || !lastEntry) return null;
	// Gap too large — can't guarantee no missed events.
	if (lastSeqId < firstEntry.seqId - 1) return null;
	// Stale-ahead: client is beyond our current epoch (daemon restart reset
	// the seq counter). Force initial-state send instead of silently
	// returning "up to date".
	if (lastSeqId > lastEntry.seqId) return null;
	const idx = buffer.findIndex((e) => e.seqId > lastSeqId);
	if (idx === -1) return []; // Client is up to date
	return buffer.slice(idx);
}

// ── Bearer / secret helpers (daemon-only) ──

/**
 * Extract a bearer token from an Authorization header OR a `?token=` query param.
 *
 * Bearer scheme is compared case-insensitively per RFC 7235 §2.1
 * ("case-insensitive scheme"). The query-param path exists ONLY for SSE
 * EventSource, which cannot set headers; see also `signStreamToken`.
 */
function extractBearerToken(
	authHeader: string | undefined,
	queryToken: string | undefined,
): string | null {
	if (authHeader) {
		const match = /^Bearer[ \t]+(.+)$/i.exec(authHeader);
		if (match) {
			const t = match[1]?.trim();
			if (t) return t;
		}
	}
	return queryToken ?? null;
}

/** Mask a secret (API key, token) to `prefix…last4`. Returns `"****"` for short values. */
function maskSecret(s: string | undefined): string | undefined {
	if (!s) return s;
	if (s.length <= 8) return "****";
	return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

/** Return an AuthGroup with every secret field masked. Does not mutate input. */
function maskAuthGroup(group: AuthGroup): AuthGroup {
	if (group.provider === "anthropic") {
		return {
			...group,
			apiKey: maskSecret(group.apiKey),
			oauthToken: maskSecret(group.oauthToken),
		};
	}
	return {
		...group,
		apiKey: maskSecret(group.apiKey),
		accessToken: maskSecret(group.accessToken),
		refreshToken: maskSecret(group.refreshToken),
	};
}

/**
 * Return a config with every `authGroups.*` credential field masked.
 * Used on GET /config/global and on `repo`/`local`/`resolved` views of
 * the three-layer config so a valid token can no longer be traded for
 * raw API keys — even if a malicious actor wrote `authGroups` into a
 * layer that's not supposed to carry credentials (Audit R7 P1.4).
 *
 * Accepts both `MatrixConfig` (full) and `Partial<MatrixConfig>` (project
 * layers where `authGroups` is typed as absent but could exist on disk).
 * When `authGroups` is not present on the input, returns a shallow clone
 * unchanged.
 */
function maskConfig<T extends Partial<MatrixConfig>>(config: T): T {
	if (!config.authGroups) return { ...config };
	const maskedGroups: Record<string, AuthGroup> = {};
	for (const [name, group] of Object.entries(config.authGroups)) {
		maskedGroups[name] = maskAuthGroup(group);
	}
	return { ...config, authGroups: maskedGroups };
}

/**
 * Reject any PATCH body that tries to set credential fields on a per-project
 * config layer (repo or local). Returns an error message if a forbidden
 * field is present, null otherwise.
 *
 * `authGroups` is marked global-only in `GLOBAL_ONLY_FIELDS` — allowing it
 * through would be a credential-injection surface: an attacker who can PATCH
 * a project's config with their own authGroups could have every subsequent
 * agent run use their credentials (Audit R7 P1.4).
 *
 * `defaultAuth` is technically per-project legal (a project can pick which
 * existing auth group to use) but is rejected here defensively — the CLI
 * already refused it pre-server, and the audit report called it out
 * alongside `authGroups` as part of the credential-layer attack surface.
 *
 * The CLI has the same check client-side (`src/cli.ts`), but defense of
 * record must not rely on a friendly client.
 */
function rejectCredentialFields(body: Partial<MatrixConfig>): string | null {
	if (body.authGroups != null) {
		return "authGroups can only be set in global config (use PATCH /config/global)";
	}
	if (body.defaultAuth != null) {
		return "defaultAuth can only be set in global config (use PATCH /config/global)";
	}
	return null;
}

/** `true` if `incoming` is the masked form of `existing`. */
function isMaskedEcho(
	existing: string | undefined,
	incoming: string | undefined,
): boolean {
	if (!existing || !incoming) return false;
	return incoming === maskSecret(existing);
}

/**
 * For PATCH: if the client submitted a masked echo of an existing secret
 * (i.e. didn't touch the field in the UI), preserve the stored plaintext.
 * Otherwise accept whatever came in — including clearing via empty string.
 * The UI writes `{ apiKey: maskedValue }` back when the user leaves the
 * field untouched; without this we'd overwrite real keys with their mask.
 */
function mergeAuthGroup(
	existing: AuthGroup | undefined,
	incoming: AuthGroup,
): AuthGroup {
	if (!existing || existing.provider !== incoming.provider) return incoming;

	// `keep(field)` : if `incoming[field]` is a masked echo of `existing[field]`,
	// return the stored plaintext; else return incoming as-is.
	const keep = (field: string): string | undefined => {
		const inc = (incoming as unknown as Record<string, unknown>)[field];
		const ex = (existing as unknown as Record<string, unknown>)[field];
		const incStr = typeof inc === "string" ? inc : undefined;
		const exStr = typeof ex === "string" ? ex : undefined;
		if (isMaskedEcho(exStr, incStr)) return exStr;
		return incStr;
	};

	if (incoming.provider === "anthropic") {
		return {
			...incoming,
			apiKey: keep("apiKey"),
			oauthToken: keep("oauthToken"),
		};
	}
	return {
		...incoming,
		apiKey: keep("apiKey"),
		accessToken: keep("accessToken"),
		refreshToken: keep("refreshToken"),
	};
}

/** Merge incoming authGroups record with existing — preserve masked echoes. */
function mergeAuthGroups(
	existing: Record<string, AuthGroup>,
	incoming: Record<string, AuthGroup>,
): Record<string, AuthGroup> {
	const out: Record<string, AuthGroup> = {};
	for (const [name, group] of Object.entries(incoming)) {
		out[name] = mergeAuthGroup(existing[name], group);
	}
	return out;
}

// ── Types ──

interface ShellSSEClient {
	controller: ReadableStreamDefaultController;
	projectId: string;
	/** The lens this stream is bound to — the plugin NAME (URL `<pluginScope>`).
	 * Live events are filtered by (projectId, scope) so a product-lens viewer
	 * never receives the dev lens's tree updates and vice versa. */
	scope: string;
}

interface ScopeWorker {
	worker: Worker;
	ready: boolean;
	pending: Map<
		string,
		{
			resolve: (response: {
				status: number;
				headers: Record<string, string>;
				body: string;
				_isStream?: boolean;
			}) => void;
			reject: (error: Error) => void;
		}
	>;
}

interface RegisteredPlugin extends PluginManifest {
	pluginRoot: string;
	projectId: string;
	resolvedWebPath?: string;
}

/**
 * The `workers` Map key for a plugin.
 *
 * - global plugin → bare `name` (one worker serves every project; matrix
 *   dev-mode is reachable for any project under `/api/matrix/...`).
 * - project plugin → `<projectId>:<name>` so two different projects can each
 *   ship a plugin with the same `name` without their workers colliding.
 *
 * This key is also the `scopeName` used for restart/backoff state and for
 * `forwardToWorker`/`workers.get`/`workers.has`. (The user-facing scope segment
 * in the URL is the bare plugin NAME; the worker key is an internal detail.)
 */
function workerKeyForPlugin(
	plugin: Pick<RegisteredPlugin, "scope" | "name" | "projectId">,
): string {
	return plugin.scope === "project"
		? `${plugin.projectId}:${plugin.name}`
		: plugin.name;
}

export interface DaemonInstance {
	/** Handle an HTTP request (for testing — bypasses Bun.serve) */
	fetch: (request: Request) => Promise<Response>;
	/** Registered plugins */
	plugins: RegisteredPlugin[];
	/** Graceful shutdown */
	shutdown: () => Promise<void>;
	/** Project manager */
	pm: ProjectManager;
	/** Global config */
	globalConfig: MatrixConfig;
}

// ── Filesystem daemon lock ──
//
// Prevents two daemons sharing the same dataDir. Without this, a second daemon
// (e.g. accidentally launched on a different port with the same MXD_DATA_DIR)
// would race on projects.json, tree.json, and JSONL files — producing lost
// writes and tree corruption.
//
// Lock contents: JSON `{ pid, startedAt, version }`. On startup we attempt to
// create the file with O_EXCL; if it already exists we check whether the
// holding process is still alive. Dead PID → stale lock, we steal it. Live PID
// → refuse to start.

const LOCK_FILE_NAME = ".mxd.lock";

interface LockFilePayload {
	pid: number;
	startedAt: string;
	version: string;
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		// signal 0 = existence probe. Throws ESRCH if the process is gone,
		// EPERM if it exists but we don't own it (still "alive" for our purposes).
		process.kill(pid, 0);
		return true;
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		return err.code === "EPERM";
	}
}

function tryWriteLockFile(lockPath: string, payload: LockFilePayload): boolean {
	try {
		// `wx` — create + fail if exists. Atomic check-and-create.
		const fd = openSync(lockPath, "wx");
		try {
			writeSync(fd, JSON.stringify(payload, null, "\t"));
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "EEXIST") return false;
		throw e;
	}
}

/**
 * Acquire the dataDir lock. Returns a release function or throws if another
 * live daemon holds it. Stale locks (dead PID) are stolen transparently.
 */
export function acquireDataDirLock(
	dataDir: string,
	version = VERSION,
): () => void {
	mkdirSync(dataDir, { recursive: true });
	const lockPath = join(dataDir, LOCK_FILE_NAME);
	const payload: LockFilePayload = {
		pid: process.pid,
		startedAt: new Date().toISOString(),
		version,
	};

	const take = () => tryWriteLockFile(lockPath, payload);

	if (take()) return () => releaseLock(lockPath, payload.pid);

	// Lock exists — read + probe holder.
	let holder: Partial<LockFilePayload> | null = null;
	try {
		holder = JSON.parse(readFileSync(lockPath, "utf-8")) as LockFilePayload;
	} catch {
		// Malformed lock (partial write, manual edit). Treat as stale.
		holder = null;
	}

	const holderPid =
		typeof holder?.pid === "number" ? (holder.pid as number) : null;
	if (holderPid !== null && isProcessAlive(holderPid)) {
		// Refuses even when `holderPid === process.pid` — that case means we
		// already hold the lock in this process (e.g., a test forgot to release,
		// or createDaemon was called twice). Reusing the same lock would mask
		// real bugs.
		throw new Error(
			`Matrix daemon already running on dataDir ${dataDir} (PID ${holderPid}, started ${holder?.startedAt ?? "unknown"}). ` +
				`If you're sure no daemon is running, delete ${lockPath}.`,
		);
	}

	// Stale or malformed — remove and retry once. A racing peer could
	// re-create between unlink and openSync(..., 'wx'), in which case `take()`
	// returns false and we surface the same "already running" error.
	try {
		unlinkSync(lockPath);
	} catch {
		/* racing cleanup */
	}
	if (take()) return () => releaseLock(lockPath, payload.pid);

	throw new Error(
		`Matrix daemon lock at ${lockPath} is contested by another process. Retry in a moment.`,
	);
}

function releaseLock(lockPath: string, expectedPid: number): void {
	try {
		const raw = readFileSync(lockPath, "utf-8");
		const existing = JSON.parse(raw) as LockFilePayload;
		if (existing.pid !== expectedPid) {
			// Someone else owns the lock now (e.g., we stole a stale one and a
			// racing daemon's lock got in first). Leave it alone.
			return;
		}
	} catch {
		// Already gone or malformed — nothing to do.
		return;
	}
	try {
		unlinkSync(lockPath);
	} catch {
		/* already gone */
	}
}

// ── createDaemon ──

export async function createDaemon(opts: {
	dataDir: string;
	globalConfigPath?: string;
	/**
	 * Acquire a filesystem lock at `<dataDir>/.mxd.lock` to prevent two
	 * daemons from sharing the same dataDir. Enabled by default in production
	 * (see `if (import.meta.main)`); tests disable it because they spin up
	 * many daemons concurrently against isolated tempdirs.
	 */
	lockDataDir?: boolean;
	/**
	 * Override worker init timeout (ms). Defaults to 30s in production.
	 * Tests use a short override so the "hung plugin" path exits quickly.
	 */
	workerInitTimeoutMs?: number;
	/** Auto-register the matrix install directory as a project on startup.
	 *  Default true. Tests pass false for clean state. */
	autoRegisterSelf?: boolean;
	/** Override computed install root. Default: auto-detect from binary path.
	 *  Tests pass an explicit path to simulate production install. */
	installRoot?: string;
}): Promise<DaemonInstance> {
	const { dataDir } = opts;
	const releaseDataDirLock = opts.lockDataDir
		? acquireDataDirLock(dataDir)
		: () => {};
	const globalConfigPath =
		opts.globalConfigPath ?? join(dataDir, "config.json");

	// Load global config.
	//
	// A missing file is fine — loadGlobalConfig returns DEFAULT_CONFIG (fresh
	// install). But a config that EXISTS yet is corrupt / incomplete must NOT
	// be silently replaced with DEFAULT_CONFIG: that boots with empty
	// authGroups, and the next saveGlobalConfig would overwrite the on-disk
	// credentials with nothing. Fail boot loudly instead — the on-disk config
	// (with credentials) is left untouched for the operator to fix.
	let globalConfig: MatrixConfig;
	try {
		globalConfig = await loadGlobalConfig(globalConfigPath);
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new Error(
			`Failed to load global config at ${globalConfigPath}: ${message}\n` +
				"Refusing to boot with an empty config — that would overwrite saved " +
				"credentials. Fix or remove the config file and restart.",
		);
	}

	// SSE state
	const sseClients = new Set<ShellSSEClient>();
	const sseEncoder = new TextEncoder();

	// Per-LENS SSE sequencing + ring buffer for Last-Event-ID catch-up.
	// A "lens" is a (projectId, scope) pair — `scope` is the plugin NAME (the
	// URL `<pluginScope>` segment). Under additive routing a project has a
	// DISTINCT tree per lens (matrix dev vs its own product), so each lens has
	// its own seqId stream + ring buffer; an EventSource is bound to one lens.
	// SSERingEntry type declared at module scope so `getEventsSinceFromBuffer`
	// can be exported without dragging closure types with it.
	const sseSeqCounters = new Map<string, number>();
	const sseEventBuffers = new Map<string, SSERingEntry[]>();
	const SSE_RING_BUFFER_SIZE = 2000;

	/** Composite key for the (projectId, scope) lens. `\u0000` can't appear in
	 * a ULID projectId or a `[A-Za-z0-9_-]` plugin name, so it's an unambiguous
	 * separator (and distinct from worker keys, which use `:`). */
	function lensKey(projectId: string, scope: string): string {
		return `${projectId}\u0000${scope}`;
	}

	function nextSseSeqId(key: string): number {
		const current = sseSeqCounters.get(key) ?? 0;
		const next = current + 1;
		sseSeqCounters.set(key, next);
		return next;
	}

	function bufferSseEvent(key: string, seqId: number, data: string): void {
		let buffer = sseEventBuffers.get(key);
		if (!buffer) {
			buffer = [];
			sseEventBuffers.set(key, buffer);
		}
		buffer.push({ seqId, data });
		if (buffer.length > SSE_RING_BUFFER_SIZE) {
			buffer.splice(0, buffer.length - SSE_RING_BUFFER_SIZE);
		}
	}

	function getEventsSince(
		key: string,
		lastSeqId: number,
	): SSERingEntry[] | null {
		return getEventsSinceFromBuffer(sseEventBuffers.get(key), lastSeqId);
	}

	// Worker state
	const workers = new Map<string, ScopeWorker>();
	// Pending restart timers — tracked so shutdown() can clear them (R8-A#9b).
	const pendingRestartTimers = new Set<ReturnType<typeof setTimeout>>();

	// ── Worker init/restart durability knobs ──
	//
	// A hung plugin `runtime.ts` (top-level `await new Promise(()=>{})`) must not
	// hang the daemon forever. INIT_TIMEOUT_MS caps how long we wait for a worker
	// to report `ready` before we terminate it and surface the failure.
	//
	// A deterministically crashing worker must not spin-loop restarting. We track
	// attempts per scope with exponential backoff (2, 4, 8, 16, 30s cap) and
	// circuit-break after MAX_RESTARTS_BEFORE_CIRCUIT_BREAK. After STABLE_RESET_MS
	// of healthy uptime the attempt counter resets so transient crashes don't
	// poison later restarts.
	const WORKER_INIT_TIMEOUT_MS = opts.workerInitTimeoutMs ?? 30_000;
	const MAX_RESTARTS_BEFORE_CIRCUIT_BREAK = 5;
	const STABLE_RESET_MS = 60_000;
	const RESTART_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

	interface WorkerRestartState {
		attempts: number;
		lastReadyAt: number;
		circuitBroken: boolean;
	}
	const workerRestartState = new Map<string, WorkerRestartState>();

	function getRestartState(scopeName: string): WorkerRestartState {
		let s = workerRestartState.get(scopeName);
		if (!s) {
			s = { attempts: 0, lastReadyAt: 0, circuitBroken: false };
			workerRestartState.set(scopeName, s);
		}
		return s;
	}

	/**
	 * Broadcast a worker-restart signal to every SSE client (all projects).
	 * Uses a null-ish projectId so the message reaches clients regardless of
	 * what project they're watching — the UI treats this as a global
	 * daemon-health event.
	 */
	function broadcastWorkerEvent(event: Record<string, unknown>): void {
		const data = JSON.stringify(event);
		const msg = sseEncoder.encode(`data: ${data}\n\n`);
		for (const client of sseClients) {
			try {
				client.controller.enqueue(msg);
			} catch {
				sseClients.delete(client);
			}
		}
	}

	function scheduleWorkerRestart(
		plugin: RegisteredPlugin,
		reason: string,
	): void {
		const scopeName = workerKeyForPlugin(plugin);
		const state = getRestartState(scopeName);

		// If the worker stayed healthy for STABLE_RESET_MS since its last ready,
		// reset the attempt counter — prior transient crashes shouldn't block
		// a legitimate recovery.
		if (
			state.lastReadyAt > 0 &&
			Date.now() - state.lastReadyAt >= STABLE_RESET_MS
		) {
			state.attempts = 0;
			state.circuitBroken = false;
		}

		if (state.circuitBroken) {
			console.error(
				`[daemon] Worker "${scopeName}" circuit broken — refusing restart (reason: ${reason})`,
			);
			return;
		}

		if (state.attempts >= MAX_RESTARTS_BEFORE_CIRCUIT_BREAK) {
			state.circuitBroken = true;
			console.error(
				`[daemon] Worker "${scopeName}" crashed ${state.attempts} times — circuit-break engaged. Manual restart required.`,
			);
			broadcastWorkerEvent({
				type: "worker_circuit_broken",
				scope: scopeName,
				attempts: state.attempts,
				reason,
			});
			return;
		}

		const idx = Math.min(state.attempts, RESTART_BACKOFF_MS.length - 1);
		const delayMs = RESTART_BACKOFF_MS[idx] ?? 30_000;
		state.attempts++;

		broadcastWorkerEvent({
			type: "worker_restart_scheduled",
			scope: scopeName,
			attempt: state.attempts,
			delayMs,
			reason,
		});

		const timer = setTimeout(() => {
			pendingRestartTimers.delete(timer);
			console.log(
				`[daemon] Restarting worker "${scopeName}" (attempt ${state.attempts}/${MAX_RESTARTS_BEFORE_CIRCUIT_BREAK})...`,
			);
			startWorkerForPlugin(plugin).catch((e) => {
				console.error(`[daemon] Worker "${scopeName}" restart failed:`, e);
				// Restart failed (e.g. init timeout) — schedule another attempt.
				scheduleWorkerRestart(
					plugin,
					`restart error: ${e instanceof Error ? e.message : String(e)}`,
				);
			});
		}, delayMs);
		pendingRestartTimers.add(timer);
	}

	function setupWorkerMessageHandler(
		pluginName: string,
		scopeWorker: ScopeWorker,
	) {
		scopeWorker.worker.onmessage = (event: MessageEvent) => {
			const msg = event.data;

			if (msg.type === "http_response") {
				const pending = scopeWorker.pending.get(msg.id);
				if (pending) {
					scopeWorker.pending.delete(msg.id);
					pending.resolve({
						status: msg.status,
						headers: msg.headers,
						body: msg.body,
					});
				}
			}

			// Streaming response support (SSE/MCP)
			if (msg.type === "http_response_stream_start") {
				const pending = scopeWorker.pending.get(msg.id);
				if (pending) {
					scopeWorker.pending.delete(msg.id);
					const stream = new ReadableStream({
						start(controller) {
							// Store controller for subsequent chunks
							scopeWorker.pending.set(`stream:${msg.id}`, {
								resolve: () => {},
								reject: () => {},
								_streamController: controller,
							} as unknown as typeof pending);
						},
					});
					pending.resolve({
						status: msg.status,
						headers: msg.headers,
						body: stream as unknown as string, // will be used as Response body
						_isStream: true,
					});
				}
			}
			if (msg.type === "http_response_stream_chunk") {
				const streamPending = scopeWorker.pending.get(
					`stream:${msg.id}`,
				) as unknown as
					| { _streamController?: ReadableStreamDefaultController }
					| undefined;
				if (streamPending?._streamController) {
					try {
						streamPending._streamController.enqueue(
							new TextEncoder().encode(msg.chunk),
						);
					} catch {
						/* client disconnected */
					}
				}
			}
			if (msg.type === "http_response_stream_end") {
				const streamPending = scopeWorker.pending.get(
					`stream:${msg.id}`,
				) as unknown as
					| { _streamController?: ReadableStreamDefaultController }
					| undefined;
				if (streamPending?._streamController) {
					try {
						streamPending._streamController.close();
					} catch {}
				}
				scopeWorker.pending.delete(`stream:${msg.id}`);
			}

			if (msg.type === "sse_event") {
				const { projectId, event: evt } = msg;
				// The emitting worker IS the lens: this worker serves `pluginName`,
				// so every event it emits belongs to the (projectId, pluginName)
				// lens. seqId + ring buffer are per-lens, and only clients viewing
				// THIS lens receive it — a product-lens viewer never sees the dev
				// lens's tree, and vice versa.
				const key = lensKey(projectId, pluginName);
				const seqId = nextSseSeqId(key);
				const data = JSON.stringify(evt);
				bufferSseEvent(key, seqId, data);
				const sseMessage = sseEncoder.encode(`id: ${seqId}\ndata: ${data}\n\n`);
				for (const client of sseClients) {
					if (client.projectId === projectId && client.scope === pluginName) {
						try {
							client.controller.enqueue(sseMessage);
						} catch {
							sseClients.delete(client);
						}
					}
				}
			}
		};
	}

	async function startWorkerForPlugin(plugin: RegisteredPlugin): Promise<void> {
		// Derive worker identity + module/data paths from the plugin. Computed
		// here (outside the Promise body) so `resolve` still refers to node:path
		// — inside `new Promise` it's shadowed by the promise's resolver.
		const scopeName = workerKeyForPlugin(plugin);
		const pluginRuntimePath = plugin.runtime
			? resolve(plugin.pluginRoot, plugin.runtime)
			: undefined;
		const pluginDataRoot = effectiveDataRoot(plugin);
		return new Promise((resolve, reject) => {
			const worker = new Worker(
				new URL("./runtime/scope-worker.ts", import.meta.url).href,
			);

			const scopeWorker: ScopeWorker = {
				worker,
				ready: false,
				pending: new Map(),
			};

			// Tracks whether init succeeded (resolve called). Used by onerror
			// to distinguish init-phase crashes from runtime crashes.
			let initResolved = false;

			// Init timeout — guards against hung `runtime.ts` top-level await.
			// Without this, a blocking plugin module hangs `createDaemon()` forever:
			// no log, no 503, no diagnostic — operators see an idle daemon with
			// no signal that anything is wrong.
			let initTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
				() => {
					initTimer = undefined;
					console.error(
						`[daemon] Worker "${scopeName}" init timed out after ${WORKER_INIT_TIMEOUT_MS}ms — terminating`,
					);
					try {
						worker.terminate();
					} catch {}
					// FIX R8-A#9c: remove dead entry from workers map.
					workers.delete(scopeName);
					reject(
						new Error(
							`Worker init timed out: ${scopeName} (>${WORKER_INIT_TIMEOUT_MS}ms)`,
						),
					);
				},
				WORKER_INIT_TIMEOUT_MS,
			);

			// Handle worker crash — reject pending requests + restart (if post-init).
			worker.onerror = (event: ErrorEvent) => {
				console.error(`[daemon] Worker "${scopeName}" crashed:`, event.message);
				scopeWorker.ready = false;
				if (initTimer) {
					clearTimeout(initTimer);
					initTimer = undefined;
				}
				// FIX R8-A#9c: remove dead entry from workers map.
				workers.delete(scopeName);
				// Reject pending HTTP requests + close zombie stream controllers
				for (const [, pending] of scopeWorker.pending) {
					const streamCtrl = (
						pending as unknown as {
							_streamController?: ReadableStreamDefaultController;
						}
					)._streamController;
					if (streamCtrl) {
						try {
							streamCtrl.error(new Error(`Worker "${scopeName}" crashed`));
						} catch {}
					} else {
						pending.reject(
							new Error(`Worker "${scopeName}" crashed: ${event.message}`),
						);
					}
				}
				scopeWorker.pending.clear();

				if (!initResolved) {
					// Init-phase crash: reject the init promise so createDaemon
					// doesn't hang. FIX R8-A#1: without reject(), the cleared
					// initTimer means no timeout fires → permanent hang.
					// Don't schedule restart — daemon boot failed; the restart
					// path's .catch handler manages its own retry chain.
					reject(
						new Error(`Worker "${scopeName}" crashed: ${event.message}`),
					);
				} else {
					// Runtime crash (worker was healthy): schedule restart with
					// exponential backoff + circuit-break.
					scheduleWorkerRestart(
						plugin,
						`crash: ${event.message || "unknown"}`,
					);
				}
			};

			// Temporary handler for init sequence
			worker.onmessage = (event: MessageEvent) => {
				const msg = event.data;
				if (msg.type === "loaded") {
					worker.postMessage({
						type: "init",
						dataDir,
						globalConfigPath,
						// Projects THIS worker serves. A global (matrix) worker is told
						// about ALL projects — it serves every project's dev lens. A
						// project-scoped worker is told only its own project. The two
						// lenses live in separate dataRoots (`plugin/matrix/<id>/` vs
						// `plugin/<own>/<id>/`), so each worker resumes only its own
						// tree — no double-resume despite matrix knowing every project.
						projects: projectsForPlugin(plugin).map((p) => ({
							id: p.id,
							name: p.name,
							path: p.path,
						})),
						pluginRuntimePath,
						dataRoot: pluginDataRoot,
						globalContext,
					});
				}
				if (msg.type === "ready") {
					if (initTimer) {
						clearTimeout(initTimer);
						initTimer = undefined;
					}
					initResolved = true;
					scopeWorker.ready = true;
					getRestartState(scopeName).lastReadyAt = Date.now();
					// Pass the plugin NAME (the lens/scope), not the worker key, so
					// the sse_event relay can tag events with the (projectId, scope)
					// lens the viewing UI subscribes to.
					setupWorkerMessageHandler(plugin.name, scopeWorker);
					resolve();
				}
				if (msg.type === "error") {
					if (initTimer) {
						clearTimeout(initTimer);
						initTimer = undefined;
					}
					// FIX R8-A#9a: terminate the worker thread. Without this, the
					// worker stays alive consuming resources after posting "error".
					try {
						worker.terminate();
					} catch {}
					// FIX R8-A#9c: remove dead entry from workers map.
					workers.delete(scopeName);
					reject(
						new Error(`Worker "${scopeName}" init failed: ${msg.message}`),
					);
				}
			};

			workers.set(scopeName, scopeWorker);
		});
	}

	async function forwardToWorker(
		scopeName: string,
		request: Request,
	): Promise<Response> {
		const sw = workers.get(scopeName);
		if (!sw?.ready) {
			return new Response(
				JSON.stringify({ error: `Worker "${scopeName}" not ready` }),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}

		const id = ulid();
		const body =
			request.method !== "GET" && request.method !== "HEAD"
				? await request.text()
				: undefined;

		const headers: Record<string, string> = {};
		request.headers.forEach((v: string, k: string) => {
			headers[k] = v;
		});

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				sw.pending.delete(id);
				resolve(
					new Response(JSON.stringify({ error: "Worker timeout" }), {
						status: 504,
						headers: { "content-type": "application/json" },
					}),
				);
			}, 60000);

			sw.pending.set(id, {
				resolve: (resp) => {
					clearTimeout(timeout);
					// For streaming responses, body is already a ReadableStream
					const responseBody = (resp as { _isStream?: boolean })._isStream
						? (resp.body as unknown as ReadableStream)
						: resp.body;
					resolve(
						new Response(responseBody, {
							status: resp.status,
							headers: resp.headers,
						}),
					);
				},
				reject: (err) => {
					clearTimeout(timeout);
					resolve(
						new Response(JSON.stringify({ error: err.message }), {
							status: 500,
							headers: { "content-type": "application/json" },
						}),
					);
				},
			});

			sw.worker.postMessage({
				type: "http_request",
				id,
				method: request.method,
				url: request.url,
				headers,
				body,
			});
		});
	}

	const pm = new ProjectManager(dataDir);
	await pm.load();

	// ── Global context — daemon-computed facts, not user config ──
	// Exposed to workers (init message) and HTTP clients (GET /global-context).
	// Plugins read installRoot/gitHash and form their own opinions (e.g., matrix's
	// production-mode semantic). Daemon stays opinion-free.
	// gitHash is derived from the installRoot's own .git (NOT from the daemon's
	// build-time GIT_HASH). This is what plugins need: "does the install location
	// have git history?" — a property of the path, not of the running binary.
	const binaryPath = realpathSync(fileURLToPath(import.meta.url));
	const computedInstallRoot =
		opts.installRoot ?? resolve(join(binaryPath, "..", ".."));
	function readGitHashAt(dir: string): string | null {
		try {
			const result = Bun.spawnSync({
				cmd: ["git", "rev-parse", "--short", "HEAD"],
				cwd: dir,
				stdout: "pipe",
				stderr: "pipe",
			});
			if (result.exitCode === 0) {
				const hash = new TextDecoder().decode(result.stdout).trim();
				return hash.length > 0 ? hash : null;
			}
		} catch {
			// git not available / not a git repo
		}
		return null;
	}
	const globalContext = {
		installRoot: computedInstallRoot,
		gitHash: readGitHashAt(computedInstallRoot),
		version: VERSION,
	};

	// ── Auto-register matrix (fresh install bootstrap) ──
	// Must run BEFORE plugin discovery so the just-registered project is seen
	// by the discovery loop (otherwise auto-register's effect only takes hold
	// on the NEXT daemon start — two-startup bug).
	if (opts.autoRegisterSelf !== false) {
		const { installRoot } = globalContext;
		if (
			existsSync(join(installRoot, ".mxd")) &&
			!pm.list().some((p) => resolve(p.path) === installRoot)
		) {
			try {
				await pm.init(installRoot);
				console.log(`[daemon] Auto-registered: ${installRoot}`);
			} catch (e) {
				console.warn("[daemon] Auto-registration failed:", e);
			}
		}
	}

	// ── Discover plugins (from all registered projects — now includes matrix if auto-registered) ──

	const registeredPlugins: RegisteredPlugin[] = [];

	for (const project of pm.list()) {
		const pluginDir = join(project.path, ".mxd", "plugin");
		const pluginIndex = join(pluginDir, "index.ts");
		if (!existsSync(pluginIndex)) continue;
		let manifest: PluginManifest;
		try {
			const mod = await import(pluginIndex);
			manifest = (mod.default ?? mod) as PluginManifest;
		} catch (e) {
			// Import failure is recoverable — the plugin is broken, the daemon
			// continues without it. Other plugins may still work.
			console.warn(`[daemon] Failed to load plugin from ${project.name}:`, e);
			continue;
		}
		// Malformed dataRoot is NOT recoverable — failing here is the point.
		// An attacker-controlled manifest with `dataRoot: "@/../etc"` must not
		// silently be skipped, or the security invariant degrades to "first
		// legitimate plugin wins, malicious ones still run alongside".
		validatePluginManifest(manifest);
		registeredPlugins.push({
			...manifest,
			pluginRoot: pluginDir,
			projectId: project.id,
			resolvedWebPath: manifest.web
				? resolve(pluginDir, manifest.web)
				: undefined,
		});
	}

	// Check for dataRoot collisions — two plugins writing to the same directory.
	// Runs after per-manifest validation so the inputs here are already canonical.
	const collision = checkDataRootCollisions(registeredPlugins);
	if (collision) {
		throw new Error(collision);
	}

	// ── Project ↔ plugin routing (ADDITIVE — dual lenses, never exclusive) ──
	//
	// A project is served by EVERY plugin whose scope applies to it: all global
	// plugins (matrix — the dev lens) PLUS the project-scoped plugin it ships, if
	// any (its product lens). Shipping a plugin ADDS a lens; it NEVER removes the
	// matrix dev lens. The `<scope>:<project>` address exists precisely because a
	// project can have more than one lens. Do NOT collapse this to single-owner.

	/**
	 * Every plugin serving `projectId`: all global plugins ∪ the project's own
	 * `scope:"project"` plugin (if it ships one). GLOBALS-FIRST so a project that
	 * ships its own plugin DEFAULTS to the matrix dev lens, with its product lens
	 * offered (one click) in the selector. Dev-first is the additive-consistent
	 * default: matrix is the foundation lens every project always has; the
	 * product lens is the ADDITION. Defaulting to product would make first-load
	 * byte-identical to the (reverted) exclusive model and hide the addition.
	 * Used for DELETE fan-out + the shell scope selector.
	 */
	function scopesForProject(projectId: string): RegisteredPlugin[] {
		const globals = registeredPlugins.filter((p) => p.scope === "global");
		const own = registeredPlugins.find(
			(p) => p.scope === "project" && p.projectId === projectId,
		);
		return own ? [...globals, own] : globals;
	}

	/**
	 * Projects this worker serves. A global plugin serves ALL projects (it is
	 * every project's dev lens — it MUST know every project to resume + build
	 * scope opts). A project-scoped plugin serves only its own project. No
	 * double-resume: the two lenses live in distinct dataRoots, so each worker
	 * only ever resumes the tree under its own dataRoot.
	 */
	function projectsForPlugin(plugin: RegisteredPlugin) {
		return plugin.scope === "global"
			? pm.list()
			: pm.list().filter((p) => p.id === plugin.projectId);
	}

	/** First global plugin with a ready worker (daemon-level, project-agnostic). */
	function firstGlobalWorkerKey(): string | undefined {
		return registeredPlugins.find(
			(p) => p.scope === "global" && workers.has(p.name),
		)?.name;
	}

	/** Name of the first global plugin (the default SSE lens when a client
	 * doesn't specify `scope`). Name only — readiness is checked separately. */
	function firstGlobalPluginName(): string | undefined {
		return registeredPlugins.find((p) => p.scope === "global")?.name;
	}

	/**
	 * The ready worker key serving the (projectId, scope) lens — used to fetch
	 * the VIEWED lens's initial tree/clarifications for an SSE stream. `scope` is
	 * a plugin NAME: a global named `scope` serves any project; a project-scoped
	 * plugin named `scope` serves only the project that ships it. Returns
	 * undefined if no such plugin or its worker isn't ready.
	 */
	function workerKeyForProjectScope(
		projectId: string,
		scope: string,
	): string | undefined {
		const plugin = registeredPlugins.find(
			(p) =>
				p.name === scope && (p.scope === "global" || p.projectId === projectId),
		);
		if (!plugin) return undefined;
		const key = workerKeyForPlugin(plugin);
		return workers.has(key) ? key : undefined;
	}

	// ── Run onProjectInit hooks (4-step flow, step 3+4) ──
	// For each plugin, run its hook on all projects in its scope.
	// Plugins own their own "should I skip this project?" logic — daemon passes
	// globalContext so plugins can inspect installRoot/gitHash and decide.
	for (const plugin of registeredPlugins) {
		if (!plugin.onProjectInit) continue;
		// A global plugin (matrix) scaffolds EVERY project's dev lens (memory.md,
		// hooks); a project-scoped plugin inits only its own project. Same set as
		// the worker's project list — additive, not exclusive.
		const targetProjects = projectsForPlugin(plugin);
		for (const project of targetProjects) {
			try {
				await plugin.onProjectInit(project.path, {
					isNew: !existsSync(join(project.path, ".git")),
					globalContext,
				});
			} catch (e) {
				console.warn(
					`[daemon] onProjectInit failed for ${plugin.name} on ${project.name}:`,
					e,
				);
			}
		}
	}

	// ── Build web assets (React vendor + shell + plugins) ──
	const { buildWebAssets, generateIndexHTML, generateBuildErrorHTML } =
		await import("./web-builder.ts");
	const buildDir = join(dataDir, "build");
	// Stable regardless of daemon CWD — resolves to the repo root (parent of `src/`).
	// Previously `resolve(".")` made the build silently broken whenever the daemon
	// was launched from anywhere other than the repo root (e.g. `bun src/daemon.ts`
	// from `/tmp`). Surfacing as H1/H2 in the web-build audit.
	const projectRoot = new URL("..", import.meta.url).pathname;
	const shellEntry = new URL("../web/main.tsx", import.meta.url).pathname;
	const shellCssPath = new URL("../web/styles.css", import.meta.url).pathname;

	const pluginBuildEntries = registeredPlugins
		.filter((p) => p.resolvedWebPath)
		.map((p) => ({
			name: p.name,
			scope: p.scope,
			webEntry: p.resolvedWebPath!,
			cssPath: existsSync(join(p.pluginRoot, "web", "style.css"))
				? join(p.pluginRoot, "web", "style.css")
				: undefined,
		}));

	let webBuild: Awaited<ReturnType<typeof buildWebAssets>> | null = null;
	let indexHTML: string;
	try {
		webBuild = await buildWebAssets({
			buildDir,
			shellEntry,
			plugins: pluginBuildEntries,
			shellCssPath,
			projectRoot,
			minify: process.env.NODE_ENV === "production",
		});
		indexHTML = generateIndexHTML(webBuild);
	} catch (e) {
		console.error("[daemon] Web build failed:", e);
		indexHTML = generateBuildErrorHTML(e);
	}

	// Start a worker for EVERY plugin — global AND project-scoped. Each worker is
	// keyed via workerKeyForPlugin (global by name, project by `<projectId>:<name>`);
	// startWorkerForPlugin derives the runtime module path, dataRoot, and its
	// served-project subset from the plugin itself.
	for (const plugin of registeredPlugins) {
		await startWorkerForPlugin(plugin);
	}

	// ── Bootstrap auth ──
	// Auth is ALWAYS on (Audit R7 P1.3). Every daemon boot initializes
	// `auth.json` with a jwtSecret + secretVersion if absent; the "no
	// secret yet" / "auth-disabled" middleware fallback no longer exists.
	// An unauthenticated client cannot observe or mutate any protected
	// endpoint regardless of installation state.
	const authPath = join(dataDir, "auth.json");
	const { createdSecret } = await ensureAuthInitialized(authPath);
	if (createdSecret) {
		console.log(
			"[auth] Initialized auth.json with a fresh jwtSecret. " +
				"Run `mxd auth <public_key>` to authenticate a browser session.",
		);
	}

	// ── Hono app with routes ──

	const app = new Hono();

	// Auth middleware.
	//
	// Paths skipped: SPA root (served anonymously so the login page can
	// load), compiled shell/vendor bundles, and `/auth/status` (the only
	// endpoint that must work pre-auth so the login page can render).
	// Previously `/auth/*` was prefix-matched — any future worker route
	// under `/auth/*` would have been publicly reachable (Audit J H1).
	// `/auth/logout` was previously on this list — removed so an anonymous
	// caller can no longer trigger a secretVersion bump (Audit R7 P1.1).
	// `/auth/status` stays anonymous — login page must read it before
	// it has a token. `/` and `/<projectId>/...` are frontend paths
	// handled by `isFrontendPath` below.
	const SKIP_EXACT = new Set(["/auth/status"]);

	// Frontend paths — shell HTML served anonymously so the SPA can load +
	// parse the URL + render. After Task Y, tasks live at `/<projectId>/...`
	// path-routed URLs; browser refresh on such a URL must reach the shell.
	// Browsers don't include the `Authorization` header on navigation, so
	// any path that should serve HTML on direct hit must skip auth — same
	// posture as `/`. The shell itself is auth-content-free; every API
	// call the shell issues still carries the session token through
	// `authFetch` and is gated by this same middleware on the API side.
	//
	// Predicate: `/` exact, OR first path segment is a *currently
	// registered* project id. Backend route names ("api", "auth",
	// "projects", "health", etc.) never collide because project ids are
	// ULIDs (26 chars, base32). Stale / deleted / never-existed first
	// segments fall through to a clean 404 (via the `app.get("*")` handler
	// below) instead of pretending to load a broken SPA.
	const isFrontendPath = (path: string): boolean => {
		if (path === "/") return true;
		const firstSeg = path.match(/^\/([^/]+)/)?.[1];
		return firstSeg != null && pm.has(firstSeg);
	};

	app.use("*", async (c, next) => {
		const path = c.req.path;
		const skipAuth =
			SKIP_EXACT.has(path) ||
			path.startsWith("/vendor/") ||
			path.startsWith("/app/") ||
			// Non-GET frontend-shaped paths (POST/PATCH to `/<projectId>/...`)
			// stay auth-gated — those don't exist as legitimate SPA paths,
			// and a 401 is more honest than accidental HTML.
			(c.req.method === "GET" && isFrontendPath(path));

		if (!skipAuth) {
			// Auth is ALWAYS on after Audit R7 P1.3 — no `hasJwtSecret`
			// branch that silently serves unauthenticated when auth.json is
			// missing/empty/corrupt. ensureAuthInitialized ran at boot; if
			// auth.json later turns corrupt, readAuthData throws → this
			// handler returns 500. Never 200-as-anonymous.
			const token = extractBearerToken(
				c.req.header("authorization"),
				c.req.query("token"),
			);
			// `/events` accepts only stream tokens so the long-lived
			// session token never rides in the URL.
			const allowed =
				path === "/events"
					? (["stream"] as const)
					: (["cli", "session"] as const);
			if (!token || !(await verifyJWT(authPath, token, allowed))) {
				return c.json({ error: "Unauthorized" }, 401);
			}
		}
		await next();
	});

	// Root page — generated HTML with importmap. `no-cache` forces the
	// browser to revalidate every time: the HTML carries content-hashed
	// asset URLs, which change whenever any asset's content changes. Stale
	// HTML would reference a stale (now-absent) hashed URL and fail to load.
	// Immutable-cached assets live at `/vendor/*` and `/app/*` — they handle
	// the actual cache win.
	const HTML_CACHE_CONTROL = "no-cache, must-revalidate";
	app.get("/", (c) => {
		c.header("cache-control", HTML_CACHE_CONTROL);
		return c.html(indexHTML);
	});

	// Health — daemon-owned, not worker-forwarded
	app.get("/health", async (c) => {
		if (c.req.query("check_model")) {
			// Forward to a global worker for full health check (Anthropic API
			// ping). Project-agnostic — any global worker can answer.
			const workerName = firstGlobalWorkerKey();
			if (workerName) {
				return forwardToWorker(workerName, c.req.raw);
			}
		}
		return c.json({ status: "ok", version: VERSION });
	});

	// Global context — daemon-computed facts, not user config.
	// Plugins (both runtime and web) read this to form their own opinions.
	// Plugin-agnostic: installRoot, gitHash (presence), version.
	app.get("/global-context", async (c) => {
		return c.json(globalContext);
	});

	// Auth routes
	//
	// `/auth/status` is on SKIP_EXACT so the login page can render before
	// the browser has a token. After P1.3 auth is ALWAYS on, so `enabled`
	// is always `true` — the field stays in the response shape for
	// backward compatibility with older browser bundles still reading it.
	app.get("/auth/status", async (c) => {
		const token = extractBearerToken(
			c.req.header("authorization"),
			c.req.query("token"),
		);
		const authenticated = token
			? (await verifyJWT(authPath, token, ["cli", "session"])) !== null
			: false;
		return c.json({ enabled: true, authenticated });
	});

	/**
	 * Logout-all. Bumps `secretVersion` in auth.json → every outstanding
	 * token (session, CLI, stream) becomes invalid on next verify.
	 * Requires a valid session/CLI token — passes the auth middleware
	 * before landing here, then hard-rotates the version.
	 *
	 * Not on SKIP_EXACT (Audit R7 P1.1): an anonymous caller is rejected
	 * by the middleware with 401 before reaching this handler.
	 */
	app.post("/auth/logout", async (c) => {
		const newVersion = await bumpSecretVersion(authPath);
		return c.json({ ok: true, secretVersion: newVersion });
	});

	/**
	 * Issue a short-lived (5min) stream token for SSE. Requires a valid
	 * session/CLI token. Browser swaps its long-lived session token for a
	 * stream token each time it (re)opens `/events`, so the 30d token
	 * never appears in URLs / proxy logs / browser history.
	 */
	app.post("/auth/stream-token", async (c) => {
		const token = await signStreamToken(authPath);
		return c.json({ token });
	});

	// ── Project CRUD (daemon-owned) ──

	app.get("/projects", (c) => {
		const projects = pm.list().map((p) => ({
			...p,
			pathExists: pm.checkPathExists(p.id),
		}));
		return c.json(projects);
	});

	app.post("/projects", async (c) => {
		try {
			const body = await c.req.json<{ path: string }>();
			if (!body.path) {
				return c.json({ error: "path is required" }, 400);
			}
			const project = await pm.init(body.path);

			// Call onProjectInit for all global plugins. If any plugin throws
			// (e.g. matrix's git init hits a broken worktree, worktree mkdir
			// hits ENOTDIR), the project we just registered is a zombie —
			// present in projects.json, visible in `mxd list`, but without
			// the filesystem state the plugin promised to create. Roll back
			// the registration before rethrowing so the user sees a clean
			// 409 instead of a partially-initialised project they can't
			// remove via CLI.
			try {
				for (const plugin of registeredPlugins.filter(
					(p) => p.scope === "global",
				)) {
					if (plugin.onProjectInit) {
						await plugin.onProjectInit(body.path, {
							isNew: !existsSync(join(body.path, ".git")),
							globalContext,
						});
					}
				}
			} catch (initErr) {
				// Compensating rollback — on-disk state is the plugin's
				// problem (best-effort; partial fs writes may survive), but
				// the registry MUST be consistent with "init succeeded".
				await pm.delete(project.id).catch(() => {
					// If rollback itself fails we've hit double trouble;
					// the original init error is more actionable than the
					// delete error, so swallow the latter.
				});
				throw initErr;
			}

			// tasks/ and debug/ directories are NOT eagerly created here.
			// EventStore's constructor and TaskTracker.save() mkdir on demand,
			// respecting the owning plugin's dataRoot. Creating them eagerly at
			// `projects/<id>/` hardcoded Matrix's "@" layout — wrong for any
			// plugin with a nested dataRoot.
			syncProjects();
			return c.json(project, 201);
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 409);
		}
	});

	app.get("/projects/:id", (c) => {
		const projectId = c.req.param("id");
		const project = pm.get(projectId);
		if (!project) {
			return c.json({ error: "Project not found" }, 404);
		}
		return c.json({
			...project,
			pathExists: pm.checkPathExists(project.id),
		});
	});

	app.delete("/projects/:id", async (c) => {
		const projectId = c.req.param("id");
		try {
			// Stop agents first — FAN OUT to EVERY scope serving this project (its
			// own project-scoped plugin if any, AND every global/matrix lens). A
			// running agent in ANY lens must be stopped before the project's data
			// is removed; stopping only one lens would leave the other lens's
			// agent writing into a deleted project.
			for (const plugin of scopesForProject(projectId)) {
				const key = workerKeyForPlugin(plugin);
				if (!workers.has(key)) continue;
				await forwardToWorker(
					key,
					new Request(`http://localhost/projects/${projectId}/stop`, {
						method: "POST",
					}),
				);
			}
			await pm.delete(projectId);
			syncToWorkers("project_deleted", { projectId });
			syncProjects();
			// Clean up SSE ring buffers for the deleted project — ACROSS EVERY
			// lens (keys are `${projectId}\u0000${scope}`), since the project may
			// have had a dev lens AND a product lens, each with its own buffer.
			const lensPrefix = `${projectId}\u0000`;
			for (const k of [...sseSeqCounters.keys()]) {
				if (k.startsWith(lensPrefix)) sseSeqCounters.delete(k);
			}
			for (const k of [...sseEventBuffers.keys()]) {
				if (k.startsWith(lensPrefix)) sseEventBuffers.delete(k);
			}
			return c.json({ ok: true });
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			return c.json({ error: message }, 404);
		}
	});

	app.patch("/projects/:id", async (c) => {
		const projectId = c.req.param("id");
		try {
			const body = await c.req.json<{ path?: string; name?: string }>();
			if (!body.path && !body.name) {
				return c.json(
					{ error: "At least one of path or name is required" },
					400,
				);
			}
			const updated = await pm.updateProject(projectId, body);
			syncProjects();
			return c.json({
				...updated,
				pathExists: pm.checkPathExists(updated.id),
			});
		} catch (e) {
			const message = e instanceof Error ? e.message : "Unknown error";
			const status = message.includes("not found") ? 404 : 400;
			return c.json({ error: message }, status);
		}
	});

	// Built web assets — vendor (React ESM) + app (shell + plugins)
	// path.sep-terminator prevents the off-by-one prefix bug where
	//   /Users/u/.mxd/build2/foo starts with /Users/u/.mxd/build
	const buildDirPrefix = resolve(buildDir) + sep;
	const isInsideBuildDir = (filePath: string): boolean => {
		const abs = resolve(filePath);
		return abs === resolve(buildDir) || abs.startsWith(buildDirPrefix);
	};
	// Built assets under /vendor/ and /app/ are content-hashed (see
	// web-builder.ts). Their URLs change whenever content changes, so we can
	// tell browsers to cache them for a year and never revalidate —
	// `public, max-age=31536000, immutable`. The HTML that references them
	// is served with `no-cache` (see `/` and the SPA fallback), so a new
	// build always reaches the browser's index fetch, which then learns the
	// new hashed asset URLs.
	const IMMUTABLE_ASSET_CACHE = "public, max-age=31536000, immutable";

	app.get("/vendor/*", async (c) => {
		const relativePath = c.req.path.slice("/vendor/".length);
		const filePath = join(buildDir, "vendor", relativePath);
		if (!isInsideBuildDir(filePath)) return c.json({ error: "Forbidden" }, 403);
		const file = Bun.file(filePath);
		if (!(await file.exists())) return c.json({ error: "Not found" }, 404);
		return new Response(file, {
			headers: {
				"content-type": "application/javascript",
				"cache-control": IMMUTABLE_ASSET_CACHE,
			},
		});
	});

	app.get("/app/*", async (c) => {
		const relativePath = c.req.path.slice("/app/".length);
		const filePath = join(buildDir, "app", relativePath);
		if (!isInsideBuildDir(filePath)) return c.json({ error: "Forbidden" }, 403);
		const file = Bun.file(filePath);
		if (!(await file.exists())) return c.json({ error: "Not found" }, 404);
		return new Response(file, {
			headers: { "cache-control": IMMUTABLE_ASSET_CACHE },
		});
	});

	// Plugins — includes buildError so the UI can explicitly render "Plugin failed
	// to build" instead of hanging on "Loading plugin…".
	app.get("/plugins", (c) => {
		return c.json(
			registeredPlugins.map((p) => {
				const output = webBuild?.pluginOutputs.get(p.name);
				return {
					name: p.name,
					scope: p.scope,
					webComponentPath: output?.jsPath,
					cssPath: output?.cssPath,
					buildError: output?.buildError,
					projectId: p.projectId,
				};
			}),
		);
	});

	// Global config
	// GET: every authGroup credential is masked. A valid token can no
	// longer be traded for raw API keys. PATCH still accepts raw values
	// (that's how you rotate a key).
	app.get("/config/global", (c) => {
		return c.json(maskConfig(globalConfig));
	});

	app.patch("/config/global", async (c) => {
		const partial = await c.req.json<Partial<MatrixConfig>>();
		// Reject null/undefined for any top-level field. The global config is a
		// COMPLETE MatrixConfig — it has no optional fields, so deleting one
		// writes an incomplete config that throws on next boot. Pre-fix, that
		// throw was silently swallowed into an empty DEFAULT_CONFIG, wiping
		// every authGroup/credential on restart. Per-field deletion of an auth
		// group still goes through `{ authGroups: { name: ... } }` (the object
		// value is non-null, so it's not rejected here).
		const nulledFields = Object.entries(partial)
			.filter(([, v]) => v === null || v === undefined)
			.map(([k]) => k);
		if (nulledFields.length > 0) {
			return c.json(
				{
					error:
						`Cannot delete required global config field(s): ${nulledFields.join(", ")}. ` +
						"Global config fields are all required — set a value instead of null.",
				},
				400,
			);
		}
		const next = { ...globalConfig } as MatrixConfig;
		for (const [k, v] of Object.entries(partial)) {
			if (k === "authGroups" && v && typeof v === "object") {
				// Special-case: preserve secrets that came back as masked echoes
				next.authGroups = mergeAuthGroups(
					globalConfig.authGroups,
					v as Record<string, AuthGroup>,
				);
			} else {
				(next as unknown as Record<string, unknown>)[k] = v;
			}
		}
		globalConfig = next;
		await saveGlobalConfig(globalConfig, globalConfigPath);
		syncConfig();
		// Re-mask on the way back so the client never sees plaintext.
		return c.json(maskConfig(globalConfig));
	});

	// ── Project config (daemon-owned: per-project settings) ──

	// Helper: resolve project or 404
	function getProjectOrNull(projectId: string) {
		return pm.get(projectId) ?? null;
	}

	app.get("/projects/:id/config/repo", async (c) => {
		const project = getProjectOrNull(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const { loadProjectRepoConfig } = await import("./config.ts");
		const cfg = await loadProjectRepoConfig(project.path);
		return c.json(cfg);
	});

	app.patch("/projects/:id/config/repo", async (c) => {
		const project = getProjectOrNull(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const { loadProjectRepoConfig, saveProjectRepoConfig } = await import(
			"./config.ts"
		);
		const partial = await c.req.json<Partial<MatrixConfig>>();
		const rejection = rejectCredentialFields(partial);
		if (rejection) return c.json({ error: rejection }, 400);
		const existing = await loadProjectRepoConfig(project.path);
		const merged = { ...existing };
		for (const [k, v] of Object.entries(partial)) {
			if (v === null || v === undefined) {
				delete (merged as unknown as Record<string, unknown>)[k];
			} else {
				(merged as unknown as Record<string, unknown>)[k] = v;
			}
		}
		await saveProjectRepoConfig(project.path, merged);
		return c.json(merged);
	});

	app.get("/projects/:id/config/all", async (c) => {
		const project = getProjectOrNull(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const { loadProjectRepoConfig, loadProjectLocalConfig, resolveConfig } =
			await import("./config.ts");
		const [repoConfig, localConfig] = await Promise.all([
			loadProjectRepoConfig(project.path),
			loadProjectLocalConfig(dataDir, project.id),
		]);
		const resolved = resolveConfig(globalConfig, repoConfig, localConfig);
		// Every layer is masked — project layers are TYPED as credential-free
		// (`ProjectConfig` excludes `authGroups`), but the on-disk JSON is
		// untyped and a malicious actor could have injected credentials into
		// `.mxd/config.json` or `<dataDir>/projects/<id>/config.json` by hand.
		// Masking unconditionally closes that leak (Audit R7 P1.4).
		return c.json({
			global: maskConfig(globalConfig),
			repo: maskConfig(repoConfig),
			local: maskConfig(localConfig),
			resolved: maskConfig(resolved),
		});
	});

	app.get("/projects/:id/config", async (c) => {
		const project = getProjectOrNull(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const { loadProjectLocalConfig } = await import("./config.ts");
		const cfg = await loadProjectLocalConfig(dataDir, project.id);
		return c.json(maskConfig(cfg));
	});

	app.patch("/projects/:id/config", async (c) => {
		const project = getProjectOrNull(c.req.param("id"));
		if (!project) return c.json({ error: "Project not found" }, 404);
		const { loadProjectLocalConfig, saveProjectLocalConfig } = await import(
			"./config.ts"
		);
		const partial = await c.req.json<Partial<MatrixConfig>>();
		const rejection = rejectCredentialFields(partial);
		if (rejection) return c.json({ error: rejection }, 400);
		const existing = await loadProjectLocalConfig(dataDir, project.id);
		const merged = { ...existing };
		for (const [k, v] of Object.entries(partial)) {
			if (v === null || v === undefined) {
				delete (merged as unknown as Record<string, unknown>)[k];
			} else {
				(merged as unknown as Record<string, unknown>)[k] = v;
			}
		}
		await saveProjectLocalConfig(dataDir, project.id, merged);
		return c.json(merged);
	});

	// SSE
	app.get("/events", async (c) => {
		const projectId = c.req.query("projectId");
		if (!projectId) {
			return c.text("projectId required", 400);
		}
		// The lens this stream subscribes to. `scope` is a plugin NAME (the URL
		// `<pluginScope>` segment). Defaults to the first global plugin (matrix)
		// so a scope-less client gets the dev lens — backward compatible with
		// single-lens projects. A project's product lens MUST pass `scope=<name>`.
		// Falls back to "" when no plugin is registered at all (e.g. an auth-only
		// test daemon): the stream still opens (auth is what matters there), it
		// just carries no lens worker → no initial tree, same as the old behavior.
		const scope = c.req.query("scope") ?? firstGlobalPluginName() ?? "";
		const lens = lensKey(projectId, scope);

		const request = c.req.raw;
		// Capture the token used to authorize this stream so we can
		// periodically re-verify it. Short-lived "stream" tokens expire
		// in 5min; re-verifying at every heartbeat also picks up global
		// revocation (logout-all bumps secretVersion).
		const streamToken = extractBearerToken(
			c.req.header("authorization"),
			c.req.query("token"),
		);

		// EventSource sends Last-Event-ID on reconnect
		const lastEventIdHeader = request.headers.get("Last-Event-ID");
		const lastSeqId = lastEventIdHeader
			? Number.parseInt(lastEventIdHeader, 10)
			: null;

		const stream = new ReadableStream({
			async start(controller) {
				const client: ShellSSEClient = { controller, projectId, scope };
				sseClients.add(client);

				let catchUpDone = false;

				// If reconnecting with Last-Event-ID, try ring buffer catch-up
				// (per-lens: seqIds belong to THIS (projectId, scope) stream).
				if (lastSeqId != null && !Number.isNaN(lastSeqId)) {
					const missed = getEventsSince(lens, lastSeqId);
					if (missed !== null) {
						catchUpDone = true;
						for (const entry of missed) {
							try {
								controller.enqueue(
									sseEncoder.encode(
										`id: ${entry.seqId}\ndata: ${entry.data}\n\n`,
									),
								);
							} catch {
								catchUpDone = false;
								break;
							}
						}
					}
				}

				// If no Last-Event-ID or catch-up failed (gap too large),
				// send full initial state — from the worker serving THIS lens
				// (the viewed scope), so a product-lens stream gets the product
				// tree and a dev-lens stream gets the matrix tree.
				if (!catchUpDone) {
					try {
						const workerName = workerKeyForProjectScope(projectId, scope);
						const treeResp = workerName
							? await forwardToWorker(
									workerName,
									new Request(`http://localhost/projects/${projectId}/tasks`, {
										headers: request.headers,
									}),
								)
							: null;
						if (treeResp?.ok) {
							const treeData = await treeResp.json();
							const msg = sseEncoder.encode(
								`data: ${JSON.stringify({ type: "tree_updated", ...treeData })}\n\n`,
							);
							controller.enqueue(msg);
						}
						// Send pending clarifications (worker has them)
						const clarifyResp = workerName
							? await forwardToWorker(
									workerName,
									new Request(
										`http://localhost/projects/${projectId}/clarifications`,
										{
											headers: request.headers,
										},
									),
								)
							: null;
						if (clarifyResp?.ok) {
							const result = await clarifyResp.json();
							const clarifications = Array.isArray(result)
								? result
								: result?.clarifications;
							if (Array.isArray(clarifications) && clarifications.length > 0) {
								controller.enqueue(
									sseEncoder.encode(
										`data: ${JSON.stringify({ type: "pending_clarifications", projectId, clarifications })}\n\n`,
									),
								);
							}
						}
					} catch {}
				}

				const closeStream = (reason: string) => {
					try {
						controller.enqueue(
							sseEncoder.encode(
								`event: auth_expired\ndata: ${JSON.stringify({ reason })}\n\n`,
							),
						);
						controller.close();
					} catch {
						/* already closed */
					}
					sseClients.delete(client);
				};

				const heartbeat = setInterval(async () => {
					// Re-verify the stream token on every heartbeat. Closes
					// the stream when the token has expired or been revoked
					// (logout-all rotates secretVersion → every stream token
					// becomes invalid on next verify). Frontend's watchdog
					// then reconnects, requesting a fresh stream token.
					// Auth is always on (P1.3), so this runs unconditionally.
					if (
						!streamToken ||
						!(await verifyJWT(authPath, streamToken, ["stream"]))
					) {
						clearInterval(heartbeat);
						closeStream("token_expired");
						return;
					}
					try {
						controller.enqueue(
							sseEncoder.encode(
								`data: ${JSON.stringify({ type: "heartbeat" })}\n\n`,
							),
						);
					} catch {}
				}, 15_000);

				request.signal.addEventListener("abort", () => {
					clearInterval(heartbeat);
					sseClients.delete(client);
				});
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	});

	// Restart daemon — daemon-owned (process.exit must run on main thread, not worker)
	app.post("/restart-daemon", async (c) => {
		setTimeout(async () => {
			await shutdown();
			process.exit(0);
		}, 100);
		return c.json({ restarting: true });
	});

	/**
	 * `/version` and `/stats` are declared daemon-root endpoints but the
	 * interesting data (nodeCount, per-status task counts) lives in the
	 * worker's trackers. Forward to the first ready global worker — same
	 * pattern as `/health?check_model=true`. Returns 503 if no worker is
	 * up (fresh daemon with zero plugins discovered).
	 */
	const forwardToFirstGlobalWorker = async (c: { req: { raw: Request } }) => {
		const workerName = firstGlobalWorkerKey();
		if (!workerName) {
			return new Response(
				JSON.stringify({ error: "No global plugin worker available" }),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}
		return forwardToWorker(workerName, c.req.raw);
	};
	app.get("/version", forwardToFirstGlobalWorker);
	app.get("/stats", forwardToFirstGlobalWorker);

	/**
	 * Plugin route namespace — `/api/<plugin-name>/*`.
	 *
	 * Daemon strips `/api/<plugin>` from the path and forwards the rewritten
	 * request to that plugin's worker. Plugin code registers routes as if at
	 * root (e.g., `/projects/:id/tasks`); the namespace is transparent on
	 * both sides. See `pluginApiPrefix` in plugin-url.ts for the shared helper.
	 *
	 * Unknown plugin or crashed worker → 404 / 503. No fallback to "first
	 * available global worker" — that was the old catch-all behavior and
	 * the exact thing this namespace replaces.
	 */
	app.all("/api/:plugin/*", async (c) => {
		const pluginName = c.req.param("plugin");

		// Strip the `/api/<plugin>` prefix from the URL path before forwarding.
		// The worker's Hono app has routes registered at root (e.g. `/projects/...`).
		// Strip FIRST: the projectId embedded in the stripped path
		// (`/projects/<id>/...`) is what disambiguates same-named project-scoped
		// plugins from two different projects.
		const prefix = pluginApiPrefix(pluginName);
		const url = new URL(c.req.url);
		const stripped = url.pathname.slice(prefix.length) || "/";
		url.pathname = stripped;

		// Resolve which worker serves this request:
		// - a GLOBAL plugin named `pluginName` is keyed by bare name and serves
		//   any project (matrix dev-mode) → use it directly. This is what keeps
		//   `/api/matrix/projects/<anyId>` reachable for EVERY project — the
		//   additive dev lens.
		// - otherwise the candidates are all project-scoped; the projectId in the
		//   stripped path selects the right one (keyed `<projectId>:<name>`). A
		//   lone candidate with no projectId in the path falls back to itself.
		const candidates = registeredPlugins.filter((p) => p.name === pluginName);
		if (candidates.length === 0) {
			return c.json({ error: `Plugin "${pluginName}" not found` }, 404);
		}
		let target: RegisteredPlugin | undefined = candidates.find(
			(p) => p.scope === "global",
		);
		if (!target) {
			const pid = stripped.match(/^\/projects\/([^/]+)/)?.[1];
			target = pid
				? candidates.find((p) => p.projectId === pid)
				: candidates.length === 1
					? candidates[0]
					: undefined;
		}
		const workerKey = target ? workerKeyForPlugin(target) : undefined;
		if (!workerKey || !workers.has(workerKey)) {
			return c.json({ error: `Plugin "${pluginName}" has no worker` }, 503);
		}

		// Rebuild a Request with the rewritten URL. Body must be consumed from
		// the original (c.req.raw) because `new Request(url, { ...request })`
		// does not copy the body stream by itself.
		const method = c.req.method;
		const hasBody = method !== "GET" && method !== "HEAD";
		const rewritten = new Request(url, {
			method,
			headers: c.req.raw.headers,
			body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
		});
		return forwardToWorker(workerKey, rewritten);
	});

	/**
	 * SPA fallback. After Task Y, paths look like `/<projectId>/<scope>/<rest>`
	 * and are server-visible (no longer hash-only). Any GET that didn't match
	 * a backend route above lands here. Serve the shell HTML iff the first
	 * segment is a currently registered project id; otherwise 404 cleanly so
	 * stray paths don't pretend to be SPA URLs.
	 *
	 * Deliberately GET-only — POST/PATCH/DELETE to unknown paths stay 404 so
	 * a typo'd write endpoint doesn't silently succeed with HTML.
	 *
	 * Mirrors the `isFrontendPath` predicate used by the auth middleware.
	 * Single source of truth: `pm.has(firstSeg)` — a project's existence
	 * decides both auth bypass and HTML serving.
	 */
	app.get("*", (c) => {
		const path = new URL(c.req.url).pathname;
		const firstSeg = path.match(/^\/([^/]+)/)?.[1];
		if (firstSeg == null || !pm.has(firstSeg)) return c.notFound();
		c.header("cache-control", HTML_CACHE_CONTROL);
		return c.html(indexHTML);
	});

	/**
	 * Typed sync primitive — daemon (golden) → workers (read-only).
	 * SyncMap shared between daemon + worker for type safety on both sides.
	 */
	function syncToWorkers<K extends keyof SyncMap>(
		key: K,
		data: SyncMap[K],
	): void {
		for (const [, sw] of workers) {
			if (sw.ready) {
				sw.worker.postMessage({ type: "sync", key, data });
			}
		}
	}

	function syncProjects(): void {
		// Each worker receives ONLY the projects it serves (projectsForPlugin):
		// a global (matrix) worker gets ALL projects (every dev lens); a
		// project-scoped worker gets only its own project. Per-plugin (not
		// broadcast) so a project-scoped worker is never told about projects it
		// doesn't own. `config` / `project_deleted` syncs stay broadcast
		// (harmless to non-owners).
		for (const plugin of registeredPlugins) {
			const key = workerKeyForPlugin(plugin);
			const sw = workers.get(key);
			if (!sw?.ready) continue;
			sw.worker.postMessage({
				type: "sync",
				key: "projects",
				data: projectsForPlugin(plugin).map((p) => ({
					id: p.id,
					name: p.name,
					path: p.path,
				})),
			});
		}
	}

	function syncConfig(): void {
		syncToWorkers("config", globalConfig);
	}

	// ── Shutdown ──

	async function shutdown(): Promise<void> {
		// FIX R8-A#9b: clear all pending restart timers FIRST, before touching
		// workers. Without this, a timer fires post-shutdown and spawns a
		// zombie worker on a daemon whose lock is already released.
		for (const timer of pendingRestartTimers) {
			clearTimeout(timer);
		}
		pendingRestartTimers.clear();

		for (const [name, sw] of workers) {
			// FIX R8-A#2: postMessage on a terminated Bun Worker throws
			// InvalidStateError synchronously. Without try/catch, the throw
			// skips remaining workers + releaseDataDirLock → unflushed JSONL
			// + held lock.
			try {
				sw.worker.postMessage({ type: "shutdown" });
			} catch {
				// Worker already terminated (crashed before shutdown).
				// Skip graceful-shutdown wait — go straight to terminate.
				try {
					sw.worker.terminate();
				} catch {}
				continue;
			}
			// Wait for graceful shutdown (agent stop, JSONL flush) before terminating
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => {
					console.warn(
						`[daemon] Worker "${name}" shutdown timeout — terminating`,
					);
					resolve();
				}, 5000);
				const handler = (event: MessageEvent) => {
					if (event.data.type === "shutdown_complete") {
						clearTimeout(timeout);
						sw.worker.removeEventListener("message", handler);
						resolve();
					}
				};
				sw.worker.addEventListener("message", handler);
			});
			try {
				sw.worker.terminate();
			} catch {}
		}
		workers.clear();
		// Release filesystem lock LAST — after all workers are gone, so a
		// subsequent daemon on the same dataDir can safely re-acquire it.
		releaseDataDirLock();
	}

	return {
		fetch: app.fetch as (request: Request) => Promise<Response>,
		plugins: registeredPlugins,
		shutdown,
		pm,
		globalConfig,
	};
}

// Re-export for tests
export type { RegisteredPlugin };

// ── Production entry ──

if (import.meta.main) {
	const dataDir = process.env.MXD_DATA_DIR ?? join(homedir(), ".mxd");
	let daemon: DaemonInstance;
	try {
		daemon = await createDaemon({
			dataDir,
			lockDataDir: true,
		});
	} catch (e) {
		// Most common failure mode: another daemon owns this dataDir.
		// Surface a clean error instead of a scary stack trace.
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}

	const port = daemon.globalConfig.port ?? 7433;
	// Default to loopback so a fresh install isn't LAN-reachable before
	// `mxd auth` has run. Opt-in to LAN/public exposure via MXD_BIND_HOST=0.0.0.0
	// (or a specific interface IP). Matches `ssh -L` / container conventions.
	const hostname = process.env.MXD_BIND_HOST ?? "127.0.0.1";

	// Probe /auth/status instead of /health. /auth/status is on SKIP_EXACT
	// (the auth middleware bypass list) and responds 200 with {enabled, ...}
	// even when no token is presented. /health requires auth, so when a
	// second daemon starts against an auth-enabled peer the old probe saw
	// 401 → `res.ok === false` → fell through to Bun.serve → EADDRINUSE
	// stack trace. Any 2xx/4xx response from /auth/status means "something
	// IS listening" — good enough to surface the friendly message.
	try {
		const res = await fetch(`http://localhost:${port}/auth/status`);
		if (res.status !== 0) {
			console.error(`Error: daemon already running on port ${port}`);
			await daemon.shutdown();
			process.exit(1);
		}
	} catch {}

	Bun.serve({
		fetch: daemon.fetch,
		port,
		hostname,
		idleTimeout: 255,
	});

	console.log(
		`Matrix daemon v${VERSION} (${GIT_HASH}) listening on http://${hostname}:${port}`,
	);
	if (hostname !== "127.0.0.1" && hostname !== "localhost") {
		console.log(
			"[auth] Bound non-loopback — ensure a strong auth.json secret is set.",
		);
	}

	const handleShutdown = async () => {
		console.log("Shutting down...");
		await daemon.shutdown();
		process.exit(0);
	};
	process.on("SIGTERM", handleShutdown);
	process.on("SIGINT", handleShutdown);
}
