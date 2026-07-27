/**
 * A message must carry text. Images alone are not sendable.
 *
 * The backend is the boundary, and it has TWO doors — a rule enforced at one
 * of them is enforced nowhere, because the other one accepts the same payload:
 *
 *   - `POST /projects/:id/tasks/:nodeId/message`  (src/runtime/routes/tasks.ts)
 *   - `POST /projects/:id/tasks/:nodeId/edit`     (.mxd/plugin/runtime.ts)
 *
 * Both are exercised here against one app, so "I closed the door" cannot mean
 * "I closed a door".
 *
 * ⚠️ This inverts a behaviour that was deliberately built (`6be3a829` in the
 * composer, `10da7d33` at both REST doors) and then never codified — the only
 * test either commit touched asserted the TEXT OF THE REJECTION MESSAGE, which
 * survives the behaviour being inverted. So there was nothing to flip here and
 * these tests are new. Do not read a green suite from before this file as
 * evidence that image-only used to be pinned.
 *
 * The regression bar is the other half and it is the one that breaks under a
 * careless guard: text WITH images must still go through, at both doors.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "./agent-provider.ts";
import type { Event } from "./events.ts";
import { MessageQueue } from "./message-queue.ts";
import { getEventStore } from "./runtime/helpers.ts";
import { createMatrixApp } from "./test-utils/create-matrix-app.ts";
import { TOOL_YIELD } from "./tool-names.ts";
import { ulid } from "./ulid.ts";

/**
 * The requirement, worded once. Both doors answer with it, and this constant
 * is what keeps them from drifting apart — a user who hits one door and then
 * the other should not be told two different things about one rule.
 */
const TEXT_REQUIRED = "Message text is required — images alone cannot be sent";

/** 1×1 transparent PNG. */
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const oneImage = () => [{ base64: TINY_PNG, mediaType: "image/png" }];

const mockProvider: AgentProvider = {
	name: "mock",
	execute: async () => ({
		exitReason: "interrupted" as const,
		output: "",
		costUsd: 0,
		turns: 0,
		sessionId: "mock-session",
	}),
	// biome-ignore lint/correctness/useYield: mock provider — drains then exits
	stream: async function* (req) {
		const queue = req.queue ?? new MessageQueue();
		if (queue.pending > 0) queue.drain();
		return {
			exitReason: "interrupted" as const,
			output: "",
			costUsd: 0,
			turns: 0,
			sessionId: "mock-session",
		};
	},
};

