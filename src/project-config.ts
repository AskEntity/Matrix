import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ProjectConfig {
	model?: string;
	childModel?: string;
	provider?: string;
	budgetUsd?: number;
	clarifyTimeoutMs?: number;
	maxDepth?: number;
}

export async function loadProjectConfig(
	dataDir: string,
	projectId: string,
): Promise<ProjectConfig> {
	const path = join(dataDir, "projects", projectId, "config.json");
	try {
		return JSON.parse(await readFile(path, "utf-8"));
	} catch {
		return {};
	}
}

export async function saveProjectConfig(
	dataDir: string,
	projectId: string,
	config: ProjectConfig,
): Promise<void> {
	const path = join(dataDir, "projects", projectId, "config.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(config, null, "\t"), "utf-8");
}

export async function mergeProjectConfig(
	dataDir: string,
	projectId: string,
	partial: Partial<ProjectConfig>,
): Promise<ProjectConfig> {
	const existing = await loadProjectConfig(dataDir, projectId);
	const merged = { ...existing };
	for (const [k, v] of Object.entries(partial)) {
		if (v === null || v === undefined)
			delete (merged as Record<string, unknown>)[k];
		else (merged as Record<string, unknown>)[k] = v;
	}
	await saveProjectConfig(dataDir, projectId, merged);
	return merged;
}
