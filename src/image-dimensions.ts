/**
 * Parse image dimensions from file buffer without external dependencies.
 * Supports PNG and JPEG. Returns null for unsupported/corrupt formats.
 */

export interface ImageDimensions {
	width: number;
	height: number;
}

/**
 * Extract width and height from a PNG or JPEG buffer by reading the header.
 * Returns null if the format is unrecognized or the header is too short/corrupt.
 */
export function getImageDimensions(buffer: Buffer): ImageDimensions | null {
	// PNG needs at least 24 bytes for signature + IHDR dimensions
	// JPEG needs at least a SOI marker (2 bytes) + some scanning room
	if (buffer.length < 4) return null;

	// PNG: 8-byte signature + IHDR chunk (length[4] + "IHDR"[4] + width[4] + height[4])
	if (
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47
	) {
		if (buffer.length < 24) return null;
		// Bytes 16-19: width (big-endian uint32)
		// Bytes 20-23: height (big-endian uint32)
		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);
		return { width, height };
	}

	// JPEG: starts with 0xFF 0xD8, scan for SOF markers
	if (buffer[0] === 0xff && buffer[1] === 0xd8) {
		let offset = 2;
		while (offset < buffer.length - 1) {
			if (buffer[offset] !== 0xff) {
				offset++;
				continue;
			}
			const marker = buffer[offset + 1];
			if (marker === undefined) break;

			// SOF0, SOF1, SOF2 markers contain dimensions
			if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
				// marker[2] + length[2] + precision[1] + height[2] + width[2]
				if (offset + 9 > buffer.length) return null;
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				return { width, height };
			}

			// Skip to next marker: length is 2 bytes after marker byte
			if (offset + 3 >= buffer.length) return null;
			const segmentLength = buffer.readUInt16BE(offset + 2);
			offset += 2 + segmentLength;
		}
		return null;
	}

	return null;
}
