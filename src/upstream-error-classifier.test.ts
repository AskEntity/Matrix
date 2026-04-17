/**
 * Tests for `classifyUpstreamError` / `formatUpstreamError` —
 * curation of provider API errors surfaced to the user.
 *
 * The pre-curation behaviour (Audit L H5) dumped raw JSON blobs like
 *   {"type":"error","error":{"message":"invalid x-api-key",...}}
 * into the activity log. Non-technical users had no way to triage.
 * After curation we always lead with a one-liner, and append the raw
 * detail for debugging.
 */
import { describe, expect, test } from "bun:test";
import {
	classifyUpstreamError,
	formatUpstreamError,
} from "./tool-execution.ts";

function err(
	msg: string,
	extras?: { status?: number; name?: string },
): Error & { status?: number } {
	const e = new Error(msg) as Error & { status?: number };
	if (extras?.status !== undefined) e.status = extras.status;
	if (extras?.name) e.name = extras.name;
	return e;
}

describe("classifyUpstreamError", () => {
	test("401 invalid x-api-key → category=auth", () => {
		const c = classifyUpstreamError(
			err(
				'{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
				{ status: 401 },
			),
		);
		expect(c.category).toBe("auth");
		expect(c.headline.toLowerCase()).toContain("api key");
	});

	test("403 unauthorized → category=auth", () => {
		const c = classifyUpstreamError(
			err("Forbidden: invalid_api_key", { status: 403 }),
		);
		expect(c.category).toBe("auth");
	});

	test("429 rate limited → category=rate_limit", () => {
		const c = classifyUpstreamError(
			err("Rate limit exceeded", { status: 429 }),
		);
		expect(c.category).toBe("rate_limit");
		expect(c.headline.toLowerCase()).toContain("rate limited");
	});

	test("credit_balance_too_low → category=credits", () => {
		const c = classifyUpstreamError(
			err(
				'{"error":{"message":"Your credit balance is too low","type":"credit_balance_too_low"}}',
				{ status: 400 },
			),
		);
		expect(c.category).toBe("credits");
		expect(c.headline.toLowerCase()).toContain("credits");
	});

	test("400 invalid_request_error → category=invalid_request", () => {
		const c = classifyUpstreamError(
			err('{"error":{"type":"invalid_request_error"}}', { status: 400 }),
		);
		expect(c.category).toBe("invalid_request");
	});

	test("503 / 529 → category=upstream_down", () => {
		expect(
			classifyUpstreamError(err("Bad Gateway", { status: 502 })).category,
		).toBe("upstream_down");
		expect(
			classifyUpstreamError(err("Overloaded", { status: 529 })).category,
		).toBe("upstream_down");
		expect(classifyUpstreamError(err("internal_server_error")).category).toBe(
			"upstream_down",
		);
	});

	test("network errors → category=network", () => {
		expect(classifyUpstreamError(err("ECONNREFUSED")).category).toBe("network");
		expect(classifyUpstreamError(err("ECONNRESET")).category).toBe("network");
		expect(classifyUpstreamError(err("fetch failed")).category).toBe("network");
	});

	test("unknown → category=other, headline is first line of message", () => {
		const c = classifyUpstreamError(
			err("Some random message\n...more detail..."),
		);
		expect(c.category).toBe("other");
		expect(c.headline).toBe("Some random message");
	});

	test("raw is preserved for debugging", () => {
		const raw = "detailed provider blob 1234567890";
		const c = classifyUpstreamError(err(raw, { status: 401 }));
		expect(c.raw).toContain(raw);
	});
});

describe("formatUpstreamError", () => {
	test("leads with curated headline, then (provider detail: …)", () => {
		const out = formatUpstreamError(
			err('{"type":"error","error":{"message":"invalid x-api-key"}}', {
				status: 401,
			}),
			"Agent error",
		);
		const firstLine = out.split("\n")[0] ?? "";
		expect(firstLine).toContain("Agent error:");
		expect(firstLine.toLowerCase()).toContain("api key");
		expect(out).toContain("provider detail:");
	});

	test("unknown errors surface without a `(provider detail:)` line", () => {
		const out = formatUpstreamError(err("something weird"));
		expect(out).toBe("Agent error: something weird");
		expect(out).not.toContain("provider detail:");
	});

	test("very long raw blob is trimmed to ~300 chars", () => {
		const long = "x".repeat(5000);
		const out = formatUpstreamError(err(long, { status: 401 }));
		// headline + "provider detail:" line
		expect(out.length).toBeLessThan(700);
		expect(out).toContain("…");
	});
});
