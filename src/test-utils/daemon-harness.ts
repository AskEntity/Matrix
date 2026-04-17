/**
 * Test harness: createDaemon-based test app.
 * Same interface as createApp() tests expect, but runs through daemon → worker pipeline.
 * Use this to verify that daemon+plugin behavior matches direct runtime behavior.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, saveGlobalConfig } from "../config.ts";
import { createDaemon, type DaemonInstance } from "../daemon.ts";

export interface DaemonTestApp {
	daemon: DaemonInstance;
	tempDir: string;
	dataDir: string;
	/** Fetch through the daemon pipeline */
	fetch: (request: Request) => Promise<Response>;
	/** Create a project through the daemon (calls onProjectInit hooks) */
	createProject: (
		path: string,
	) => Promise<{ id: string; name: string; path: string }>;
	/** Clean up */
	cleanup: () => Promise<void>;
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

	const daemon = await createDaemon({ dataDir });

	return {
		daemon,
		tempDir,
		dataDir,
		fetch: daemon.fetch,
		async createProject(path: string) {
			const res = await daemon.fetch(
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
