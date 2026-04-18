/**
 * Test harness: createDaemon-based test app.
 * Same interface as createApp() tests expect, but runs through daemon → worker pipeline.
 * Use this to verify that daemon+plugin behavior matches direct runtime behavior.
 *
 * After Audit R7 P1.3 auth is ALWAYS on — no `autoInitAuth: false` escape.
 * The harness mints a session token at construction and exposes it; its
 * `fetch` wrapper attaches `Authorization: Bearer <token>` automatically,
 * so call sites can stay terse. Tests that need a different subject (CLI,
 * stream) use `createTestToken(authPath, { sub: "cli" })` directly.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../config.ts";
import { createDaemon, type DaemonInstance } from "../daemon.ts";
import { createTestToken } from "./auth-helper.ts";

export interface DaemonTestApp {
	daemon: DaemonInstance;
	tempDir: string;
	dataDir: string;
	authPath: string;
	/** Session JWT for the test caller — pre-attached by `fetch`. */
	sessionToken: string;
	/** Fetch through the daemon pipeline, with session token auto-attached. */
	fetch: (request: Request) => Promise<Response>;
	/** Create a project through the daemon (calls onProjectInit hooks) */
	createProject: (
		path: string,
	) => Promise<{ id: string; name: string; path: string }>;
	/** Clean up */
	cleanup: () => Promise<void>;
}

/** Attach `Authorization: Bearer <token>` to an existing Request. */
export function withBearer(req: Request, token: string): Request {
	const headers = new Headers(req.headers);
	if (!headers.has("authorization")) {
		headers.set("Authorization", `Bearer ${token}`);
	}
	return new Request(req.url, {
		method: req.method,
		headers,
		body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
	});
}

/**
 * Create a test daemon with a registered project that has a global plugin.
 * The plugin triggers worker startup, so HTTP forwarding works.
 */
export async function createDaemonTestApp(opts?: {
	projectPath?: string;
	pluginManifest?: string;
}): Promise<DaemonTestApp> {
	const tempDir = await mkdtemp(join(tmpdir(), "daemon-test-"));
	const dataDir = join(tempDir, ".mxd");
	const authPath = join(dataDir, "auth.json");
	const projectPath = opts?.projectPath ?? join(tempDir, "test-project");

	// Create project with global plugin
	await mkdir(join(projectPath, ".mxd", "plugin"), { recursive: true });
	await writeFile(
		join(projectPath, ".mxd", "plugin", "index.ts"),
		opts?.pluginManifest ??
			`export default { name: "test-matrix", scope: "global" };`,
		"utf-8",
	);

	// Register project
	await mkdir(join(dataDir, "projects"), { recursive: true });
	const projectId = "test-project-id";
	await writeFile(
		join(dataDir, "projects.json"),
		JSON.stringify([
			{
				id: projectId,
				name: "test-project",
				path: projectPath,
				createdAt: new Date().toISOString(),
			},
		]),
		"utf-8",
	);

	await saveGlobalConfig({ ...DEFAULT_CONFIG }, join(dataDir, "config.json"));

	// Mint a session token BEFORE starting the daemon — the caller also
	// inits auth, so secretVersion matches whatever the daemon sees.
	const sessionToken = await createTestToken(authPath);

	const daemon = await createDaemon({
		dataDir,
		autoRegisterSelf: false,
	});

	const fetch = (req: Request) => daemon.fetch(withBearer(req, sessionToken));

	return {
		daemon,
		tempDir,
		dataDir,
		authPath,
		sessionToken,
		fetch,
		async createProject(path: string) {
			const res = await fetch(
				new Request("http://localhost/projects", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path }),
				}),
			);
			if (!res.ok) {
				const err = await res.text();
				throw new Error(`createProject failed (${res.status}): ${err}`);
			}
			return res.json();
		},
		async cleanup() {
			await daemon.shutdown();
			await rm(tempDir, { recursive: true, force: true });
		},
	};
}
