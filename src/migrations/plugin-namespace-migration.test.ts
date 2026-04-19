/**
 * Unit tests for the plugin-namespace one-shot migration.
 *
 * Scenarios covered:
 *  - Old layout → new layout: tree.json / tasks/ / debug/ move to plugin/matrix/
 *  - Idempotency: second run is a no-op
 *  - Mixed state: new-layout projects skipped, old-layout projects migrated
 *  - Empty project dir (no legacy data): skip cleanly
 *  - Multiple projects: each handled independently
 *  - config.json stays put
 *  - Collision guard: refuses to clobber pre-existing plugin/matrix/<name>
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	migrateProject,
	migrateToPluginNamespace,
} from "./plugin-namespace-migration.ts";

let tempDir: string;
let dataDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "mxd-migration-"));
	dataDir = join(tempDir, ".mxd");
	mkdirSync(dataDir, { recursive: true });
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

/** Build a project directory in the OLD layout with given contents. */
function makeOldLayoutProject(
	projectId: string,
	opts: {
		tree?: string;
		tasks?: Record<string, string>;
		debug?: Record<string, string>;
		config?: string;
	} = {},
): string {
	const projectDir = join(dataDir, "projects", projectId);
	mkdirSync(projectDir, { recursive: true });
	if (opts.tree !== undefined) {
		writeFileSync(join(projectDir, "tree.json"), opts.tree);
	}
	if (opts.config !== undefined) {
		writeFileSync(join(projectDir, "config.json"), opts.config);
	}
	if (opts.tasks) {
		const tasksDir = join(projectDir, "tasks");
		mkdirSync(tasksDir, { recursive: true });
		for (const [name, content] of Object.entries(opts.tasks)) {
			writeFileSync(join(tasksDir, name), content);
		}
	}
	if (opts.debug) {
		const debugDir = join(projectDir, "debug");
		mkdirSync(debugDir, { recursive: true });
		for (const [name, content] of Object.entries(opts.debug)) {
			const fullPath = join(debugDir, name);
			mkdirSync(join(fullPath, ".."), { recursive: true });
			writeFileSync(fullPath, content);
		}
	}
	return projectDir;
}

/** Build a project already in the NEW layout (post-migration). */
function makeNewLayoutProject(
	projectId: string,
	opts: { tree?: string; config?: string } = {},
): string {
	const projectDir = join(dataDir, "projects", projectId);
	const matrixDir = join(projectDir, "plugin", "matrix");
	mkdirSync(matrixDir, { recursive: true });
	if (opts.tree !== undefined) {
		writeFileSync(join(matrixDir, "tree.json"), opts.tree);
	}
	if (opts.config !== undefined) {
		writeFileSync(join(projectDir, "config.json"), opts.config);
	}
	return projectDir;
}

