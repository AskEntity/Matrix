import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateStorageLayout } from "./storage-migration.ts";

describe("migrateStorageLayout", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mxd-migrate-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	test("no-op when sessions/ does not exist", async () => {
		const result = await migrateStorageLayout(dataDir);
		expect(result.migrated).toBe(false);
		expect(result.filesMoved).toBe(0);
		expect(result.filesSkipped).toBe(0);
		expect(result.errors).toEqual([]);
	});

	test("moves .events.jsonl files to projects/<id>/tasks/<id>.jsonl", async () => {
		const projectId = "proj-123";
		const oldDir = join(dataDir, "sessions", projectId);
		await mkdir(oldDir, { recursive: true });
		// Pre-create the project dir (like ProjectManager would)
		await mkdir(join(dataDir, "projects", projectId), { recursive: true });

		await writeFile(join(oldDir, "task-abc.events.jsonl"), "line1\nline2\n");
		await writeFile(join(oldDir, "task-def.events.jsonl"), "only line\n");

		const result = await migrateStorageLayout(dataDir);

		expect(result.migrated).toBe(true);
		expect(result.projectsScanned).toBe(1);
		expect(result.filesMoved).toBe(2);
		expect(result.filesSkipped).toBe(0);
		expect(result.errors).toEqual([]);

		const tasksDir = join(dataDir, "projects", projectId, "tasks");
		expect(existsSync(tasksDir)).toBe(true);
		expect(existsSync(join(dataDir, "projects", projectId, "debug"))).toBe(
			true,
		);

		expect(await readFile(join(tasksDir, "task-abc.jsonl"), "utf-8")).toBe(
			"line1\nline2\n",
		);
		expect(await readFile(join(tasksDir, "task-def.jsonl"), "utf-8")).toBe(
			"only line\n",
		);

		// Old sessions dir should be removed (empty)
		expect(existsSync(oldDir)).toBe(false);
		// Old sessions root should also be removed (empty)
		expect(existsSync(join(dataDir, "sessions"))).toBe(false);
	});

	test("migrates multiple projects", async () => {
		const p1 = "project-one";
		const p2 = "project-two";
		await mkdir(join(dataDir, "sessions", p1), { recursive: true });
		await mkdir(join(dataDir, "sessions", p2), { recursive: true });

		await writeFile(
			join(dataDir, "sessions", p1, "t1.events.jsonl"),
			"p1 content\n",
		);
		await writeFile(
			join(dataDir, "sessions", p2, "t2.events.jsonl"),
			"p2 content\n",
		);
		await writeFile(
			join(dataDir, "sessions", p2, "t3.events.jsonl"),
			"p2 more content\n",
		);

		const result = await migrateStorageLayout(dataDir);
		expect(result.projectsScanned).toBe(2);
		expect(result.filesMoved).toBe(3);

		expect(
			await readFile(
				join(dataDir, "projects", p1, "tasks", "t1.jsonl"),
				"utf-8",
			),
		).toBe("p1 content\n");
		expect(
			await readFile(
				join(dataDir, "projects", p2, "tasks", "t2.jsonl"),
				"utf-8",
			),
		).toBe("p2 content\n");
		expect(
			await readFile(
				join(dataDir, "projects", p2, "tasks", "t3.jsonl"),
				"utf-8",
			),
		).toBe("p2 more content\n");
	});

	test("is idempotent: second run is a no-op", async () => {
		const projectId = "idem-proj";
		await mkdir(join(dataDir, "sessions", projectId), { recursive: true });
		await writeFile(
			join(dataDir, "sessions", projectId, "task-x.events.jsonl"),
			"alpha\n",
		);

		const first = await migrateStorageLayout(dataDir);
		expect(first.filesMoved).toBe(1);

		// Second run: old dir is gone, so migrated=false
		const second = await migrateStorageLayout(dataDir);
		expect(second.migrated).toBe(false);
		expect(second.filesMoved).toBe(0);

		// Data is intact
		expect(
			await readFile(
				join(dataDir, "projects", projectId, "tasks", "task-x.jsonl"),
				"utf-8",
			),
		).toBe("alpha\n");
	});

	test("crash-safe: re-running with partial migration skips already-moved files", async () => {
		const projectId = "partial-proj";
		// Simulate partial: target file already exists, source still there
		await mkdir(join(dataDir, "sessions", projectId), { recursive: true });
		await mkdir(join(dataDir, "projects", projectId, "tasks"), {
			recursive: true,
		});

		// Source (old layout)
		await writeFile(
			join(dataDir, "sessions", projectId, "already.events.jsonl"),
			"stale-source\n",
		);
		// Destination (already migrated — trust this one)
		await writeFile(
			join(dataDir, "projects", projectId, "tasks", "already.jsonl"),
			"trusted-destination\n",
		);
		// Another file that still needs migration
		await writeFile(
			join(dataDir, "sessions", projectId, "fresh.events.jsonl"),
			"move-me\n",
		);

		const result = await migrateStorageLayout(dataDir);
		expect(result.filesMoved).toBe(1);
		expect(result.filesSkipped).toBe(1);

		// Destination content preserved (not overwritten with stale source)
		expect(
			await readFile(
				join(dataDir, "projects", projectId, "tasks", "already.jsonl"),
				"utf-8",
			),
		).toBe("trusted-destination\n");
		// Fresh file moved
		expect(
			await readFile(
				join(dataDir, "projects", projectId, "tasks", "fresh.jsonl"),
				"utf-8",
			),
		).toBe("move-me\n");

		// Source is cleaned up
		expect(
			existsSync(join(dataDir, "sessions", projectId, "already.events.jsonl")),
		).toBe(false);
		expect(
			existsSync(join(dataDir, "sessions", projectId, "fresh.events.jsonl")),
		).toBe(false);
	});

	test("creates tasks/ and debug/ dirs for each migrated project", async () => {
		const projectId = "with-dirs";
		await mkdir(join(dataDir, "sessions", projectId), { recursive: true });
		await writeFile(
			join(dataDir, "sessions", projectId, "task.events.jsonl"),
			"x\n",
		);

		await migrateStorageLayout(dataDir);

		expect(existsSync(join(dataDir, "projects", projectId, "tasks"))).toBe(
			true,
		);
		expect(existsSync(join(dataDir, "projects", projectId, "debug"))).toBe(
			true,
		);
	});

	test("leaves non-jsonl files alone", async () => {
		const projectId = "stray";
		const oldDir = join(dataDir, "sessions", projectId);
		await mkdir(oldDir, { recursive: true });
		await writeFile(join(oldDir, "valid.events.jsonl"), "ok\n");
		await writeFile(join(oldDir, "random.txt"), "not a jsonl\n");

		const result = await migrateStorageLayout(dataDir);
		expect(result.filesMoved).toBe(1);

		// Valid file migrated
		expect(
			existsSync(join(dataDir, "projects", projectId, "tasks", "valid.jsonl")),
		).toBe(true);

		// Stray file left in place; old dir NOT removed because it's non-empty
		expect(existsSync(join(oldDir, "random.txt"))).toBe(true);
		expect(existsSync(oldDir)).toBe(true);
	});

	test("empty project sessions dir is cleaned up", async () => {
		const projectId = "empty-proj";
		await mkdir(join(dataDir, "sessions", projectId), { recursive: true });

		const result = await migrateStorageLayout(dataDir);
		expect(result.projectsScanned).toBe(1);
		expect(result.filesMoved).toBe(0);

		// Empty project dir removed
		expect(existsSync(join(dataDir, "sessions", projectId))).toBe(false);
		// Sessions root removed since it became empty
		expect(existsSync(join(dataDir, "sessions"))).toBe(false);
	});

	test("preserves JSONL content byte-for-byte", async () => {
		const projectId = "byte-proj";
		await mkdir(join(dataDir, "sessions", projectId), { recursive: true });
		// JSONL content with unicode, quotes, embedded newlines in JSON strings
		const content =
			'{"type":"assistant_text","content":"hello 你好 \\"quoted\\" \\n embedded","ts":1000}\n' +
			'{"type":"tool_call","tool":"bash","input":{"command":"echo x"},"ts":1001}\n';
		await writeFile(
			join(dataDir, "sessions", projectId, "roundtrip.events.jsonl"),
			content,
		);

		await migrateStorageLayout(dataDir);

		const migrated = await readFile(
			join(dataDir, "projects", projectId, "tasks", "roundtrip.jsonl"),
			"utf-8",
		);
		expect(migrated).toBe(content);
	});

	test("handles already-.jsonl files in old layout (previous rename)", async () => {
		// Edge case: if a previous partial migration renamed files inside sessions/,
		// we should still move them.
		const projectId = "prev-partial";
		const oldDir = join(dataDir, "sessions", projectId);
		await mkdir(oldDir, { recursive: true });
		await writeFile(join(oldDir, "already-renamed.jsonl"), "content\n");

		const result = await migrateStorageLayout(dataDir);
		expect(result.filesMoved).toBe(1);

		expect(
			await readFile(
				join(dataDir, "projects", projectId, "tasks", "already-renamed.jsonl"),
				"utf-8",
			),
		).toBe("content\n");
	});

	test("does not touch new layout files (projects/<id>/tasks/)", async () => {
		// If there's no sessions/ at all but the new layout exists, nothing happens.
		const projectId = "new-layout";
		await mkdir(join(dataDir, "projects", projectId, "tasks"), {
			recursive: true,
		});
		await writeFile(
			join(dataDir, "projects", projectId, "tasks", "existing.jsonl"),
			"keep\n",
		);

		const result = await migrateStorageLayout(dataDir);
		expect(result.migrated).toBe(false);

		// Untouched
		expect(
			await readFile(
				join(dataDir, "projects", projectId, "tasks", "existing.jsonl"),
				"utf-8",
			),
		).toBe("keep\n");
	});

	test("keeps a tasks/ dir around after migration so EventStore can find it", async () => {
		// Regression: EventStore constructor creates the dir if missing, but we
		// should create it up front so downstream code that does existsSync checks
		// before the store is instantiated sees it.
		const projectId = "dir-exists";
		await mkdir(join(dataDir, "sessions", projectId), { recursive: true });
		await writeFile(
			join(dataDir, "sessions", projectId, "t.events.jsonl"),
			"x\n",
		);

		await migrateStorageLayout(dataDir);

		const tasksDir = join(dataDir, "projects", projectId, "tasks");
		const entries = await readdir(tasksDir);
		expect(entries).toContain("t.jsonl");
	});
});
