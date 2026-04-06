/**
 * Tests for image dimension parsing and read_file pixel guard.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getImageDimensions } from "./image-dimensions.ts";
import { resetResourceRegistry } from "./resource-registry.ts";
import { TaskTracker } from "./task-tracker.ts";
import { initMockResourceRegistry } from "./test-utils.ts";
import { toToolDefinition } from "./tool-def.ts";
import { buildBuiltinToolDefs } from "./tools/definitions.ts";

// ── Helpers to construct minimal valid image headers ──

/** Build a minimal PNG buffer with the given dimensions in the IHDR chunk. */
function makePngBuffer(width: number, height: number): Buffer {
	const buf = Buffer.alloc(24);
	// PNG signature
	buf[0] = 0x89;
	buf[1] = 0x50; // P
	buf[2] = 0x4e; // N
	buf[3] = 0x47; // G
	buf[4] = 0x0d;
	buf[5] = 0x0a;
	buf[6] = 0x1a;
	buf[7] = 0x0a;
	// IHDR chunk: length (13 = 0x0000000D)
	buf.writeUInt32BE(13, 8);
	// "IHDR"
	buf[12] = 0x49; // I
	buf[13] = 0x48; // H
	buf[14] = 0x44; // D
	buf[15] = 0x52; // R
	// Width and height (big-endian 32-bit)
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	return buf;
}

/** Build a minimal JPEG buffer with SOF0 containing the given dimensions. */
function makeJpegBuffer(width: number, height: number): Buffer {
	// SOI (2) + APP0 marker (2+2+content) + SOF0 marker with dimensions
	// Minimal: SOI + SOF0 directly
	const buf = Buffer.alloc(20);
	// SOI marker
	buf[0] = 0xff;
	buf[1] = 0xd8;
	// SOF0 marker
	buf[2] = 0xff;
	buf[3] = 0xc0;
	// Segment length (includes length bytes): 8 bytes of header data
	buf.writeUInt16BE(8, 4);
	// Precision
	buf[6] = 8;
	// Height (big-endian 16-bit)
	buf.writeUInt16BE(height, 7);
	// Width (big-endian 16-bit)
	buf.writeUInt16BE(width, 9);
	return buf;
}

/** Build a JPEG buffer with an APP0 segment before the SOF0 marker. */
function makeJpegWithApp0(width: number, height: number): Buffer {
	// SOI(2) + APP0(2+2+5 content) + SOF0(2+2+1+2+2)
	const buf = Buffer.alloc(22);
	// SOI
	buf[0] = 0xff;
	buf[1] = 0xd8;
	// APP0 marker
	buf[2] = 0xff;
	buf[3] = 0xe0;
	// APP0 length: 7 (2 length bytes + 5 content bytes)
	buf.writeUInt16BE(7, 4);
	// 5 bytes of APP0 content (filler)
	// Total APP0 segment: marker(2) + content(7) = offset 2+2+7 = 11
	// SOF0 starts at offset 11
	buf[11] = 0xff;
	buf[12] = 0xc0;
	// SOF0 length: 8
	buf.writeUInt16BE(8, 13);
	// Precision
	buf[15] = 8;
	// Height
	buf.writeUInt16BE(height, 16);
	// Width
	buf.writeUInt16BE(width, 18);
	return buf;
}

describe("getImageDimensions", () => {
	describe("PNG", () => {
		it("parses normal PNG dimensions", () => {
			const buf = makePngBuffer(1920, 1080);
			const dims = getImageDimensions(buf);
			expect(dims).toEqual({ width: 1920, height: 1080 });
		});

		it("parses large PNG dimensions (>8000px)", () => {
			const buf = makePngBuffer(10000, 5000);
			const dims = getImageDimensions(buf);
			expect(dims).toEqual({ width: 10000, height: 5000 });
		});

		it("parses PNG with height >8000px", () => {
			const buf = makePngBuffer(800, 12000);
			const dims = getImageDimensions(buf);
			expect(dims).toEqual({ width: 800, height: 12000 });
		});

		it("parses 1x1 PNG", () => {
			const buf = makePngBuffer(1, 1);
			const dims = getImageDimensions(buf);
			expect(dims).toEqual({ width: 1, height: 1 });
		});

		it("parses exactly 8000x8000 PNG", () => {
			const buf = makePngBuffer(8000, 8000);
			const dims = getImageDimensions(buf);
			expect(dims).toEqual({ width: 8000, height: 8000 });
		});
	});

	describe("JPEG", () => {
		it("parses JPEG with SOF0 immediately after SOI", () => {
			const buf = makeJpegBuffer(1920, 1080);
			const dims = getImageDimensions(buf);
			expect(dims).toEqual({ width: 1920, height: 1080 });
		});

		it("parses JPEG with APP0 before SOF0", () => {
			const buf = makeJpegWithApp0(3840, 2160);
			const dims = getImageDimensions(buf);
			expect(dims).toEqual({ width: 3840, height: 2160 });
		});

		it("parses oversized JPEG dimensions", () => {
			const buf = makeJpegBuffer(9000, 6000);
			const dims = getImageDimensions(buf);
			expect(dims).toEqual({ width: 9000, height: 6000 });
		});

		it("handles SOF2 (progressive JPEG)", () => {
			const buf = makeJpegBuffer(800, 600);
			// Change SOF0 (0xC0) to SOF2 (0xC2)
			buf[3] = 0xc2;
			const dims = getImageDimensions(buf);
			expect(dims).toEqual({ width: 800, height: 600 });
		});
	});

	describe("edge cases", () => {
		it("returns null for empty buffer", () => {
			expect(getImageDimensions(Buffer.alloc(0))).toBeNull();
		});

		it("returns null for buffer too short", () => {
			expect(getImageDimensions(Buffer.alloc(10))).toBeNull();
		});

		it("returns null for unknown format", () => {
			const buf = Buffer.alloc(100, 0x42);
			expect(getImageDimensions(buf)).toBeNull();
		});

		it("returns null for GIF (unsupported)", () => {
			// GIF89a header
			const buf = Buffer.from(`GIF89a${"\x00".repeat(100)}`);
			expect(getImageDimensions(buf)).toBeNull();
		});

		it("returns null for truncated JPEG (no SOF marker found)", () => {
			// Just SOI, nothing else
			const buf = Buffer.alloc(2);
			buf[0] = 0xff;
			buf[1] = 0xd8;
			expect(getImageDimensions(buf)).toBeNull();
		});
	});
});

