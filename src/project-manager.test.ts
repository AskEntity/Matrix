import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "./project-manager.ts";

describe("ProjectManager", () => {
	let tempDir: string;
	let dataDir: string;
	let pm: ProjectManager;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-test-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-data-"));
		pm = new ProjectManager(dataDir);
		await pm.load();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	describe("init — registry only", () => {
		test("registers project and returns metadata", async () => {
			const projectPath = join(tempDir, "new-app");
			await mkdir(projectPath, { recursive: true });
			const project = await pm.init(projectPath);

			expect(project.name).toBe("new-app");
			expect(project.path).toBe(projectPath);
			expect(project.id).toBeTruthy();
			expect(project.createdAt).toBeTruthy();
		});

		test("does NOT eagerly create tasks/debug (lazy creation respects plugin dataRoot)", async () => {
			// After Audit FU5: project-manager no longer eagerly creates
			// tasks/ and debug/ at the Matrix hardcoded location. EventStore
			// and TaskTracker create them on first write, at the plugin's
			// dataRoot. Pre-creating here produced stale empty dirs at the
			// wrong path for any plugin with `dataRoot !== "@"`.
			const projectPath = join(tempDir, "no-eager");
			await mkdir(projectPath, { recursive: true });
			const project = await pm.init(projectPath);

			expect(existsSync(join(dataDir, "projects", project.id, "tasks"))).toBe(
				false,
			);
			expect(existsSync(join(dataDir, "projects", project.id, "debug"))).toBe(
				false,
			);
		});

		test("does NOT create .mxd/ or .git in project path", async () => {
			const projectPath = join(tempDir, "no-fs");
			await mkdir(projectPath, { recursive: true });
			await pm.init(projectPath);

			// pm.init() should not touch the project directory
			expect(existsSync(join(projectPath, ".mxd"))).toBe(false);
			expect(existsSync(join(projectPath, ".git"))).toBe(false);
		});

		test("rejects non-existent path (Audit R7 P2.6)", async () => {
			// Old contract: any path was accepted; matrix's onProjectInit
			// did `mkdir({recursive: true})` + git init, silently creating
			// a ghost project tree from a user typo.
			//
			// New contract: path must exist. Matches `updateProject`'s
			// existing check. Two-layer defence: ProjectManager rejects
			// here; matrix plugin also rejects inside onProjectInit.
			const projectPath = join(tempDir, "not-yet");
			expect(pm.init(projectPath)).rejects.toThrow(/does not exist/);
			expect(existsSync(projectPath)).toBe(false);
		});
	});

	describe("absolute path enforcement", () => {
		test("init rejects relative paths", async () => {
			expect(pm.init("my-project")).rejects.toThrow(
				/must be absolute.*my-project/,
			);
		});

		test("init rejects paths starting with ./", async () => {
			expect(pm.init("./relative")).rejects.toThrow(/must be absolute/);
		});

		test("init accepts absolute paths", async () => {
			const projectPath = join(tempDir, "absolute-ok");
			await mkdir(projectPath, { recursive: true });
			const project = await pm.init(projectPath);
			expect(project.path).toBe(projectPath);
		});

		test("updateProject rejects relative paths", async () => {
			const projectPath = join(tempDir, "for-update");
			await mkdir(projectPath, { recursive: true });
			const project = await pm.init(projectPath);
			expect(
				pm.updateProject(project.id, { path: "relative-new" }),
			).rejects.toThrow(/must be absolute.*relative-new/);
		});
	});

	test("rejects duplicate path registration", async () => {
		const projectPath = join(tempDir, "dup");
		await mkdir(projectPath, { recursive: true });
		await pm.init(projectPath);
		expect(pm.init(projectPath)).rejects.toThrow("already registered");
	});

	test("list returns all projects", async () => {
		await mkdir(join(tempDir, "a"), { recursive: true });
		await mkdir(join(tempDir, "b"), { recursive: true });
		await pm.init(join(tempDir, "a"));
		await pm.init(join(tempDir, "b"));

		const list = pm.list();
		expect(list).toHaveLength(2);
		expect(list.map((p) => p.name).sort()).toEqual(["a", "b"]);
	});

	test("get returns project by id", async () => {
		await mkdir(join(tempDir, "find-me"), { recursive: true });
		const project = await pm.init(join(tempDir, "find-me"));
		const found = pm.get(project.id);
		expect(found?.name).toBe("find-me");
	});

	test("delete removes metadata and daemon data dir", async () => {
		await mkdir(join(tempDir, "delete-me"), { recursive: true });
		const project = await pm.init(join(tempDir, "delete-me"));
		const projectDataDir = join(dataDir, "projects", project.id);
		// Simulate lazy dir creation that normally happens when EventStore /
		// TaskTracker write. Audit FU5 removed pm.init's eager mkdir.
		await mkdir(join(projectDataDir, "tasks"), { recursive: true });
		expect(existsSync(projectDataDir)).toBe(true);

		await pm.delete(project.id);

		expect(pm.get(project.id)).toBeUndefined();
		// Project directory on disk is NOT touched
		expect(existsSync(project.path)).toBe(true);
		// Daemon data dir IS removed
		expect(existsSync(projectDataDir)).toBe(false);
	});

	test("persists and reloads across instances", async () => {
		await mkdir(join(tempDir, "persistent"), { recursive: true });
		await pm.init(join(tempDir, "persistent"));

		const pm2 = new ProjectManager(dataDir);
		await pm2.load();

		const list = pm2.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.name).toBe("persistent");
	});

	describe("checkPathExists", () => {
		test("returns true when project path exists", async () => {
			await mkdir(join(tempDir, "exists"), { recursive: true });
			const project = await pm.init(join(tempDir, "exists"));
			expect(pm.checkPathExists(project.id)).toBe(true);
		});

		test("returns false when project path is missing", async () => {
			const projectPath = join(tempDir, "will-vanish");
			await mkdir(projectPath, { recursive: true });
			const project = await pm.init(projectPath);
			await rm(project.path, { recursive: true });
			expect(pm.checkPathExists(project.id)).toBe(false);
		});

		test("returns false for unknown project id", () => {
			expect(pm.checkPathExists("nonexistent")).toBe(false);
		});
	});

	describe("updateProject", () => {
		test("updates project path to a valid mxd directory", async () => {
			await mkdir(join(tempDir, "original"), { recursive: true });
			const project = await pm.init(join(tempDir, "original"));
			const newPath = join(tempDir, "relocated");
			await mkdir(join(newPath, ".mxd"), { recursive: true });

			const updated = await pm.updateProject(project.id, { path: newPath });
			expect(updated.path).toBe(newPath);
			expect(pm.get(project.id)?.path).toBe(newPath);
		});

		test("updates project name", async () => {
			await mkdir(join(tempDir, "old-name"), { recursive: true });
			const project = await pm.init(join(tempDir, "old-name"));
			const updated = await pm.updateProject(project.id, {
				name: "new-name",
			});
			expect(updated.name).toBe("new-name");
		});

		test("updates both path and name", async () => {
			await mkdir(join(tempDir, "both"), { recursive: true });
			const project = await pm.init(join(tempDir, "both"));
			const newPath = join(tempDir, "both-new");
			await mkdir(join(newPath, ".mxd"), { recursive: true });

			const updated = await pm.updateProject(project.id, {
				path: newPath,
				name: "renamed",
			});
			expect(updated.path).toBe(newPath);
			expect(updated.name).toBe("renamed");
		});

		test("rejects nonexistent path", async () => {
			await mkdir(join(tempDir, "reject-path"), { recursive: true });
			const project = await pm.init(join(tempDir, "reject-path"));
			expect(
				pm.updateProject(project.id, {
					path: join(tempDir, "does-not-exist"),
				}),
			).rejects.toThrow("Path does not exist");
		});

		test("rejects path without .mxd/ directory", async () => {
			await mkdir(join(tempDir, "reject-mxd"), { recursive: true });
			const project = await pm.init(join(tempDir, "reject-mxd"));
			const badPath = join(tempDir, "no-mxd");
			await mkdir(badPath, { recursive: true });

			expect(pm.updateProject(project.id, { path: badPath })).rejects.toThrow(
				"missing .mxd/ directory",
			);
		});

		test("rejects path already used by another project", async () => {
			await mkdir(join(tempDir, "proj-a"), { recursive: true });
			await mkdir(join(tempDir, "proj-b", ".mxd"), { recursive: true });
			const projectA = await pm.init(join(tempDir, "proj-a"));
			await pm.init(join(tempDir, "proj-b"));

			expect(
				pm.updateProject(projectA.id, {
					path: join(tempDir, "proj-b"),
				}),
			).rejects.toThrow("already used by project");
		});

		test("rejects unknown project id", async () => {
			expect(pm.updateProject("nonexistent", { name: "foo" })).rejects.toThrow(
				"Project not found",
			);
		});

		test("persists updated path across reload", async () => {
			await mkdir(join(tempDir, "persist-update"), { recursive: true });
			const project = await pm.init(join(tempDir, "persist-update"));
			const newPath = join(tempDir, "persist-new");
			await mkdir(join(newPath, ".mxd"), { recursive: true });

			await pm.updateProject(project.id, { path: newPath });

			const pm2 = new ProjectManager(dataDir);
			await pm2.load();
			expect(pm2.get(project.id)?.path).toBe(newPath);
		});
	});

	// syncFromDaemon deleted — worker uses ProjectStore.sync(), not PM.
});
