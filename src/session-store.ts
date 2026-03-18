import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class SessionStore {
	private cache = new Map<string, unknown[]>();

	constructor(private sessionsDir: string) {}

	async get(sessionId: string, suffix?: string): Promise<unknown[] | null> {
		const key = this.cacheKey(sessionId, suffix);
		const cached = this.cache.get(key);
		if (cached) return cached;
		const filePath = this.filePath(sessionId, suffix);
		try {
			const data = await readFile(filePath, "utf-8");
			const history = JSON.parse(data) as unknown[];
			this.cache.set(key, history);
			return history;
		} catch {
			return null;
		}
	}

	async set(
		sessionId: string,
		messages: unknown[],
		suffix?: string,
	): Promise<void> {
		const key = this.cacheKey(sessionId, suffix);
		this.cache.set(key, messages);
		try {
			await mkdir(this.sessionsDir, { recursive: true });
			await writeFile(
				this.filePath(sessionId, suffix),
				JSON.stringify(messages),
				"utf-8",
			);
		} catch {
			/* non-fatal */
		}
	}

	setSync(sessionId: string, messages: unknown[], suffix?: string): void {
		const key = this.cacheKey(sessionId, suffix);
		this.cache.set(key, messages);
		mkdir(this.sessionsDir, { recursive: true })
			.then(() =>
				writeFile(
					this.filePath(sessionId, suffix),
					JSON.stringify(messages),
					"utf-8",
				),
			)
			.catch(() => {});
	}

	async clear(sessionId: string): Promise<void> {
		for (const key of this.cache.keys()) {
			if (key === sessionId || key.startsWith(`${sessionId}.`)) {
				this.cache.delete(key);
			}
		}
		try {
			const files = await readdir(this.sessionsDir);
			const toDelete = files.filter(
				(f) => f.startsWith(`${sessionId}.`) && f.endsWith(".json"),
			);
			await Promise.all(
				toDelete.map((f) => rm(join(this.sessionsDir, f), { force: true })),
			);
		} catch {
			/* ok */
		}
	}

	async clearAll(): Promise<void> {
		this.cache.clear();
		try {
			await rm(this.sessionsDir, { recursive: true, force: true });
			await mkdir(this.sessionsDir, { recursive: true });
		} catch {
			/* ok */
		}
	}

	has(sessionId: string, suffix?: string): boolean {
		const key = this.cacheKey(sessionId, suffix);
		if (this.cache.has(key)) return true;
		return existsSync(this.filePath(sessionId, suffix));
	}

	/** Check if ANY suffix variant exists for this sessionId */
	hasAny(sessionId: string): boolean {
		// Check cache
		for (const key of this.cache.keys()) {
			if (key === sessionId || key.startsWith(`${sessionId}.`)) return true;
		}
		// Check disk
		try {
			if (existsSync(join(this.sessionsDir, `${sessionId}.json`))) return true;
			if (existsSync(join(this.sessionsDir, `${sessionId}.openai.json`)))
				return true;
		} catch {
			/* */
		}
		return false;
	}

	private cacheKey(id: string, suffix?: string): string {
		return suffix ? `${id}.${suffix}` : id;
	}

	private filePath(id: string, suffix?: string): string {
		return join(
			this.sessionsDir,
			suffix ? `${id}.${suffix}.json` : `${id}.json`,
		);
	}
}
