/**
 * Queue message utilities: image extraction, formatting, drain logic, and event recording.
 * Used by both providers and the run loop in provider-shared.ts.
 */
import { type Event, queueMessageToEvent } from "./events.ts";
import type { MessageQueue, QueueMessage } from "./message-queue.ts";

// ── recordQueueEvents helper ──

// ── Queue image extraction ──

/**
 * Extract images from queue messages in Anthropic format (base64 image blocks).
 */
export function extractQueueImages(msgs: QueueMessage[]): Array<{
	type: "image";
	source: {
		type: "base64";
		media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
		data: string;
	};
}> {
	type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
	const blocks: Array<{
		type: "image";
		source: { type: "base64"; media_type: ImageMediaType; data: string };
	}> = [];
	for (const msg of msgs) {
		if (msg.source === "user" && msg.images) {
			for (const img of msg.images) {
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: img.mediaType as ImageMediaType,
						data: img.base64,
					},
				});
			}
		}
	}
	return blocks;
}

/**
 * Extract images from queue messages in OpenAI format (image_url parts with data URIs).
 */
export function extractQueueImageParts(
	msgs: QueueMessage[],
): Array<{ type: "image_url"; image_url: { url: string; detail: "auto" } }> {
	const parts: Array<{
		type: "image_url";
		image_url: { url: string; detail: "auto" };
	}> = [];
	for (const msg of msgs) {
		if (msg.source === "user" && msg.images) {
			for (const img of msg.images) {
				parts.push({
					type: "image_url",
					image_url: {
						url: `data:${img.mediaType};base64,${img.base64}`,
						detail: "auto",
					},
				});
			}
		}
	}
	return parts;
}

// ── Cancellation point queue drain ──

/**
 * Drain queue at cancellation point (between tool execution and next API call).
 * Returns the raw queue messages, or null if nothing to drain.
 * Formatting is handled by buildUserTurn inside each provider.
 */
export function drainQueueAtCancellationPoint(queue: MessageQueue): {
	messages: QueueMessage[];
	manualCompactRequested: boolean;
} | null {
	if (queue.pending <= 0) return null;

	const queueMsgs = queue.drain();
	const manualCompactRequested = queueMsgs.some((m) => m.source === "compact");
	const nonCompactMsgs = queueMsgs.filter((m) => m.source !== "compact");
	return { messages: nonCompactMsgs, manualCompactRequested };
}

// ── Event emission helpers ──

/**
 * Emit queue events and messages_consumed for queue messages drained during
 * the provider loop.
 *
 * Two-phase message lifecycle invariant: every QueueMessage must be persisted
 * to JSONL EXACTLY ONCE. There are two ways a message gets on disk:
 *
 *   1. `deliverMessage` writes the `message` event to JSONL in step 1, THEN
 *      enqueues to the target queue with `queue.markPersisted(id)`. The
 *      provider loop drains it and MUST NOT re-emit it here.
 *
 *   2. Direct-enqueue paths (bash background_complete, orchestrator-tools
 *      tree_change `notifyTargetNode`, REST compact route) push the message
 *      onto the queue WITHOUT marking it persisted. These messages are not
 *      yet on disk — this function emits them so `findUnconsumedMessages`
 *      can recover them after a crash.
 *
 * We detect which case a message is in via `queue.isPersisted(msg.id)`.
 * No re-emit for persisted messages = no duplicate `message` events on
 * disk (which previously produced byte-identical lines and inflated JSONL).
 *
 * The queue arg is optional for tests that don't construct a real queue —
 * in that case, we fall back to emitting all non-user messages (legacy
 * behavior for user === already-persisted by HTTP layer).
 */
export function recordQueueEvents(
	emit: (event: Event) => void,
	queueMsgs: QueueMessage[],
	additionalConsumedIds?: string[],
	taskId = "",
	queue?: MessageQueue,
): void {
	const consumedIds: string[] = [...(additionalConsumedIds ?? [])];

	for (const msg of queueMsgs) {
		const alreadyPersisted = queue
			? queue.isPersisted(msg.id)
			: msg.source === "user"; // legacy fallback when no queue provided

		if (alreadyPersisted) {
			// Already written to JSONL by the sender — just track the id.
			consumedIds.push(msg.id);
		} else {
			// Direct-enqueue path (bg_complete, tree_change notifyTargetNode,
			// compact) — this is the first (and only) write to JSONL.
			const evt = queueMessageToEvent(msg, taskId);
			const evtId = (evt as { id?: string }).id;
			if (evtId) consumedIds.push(evtId);
			emit(evt);
		}
	}

	// Drop persisted-id bookkeeping for consumed messages to keep the set bounded.
	if (queue && consumedIds.length > 0) {
		queue.clearPersisted(consumedIds);
	}

	if (consumedIds.length > 0) {
		emit({
			type: "messages_consumed",
			messageIds: consumedIds,
			taskId,
			ts: Date.now(),
		});
	}
}