// ── read_file integration tests ──

describe("read_file pixel dimension guard", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "img-dims-test-"));

	/** Write a buffer to a temp file and return its path. */
	function writeTempImage(name: string, buf: Buffer): string {
		const p = join(tmpDir, name);
		writeFileSync(p, buf);
		return p;
	}

	// biome-ignore lint/suspicious/noExplicitAny: test setup
	let readFile: any;

	beforeAll(async () => {
		resetResourceRegistry();
		const testTracker = new TaskTracker(join(tmpDir, "tree.json"));
		await testTracker.load("main");
		const testNode = testTracker.addChild(
			testTracker.rootNodeId,
			"test-task",
			"",
		);
		testNode.session = {
			queue: {
				enqueue: () => {},
				close: () => {},
				isClosed: false,
				drain: () => [],
				wait: async () => ({
					messages: [],
					reason: "closed" as const,
				}),
			} as never,
			abortController: new AbortController(),
			cwd: tmpDir,
			fallbackCwd: tmpDir,
			depth: 0,
			backgroundProcesses: new Map(),
			foregroundExecutions: new Map(),
		};
		const { auth } = initMockResourceRegistry({
			tracker: testTracker,
			projectId: "test-project",
			projectPath: tmpDir,
			taskId: testNode.id,
		});
		const tools = buildBuiltinToolDefs().map((def) =>
			toToolDefinition(def, auth),
		);
		const tool = tools.find((t) => t.name === "read_file");
		if (!tool) throw new Error("read_file tool not found");
		readFile = tool.handler;
	});

	it("rejects PNG with width >8000px", async () => {
		const p = writeTempImage("wide.png", makePngBuffer(10000, 1000));
		const result = await readFile({ path: p }, undefined);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Image too large");
		expect(text).toContain("10000x1000");
		expect(text).toContain("max 8000px");
		// Should NOT contain base64 image data
		expect(result).not.toHaveProperty("isImage", true);
	});

	it("rejects PNG with height >8000px", async () => {
		const p = writeTempImage("tall.png", makePngBuffer(800, 12000));
		const result = await readFile({ path: p }, undefined);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Image too large");
		expect(text).toContain("800x12000");
	});

	it("rejects JPEG with oversized dimensions", async () => {
		const p = writeTempImage("big.jpg", makeJpegBuffer(9000, 6000));
		const result = await readFile({ path: p }, undefined);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Image too large");
		expect(text).toContain("9000x6000");
	});

	it("accepts PNG with dimensions exactly 8000x8000", async () => {
		const p = writeTempImage("exact.png", makePngBuffer(8000, 8000));
		const result = (await readFile({ path: p }, undefined)) as Record<
			string,
			unknown
		>;
		expect(result.isImage).toBe(true);
		expect(result.imageData).toBeDefined();
	});

	it("accepts normal-sized PNG", async () => {
		const p = writeTempImage("normal.png", makePngBuffer(1920, 1080));
		const result = (await readFile({ path: p }, undefined)) as Record<
			string,
			unknown
		>;
		expect(result.isImage).toBe(true);
		expect(result.imageData).toBeDefined();
		expect(result.mediaType).toBe("image/png");
	});

	it("accepts normal-sized JPEG", async () => {
		const p = writeTempImage("normal.jpg", makeJpegBuffer(1920, 1080));
		const result = (await readFile({ path: p }, undefined)) as Record<
			string,
			unknown
		>;
		expect(result.isImage).toBe(true);
		expect(result.imageData).toBeDefined();
		expect(result.mediaType).toBe("image/jpeg");
	});

	it("passes through unknown image format (e.g. GIF) without blocking", async () => {
		// GIF header — getImageDimensions returns null for GIF
		const gifBuf = Buffer.alloc(100);
		gifBuf.write("GIF89a", 0);
		const p = writeTempImage("test.gif", gifBuf);
		const result = (await readFile({ path: p }, undefined)) as Record<
			string,
			unknown
		>;
		// Should still return as image (GIF is in IMAGE_MEDIA_TYPES)
		expect(result.isImage).toBe(true);
	});

	it("includes resize command suggestion in error message", async () => {
		const p = writeTempImage("huge.png", makePngBuffer(15000, 10000));
		const result = await readFile({ path: p }, undefined);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("magick");
		expect(text).toContain("8000x8000");
	});
});
