/**
 * Queue message utilities: image extraction, formatting, drain logic, and event recording.
 * Used by both providers and the run loop in provider-shared.ts.
 */
import type { Event } from "./events.ts";
import type { MessageQueue, QueueMessage } from "./message-queue.ts";

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

// ── messages_consumed emitter ──

/**
 * Emit a `messages_consumed` event referencing the given drained queue messages.
 *
 * After the `enqueue === persist` refactor, every message that lands in the
 * queue is persisted to JSONL exactly once (by `queue.enqueue`'s onPersist
 * callback, or by direct `emitEvent` on the agent-not-running path). This
 * function no longer re-emits message events — its sole job is to tell the
 * walker which message ids have been consumed by the current turn so the
 * reconstruction path can resolve them via eventIndex.
 */
export function recordQueueEvents(
	emit: (event: Event) => void,
	queueMsgs: QueueMessage[],
	additionalConsumedIds?: string[],
	taskId = "",
): void {
	const consumedIds: string[] = [...(additionalConsumedIds ?? [])];
	for (const msg of queueMsgs) {
		consumedIds.push(msg.id);
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
