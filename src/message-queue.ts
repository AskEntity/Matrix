/**
 * Global registry of all currently running agent queues, keyed by taskId.
 * Populated when a child agent starts, removed when it finishes.
 * Allows daemon.ts to route messages to specific agent queues.
 */
export const globalAgentQueues = new Map<string, MessageQueue>();

/** Image attachment for user messages. */
export interface QueueImage {
	base64: string;
	mediaType: string;
}

/** Message types that can flow through the queue. */
export type QueueMessage =
	| { source: "user"; id?: string; content: string; images?: QueueImage[] }
	| { source: "system"; content: string }
	| {
			source: "child_complete";
			taskId: string;
			title: string;
			success: boolean;
			output: string;
	  }
	| { source: "parent_update"; content: string; requestReply?: boolean }
	| { source: "clarify_response"; answer: string }
	| {
			source: "child_report";
			taskId: string;
			title: string;
			content: string;
			requestReply?: boolean;
	  }
	| {
			source: "cross_project";
			fromProjectId: string;
			fromProjectName: string;
			content: string;
	  }
	| {
			source: "background_complete";
			commandId: string;
			command: string;
			exitCode: number | null;
			durationMs: number;
			/** @deprecated No longer included — use read_file on output files instead. */
			stdout?: string;
			/** @deprecated No longer included — use read_file on output files instead. */
			stderr?: string;
	  }
	| { source: "compact" };

/**
 * A simple async message queue for inter-agent communication.
 * Supports blocking wait(), non-blocking drain(), and graceful close().
 */
export class MessageQueue {
	private messages: QueueMessage[] = [];
	private waiter: {
		resolve: (msg: QueueMessage) => void;
		reject: (err: Error) => void;
	} | null = null;
	private closed = false;

	/** Whether the queue has been closed. */
	get isClosed(): boolean {
		return this.closed;
	}

	/** Whether this agent is currently idle (waiting for messages). */
	idle = false;

	/** Optional callback fired whenever a message is enqueued (before delivery to waiter or array). */
	onEnqueue?: (msg: QueueMessage) => void;

	/** Optional callback fired after messages are drained from the queue. */
	onDrain?: () => void;

	/** Add a message to the queue. If someone is waiting via wait(), resolve them immediately. */
	enqueue(msg: QueueMessage): void {
		if (this.closed) {
			throw new Error("Queue closed");
		}

		this.onEnqueue?.(msg);

		if (this.waiter) {
			const { resolve } = this.waiter;
			this.waiter = null;
			resolve(msg);
			// Message was consumed immediately — clear pending banner
			this.onDrain?.();
		} else {
			this.messages.push(msg);
		}
	}

	/** Add a message to the queue without waking a pending wait(). Picked up on next drain() or wait() with pending messages. */
	enqueueQuiet(msg: QueueMessage): void {
		if (this.closed) {
			throw new Error("Queue closed");
		}
		this.messages.push(msg);
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

	/**
	 * Drain with deduplication: merges consecutive system messages with similar content
	 * into a single summary. Non-system messages pass through unchanged.
	 */
	drainMerged(): QueueMessage[] {
		const msgs = this.drain();
		if (msgs.length <= 1) return msgs;

		const result: QueueMessage[] = [];
		const systemMessages: Array<Extract<QueueMessage, { source: "system" }>> =
			[];

		const flushSystem = () => {
			if (systemMessages.length === 0) return;
			if (systemMessages.length === 1) {
				result.push(...systemMessages);
			} else {
				// Merge multiple system messages into one summary
				result.push({
					source: "system",
					content: `Tree updated ${systemMessages.length} times. Call get_tree to see the latest state.`,
				});
			}
			systemMessages.length = 0;
		};

		for (const msg of msgs) {
			if (msg.source === "system") {
				systemMessages.push(msg);
			} else {
				flushSystem();
				result.push(msg);
			}
		}
		flushSystem();

		return result;
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