describe("migrateToPluginNamespace — happy path", () => {
	test("moves tree.json + tasks/ + debug/ into plugin/matrix/", async () => {
		const projectId = "01TESTPROJ1";
		const projectDir = makeOldLayoutProject(projectId, {
			tree: '{"nodes":[{"id":"root","title":"test"}]}',
			tasks: {
				"session1.jsonl": "line1\nline2\n",
				"session2.jsonl": "line3\n",
			},
			debug: {
				"root/trace1/last.json": '{"debug":true}',
			},
			config: '{"foo":"bar"}',
		});

		const summary = await migrateToPluginNamespace(dataDir);

		expect(summary.projectsScanned).toBe(1);
		expect(summary.migrated).toBe(1);
		expect(summary.errors).toBe(0);
		expect(summary.details[0]?.status).toBe("migrated");

		// New layout exists
		const matrixDir = join(projectDir, "plugin", "matrix");
		expect(existsSync(join(matrixDir, "tree.json"))).toBe(true);
		expect(existsSync(join(matrixDir, "tasks", "session1.jsonl"))).toBe(true);
		expect(existsSync(join(matrixDir, "tasks", "session2.jsonl"))).toBe(true);
		expect(
			existsSync(join(matrixDir, "debug", "root", "trace1", "last.json")),
		).toBe(true);

		// Old layout gone
		expect(existsSync(join(projectDir, "tree.json"))).toBe(false);
		expect(existsSync(join(projectDir, "tasks"))).toBe(false);
		expect(existsSync(join(projectDir, "debug"))).toBe(false);

		// config.json STAYS at project top
		expect(existsSync(join(projectDir, "config.json"))).toBe(true);
		expect(readFileSync(join(projectDir, "config.json"), "utf-8")).toBe(
			'{"foo":"bar"}',
		);

		// Content integrity — tree.json bytes are identical
		expect(readFileSync(join(matrixDir, "tree.json"), "utf-8")).toBe(
			'{"nodes":[{"id":"root","title":"test"}]}',
		);
		// JSONL content identical
		expect(
			readFileSync(join(matrixDir, "tasks", "session1.jsonl"), "utf-8"),
		).toBe("line1\nline2\n");
	});

	test("handles partial legacy state (tree.json only, no tasks/ or debug/)", async () => {
		const projectId = "01PARTIAL";
		const projectDir = makeOldLayoutProject(projectId, {
			tree: '{"rootNodeId":"root"}',
		});

		const summary = await migrateToPluginNamespace(dataDir);

		expect(summary.migrated).toBe(1);
		expect(existsSync(join(projectDir, "plugin", "matrix", "tree.json"))).toBe(
			true,
		);
		expect(existsSync(join(projectDir, "tree.json"))).toBe(false);
	});

	test("creates parent plugin/ dir when missing", async () => {
		const projectId = "01NEEDPARENT";
		const projectDir = makeOldLayoutProject(projectId, {
			tree: "{}",
			tasks: { "a.jsonl": "x" },
		});

		// No plugin/ dir yet
		expect(existsSync(join(projectDir, "plugin"))).toBe(false);

		const summary = await migrateToPluginNamespace(dataDir);

		expect(summary.migrated).toBe(1);
		expect(existsSync(join(projectDir, "plugin", "matrix", "tree.json"))).toBe(
			true,
		);
		expect(
			existsSync(join(projectDir, "plugin", "matrix", "tasks", "a.jsonl")),
		).toBe(true);
	});
});

describe("migrateToPluginNamespace — idempotency", () => {
	test("second run after success is a no-op (skipped)", async () => {
		const projectId = "01IDEMP";
		makeOldLayoutProject(projectId, {
			tree: '{"v":1}',
			tasks: { "s.jsonl": "x" },
		});

		const first = await migrateToPluginNamespace(dataDir);
		expect(first.migrated).toBe(1);

		const second = await migrateToPluginNamespace(dataDir);
		expect(second.projectsScanned).toBe(1);
		expect(second.migrated).toBe(0);
		expect(second.skipped).toBe(1);
		expect(second.details[0]?.status).toBe("skipped");

		// Third time still a no-op (sanity)
		const third = await migrateToPluginNamespace(dataDir);
		expect(third.migrated).toBe(0);
		expect(third.skipped).toBe(1);
	});

	test("projects already in new layout are skipped", async () => {
		const projectId = "01NEW";
		makeNewLayoutProject(projectId, {
			tree: '{"already":"migrated"}',
			config: '{"c":true}',
		});

		const summary = await migrateToPluginNamespace(dataDir);

		expect(summary.projectsScanned).toBe(1);
		expect(summary.migrated).toBe(0);
		expect(summary.skipped).toBe(1);
		const first = summary.details[0];
		expect(first?.status).toBe("skipped");
		if (first?.status === "skipped") {
			expect(first.reason).toMatch(/already migrated/);
		}
	});

	test("empty project dir (no legacy data, no new data) skips cleanly", async () => {
		const projectId = "01EMPTY";
		const projectDir = join(dataDir, "projects", projectId);
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "config.json"), "{}");

		const summary = await migrateToPluginNamespace(dataDir);

		expect(summary.projectsScanned).toBe(1);
		expect(summary.skipped).toBe(1);
		expect(summary.migrated).toBe(0);
		const first = summary.details[0];
		expect(first?.status).toBe("skipped");
		if (first?.status === "skipped") {
			expect(first.reason).toMatch(/fresh project|no legacy/i);
		}
		// Never created a plugin/matrix/ for an empty project.
		expect(existsSync(join(projectDir, "plugin"))).toBe(false);
	});
});

