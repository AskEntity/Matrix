/** Image attachment for user messages. */
export interface QueueImage {
	base64: string;
	mediaType: string;
}

/** Message types that can flow through the queue. Every message MUST have a ULID id for dedup and a ts for timestamps. */
export type QueueMessage =
	| {
			source: "user";
			id: string;
			ts: number;
			content: string;
			images?: QueueImage[];
			header?: string;
	  }
	| {
			source: "tree_change";
			id: string;
			ts: number;
			action: "created" | "updated" | "deleted" | "reordered";
			nodeId: string;
			title?: string;
	  }
	| {
			source: "task_complete";
			id: string;
			ts: number;
			taskId: string;
			title: string;
			success: boolean;
			output: string;
	  }
	| {
			source: "task_message";
			id: string;
			ts: number;
			fromTaskId: string;
			fromTitle: string;
			content: string;
			/** Message subject line (from send_message's title param). */
			title?: string;
			requestReply?: boolean;
			/** Only on cold-start downward messages. */
			header?: string;
	  }
	| { source: "clarify_response"; id: string; ts: number; answer: string }
	| {
			source: "user_message_forwarded";
			id: string;
			ts: number;
			fromTaskId: string;
			fromTitle: string;
			content: string;
			/** True when this forward was triggered by resuming a verify/closed/failed task. */
			resumed?: boolean;
	  }
	| {
			source: "cross_project";
			id: string;
			ts: number;
			fromProjectId: string;
			fromProjectName: string;
			content: string;
	  }
	| {
			source: "background_complete";
			id: string;
			ts: number;
			commandId: string;
			command: string;
			exitCode: number | null;
			durationMs: number;
			/** Formatted output — identical to foreground bash tool_result content. From formatBashResult(). */
			content: string;
	  }
	| { source: "compact"; id: string; ts: number };

/**
 * A simple async message queue for inter-agent communication.
 * Supports blocking wait(), non-blocking drain(), and graceful close().
 *
 * ## Enqueue is the single persistence path
 *
 * Every `enqueue(msg)` call synchronously calls the `onPersist` callback
 * (if configured) BEFORE the message is delivered to a waiter or pushed
 * onto the array. This folds "write to JSONL" and "deliver to agent" into
 * a single atomic action.
 *
 * The production daemon wires `onPersist` to `emitEvent({ type: "message", ... })`,
 * so any caller — `deliverMessage`, bash background_complete, MCP
 * tree_change notifyTargetNode, compact REST route — automatically gets
 * "persist exactly once" without needing to know about JSONL.
 *
 * The `{ replay: true }` option bypasses `onPersist`. It is used when
 * recovering messages from JSONL on agent startup (findUnconsumedMessages,
 * bgOrphans) — those messages are already on disk, re-persisting them
 * would create byte-identical duplicates on adjacent lines.
 *
 * The `{ quiet: true }` option suppresses waking a pending `wait()`
 * caller — used for notifications that shouldn't interrupt. `quiet`
 * does NOT affect persistence.
 */
export class MessageQueue {
	private messages: QueueMessage[] = [];
	private waiter: {
		resolve: (msg: QueueMessage) => void;
		reject: (err: Error) => void;
	} | null = null;
	private closed = false;

	/**
	 * Persistence callback — invoked synchronously on every non-replay
	 * `enqueue` before the message is delivered. Wired to `emitEvent` by
	 * the daemon so queue = persistence. Undefined in tests / mock sessions
	 * where JSONL persistence is not needed.
	 */
	private onPersist?: (msg: QueueMessage) => void;

	constructor(opts?: { onPersist?: (msg: QueueMessage) => void }) {
		this.onPersist = opts?.onPersist;
	}

	/** Whether the queue has an onPersist callback wired. */
	hasOnPersist(): boolean {
		return this.onPersist != null;
	}

	/**
	 * Wire an onPersist callback post-construction. Used by the provider loop
	 * to enforce `enqueue === persist` at loop entry when the caller passed
	 * a bare queue (typical in unit tests). Only allowed when no onPersist
	 * is currently set — prevents silently overwriting production wiring.
	 */
	setOnPersist(cb: (msg: QueueMessage) => void): void {
		if (this.onPersist != null) {
			throw new Error("onPersist already set");
		}
		this.onPersist = cb;
	}

