import { describe, expect, test } from "bun:test";
import { VERSION } from "./version";

describe("VERSION", () => {
	test("equals 0.1.0", () => {
		expect(VERSION).toBe("0.1.0");
	});

	test("matches semver format", () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
