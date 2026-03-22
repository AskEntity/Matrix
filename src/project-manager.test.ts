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

		test("new project memory includes first-launch bootstrap", async () => {
			const projectPath = join(tempDir, "bootstrap");
			await pm.init(projectPath);

			const memory = await readFile(
				join(projectPath, ".opengraft", "memory.md"),
				"utf-8",
			);
			expect(memory).toContain("setup_worktree.sh");
		});

		test("creates setup hook with template content", async () => {
			const projectPath = join(tempDir, "hook-test");
			await pm.init(projectPath);

			const hookPath = join(
				projectPath,
				".opengraft",
				"hooks",
				"setup_worktree.sh",
			);
			expect(existsSync(hookPath)).toBe(true);
			const content = await readFile(hookPath, "utf-8");
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
				"setup_worktree.sh",
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
				"setup_worktree.sh",
			);
			const content = await readFile(hookPath, "utf-8");
			expect(content).toContain("npm ci");
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
});
