import { describe, expect, test } from "bun:test";
import { ulid } from "./ulid.ts";

const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ulid", () => {
	test("generates 26-char Crockford base32 string", () => {
		const id = ulid();
		expect(id).toHaveLength(26);
		expect(id).toMatch(CROCKFORD_RE);
	});

	test("monotonically increasing — 1000 IDs in rapid succession", () => {
		const ids: string[] = [];
		for (let i = 0; i < 1000; i++) {
			ids.push(ulid());
		}
		for (let i = 1; i < ids.length; i++) {
			const curr = ids[i] as string;
			const prev = ids[i - 1] as string;
			expect(curr > prev).toBe(true);
		}
	});

	test("no duplicates in 10000 generations", () => {
		const set = new Set<string>();
		for (let i = 0; i < 10000; i++) {
			set.add(ulid());
		}
		expect(set.size).toBe(10000);
	});

	test("all characters are valid Crockford base32", () => {
		for (let i = 0; i < 100; i++) {
			const id = ulid();
			expect(id).toMatch(CROCKFORD_RE);
		}
	});

	test("timestamp prefix increases over time", async () => {
		const id1 = ulid();
		await new Promise((r) => setTimeout(r, 5));
		const id2 = ulid();
		// First 10 chars = timestamp — should be different after waiting
		expect(id2.slice(0, 10) >= id1.slice(0, 10)).toBe(true);
		expect(id2 > id1).toBe(true);
	});
});
