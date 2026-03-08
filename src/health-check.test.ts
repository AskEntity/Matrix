import { describe, expect, test } from "bun:test";
import { checkHealth } from "./health-check";

describe("checkHealth", () => {
	test("returns an object with status, uptime, memoryUsage", () => {
		const result = checkHealth();
		expect(result).toHaveProperty("status");
		expect(result).toHaveProperty("uptime");
		expect(result).toHaveProperty("memoryUsage");
	});

	test("status is 'ok'", () => {
		const result = checkHealth();
		expect(result.status).toBe("ok");
	});

	test("uptime is a positive number", () => {
		const result = checkHealth();
		expect(typeof result.uptime).toBe("number");
		expect(result.uptime).toBeGreaterThan(0);
	});

	test("memoryUsage has expected properties", () => {
		const result = checkHealth();
		expect(result.memoryUsage).toHaveProperty("rss");
		expect(result.memoryUsage).toHaveProperty("heapTotal");
		expect(result.memoryUsage).toHaveProperty("heapUsed");
		expect(result.memoryUsage).toHaveProperty("external");
	});
});
