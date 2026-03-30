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

/**
 * Unified tool execution result type. Used by executeTool(), both providers,
 * and the run loop. Content is always string (executeTool converts MCP Array→string).
 * No index signature — all fields explicitly typed.
 *
 * Built-in tools use: cwd, backgroundId, backgroundCommand, isImage, imageData, mediaType
 * Orchestrator tools use: consumedMessageIds, consumedQueueMessages, formattedQueueMessages, pending
 */
export interface ToolResult {
	content: string;
	isError: boolean;
	/** Updated working directory after tool execution. */
	cwd?: string;
	/** Background process ID — set when bash moves a command to background. */
	backgroundId?: string;
	/** Background command — set when bash moves a command to background. */
	backgroundCommand?: string;
	/** Whether the result is a screenshot/image. */
	isImage?: boolean;
	/** Base64-encoded image data. */
	imageData?: string;
	/** MIME type of the image (e.g. "image/png"). */
	mediaType?: string;
	/** MCP images from tool results (e.g. screenshots from external MCP servers). */
	mcpImages?: Array<EventImageData & { data?: string }>;
	/** User message IDs consumed (already persisted at send time). */
	consumedMessageIds?: string[];
	/** Raw queue messages from yield/done that need to flow through emit for SSE broadcast + persistence. */
	consumedQueueMessages?: import("./message-queue.ts").QueueMessage[];
	/** Formatted text of all consumed queue messages for display. */
	formattedQueueMessages?: string;
	/** Structured pending state after yield/done. */
	pending?: PendingState;
}