describe("an image needs text — both REST doors", () => {
	let tempDir: string;
	let dataDir: string;
	let app: ReturnType<typeof createMatrixApp>["app"];
	let ctx: ReturnType<typeof createMatrixApp>["ctx"];
	let shutdown: ReturnType<typeof createMatrixApp>["shutdown"];
	let projectId: string;
	let rootNodeId: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "mxd-imgtext-"));
		dataDir = await mkdtemp(join(tmpdir(), "mxd-imgtext-data-"));
		const { registerRoutes } = await import("../.mxd/plugin/runtime.ts");
		const project = {
			id: ulid(),
			name: "img-text",
			path: join(tempDir, "img-text"),
		};
		const result = createMatrixApp({
			dataDir,
			agentProvider: mockProvider,
			projects: [project],
			registerPluginRoutes: registerRoutes,
		});
		app = result.app;
		ctx = result.ctx;
		shutdown = result.shutdown;
		result.markReady();
		projectId = project.id;
		rootNodeId = (await result.getTracker(projectId)).rootNodeId;
	});

	afterEach(async () => {
		// Shut down BEFORE removing the dirs: an accepted message launches an
		// agent whose fire-and-forget tracker.save otherwise races the rm.
		await shutdown();
		await rm(tempDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	});

	function post(path: string, body: unknown) {
		return app.request(`/projects/${projectId}/tasks/${rootNodeId}/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	/**
	 * A parked session with one user message that started a run — the shape
	 * `/edit` accepts. Returns the eid of that message.
	 */
	async function seedEditableMessage(): Promise<string> {
		const store = getEventStore(ctx, projectId);
		const ts = Date.now();
		const events: Event[] = [
			{ type: "assistant_text", content: "on it", taskId: rootNodeId, ts },
			{
				type: "tool_call",
				tool: TOOL_YIELD,
				toolCallId: "y1",
				input: {},
				taskId: rootNodeId,
				ts: ts + 1,
			},
			{
				type: "message",
				id: "m1",
				body: { source: "user", id: "m1", ts: ts + 2, content: "hello" },
				taskId: rootNodeId,
				ts: ts + 2,
			},
			{
				type: "tool_result",
				tool: TOOL_YIELD,
				toolCallId: "y1",
				content: "resumed.",
				isError: false,
				taskId: rootNodeId,
				ts: ts + 3,
			},
			{
				type: "messages_consumed",
				messageIds: ["m1"],
				taskId: rootNodeId,
				ts: ts + 4,
			},
		];
		for (const e of events) await store.append(rootNodeId, e);
		await store.flushSession(rootNodeId);
		const msg = store.read(rootNodeId).find((e) => e.type === "message");
		if (!msg?.eid) throw new Error("fixture produced no message eid");
		return msg.eid;
	}

	// ── /message ──────────────────────────────────────────────────────────

	test("/message refuses images with no text", async () => {
		const res = await post("message", { images: oneImage() });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe(TEXT_REQUIRED);
	});

	test("/message refuses images with whitespace-only text", async () => {
		const res = await post("message", {
			content: "   \n\t ",
			images: oneImage(),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe(TEXT_REQUIRED);
	});

	test("/message refuses images sent under the legacy `message` alias too", async () => {
		// The endpoint accepts `content` OR `message`; a rule enforced on one
		// spelling is bypassable by the other.
		const res = await post("message", { message: "  ", images: oneImage() });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe(TEXT_REQUIRED);
	});

	test("REGRESSION: /message still accepts text WITH images", async () => {
		const res = await post("message", {
			content: "look at this",
			images: oneImage(),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});

	test("REGRESSION: the image survives to the persisted message", async () => {
		// The guard must reject the payload, never quietly strip part of it.
		await post("message", { content: "look at this", images: oneImage() });
		const store = getEventStore(ctx, projectId);
		await store.flushSession(rootNodeId);
		const persisted = store
			.read(rootNodeId)
			.find((e) => e.type === "message" && e.body.source === "user");
		expect(persisted).toBeDefined();
		const body = (persisted as Extract<Event, { type: "message" }>).body as {
			content?: string;
			images?: unknown[];
		};
		expect(body.content).toBe("look at this");
		expect(body.images).toHaveLength(1);
	});

	// ── /edit ─────────────────────────────────────────────────────────────

	test("/edit refuses images with no text", async () => {
		const eid = await seedEditableMessage();
		const res = await post("edit", { eid, images: oneImage() });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe(TEXT_REQUIRED);
	});

	test("/edit refuses images with whitespace-only text", async () => {
		const eid = await seedEditableMessage();
		const res = await post("edit", { eid, content: "  ", images: oneImage() });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe(TEXT_REQUIRED);
	});

	test("/edit still names a missing eid separately", async () => {
		// The two requirements are different problems and must not collapse
		// into one message — "text is required" is a lie when the eid is what
		// is missing.
		const res = await post("edit", { content: "hello" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("eid");
		// Not a word about text or images: naming a requirement the caller
		// already met sends them looking in the wrong place.
		expect(body.error).not.toContain("image");
		expect(body.error).not.toBe(TEXT_REQUIRED);
	});

	test("REGRESSION: /edit still accepts text WITH images", async () => {
		const eid = await seedEditableMessage();
		const res = await post("edit", {
			eid,
			content: "look at this instead",
			images: oneImage(),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean };
		expect(body.ok).toBe(true);
	});
});
