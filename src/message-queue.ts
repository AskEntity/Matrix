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
			/** Included when output is small (< 50KB). Undefined for large output — use read_file. */
			stdout?: string;
			/** Included when output is small (< 50KB). Undefined for large output — use read_file. */
			stderr?: string;
	  }
	| { source: "compact"; id: string; ts: number };

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

	/** Optional callback fired after messages are drained (consumed) from the queue. */
	onDrain?: () => void;

	/** Add a message to the queue. If someone is waiting via wait(), resolve them immediately.
	 * When `quiet` is true, the message is added without waking a pending wait() — picked up on next drain() or wait() with pending messages. */
	enqueue(msg: QueueMessage, options?: { quiet?: boolean }): void {
		if (this.closed) {
			throw new Error("Queue closed");
		}
		if (!msg.id) {
			throw new Error(
				`QueueMessage must have a non-empty id (source: ${msg.source})`,
			);
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
