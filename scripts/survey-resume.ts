#!/usr/bin/env bun
/**
 * One-off survey: for every in_progress task node across every project/scope,
 * read its ACTIVE chain and report what the resume path would find — the tail
 * shape, the unconsumed messages and their sources.
 *
 * Deliberately a raw dump — no classification, no heuristics. The point is to
 * see the real shapes before deciding what the launch predicate must key on.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/event-store.ts";
import { type Event, findUnconsumedMessages } from "../src/events.ts";

const ROOT = join(homedir(), ".mxd", "projects");
const TAIL = Number(process.argv[2] ?? 10);

type Node = { id: string; type?: string; status?: string; title?: string };

/** Event types that carry conversation content (what the walker turns into messages). */
const CONTENT = new Set([
	"assistant_text",
	"thinking",
	"tool_call",
	"tool_result",
	"messages_consumed",
]);

let total = 0;
for (const projectId of readdirSync(ROOT)) {
	const pluginDir = join(ROOT, projectId, "plugin");
	if (!existsSync(pluginDir)) continue;
	for (const scope of readdirSync(pluginDir)) {
		const scopeDir = join(pluginDir, scope);
		const treePath = join(scopeDir, "tree.json");
		if (!existsSync(treePath)) continue;
		const raw = await Bun.file(treePath).json();
		const nodes: Node[] = Array.isArray(raw) ? raw : (raw.nodes ?? []);
		const tasksDir = join(scopeDir, "tasks");
		if (!existsSync(tasksDir)) continue;
		const store = new EventStore(tasksDir);

		for (const n of nodes) {
			if (n.status !== "in_progress") continue;
			if (n.type && n.type !== "task") continue;
			total++;
			let active: Event[] = [];
			try {
				active = store.readActive(n.id);
			} catch (e) {
				console.log(`${n.id} READ FAILED: ${(e as Error).message}`);
				continue;
			}
			const last = active[active.length - 1];
			const ageH = last?.ts
				? ((Date.now() - last.ts) / 3600_000).toFixed(0)
				: "?";
			const contentTail = active
				.filter((e) => CONTENT.has(e.type))
				.slice(-TAIL)
				.map((e) =>
					e.type === "tool_call"
						? `tool_call(${(e as { tool: string }).tool.replace("mcp__mxd__", "")})`
						: e.type,
				)
				.join(" → ");
			const unconsumed = findUnconsumedMessages(active);
			const bySource = new Map<string, number>();
			for (const m of unconsumed)
				bySource.set(m.source, (bySource.get(m.source) ?? 0) + 1);
			const srcStr =
				unconsumed.length === 0
					? "(none)"
					: [...bySource].map(([s, c]) => `${s}×${c}`).join(", ");
			console.log(
				`\n== ${scope}:${projectId.slice(0, 10)} ${n.id} "${(n.title ?? "").slice(0, 46)}"`,
			);
			console.log(`   active=${active.length} lastEventAge=${ageH}h`);
			console.log(`   content tail: ${contentTail || "(no content events)"}`);
			console.log(`   unconsumed:   ${srcStr}`);
		}
	}
}
console.log(`\n\nTOTAL in_progress task nodes: ${total}`);
