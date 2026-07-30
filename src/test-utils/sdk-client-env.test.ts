/**
 * Tests for the env fixture itself.
 *
 * ⭐ It is an instrument, and its failure mode is a PASS: if env is gone by the
 * time the client under test is constructed, the test sees no leak and reports
 * clean. Nothing else in the suite can tell that apart from a real result, so
 * the fixture needs its own tests.
 *
 * ⚠️ MEASURED 2026-07-30, and it is why the async deferral exists even though it
 * changes no outcome at any of today's four doors. Where the client is built
 * decides whether a restore-on-return fixture can see anything:
 *
 *   sync callback                      → env visible   (llm.ts's createLLM)
 *   async fn, before its first await   → env visible   (check_model via app.request)
 *   async generator, first next()      → env visible   (streamResponsesAPI)
 *   async fn, AFTER an await           → env GONE
 *
 * All four doors happen to sit in the visible group, so every one of these
 * fixtures currently works by an accident of where the first `await` sits. Add
 * one `await` upstream of a client construction and the fixture goes green and
 * blind. The deferral removes that whole class, and this file is what pins it.
 */

import { describe, expect, test } from "bun:test";
import { SDK_CLIENT_ENV, withClientEnv } from "./sdk-client-env.ts";

describe("withClientEnv", () => {
	test("sets what you ask for and deletes every sibling", () => {
		process.env.ANTHROPIC_API_KEY = "outer-key";
		process.env.OPENAI_ORG_ID = "outer-org";
		try {
			const inside = withClientEnv(
				{ ANTHROPIC_AUTH_TOKEN: "only-this" },
				() => ({
					authToken: process.env.ANTHROPIC_AUTH_TOKEN,
					apiKey: process.env.ANTHROPIC_API_KEY,
					org: process.env.OPENAI_ORG_ID,
				}),
			);
			expect(inside).toEqual({
				authToken: "only-this",
				apiKey: undefined,
				org: undefined,
			});
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.OPENAI_ORG_ID;
		}
	});

	test("restores a pre-existing value byte-identically, and an absent one stays absent", () => {
		process.env.ANTHROPIC_API_KEY = "outer-key";
		delete process.env.OPENAI_PROJECT_ID;
		try {
			withClientEnv(
				{ ANTHROPIC_API_KEY: "inner", OPENAI_PROJECT_ID: "inner" },
				() => {
					expect(process.env.ANTHROPIC_API_KEY).toBe("inner");
				},
			);
			expect(process.env.ANTHROPIC_API_KEY).toBe("outer-key");
			expect("OPENAI_PROJECT_ID" in process.env).toBe(false);
		} finally {
			delete process.env.ANTHROPIC_API_KEY;
		}
	});

	test("restores on a throw", () => {
		delete process.env.ANTHROPIC_API_KEY;
		expect(() =>
			withClientEnv({ ANTHROPIC_API_KEY: "inner" }, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
	});

	test("an async callback still sees env AFTER an await, and env is restored once it settles", async () => {
		delete process.env.ANTHROPIC_API_KEY;
		const afterAwait = await withClientEnv(
			{ ANTHROPIC_API_KEY: "inner" },
			async () => {
				await Promise.resolve();
				// Without the deferral this is `undefined` — the fixture has already
				// restored, and any client built here reads the real shell.
				return process.env.ANTHROPIC_API_KEY;
			},
		);
		expect(afterAwait).toBe("inner");
		expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
	});

	test("an async callback that rejects still restores", async () => {
		delete process.env.ANTHROPIC_API_KEY;
		await expect(
			withClientEnv({ ANTHROPIC_API_KEY: "inner" }, async () => {
				await Promise.resolve();
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect("ANTHROPIC_API_KEY" in process.env).toBe(false);
	});

	test("the list covers both vendors' credential, host and attribution names", () => {
		// A subtract-list would be wrong here: there is no way to enumerate "every
		// env var an SDK might read". So the list is explicit, and this pins it so
		// that dropping a name is a visible edit rather than a fixture that quietly
		// stops covering one.
		expect([...SDK_CLIENT_ENV]).toEqual([
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"OPENAI_API_KEY",
			"OPENAI_BASE_URL",
			"OPENAI_ORG_ID",
			"OPENAI_PROJECT_ID",
		]);
	});
});