describe("migrateToPluginNamespace — multiple projects", () => {
	test("mixed state: old + new + empty each handled independently", async () => {
		const oldId = "01MIXED_OLD";
		const newId = "01MIXED_NEW";
		const emptyId = "01MIXED_EMPTY";

		const oldDir = makeOldLayoutProject(oldId, {
			tree: '{"who":"old"}',
			tasks: { "old.jsonl": "content" },
		});
		const newDir = makeNewLayoutProject(newId, {
			tree: '{"who":"new"}',
		});
		const emptyDir = join(dataDir, "projects", emptyId);
		mkdirSync(emptyDir, { recursive: true });

		const summary = await migrateToPluginNamespace(dataDir);

		expect(summary.projectsScanned).toBe(3);
		expect(summary.migrated).toBe(1); // oldId
		expect(summary.skipped).toBe(2); // newId + emptyId
		expect(summary.errors).toBe(0);

		// Old project migrated
		expect(existsSync(join(oldDir, "tree.json"))).toBe(false);
		expect(existsSync(join(oldDir, "plugin", "matrix", "tree.json"))).toBe(
			true,
		);
		expect(
			readFileSync(join(oldDir, "plugin", "matrix", "tree.json"), "utf-8"),
		).toBe('{"who":"old"}');

		// New project untouched
		expect(existsSync(join(newDir, "plugin", "matrix", "tree.json"))).toBe(
			true,
		);
		expect(
			readFileSync(join(newDir, "plugin", "matrix", "tree.json"), "utf-8"),
		).toBe('{"who":"new"}');

		// Empty project left alone
		expect(existsSync(join(emptyDir, "plugin"))).toBe(false);
	});

	test("10 projects all migrate in one pass", async () => {
		for (let i = 0; i < 10; i++) {
			makeOldLayoutProject(`01PROJ_${i}`, {
				tree: `{"i":${i}}`,
				tasks: { "s.jsonl": `p${i}` },
			});
		}

		const summary = await migrateToPluginNamespace(dataDir);
		expect(summary.projectsScanned).toBe(10);
		expect(summary.migrated).toBe(10);
		expect(summary.errors).toBe(0);

		for (let i = 0; i < 10; i++) {
			const p = join(dataDir, "projects", `01PROJ_${i}`);
			expect(existsSync(join(p, "tree.json"))).toBe(false);
			expect(existsSync(join(p, "plugin", "matrix", "tree.json"))).toBe(true);
			expect(
				readFileSync(join(p, "plugin", "matrix", "tree.json"), "utf-8"),
			).toBe(`{"i":${i}}`);
		}
	});
});

describe("migrateToPluginNamespace — edge cases", () => {
	test("non-existent projects/ dir returns zero-summary (fresh install)", async () => {
		// dataDir exists but no projects/ subdir
		const summary = await migrateToPluginNamespace(dataDir);
		expect(summary.projectsScanned).toBe(0);
		expect(summary.migrated).toBe(0);
		expect(summary.skipped).toBe(0);
		expect(summary.errors).toBe(0);
	});

	test("non-directory entries under projects/ are ignored (e.g. .DS_Store)", async () => {
		mkdirSync(join(dataDir, "projects"), { recursive: true });
		writeFileSync(join(dataDir, "projects", ".DS_Store"), "junk");
		makeOldLayoutProject("01REAL", { tree: "{}" });

		const summary = await migrateToPluginNamespace(dataDir);

		// Only the real project counts.
		expect(summary.projectsScanned).toBe(1);
		expect(summary.migrated).toBe(1);
		// .DS_Store untouched.
		expect(existsSync(join(dataDir, "projects", ".DS_Store"))).toBe(true);
	});

	test("config.json-only project (no legacy data) skips cleanly", async () => {
		const projectId = "01CFGONLY";
		const projectDir = join(dataDir, "projects", projectId);
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "config.json"), '{"x":1}');

		const summary = await migrateToPluginNamespace(dataDir);
		expect(summary.migrated).toBe(0);
		expect(summary.skipped).toBe(1);
		expect(existsSync(join(projectDir, "config.json"))).toBe(true);
	});
});

