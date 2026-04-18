/**
 * Daemon integration tests — verify that key HTTP behaviors work
 * through the full daemon → worker pipeline (not just direct createApp).
 *
 * These mirror runtime.test.ts scenarios but go through createDaemon.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	createDaemonTestApp,
	type DaemonTestApp,
} from "./test-utils/daemon-harness.ts";

describe("daemon integration: health + version + stats", () => {
	let app: DaemonTestApp;

	beforeAll(async () => {
		app = await createDaemonTestApp();
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /health returns ok", async () => {
		const res = await app.fetch(new Request("http://localhost/health"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.status).toBe("ok");
		expect(body.version).toBeDefined();
	});

	test("GET /version returns version + counts", async () => {
		const res = await app.fetch(new Request("http://localhost/version"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.version).toBeDefined();
		expect(typeof body.nodeCount).toBe("number");
	});

	test("GET /stats returns stats", async () => {
		const res = await app.fetch(new Request("http://localhost/stats"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.uptime).toBeGreaterThanOrEqual(0);
	});

	test("GET /unknown returns 404", async () => {
		const res = await app.fetch(new Request("http://localhost/nonexistent"));
		expect(res.status).toBe(404);
	});
});

describe("daemon integration: projects", () => {
	let app: DaemonTestApp;

	beforeAll(async () => {
		app = await createDaemonTestApp();
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /projects returns list", async () => {
		const res = await app.fetch(new Request("http://localhost/projects"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
	});

	test("POST /projects creates project", async () => {
		const { mkdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const newProjectPath = join(app.tempDir, "new-project");
		await mkdir(newProjectPath, { recursive: true });

		const res = await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: newProjectPath }),
			}),
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.id).toBeDefined();
		expect(body.name).toBe("new-project");
	});

	test("POST /projects rejects duplicate", async () => {
		const { mkdir } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const dupPath = join(app.tempDir, "dup-project");
		await mkdir(dupPath, { recursive: true });

		// Create first
		await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: dupPath }),
			}),
		);

		// Duplicate should fail
		const res = await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: dupPath }),
			}),
		);
		expect(res.status).toBe(409);
	});
});

describe("daemon integration: config", () => {
	let app: DaemonTestApp;

	beforeAll(async () => {
		app = await createDaemonTestApp();
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /config/global returns config (daemon-owned)", async () => {
		const res = await app.fetch(new Request("http://localhost/config/global"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.budgetUsd).toBe(-1);
	});

	test("PATCH /config/global updates config (daemon-owned)", async () => {
		const res = await app.fetch(
			new Request("http://localhost/config/global", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ budgetUsd: 100 }),
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.budgetUsd).toBe(100);
	});

	test("/plugins returns discovered plugins", async () => {
		const res = await app.fetch(new Request("http://localhost/plugins"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBe(1);
		expect(body[0].name).toBe("test-matrix");
	});
});

describe("daemon integration: project config", () => {
	let app: DaemonTestApp;
	let projectId: string;

	beforeAll(async () => {
		app = await createDaemonTestApp();
		const res = await app.fetch(new Request("http://localhost/projects"));
		const projects = await res.json();
		projectId = projects[0]?.id;
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /projects/:id/config returns empty for new project", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({});
	});

	test("PATCH /projects/:id/config sets and returns config", async () => {
		await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "claude-opus-4-5" }),
			}),
		);
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { model?: string };
		expect(body.model).toBe("claude-opus-4-5");
	});

	test("PATCH preserves unrelated fields", async () => {
		await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "a", budgetUsd: 2 }),
			}),
		);
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "b" }),
			}),
		);
		const body = (await res.json()) as { model?: string; budgetUsd?: number };
		expect(body.model).toBe("b");
		expect(body.budgetUsd).toBe(2);
	});

	test("PATCH null removes field", async () => {
		await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "x" }),
			}),
		);
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: null }),
			}),
		);
		const body = (await res.json()) as { model?: string };
		expect(body.model).toBeUndefined();
	});

	test("GET /projects/:id/config/repo returns empty when no repo config", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/config/repo`),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({});
	});

	test("returns 404 for unknown project", async () => {
		const res = await app.fetch(
			new Request("http://localhost/projects/nonexistent/config"),
		);
		expect(res.status).toBe(404);
	});
});

describe("daemon integration: tasks through worker", () => {
	let app: DaemonTestApp;
	let projectId: string;
	// Plugin-owned routes live under `/api/<plugin>/*`. The harness registers
	// a plugin with name "test-matrix" (see createDaemonTestApp).
	const PLUGIN_PREFIX = "/api/test-matrix";

	beforeAll(async () => {
		app = await createDaemonTestApp();

		// Get the registered project ID
		const res = await app.fetch(new Request("http://localhost/projects"));
		const projects = await res.json();
		projectId = projects[0]?.id;
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /api/<plugin>/projects/:id/tasks returns tree", async () => {
		expect(projectId).toBeTruthy();
		const res = await app.fetch(
			new Request(
				`http://localhost${PLUGIN_PREFIX}/projects/${projectId}/tasks`,
			),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(typeof body.rootNodeId).toBe("string");
		expect(body.rootNodeId.length).toBeGreaterThan(0);
		expect(Array.isArray(body.nodes)).toBe(true);
		expect(body.nodes.length).toBeGreaterThan(0);
		expect(body.nodes[0].title).toBe("Orchestrator");
	});

	test("POST /api/<plugin>/projects/:id/tasks creates task through worker", async () => {
		expect(projectId).toBeTruthy();

		// Get root node ID first
		const treeRes = await app.fetch(
			new Request(
				`http://localhost${PLUGIN_PREFIX}/projects/${projectId}/tasks`,
			),
		);
		const tree = await treeRes.json();
		const rootId = tree.rootNodeId;

		const res = await app.fetch(
			new Request(
				`http://localhost${PLUGIN_PREFIX}/projects/${projectId}/tasks`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						parentId: rootId,
						title: "Test task via daemon",
						description: "Created through daemon pipeline",
					}),
				},
			),
		);
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.title).toBe("Test task via daemon");
	});

	test("unprefixed plugin path returns 404 (no fallback)", async () => {
		// Regression guard: old behavior was to forward unprefixed paths to
		// "the first available global worker". This is gone — plugin routes
		// MUST go through the namespace now.
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}/tasks`),
		);
		expect(res.status).toBe(404);
	});
});

describe("daemon integration: project CRUD coverage", () => {
	let app: DaemonTestApp;
	let projectId: string;
	let projectPath: string;

	beforeAll(async () => {
		app = await createDaemonTestApp();
		projectPath = join(app.tempDir, "crud-project");
		const { mkdir } = await import("node:fs/promises");
		await mkdir(projectPath, { recursive: true });

		const res = await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			}),
		);
		const body = await res.json();
		projectId = body.id;
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET /projects/:id returns project", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}`),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe(projectId);
		expect(body.name).toBe("crud-project");
	});

	test("GET /projects/:id returns 404 for unknown", async () => {
		const res = await app.fetch(
			new Request("http://localhost/projects/nonexistent"),
		);
		expect(res.status).toBe(404);
	});

	test("GET /projects includes pathExists field", async () => {
		const res = await app.fetch(new Request("http://localhost/projects"));
		const projects = (await res.json()) as Array<{
			id: string;
			pathExists?: boolean;
		}>;
		const proj = projects.find((p) => p.id === projectId);
		expect(proj?.pathExists).toBeDefined();
	});

	test("PATCH /projects/:id updates name", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "renamed-project" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.name).toBe("renamed-project");
	});

	test("PATCH /projects/:id rejects empty body", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/projects/${projectId}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		expect(res.status).toBe(400);
	});

	test("PATCH /projects/:id returns 404 for unknown", async () => {
		const res = await app.fetch(
			new Request("http://localhost/projects/nonexistent", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ name: "x" }),
			}),
		);
		expect(res.status).toBe(404);
	});

	test("DELETE /projects/:id removes project", async () => {
		// Create a throwaway project to delete
		const { mkdir } = await import("node:fs/promises");
		const delPath = join(app.tempDir, "to-delete");
		await mkdir(delPath, { recursive: true });
		const createRes = await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: delPath }),
			}),
		);
		const created = await createRes.json();

		const res = await app.fetch(
			new Request(`http://localhost/projects/${created.id}`, {
				method: "DELETE",
			}),
		);
		expect(res.status).toBe(200);

		// Verify gone
		const getRes = await app.fetch(
			new Request(`http://localhost/projects/${created.id}`),
		);
		expect(getRes.status).toBe(404);
	});
});

describe("daemon integration: onProjectInit pipeline", () => {
	let app: DaemonTestApp;

	beforeAll(async () => {
		// Use a plugin manifest WITH onProjectInit so the pipeline test is real
		const pluginWithInit = `
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
export default {
	name: "test-with-init",
	scope: "global",
	async onProjectInit(projectPath, { isNew }) {
		await mkdir(join(projectPath, ".mxd"), { recursive: true });
		if (!existsSync(join(projectPath, ".mxd", "memory.md"))) {
			await writeFile(join(projectPath, ".mxd", "memory.md"), "# Project Memory\\nTest init.\\n");
		}
	},
};`;
		app = await createDaemonTestApp({ pluginManifest: pluginWithInit });
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("POST /projects calls plugin onProjectInit — new project gets memory.md", async () => {
		const { mkdir, readFile } = await import("node:fs/promises");
		const { existsSync } = await import("node:fs");
		const projectPath = join(app.tempDir, "init-test-project");
		await mkdir(projectPath, { recursive: true });

		const res = await app.fetch(
			new Request("http://localhost/projects", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path: projectPath }),
			}),
		);
		expect(res.status).toBe(201);

		// Plugin's onProjectInit should have created .mxd/memory.md
		expect(existsSync(join(projectPath, ".mxd", "memory.md"))).toBe(true);
		const memory = await readFile(
			join(projectPath, ".mxd", "memory.md"),
			"utf-8",
		);
		expect(memory).toContain("Project Memory");
	});
});

/**
 * SPA fallback (Task Y refresh fix).
 *
 * After Task Y, tasks live at `/<projectId>/<scope>/<taskId>` path-routed
 * URLs. Browser refresh on those paths must reach the shell HTML so the
 * SPA can boot, parse the URL, and render. Browsers don't carry the
 * `Authorization` header on navigation, so the shell must be served
 * anonymously — same posture as `/`.
 *
 * Predicate (single source of truth, both for the auth bypass and the
 * SPA route handler): `pm.has(firstSegment)`. ULID project ids never
 * collide with backend route names ("api", "auth", "projects", etc.).
 *
 * `app.daemon.fetch` (raw) is used for unauthenticated tests — `app.fetch`
 * (harness) auto-attaches the session token and would mask the
 * anonymous-access invariants we care about for browser refresh.
 */
