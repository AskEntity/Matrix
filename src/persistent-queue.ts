/**
 * Persistent message queue — write-through to disk so messages survive daemon restart.
 *
 * Storage format: JSON array of QueueMessage objects at
 * `<dataDir>/messages/<projectId>/<taskId>.json`
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { QueueMessage } from "./message-queue.ts";

/** Build the path for a task's persisted message file. */
function messagePath(
	dataDir: string,
	projectId: string,
	taskId: string,
): string {
	return join(dataDir, "messages", projectId, `${taskId}.json`);
}

/**
 * Append a message to the persisted queue on disk.
 * Write-through: reads existing array, appends, writes back.
 */
export async function persistMessage(
	dataDir: string,
	projectId: string,
	taskId: string,
	msg: QueueMessage,
): Promise<void> {
	const filePath = messagePath(dataDir, projectId, taskId);
	await mkdir(dirname(filePath), { recursive: true });

	let existing: QueueMessage[] = [];
	try {
		const raw = await readFile(filePath, "utf-8");
		existing = JSON.parse(raw) as QueueMessage[];
	} catch {
		// File doesn't exist yet — start with empty array
	}

	existing.push(msg);
	await writeFile(filePath, JSON.stringify(existing), "utf-8");
}

/**
 * Load all persisted messages for a task. Returns empty array if no file exists.
 */
export async function loadPersistedMessages(
	dataDir: string,
	projectId: string,
	taskId: string,
): Promise<QueueMessage[]> {
	const filePath = messagePath(dataDir, projectId, taskId);
	try {
		const raw = await readFile(filePath, "utf-8");
		return JSON.parse(raw) as QueueMessage[];
	} catch {
		return [];
	}
}

/**
 * Delete the persisted messages file for a task.
 */
export async function clearPersistedMessages(
	dataDir: string,
	projectId: string,
	taskId: string,
): Promise<void> {
	const filePath = messagePath(dataDir, projectId, taskId);
	try {
		await rm(filePath);
	} catch {
		// File may not exist — that's fine
	}
}
