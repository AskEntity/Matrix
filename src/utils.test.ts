import { describe, expect, test } from "bun:test";
import { formatBytes } from "./utils";

describe("formatBytes", () => {
	test("returns '0 Bytes' for 0", () => {
		expect(formatBytes(0)).toBe("0 Bytes");
	});

	test("formats bytes (< 1024)", () => {
		expect(formatBytes(1)).toBe("1 Bytes");
		expect(formatBytes(512)).toBe("512 Bytes");
		expect(formatBytes(1023)).toBe("1023 Bytes");
	});

	test("formats kilobytes", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(10240)).toBe("10.0 KB");
	});

	test("formats megabytes", () => {
		expect(formatBytes(1048576)).toBe("1.0 MB");
		expect(formatBytes(5242880)).toBe("5.0 MB");
	});

	test("formats gigabytes", () => {
		expect(formatBytes(1073741824)).toBe("1.0 GB");
	});

	test("formats terabytes", () => {
		expect(formatBytes(1099511627776)).toBe("1.0 TB");
	});

	test("formats petabytes", () => {
		expect(formatBytes(1125899906842624)).toBe("1.0 PB");
	});

	test("clamps to petabytes for very large values", () => {
		expect(formatBytes(1125899906842624 * 1024)).toBe("1024.0 PB");
	});

	test("handles negative numbers", () => {
		expect(formatBytes(-1024)).toBe("-1.0 KB");
		expect(formatBytes(-1048576)).toBe("-1.0 MB");
	});
});