describe("daemon integration: SPA fallback (Task Y refresh)", () => {
	let app: DaemonTestApp;
	const projectId = "test-project-id"; // hardcoded by daemon-harness.ts

	beforeAll(async () => {
		app = await createDaemonTestApp();
	});

	afterAll(async () => {
		await app.cleanup();
	});

	test("GET / serves shell HTML (regression-free)", async () => {
		const res = await app.daemon.fetch(new Request("http://localhost/"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
	});

	test("GET /<projectId>/matrix/<taskId> serves shell HTML (authenticated)", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/${projectId}/matrix/some-task-id`),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
	});

	test("GET /<projectId>/<anything> serves shell HTML — plugin owns 2nd+ segments", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/${projectId}/whatever-the-plugin-wants`),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});

	test("GET /<projectId> (no trailing path) serves shell HTML", async () => {
		const res = await app.fetch(
			new Request(`http://localhost/${projectId}`),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});

	test("GET / and GET /<projectId>/... return BYTE-IDENTICAL HTML", async () => {
		// The fallback must serve the same bytes as `/`, not a slightly
		// different shell — otherwise the SPA boot diverges between fresh
		// load and refresh, and cache stops working.
		const rootRes = await app.daemon.fetch(new Request("http://localhost/"));
		const spaRes = await app.daemon.fetch(
			new Request(`http://localhost/${projectId}/matrix/x`),
		);
		const rootHtml = await rootRes.text();
		const spaHtml = await spaRes.text();
		expect(spaHtml).toBe(rootHtml);
	});

	test("UX scenario: browser refresh (NO Authorization) on real project URL serves HTML", async () => {
		// The whole point of this fix. A user already authenticated (token
		// in localStorage) hits F5 on `/abc123/matrix/xyz`. The browser
		// reissues the request with NO custom headers — Authorization
		// only rides on JS-issued requests. Without the auth bypass, the
		// shell would 401 and the user sees raw JSON. With the bypass,
		// the shell loads, JS reads the token, authFetch resumes work.
		const res = await app.daemon.fetch(
			new Request(`http://localhost/${projectId}/matrix/some-task`),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});

	test("GET /<unregistered-project-id>/... returns 404 (no fake SPA on stale ids)", async () => {
		// Deleted / never-existed project ids return 404 cleanly instead
		// of pretending to load an SPA that will immediately 404 on its
		// own data fetches.
		const res = await app.fetch(
			new Request(
				"http://localhost/01ZZZZZZZZZZZZZZZZZZZZZZZZ/matrix/x",
			),
		);
		expect(res.status).toBe(404);
	});

	test("GET /randomWord returns 404 (random first segment ≠ project id)", async () => {
		const res = await app.fetch(
			new Request("http://localhost/randomNotAProjectIdAtAll"),
		);
		expect(res.status).toBe(404);
	});

	test("GET /api/<plugin>/unknown-endpoint returns 404 from plugin worker (NOT HTML)", async () => {
		// Plugin route handler runs and returns 404. Wildcard never sees
		// it. This is the regression guard that the fallback doesn't
		// swallow legitimate plugin 404s.
		const res = await app.fetch(
			new Request(
				"http://localhost/api/test-matrix/this-endpoint-does-not-exist",
			),
		);
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).not.toContain("<!DOCTYPE html>");
	});

	test("GET /auth/bogus returns 401 from auth middleware (NOT HTML)", async () => {
		// `/auth/*` is not a frontend path. Auth middleware blocks before
		// any handler can serve HTML. Critical: stale `/auth/<typo>` must
		// NOT pretend to be a valid SPA shell.
		const res = await app.daemon.fetch(
			new Request("http://localhost/auth/bogus"),
		);
		expect(res.status).toBe(401);
		const body = await res.text();
		expect(body).not.toContain("<!DOCTYPE html>");
	});

	test("GET /vendor/nonexistent.js returns 404 from static handler (NOT HTML)", async () => {
		// Static asset handler matches `/vendor/*` and returns 404 for
		// missing files. Wildcard never sees it. Important because /vendor
		// IS in the auth-skip list — without the per-handler 404 check,
		// the wildcard could fall through and serve HTML for a missing JS
		// bundle, breaking script loading.
		const res = await app.fetch(
			new Request("http://localhost/vendor/this-bundle-does-not-exist.js"),
		);
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).not.toContain("<!DOCTYPE html>");
	});

	test("POST /<projectId>/matrix/<taskId> stays auth-gated (no HTML for writes)", async () => {
		// Frontend paths bypass auth ONLY for GET. A POST to the same path
		// shape is either a typo or an attack — return 401, not silent HTML.
		const res = await app.daemon.fetch(
			new Request(`http://localhost/${projectId}/matrix/x`, {
				method: "POST",
			}),
		);
		expect(res.status).not.toBe(200);
		const body = await res.text();
		expect(body).not.toContain("<!DOCTYPE html>");
	});

	test("PATCH /<projectId>/anything stays auth-gated (no HTML for writes)", async () => {
		const res = await app.daemon.fetch(
			new Request(`http://localhost/${projectId}/some-resource`, {
				method: "PATCH",
			}),
		);
		expect(res.status).not.toBe(200);
		const body = await res.text();
		expect(body).not.toContain("<!DOCTYPE html>");
	});
});
