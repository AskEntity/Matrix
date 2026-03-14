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
	| { source: "user"; content: string; images?: QueueImage[] }
	| {
			source: "child_complete";
			taskId: string;
			title: string;
			success: boolean;
			output: string;
	  }
	| { source: "parent_update"; content: string }
	| { source: "clarify_response"; answer: string }
	| { source: "child_report"; taskId: string; title: string; content: string };

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

	/** Add a message to the queue. If someone is waiting via wait(), resolve them immediately. */
	enqueue(msg: QueueMessage): void {
		if (this.closed) {
			throw new Error("Queue closed");
		}

		if (this.waiter) {
			const { resolve } = this.waiter;
			this.waiter = null;
			resolve(msg);
		} else {
			this.messages.push(msg);
		}
	}

	/** Take all pending messages and clear the queue. Non-blocking. Returns empty array if nothing pending. */
	drain(): QueueMessage[] {
		const msgs = this.messages;
		this.messages = [];
		return msgs;
	}

	/** Block until at least one message arrives. If messages already pending, resolve immediately. */
	wait(): Promise<QueueMessage> {
		if (this.closed) {
			return Promise.reject(new Error("Queue closed"));
		}

		if (this.messages.length > 0) {
			const msg = this.messages.shift() as QueueMessage;
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
