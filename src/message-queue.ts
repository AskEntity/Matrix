/**
 * Stub file for MessageQueue types.
 * The real implementation is created in a parallel task and will replace this on merge.
 */

export type QueueMessage = { source: string; [key: string]: unknown };

export class MessageQueue {
	enqueue(_msg: QueueMessage): void {}
	drain(): QueueMessage[] {
		return [];
	}
	async wait(): Promise<QueueMessage> {
		return { source: "stub" };
	}
	get pending(): number {
		return 0;
	}
	close(): void {}
}
