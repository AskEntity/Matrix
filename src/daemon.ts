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
	hasJwtSecret,
	signStreamToken,
	verifyJWT,
} from "./auth.ts";
import {
	type AuthGroup,
	DEFAULT_CONFIG,
	loadGlobalConfig,
	type MatrixConfig,
	saveGlobalConfig,
} from "./config.ts";
import {
	checkDataRootCollisions,
	type PluginManifest,
	pluginApiPrefix,
	validatePluginManifest,
} from "./plugin.ts";
import { ProjectManager } from "./project-manager.ts";
import type { SyncMap } from "./runtime/worker-api.ts";
import { ulid } from "./ulid.ts";
import { GIT_HASH, VERSION } from "./version.ts";

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
	 * Eagerly initialize `auth.json` with a jwtSecret + secretVersion.
	 * Default true in production (closes the "no-secret" window between
	 * daemon boot and `mxd auth`). Tests pass `false` so they don't
	 * auto-enable auth and have to pass a token on every request.
	 */
	autoInitAuth?: boolean;
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
	const autoInitAuth = opts.autoInitAuth ?? true;

	// Load global config
	let globalConfig: MatrixConfig;
	try {
		globalConfig = await loadGlobalConfig(globalConfigPath);
	} catch {
		globalConfig = { ...DEFAULT_CONFIG };
	}

	// SSE state
	const sseClients = new Set<ShellSSEClient>();
	const sseEncoder = new TextEncoder();

	// Per-project SSE sequencing + ring buffer for Last-Event-ID catch-up
	const sseSeqCounters = new Map<string, number>();
	interface SSERingEntry {
		seqId: number;
		data: string;
	}
	const sseEventBuffers = new Map<string, SSERingEntry[]>();
	const SSE_RING_BUFFER_SIZE = 2000;

	function nextSseSeqId(projectId: string): number {
		const current = sseSeqCounters.get(projectId) ?? 0;
		const next = current + 1;
		sseSeqCounters.set(projectId, next);
		return next;
	}

	function bufferSseEvent(
		projectId: string,
		seqId: number,
		data: string,
	): void {
		let buffer = sseEventBuffers.get(projectId);
		if (!buffer) {
			buffer = [];
			sseEventBuffers.set(projectId, buffer);
		}
		buffer.push({ seqId, data });
		if (buffer.length > SSE_RING_BUFFER_SIZE) {
			buffer.splice(0, buffer.length - SSE_RING_BUFFER_SIZE);
		}
	}

	function getEventsSince(
		projectId: string,
		lastSeqId: number,
	): SSERingEntry[] | null {
		const buffer = sseEventBuffers.get(projectId);
		if (!buffer || buffer.length === 0) return null;
		const firstEntry = buffer[0];
		if (!firstEntry) return null;
		// Gap too large — can't guarantee no missed events
		if (lastSeqId < firstEntry.seqId - 1) return null;
		const idx = buffer.findIndex((e) => e.seqId > lastSeqId);
		if (idx === -1) return []; // Client is up to date
		return buffer.slice(idx);
	}

	// Worker state
	const workers = new Map<string, ScopeWorker>();

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
		scopeName: string,
		pluginRuntimePath: string | undefined,
		pluginDataRoot: string | undefined,
		reason: string,
	): void {
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

		setTimeout(() => {
			console.log(
				`[daemon] Restarting worker "${scopeName}" (attempt ${state.attempts}/${MAX_RESTARTS_BEFORE_CIRCUIT_BREAK})...`,
			);
			startWorkerForPlugin(scopeName, pluginRuntimePath, pluginDataRoot).catch(
				(e) => {
					console.error(`[daemon] Worker "${scopeName}" restart failed:`, e);
					// Restart failed (e.g. init timeout) — schedule another attempt.
					scheduleWorkerRestart(
						scopeName,
						pluginRuntimePath,
						pluginDataRoot,
						`restart error: ${e instanceof Error ? e.message : String(e)}`,
					);
				},
			);
		}, delayMs);
	}

	function setupWorkerMessageHandler(
		_scopeName: string,
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
				const seqId = nextSseSeqId(projectId);
				const data = JSON.stringify(evt);
				bufferSseEvent(projectId, seqId, data);
				const sseMessage = sseEncoder.encode(`id: ${seqId}\ndata: ${data}\n\n`);
				for (const client of sseClients) {
					if (client.projectId === projectId) {
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

	async function startWorkerForPlugin(
		scopeName: string,
		pluginRuntimePath?: string,
		pluginDataRoot?: string,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			const worker = new Worker(
				new URL("./runtime/scope-worker.ts", import.meta.url).href,
			);

			const scopeWorker: ScopeWorker = {
				worker,
				ready: false,
				pending: new Map(),
			};

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
					// Don't remove from workers map here — onerror handler below may
					// also fire; either path causes a single cleanup via the reject.
					reject(
						new Error(
							`Worker init timed out: ${scopeName} (>${WORKER_INIT_TIMEOUT_MS}ms)`,
						),
					);
				},
				WORKER_INIT_TIMEOUT_MS,
			);

			// Handle worker crash — reject all pending requests + schedule restart.
			worker.onerror = (event: ErrorEvent) => {
				console.error(`[daemon] Worker "${scopeName}" crashed:`, event.message);
				scopeWorker.ready = false;
				if (initTimer) {
					clearTimeout(initTimer);
					initTimer = undefined;
				}
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
				// Exponential backoff + circuit-break (handled by scheduleWorkerRestart).
				scheduleWorkerRestart(
					scopeName,
					pluginRuntimePath,
					pluginDataRoot,
					`crash: ${event.message || "unknown"}`,
				);
			};

			// Temporary handler for init sequence
			worker.onmessage = (event: MessageEvent) => {
				const msg = event.data;
				if (msg.type === "loaded") {
					worker.postMessage({
						type: "init",
						dataDir,
						globalConfigPath,
						projects: pm
							.list()
							.map((p) => ({ id: p.id, name: p.name, path: p.path })),
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
					scopeWorker.ready = true;
					getRestartState(scopeName).lastReadyAt = Date.now();
					setupWorkerMessageHandler(scopeName, scopeWorker);
					resolve();
				}
				if (msg.type === "error") {
					if (initTimer) {
						clearTimeout(initTimer);
						initTimer = undefined;
					}
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

	// ── Run onProjectInit hooks (4-step flow, step 3+4) ──
	// For each plugin, run its hook on all projects in its scope.
	// Plugins own their own "should I skip this project?" logic — daemon passes
	// globalContext so plugins can inspect installRoot/gitHash and decide.
	for (const plugin of registeredPlugins) {
		if (!plugin.onProjectInit) continue;
		const targetProjects =
			plugin.scope === "global"
				? pm.list()
				: pm.list().filter((p) => p.id === plugin.projectId);
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

	// Start workers for global plugins
	for (const plugin of registeredPlugins.filter((p) => p.scope === "global")) {
		// Resolve plugin's runtime module path for the worker
		const runtimePath = plugin.runtime
			? resolve(plugin.pluginRoot, plugin.runtime)
			: undefined;
		const { effectiveDataRoot } = await import("./plugin.ts");
		await startWorkerForPlugin(
			plugin.name,
			runtimePath,
			effectiveDataRoot(plugin),
		);
	}

	// ── Bootstrap auth eagerly ──
	// Historically the daemon ran with no `auth.json` until the user ran
	// `mxd auth`, opening a "no-secret" window where ANY LAN-reachable
	// client could hit the daemon (Audit G H2). Close that window by
	// creating `jwtSecret` + `secretVersion` on first boot.
	const authPath = join(dataDir, "auth.json");
	if (autoInitAuth) {
		const { createdSecret } = await ensureAuthInitialized(authPath);
		if (createdSecret) {
			console.log(
				"[auth] Initialized auth.json with a fresh jwtSecret. " +
					"Run `mxd auth <public_key>` to authenticate a browser session.",
			);
		}
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
	const SKIP_EXACT = new Set(["/", "/auth/status"]);
	app.use("*", async (c, next) => {
		const path = c.req.path;
		const skipAuth =
			SKIP_EXACT.has(path) ||
			path.startsWith("/vendor/") ||
			path.startsWith("/app/");

		if (!skipAuth) {
			if (await hasJwtSecret(authPath)) {
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
		}
		await next();
	});

	// Root page — generated HTML with importmap
	app.get("/", (c) => {
		return c.html(indexHTML);
	});

	// Health — daemon-owned, not worker-forwarded
	app.get("/health", async (c) => {
		if (c.req.query("check_model")) {
			// Forward to worker for full health check (includes Anthropic API ping)
			const workerName = registeredPlugins.find(
				(p) => p.scope === "global" && workers.has(p.name),
			)?.name;
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
	app.get("/auth/status", async (c) => {
		const hasSecret = await hasJwtSecret(authPath);
		const token = extractBearerToken(
			c.req.header("authorization"),
			c.req.query("token"),
		);
		const hasValidToken = token
			? (await verifyJWT(authPath, token, ["cli", "session"])) !== null
			: false;
		const authenticated = hasValidToken || !hasSecret;
		return c.json({ enabled: hasSecret, authenticated });
	});

	/**
	 * Logout-all. Bumps `secretVersion` in auth.json → every outstanding
	 * token (session, CLI, stream) becomes invalid on next verify.
	 * Requires a valid session/CLI token — passes the auth middleware
	 * before landing here, then hard-rotates the version.
	 *
	 * NOTE: not on SKIP_EXACT — calling this without a token returns 401,
	 * which is intentional (an anonymous client cannot log anyone out).
	 */
	app.post("/auth/logout", async (c) => {
		// If auth isn't set up, logout is meaningless but shouldn't 500.
		if (!(await hasJwtSecret(authPath))) return c.json({ ok: true });
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
		// If auth isn't set up, no token is needed anywhere — return empty.
		if (!(await hasJwtSecret(authPath))) {
			return c.json({ token: null });
		}
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

			// Call onProjectInit for all global plugins
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
			// Stop worker agents first
			const globalWorkerName = registeredPlugins.find(
				(p) => p.scope === "global" && workers.has(p.name),
			)?.name;
			if (globalWorkerName) {
				await forwardToWorker(
					globalWorkerName,
					new Request(`http://localhost/projects/${projectId}/stop`, {
						method: "POST",
					}),
				);
			}
			await pm.delete(projectId);
			syncToWorkers("project_deleted", { projectId });
			syncProjects();
			// Clean up SSE ring buffers for deleted project
			sseSeqCounters.delete(projectId);
			sseEventBuffers.delete(projectId);
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
	app.get("/vendor/*", async (c) => {
		const relativePath = c.req.path.slice("/vendor/".length);
		const filePath = join(buildDir, "vendor", relativePath);
		if (!isInsideBuildDir(filePath)) return c.json({ error: "Forbidden" }, 403);
		const file = Bun.file(filePath);
		if (!(await file.exists())) return c.json({ error: "Not found" }, 404);
		return new Response(file, {
			headers: { "content-type": "application/javascript" },
		});
	});

	app.get("/app/*", async (c) => {
		const relativePath = c.req.path.slice("/app/".length);
		const filePath = join(buildDir, "app", relativePath);
		if (!isInsideBuildDir(filePath)) return c.json({ error: "Forbidden" }, 403);
		const file = Bun.file(filePath);
		if (!(await file.exists())) return c.json({ error: "Not found" }, 404);
		return new Response(file);
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
		const next = { ...globalConfig } as MatrixConfig;
		for (const [k, v] of Object.entries(partial)) {
			if (k === "authGroups" && v && typeof v === "object") {
				// Special-case: preserve secrets that came back as masked echoes
				next.authGroups = mergeAuthGroups(
					globalConfig.authGroups,
					v as Record<string, AuthGroup>,
				);
			} else if (v === null || v === undefined) {
				delete (next as unknown as Record<string, unknown>)[k];
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

		const request = c.req.raw;
		// Capture the token used to authorize this stream so we can
		// periodically re-verify it. Short-lived "stream" tokens expire
		// in 5min; re-verifying at every heartbeat also picks up global
		// revocation (logout-all bumps secretVersion).
		const streamToken = extractBearerToken(
			c.req.header("authorization"),
			c.req.query("token"),
		);
		const authEnabled = await hasJwtSecret(authPath);

		// EventSource sends Last-Event-ID on reconnect
		const lastEventIdHeader = request.headers.get("Last-Event-ID");
		const lastSeqId = lastEventIdHeader
			? Number.parseInt(lastEventIdHeader, 10)
			: null;

		const stream = new ReadableStream({
			async start(controller) {
				const client: ShellSSEClient = { controller, projectId };
				sseClients.add(client);

				let catchUpDone = false;

				// If reconnecting with Last-Event-ID, try ring buffer catch-up
				if (lastSeqId != null && !Number.isNaN(lastSeqId)) {
					const missed = getEventsSince(projectId, lastSeqId);
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
				// send full initial state
				if (!catchUpDone) {
					try {
						const workerName = registeredPlugins.find(
							(p) => p.scope === "global" && workers.has(p.name),
						)?.name;
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
					if (authEnabled) {
						if (
							!streamToken ||
							!(await verifyJWT(authPath, streamToken, ["stream"]))
						) {
							clearInterval(heartbeat);
							closeStream("token_expired");
							return;
						}
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
		const workerName = registeredPlugins.find(
			(p) => p.scope === "global" && workers.has(p.name),
		)?.name;
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
	 * both sides. See `pluginApiPrefix` in plugin.ts for the shared helper.
	 *
	 * Unknown plugin or crashed worker → 404 / 503. No fallback to "first
	 * available global worker" — that was the old catch-all behavior and
	 * the exact thing this namespace replaces.
	 */
	app.all("/api/:plugin/*", async (c) => {
		const pluginName = c.req.param("plugin");
		const plugin = registeredPlugins.find((p) => p.name === pluginName);
		if (!plugin) {
			return c.json({ error: `Plugin "${pluginName}" not found` }, 404);
		}
		if (!workers.has(pluginName)) {
			return c.json({ error: `Plugin "${pluginName}" has no worker` }, 503);
		}

		// Strip the `/api/<plugin>` prefix from the URL path before forwarding.
		// The worker's Hono app has routes registered at root (e.g. `/projects/...`).
		const prefix = pluginApiPrefix(pluginName);
		const url = new URL(c.req.url);
		const stripped = url.pathname.slice(prefix.length) || "/";
		url.pathname = stripped;

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
		return forwardToWorker(pluginName, rewritten);
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
		syncToWorkers(
			"projects",
			pm.list().map((p) => ({ id: p.id, name: p.name, path: p.path })),
		);
	}

	function syncConfig(): void {
		syncToWorkers("config", globalConfig);
	}

	// ── Shutdown ──

	async function shutdown(): Promise<void> {
		for (const [name, sw] of workers) {
			sw.worker.postMessage({ type: "shutdown" });
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
			sw.worker.terminate();
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

	try {
		const res = await fetch(`http://localhost:${port}/health`);
		if (res.ok) {
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