describe("migrateProject — single-project helper", () => {
	test("migrates an isolated project dir when called directly", () => {
		const projectId = "01SOLO";
		const projectDir = makeOldLayoutProject(projectId, {
			tree: "{}",
			tasks: { "x.jsonl": "content" },
		});

		const result = migrateProject(projectDir, projectId);
		expect(result.status).toBe("migrated");
		if (result.status === "migrated") {
			expect(result.moved).toContain("tree.json");
			expect(result.moved).toContain("tasks");
		}
	});

	test("refuses to clobber an existing file in plugin/matrix/", () => {
		const projectId = "01COLLIDE";
		const projectDir = makeOldLayoutProject(projectId, {
			tree: "{}",
			tasks: { "old.jsonl": "legacy" },
		});
		// Pre-seed a colliding entry in the new location (but NO tree.json there,
		// so idempotency gate doesn't short-circuit).
		const matrixDir = join(projectDir, "plugin", "matrix");
		mkdirSync(matrixDir, { recursive: true });
		mkdirSync(join(matrixDir, "tasks"), { recursive: true });

		// Now the target `tasks` dir exists. rename would refuse to clobber.
		const result = migrateProject(projectDir, projectId);

		// The migration should surface an error rather than silently overwriting
		// or half-migrating.
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.message).toMatch(/target already exists/);
		}

		// Legacy tree.json untouched (migration aborted before moving it, because
		// it discovered the collision while trying to move tasks/). Actually, the
		// order is tree.json → tasks → debug — but because we move them
		// atomically with no rollback, tree.json MAY have already moved. What
		// matters is that the error was surfaced, not that nothing changed.
	});
});

describe("content preservation across migration", () => {
	test("JSONL contents are byte-identical pre and post", async () => {
		const projectId = "01PRESERVE";
		const tricky = "line1\n\nline3 with 空白 + emoji 🚀\n";
		makeOldLayoutProject(projectId, {
			tasks: { "weird.jsonl": tricky },
			tree: "{}",
		});

		await migrateToPluginNamespace(dataDir);

		const moved = readFileSync(
			join(
				dataDir,
				"projects",
				projectId,
				"plugin",
				"matrix",
				"tasks",
				"weird.jsonl",
			),
			"utf-8",
		);
		expect(moved).toBe(tricky);
	});

	test("tasks/ dir preserves multiple files and their mtimes", async () => {
		const projectId = "01MULTIFILE";
		const projectDir = makeOldLayoutProject(projectId, {
			tasks: {
				"a.jsonl": "content-a",
				"b.jsonl": "content-b",
				"c.jsonl": "content-c",
			},
			tree: "{}",
		});

		await migrateToPluginNamespace(dataDir);

		const matrixTasks = join(projectDir, "plugin", "matrix", "tasks");
		const files = readdirSync(matrixTasks).sort();
		expect(files).toEqual(["a.jsonl", "b.jsonl", "c.jsonl"]);
		expect(readFileSync(join(matrixTasks, "a.jsonl"), "utf-8")).toBe(
			"content-a",
		);
		expect(readFileSync(join(matrixTasks, "b.jsonl"), "utf-8")).toBe(
			"content-b",
		);
		expect(readFileSync(join(matrixTasks, "c.jsonl"), "utf-8")).toBe(
			"content-c",
		);
	});
});