	/** Whether the queue has been closed. */
	get isClosed(): boolean {
		return this.closed;
	}

	/** Whether this agent is currently idle (waiting for messages). */
	idle = false;

	/** Optional callback fired whenever a message is enqueued (before delivery to waiter or array). */
	onEnqueue?: (msg: QueueMessage) => void;

	/** Optional callback fired after messages are drained (consumed) from the queue. */
	onDrain?: () => void;

	/**
	 * Add a message to the queue.
	 *
	 * - Calls `onPersist(msg)` synchronously unless `replay: true`.
	 * - Delivers to a pending waiter, otherwise pushes onto the array.
	 * - `quiet: true` suppresses waking the waiter (picked up on next drain/wait).
	 * - `replay: true` skips `onPersist` (used when recovering messages already in JSONL).
	 */
	enqueue(
		msg: QueueMessage,
		options?: { quiet?: boolean; replay?: boolean },
	): void {
		if (this.closed) {
			throw new Error("Queue closed");
		}
		if (!msg.id) {
			throw new Error(
				`QueueMessage must have a non-empty id (source: ${msg.source})`,
			);
		}

		// Persist first (unless this is a replay from JSONL).
		// Any write failure propagates to the caller — we do not silently
		// drop messages on persistence error.
		if (!options?.replay && this.onPersist) {
			this.onPersist(msg);
		}

		if (options?.quiet) {
			this.messages.push(msg);
			return;
		}

		this.onEnqueue?.(msg);

		if (this.waiter) {
			const { resolve } = this.waiter;
			this.waiter = null;
			resolve(msg);
			this.onDrain?.();
		} else {
			this.messages.push(msg);
		}
	}

	/** Return a shallow copy of pending messages without consuming them. */
	peekMessages(): QueueMessage[] {
		return [...this.messages];
	}

	/** Take all pending messages and clear the queue. Non-blocking. Returns empty array if nothing pending. */
	drain(): QueueMessage[] {
		const msgs = this.messages;
		this.messages = [];
		if (msgs.length > 0) this.onDrain?.();
		return msgs;
	}

	/** Block until at least one message arrives. If messages already pending, resolve immediately. */
	wait(): Promise<QueueMessage> {
		if (this.closed) {
			return Promise.reject(new Error("Queue closed"));
		}

		if (this.messages.length > 0) {
			const msg = this.messages.shift() as QueueMessage;
			this.onDrain?.();
			return Promise.resolve(msg);
		}

		return new Promise<QueueMessage>((resolve, reject) => {
			this.waiter = { resolve, reject };
		});
	}

	/**
	 * Block until at least one message arrives or the timeout fires.
	 * Returns "timeout" sentinel if no message arrives within timeoutMs.
	 * If timeoutMs is undefined, behaves like wait() (waits forever).
	 */
	waitForMessage(timeoutMs?: number): Promise<QueueMessage | "timeout"> {
		if (timeoutMs === undefined) {
			return this.wait();
		}

		if (this.closed) {
			return Promise.reject(new Error("Queue closed"));
		}

		if (this.messages.length > 0) {
			const msg = this.messages.shift() as QueueMessage;
			this.onDrain?.();
			return Promise.resolve(msg);
		}

		return new Promise<QueueMessage | "timeout">((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.waiter) {
					this.waiter = null;
					resolve("timeout");
				}
			}, timeoutMs);

			this.waiter = {
				resolve: (msg: QueueMessage) => {
					clearTimeout(timer);
					resolve(msg);
				},
				reject: (err: Error) => {
					clearTimeout(timer);
					reject(err);
				},
			};
		});
	}

	/** Check if there are pending messages without consuming them. */
	get pending(): number {
		return this.messages.length;
	}

	/** Close the queue. Any pending wait() calls reject with "Queue closed" error. */
	close(): void {
		this.closed = true;
		if (this.waiter) {
			const { reject } = this.waiter;
			this.waiter = null;
			reject(new Error("Queue closed"));
		}
	}
}
