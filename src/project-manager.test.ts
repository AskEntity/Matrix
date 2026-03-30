import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectManager } from "./project-manager.ts";

describe("ProjectManager", () => {
	let tempDir: string;
	let dataDir: string;
	let pm: ProjectManager;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "og-test-"));
		dataDir = await mkdtemp(join(tmpdir(), "og-data-"));
		pm = new ProjectManager(dataDir);
		await pm.load();
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true });
		await rm(dataDir, { recursive: true });
	});

	describe("init — new directory", () => {
		test("creates directory structure with .opengraft/memory.md and git", async () => {
			const projectPath = join(tempDir, "new-app");
			const project = await pm.init(projectPath);

			expect(project.name).toBe("new-app");
			expect(project.path).toBe(projectPath);
			expect(existsSync(join(projectPath, ".opengraft", "memory.md"))).toBe(
				true,
			);
			expect(existsSync(join(projectPath, ".git"))).toBe(true);
			expect(existsSync(join(projectPath, "src"))).toBe(true);
			expect(existsSync(join(projectPath, ".gitignore"))).toBe(true);
		});

		test("new project memory has scratch pad content", async () => {
			const projectPath = join(tempDir, "fresh");
			await pm.init(projectPath);

			const memory = await readFile(
				join(projectPath, ".opengraft", "memory.md"),
				"utf-8",
			);
			expect(memory).toContain("scratch pad");
		});

		test("new project memory includes critical first-launch bootstrap", async () => {
			const projectPath = join(tempDir, "bootstrap");
			await pm.init(projectPath);

			const memory = await readFile(
				join(projectPath, ".opengraft", "memory.md"),
				"utf-8",
			);
			expect(memory).toContain("CRITICAL: First Launch Setup");
			expect(memory).toContain("setup_worktree.sh.example");
			expect(memory).toContain("DO THIS FIRST");
		});

		test("creates setup hook as .example template", async () => {
			const projectPath = join(tempDir, "hook-test");
			await pm.init(projectPath);

			const examplePath = join(
				projectPath,
				".opengraft",
				"hooks",
				"setup_worktree.sh.example",
			);
			const finalPath = join(
				projectPath,
				".opengraft",
				"hooks",
				"setup_worktree.sh",
			);
			expect(existsSync(examplePath)).toBe(true);
			expect(existsSync(finalPath)).toBe(false);
			const content = await readFile(examplePath, "utf-8");
			expect(content).toContain("#!/bin/bash");
		});
	});

	describe("init — existing directory", () => {
		test("converts existing directory without overwriting files", async () => {
			const projectPath = join(tempDir, "existing-app");
			await mkdir(projectPath, { recursive: true });
			await writeFile(join(projectPath, "README.md"), "# My App\n", "utf-8");

			const project = await pm.init(projectPath);

			expect(project.name).toBe("existing-app");
			// Original file preserved
			const readme = await readFile(join(projectPath, "README.md"), "utf-8");
			expect(readme).toBe("# My App\n");
			// .opengraft/ created
			expect(existsSync(join(projectPath, ".opengraft", "memory.md"))).toBe(
				true,
			);
		});

		test("converted project memory says to explore codebase", async () => {
			const projectPath = join(tempDir, "convert-me");
			await mkdir(projectPath, { recursive: true });

			await pm.init(projectPath);

			const memory = await readFile(
				join(projectPath, ".opengraft", "memory.md"),
				"utf-8",
			);
			expect(memory).toContain("Converted existing project");
			expect(memory).toContain("Check existing documentation");
			expect(memory).not.toContain("CLAUDE.md");
		});

		test("creates setup hook with bun install when bun.lockb exists", async () => {
			const projectPath = join(tempDir, "bun-project");
			await mkdir(projectPath, { recursive: true });
			await writeFile(join(projectPath, "bun.lockb"), "", "utf-8");

			await pm.init(projectPath);

			const hookPath = join(
				projectPath,
				".opengraft",
				"hooks",
				"setup_worktree.sh.example",
			);
			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("bun install --frozen-lockfile");
		});

		test("creates setup hook with npm ci when package-lock.json exists", async () => {
			const projectPath = join(tempDir, "npm-project");
			await mkdir(projectPath, { recursive: true });
			await writeFile(join(projectPath, "package-lock.json"), "{}", "utf-8");

			await pm.init(projectPath);

			const hookPath = join(
				projectPath,
				".opengraft",
				"hooks",
				"setup_worktree.sh.example",
			);
			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("npm ci");
		});

		test("does not create .example when setup_worktree.sh already exists", async () => {
			const projectPath = join(tempDir, "has-hook");
			const hookDir = join(projectPath, ".opengraft", "hooks");
			await mkdir(hookDir, { recursive: true });
			await writeFile(
				join(hookDir, "setup_worktree.sh"),
				"#!/bin/bash\nexit 0\n",
				"utf-8",
			);

			await pm.init(projectPath);

			expect(existsSync(join(hookDir, "setup_worktree.sh.example"))).toBe(
				false,
			);
			// Original hook preserved
			const content = await readFile(
				join(hookDir, "setup_worktree.sh"),
				"utf-8",
			);
			expect(content).toBe("#!/bin/bash\nexit 0\n");
		});

		test("does not overwrite existing .opengraft/memory.md", async () => {
			const projectPath = join(tempDir, "has-memory");
			await mkdir(join(projectPath, ".opengraft"), { recursive: true });
			await writeFile(
				join(projectPath, ".opengraft", "memory.md"),
				"# Custom memory\n",
				"utf-8",
			);

			await pm.init(projectPath);

			const memory = await readFile(
				join(projectPath, ".opengraft", "memory.md"),
				"utf-8",
			);
			expect(memory).toBe("# Custom memory\n");
		});

		test("does not re-init git if .git exists", async () => {
			const projectPath = join(tempDir, "has-git");
			await mkdir(projectPath, { recursive: true });
			// Init git with a commit so we can verify it wasn't wiped
			const exec = async (cmd: string[]) => {
				const proc = Bun.spawn(cmd, {
					cwd: projectPath,
					stdout: "pipe",
					stderr: "pipe",
				});
				await proc.exited;
			};
			await exec(["git", "init"]);
			await writeFile(join(projectPath, "file.txt"), "hello\n", "utf-8");
			await exec(["git", "add", "-A"]);
			await exec(["git", "commit", "-m", "existing commit"]);

			await pm.init(projectPath);

			// Verify existing commit is still there
			const proc = Bun.spawn(["git", "log", "--oneline"], {
				cwd: projectPath,
				stdout: "pipe",
			});
			const log = await new Response(proc.stdout).text();
			expect(log).toContain("existing commit");
		});
	});

	describe("git exclude — .worktrees", () => {
		test("new project has .worktrees in .git/info/exclude", async () => {
			const projectPath = join(tempDir, "new-exclude");
			await pm.init(projectPath);

			const exclude = await readFile(
				join(projectPath, ".git", "info", "exclude"),
				"utf-8",
			);
			expect(exclude).toContain(".worktrees");
		});

		test("existing project gets .worktrees in .git/info/exclude", async () => {
			const projectPath = join(tempDir, "existing-exclude");
			await mkdir(projectPath, { recursive: true });
			// Init git manually
			const proc = Bun.spawn(["git", "init"], {
				cwd: projectPath,
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;

			await pm.init(projectPath);

			const exclude = await readFile(
				join(projectPath, ".git", "info", "exclude"),
				"utf-8",
			);
			expect(exclude).toContain(".worktrees");
		});

		test("does not duplicate .worktrees if already in exclude", async () => {
			const projectPath = join(tempDir, "no-dup-exclude");
			await mkdir(projectPath, { recursive: true });
			const proc = Bun.spawn(["git", "init"], {
				cwd: projectPath,
				stdout: "pipe",
				stderr: "pipe",
			});
			await proc.exited;

			// Pre-add .worktrees to exclude
			const excludePath = join(projectPath, ".git", "info", "exclude");
			const existing = await readFile(excludePath, "utf-8");
			await writeFile(excludePath, `${existing}.worktrees\n`, "utf-8");

			await pm.init(projectPath);

			const exclude = await readFile(excludePath, "utf-8");
			const matches = exclude.match(/\.worktrees/g);
			expect(matches).toHaveLength(1);
		});
	});

	test("rejects duplicate path registration", async () => {
		const projectPath = join(tempDir, "dup");
		await pm.init(projectPath);
		expect(pm.init(projectPath)).rejects.toThrow("already registered");
	});

	test("list returns all projects", async () => {
		await pm.init(join(tempDir, "a"));
		await pm.init(join(tempDir, "b"));

		const list = pm.list();
		expect(list).toHaveLength(2);
		expect(list.map((p) => p.name).sort()).toEqual(["a", "b"]);
	});

	test("get returns project by id", async () => {
		const project = await pm.init(join(tempDir, "find-me"));
		const found = pm.get(project.id);
		expect(found?.name).toBe("find-me");
	});

	test("delete removes metadata but not code directory", async () => {
		const project = await pm.init(join(tempDir, "delete-me"));
		await pm.delete(project.id);

		expect(pm.get(project.id)).toBeUndefined();
		expect(existsSync(project.path)).toBe(true);
	});

	test("persists and reloads across instances", async () => {
		await pm.init(join(tempDir, "persistent"));

		const pm2 = new ProjectManager(dataDir);
		await pm2.load();

		const list = pm2.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.name).toBe("persistent");
	});

	describe("checkPathExists", () => {
		test("returns true when project path exists", async () => {
			const project = await pm.init(join(tempDir, "exists"));
			expect(pm.checkPathExists(project.id)).toBe(true);
		});

		test("returns false when project path is missing", async () => {
			const project = await pm.init(join(tempDir, "will-vanish"));
			// Remove the project directory
			await rm(project.path, { recursive: true });
			expect(pm.checkPathExists(project.id)).toBe(false);
		});

		test("returns false for unknown project id", () => {
			expect(pm.checkPathExists("nonexistent")).toBe(false);
		});
	});

	describe("updateProject", () => {
		test("updates project path to a valid opengraft directory", async () => {
			const project = await pm.init(join(tempDir, "original"));
			// Create a new directory with .opengraft/
			const newPath = join(tempDir, "relocated");
			await mkdir(join(newPath, ".opengraft"), { recursive: true });

			const updated = await pm.updateProject(project.id, { path: newPath });
			expect(updated.path).toBe(newPath);
			expect(pm.get(project.id)?.path).toBe(newPath);
		});

		test("updates project name", async () => {
			const project = await pm.init(join(tempDir, "old-name"));
			const updated = await pm.updateProject(project.id, {
				name: "new-name",
			});
			expect(updated.name).toBe("new-name");
		});

		test("updates both path and name", async () => {
			const project = await pm.init(join(tempDir, "both"));
			const newPath = join(tempDir, "both-new");
			await mkdir(join(newPath, ".opengraft"), { recursive: true });

			const updated = await pm.updateProject(project.id, {
				path: newPath,
				name: "renamed",
			});
			expect(updated.path).toBe(newPath);
			expect(updated.name).toBe("renamed");
		});

		test("rejects nonexistent path", async () => {
			const project = await pm.init(join(tempDir, "reject-path"));
			expect(
				pm.updateProject(project.id, {
					path: join(tempDir, "does-not-exist"),
				}),
			).rejects.toThrow("Path does not exist");
		});

		test("rejects path without .opengraft/ directory", async () => {
			const project = await pm.init(join(tempDir, "reject-og"));
			const badPath = join(tempDir, "no-opengraft");
			await mkdir(badPath, { recursive: true });

			expect(pm.updateProject(project.id, { path: badPath })).rejects.toThrow(
				"missing .opengraft/ directory",
			);
		});

		test("rejects path already used by another project", async () => {
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
			const project = await pm.init(join(tempDir, "persist-update"));
			const newPath = join(tempDir, "persist-new");
			await mkdir(join(newPath, ".opengraft"), { recursive: true });

			await pm.updateProject(project.id, { path: newPath });

			const pm2 = new ProjectManager(dataDir);
			await pm2.load();
			expect(pm2.get(project.id)?.path).toBe(newPath);
		});
	});
});
