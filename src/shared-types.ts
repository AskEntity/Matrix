/**
 * Shared type definitions used across multiple modules.
 * Avoids inline repetition of structural types.
 */

/** Structured pending state: running children + outstanding clarifications. */
export interface PendingState {
	runningChildren: Array<{ id: string; title: string }>;
	pendingClarifications: number;
}

/** Image data extracted from events (provider-agnostic). */
export interface EventImageData {
	base64: string;
	mediaType: string;
}
