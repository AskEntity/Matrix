/**
 * Tests for the ONE place a context window comes from.
 *
 * Every number below was measured against the real endpoints on 2026-07-29 —
 * `api.anthropic.com` (11 models, all under `max_input_tokens`) and
 * `api.kimi.com/coding/` (4 models, all under `context_length`). The point of
 * using real values rather than round ones is that the two dialect cases and
 * the two same-host-different-window cases are facts, not fixtures.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	clearContextWindowCache,
	resolveContextWindow,
} from "./context-window.ts";

/** A models list that records how many times it was asked for. */
function listing(entries: Array<Record<string, unknown>>): {
	listModels: () => Promise<unknown[]>;
	calls: () => number;
} {
	let calls = 0;
	return {
		listModels: async () => {
			calls++;
			return entries;
		},
		calls: () => calls,
	};
}

beforeEach(() => {
	clearContextWindowCache();
});

describe("which key the window is read from", () => {
	test("Anthropic's dialect: max_input_tokens", async () => {
		const { listModels } = listing([
			{
				type: "model",
				id: "claude-opus-5",
				display_name: "Claude Opus 5",
				max_input_tokens: 1_000_000,
				max_tokens: 128_000,
			},
		]);
		expect(
			await resolveContextWindow({
				endpoint: "https://api.anthropic.com",
				model: "claude-opus-5",
				listModels,
			}),
		).toBe(1_000_000);
	});

	/**
	 * ⭐ The trap this test exists for. kimi's auth group is
	 * `provider: "anthropic"`, and the response below is byte-shaped like
	 * Anthropic's — `type: "model"`, `display_name`, `created_at` — while the
	 * number sits under OpenAI's key. A client that picks the key from the
	 * configured provider type looks for `max_input_tokens`, does not find it,
	 * and (before this module) answered 200000 with 1M in the next field.
	 */
	test("kimi looks Anthropic and answers under OpenAI's context_length", async () => {
		const { listModels } = listing([
			{
				id: "k3",
				created: 1761264000,
				created_at: "2025-10-24T00:00:00Z",
				object: "model",
				type: "model",
				display_name: "K3",
				context_length: 1_048_576,
				supports_thinking_type: "only",
			},
		]);
		expect(
			await resolveContextWindow({
				endpoint: "https://api.kimi.com/coding/",
				model: "k3",
				listModels,
			}),
		).toBe(1_048_576);
	});

	/**
	 * ⭐ The codex catalog is a THIRD dialect and disagrees on all three of
	 * envelope, name key and window key. Entry copied from the live response
	 * (2026-07-30, `client_version=999.0.0`), trimmed to the fields that matter
	 * plus the ones that make it a trap.
	 */
	test("codex's dialect: window under context_window, name under slug", async () => {
		const { listModels } = listing([
			{
				slug: "gpt-5.5",
				display_name: "GPT-5.5",
				context_window: 272_000,
				max_context_window: 272_000,
				minimal_client_version: "0.124.0",
			},
		]);
		expect(
			await resolveContextWindow({
				endpoint: "https://chatgpt.com/backend-api/codex",
				model: "gpt-5.5",
				listModels,
			}),
		).toBe(272_000);
	});

	/**
	 * ⚠️ MEASURED 2026-07-30, and the reason this test exists rather than a
	 * comment: on `gpt-5.4` the codex catalog reports `context_window: 272000`
	 * NEXT TO `max_context_window: 1000000` — 3.68× apart. `context_window` is
	 * what this deployment grants; `max_context_window` is the model's ceiling
	 * somewhere else. Reading the wrong one over-estimates, which is the
	 * direction that walks into the compaction deadlock.
	 *
	 * Five of the seven live models have the two keys EQUAL, so a fixture drawn
	 * from those five cannot tell them apart — this entry is `gpt-5.4`
	 * specifically because it is one of the two that can. The mutation that
	 * proves it: add `max_context_window` to WINDOW_KEYS before
	 * `context_window` and this goes red at 1,000,000.
	 */
	test("max_context_window is NOT the window this deployment grants", async () => {
		const { listModels } = listing([
			{
				slug: "gpt-5.4",
				context_window: 272_000,
				max_context_window: 1_000_000,
			},
		]);
		expect(
			await resolveContextWindow({
				endpoint: "https://chatgpt.com/backend-api/codex",
				model: "gpt-5.4",
				listModels,
			}),
		).toBe(272_000);
	});

	test("an entry with no name key at all is skipped, not crashed on", async () => {
		const { listModels } = listing([
			{ context_window: 999 },
			{ slug: "gpt-5.5", context_window: 272_000 },
		]);
		expect(
			await resolveContextWindow({
				endpoint: "e",
				model: "gpt-5.5",
				listModels,
			}),
		).toBe(272_000);
	});

	test("max_input_tokens wins when an entry somehow carries both", async () => {
		const { listModels } = listing([
			{ id: "m", max_input_tokens: 200_000, context_length: 999 },
		]);
		expect(
			await resolveContextWindow({ endpoint: "e", model: "m", listModels }),
		).toBe(200_000);
	});

	/**
	 * ⚠️ `max_tokens` is the OUTPUT cap and sits directly beside
	 * `max_input_tokens` in every real Anthropic entry (128,000 next to
	 * 1,000,000). Reading it as the window is LiteLLM #14876. The mutation that
	 * proves this test: add `"max_tokens"` to WINDOW_KEYS and it goes red.
	 */
	test("max_tokens is NOT a context window", async () => {
		const { listModels } = listing([
			{ id: "claude-opus-5", type: "model", max_tokens: 128_000 },
		]);
		await expect(
			resolveContextWindow({
				endpoint: "https://api.anthropic.com",
				model: "claude-opus-5",
				listModels,
			}),
		).rejects.toThrow(/neither max_input_tokens nor context_length/);
	});

	/**
	 * ⚠️ OpenClaw #88596 read xAI's `long_context_threshold` — a PRICING
	 * breakpoint — as the window and reported a 1M model as 200K. Any
	 * limit-shaped number that is not one of the two keys is a different
	 * quantity, so an entry carrying only those must fail rather than answer.
	 */
	test("a plausible-looking third key is not read", async () => {
		const { listModels } = listing([
			{
				id: "grok-4",
				long_context_threshold: 200_000,
				max_output_tokens: 32_000,
			},
		]);
		await expect(
			resolveContextWindow({
				endpoint: "https://api.x.ai/v1",
				model: "grok-4",
				listModels,
			}),
		).rejects.toThrow(/neither max_input_tokens nor context_length/);
	});

	test("a non-positive or non-numeric value is not a window", async () => {
		for (const bad of [0, -1, "1000000", null, Number.NaN]) {
			clearContextWindowCache();
			const { listModels } = listing([{ id: "m", max_input_tokens: bad }]);
			await expect(
				resolveContextWindow({ endpoint: "e", model: "m", listModels }),
			).rejects.toThrow(/neither max_input_tokens nor context_length/);
		}
	});
});

describe("the window belongs to the endpoint, not the model", () => {
	/**
	 * ⭐ `k3` and `k3-256k` are the same model deployed twice at ONE host, with
	 * a 4× difference. Two separate facts follow, and this file tests both:
	 * the id must match exactly (below), and the cache must be keyed on
	 * endpoint AND model (here).
	 */
	test("one model id, two deployments, two answers — no cross-talk", async () => {
		const big = listing([{ id: "k3", context_length: 1_048_576 }]);
		const small = listing([{ id: "k3", context_length: 262_144 }]);

		expect(
			await resolveContextWindow({
				endpoint: "https://api.kimi.com/coding/",
				model: "k3",
				listModels: big.listModels,
			}),
		).toBe(1_048_576);
		expect(
			await resolveContextWindow({
				endpoint: "https://mirror.example/coding/",
				model: "k3",
				listModels: small.listModels,
			}),
		).toBe(262_144);
		expect(big.calls()).toBe(1);
		expect(small.calls()).toBe(1);
	});

	test("a hit is cached per endpoint+model", async () => {
		const { listModels, calls } = listing([
			{ id: "k3", context_length: 1_048_576 },
			{ id: "k3-256k", context_length: 262_144 },
		]);
		const ask = (model: string) =>
			resolveContextWindow({ endpoint: "https://kimi", model, listModels });

		expect(await ask("k3")).toBe(1_048_576);
		expect(await ask("k3")).toBe(1_048_576);
		expect(calls()).toBe(1);
		// A different model at the same endpoint is a separate question.
		expect(await ask("k3-256k")).toBe(262_144);
		expect(calls()).toBe(2);
	});

	test("a failure is never cached — the next attempt asks again", async () => {
		let attempt = 0;
		const listModels = async () => {
			attempt++;
			if (attempt === 1) throw new Error("connect ECONNREFUSED");
			return [{ id: "m", max_input_tokens: 200_000 }];
		};
		const ask = () =>
			resolveContextWindow({ endpoint: "e", model: "m", listModels });

		await expect(ask()).rejects.toThrow(/ECONNREFUSED/);
		expect(await ask()).toBe(200_000);
	});
});

describe("exact id matching", () => {
	/**
	 * ⭐ `/v1/models` is keyed by model ID; an alias is a separate documented
	 * name the server repoints at will. So prefix resolution is a guess about
	 * which snapshot an alias designates today. Here it would have had to
	 * choose between a 1M ID and a 200K ID by list order.
	 */
	test("a prefix is not a match, even when only one candidate exists", async () => {
		const { listModels } = listing([
			{ id: "claude-opus-4-8", max_input_tokens: 1_000_000 },
			{ id: "claude-opus-4-1-20250805", max_input_tokens: 200_000 },
		]);
		await expect(
			resolveContextWindow({
				endpoint: "https://api.anthropic.com",
				model: "claude-opus-4",
				listModels,
			}),
		).rejects.toThrow(/does not list it/);
	});

	test("the reverse direction is not a match either", async () => {
		const { listModels } = listing([{ id: "gpt-4o", context_length: 131072 }]);
		await expect(
			resolveContextWindow({
				endpoint: "https://api.openai.com/v1",
				model: "gpt-4o-2024-08-06",
				listModels,
			}),
		).rejects.toThrow(/does not list it/);
	});

	test("k3 does not answer with k3-256k's window", async () => {
		// Ordered so that a prefix pass over `k3-256k` would hit it first.
		const { listModels } = listing([
			{ id: "k3-256k", context_length: 262_144 },
			{ id: "kimi-for-coding", context_length: 262_144 },
		]);
		await expect(
			resolveContextWindow({
				endpoint: "https://api.kimi.com/coding/",
				model: "k3",
				listModels,
			}),
		).rejects.toThrow(/does not list it/);
	});
});

describe("what a miss tells the user", () => {
	/**
	 * MEASURED: `claude-haiku-4-5` is the documented ALIAS of
	 * `claude-haiku-4-5-20251001`; `/v1/models` returns IDs, so the alias is
	 * not among the 11 entries — and the messages API accepts it anyway (HTTP
	 * 200, 2026-07-29). That is the real cost of exact matching, and the
	 * suggestion is what pays it down: one config edit, chosen by the user
	 * rather than guessed by us. All four of Anthropic's dated models have
	 * exactly one listed ID starting with their alias, so this branch covers
	 * every alias in play today.
	 */
	test("exactly one prefix candidate is suggested by name", async () => {
		const { listModels } = listing([
			{ id: "claude-opus-5", max_input_tokens: 1_000_000 },
			{ id: "claude-haiku-4-5-20251001", max_input_tokens: 200_000 },
		]);
		await expect(
			resolveContextWindow({
				endpoint: "https://api.anthropic.com",
				model: "claude-haiku-4-5",
				listModels,
			}),
		).rejects.toThrow(/Did you mean "claude-haiku-4-5-20251001"\?/);
	});

	/**
	 * ⚠️ Two candidates IS the ambiguity exact matching exists to delete, so
	 * naming either one would be the guess wearing a question mark.
	 */
	test("two prefix candidates suggest nothing", async () => {
		const { listModels } = listing([
			{ id: "claude-opus-4-8", max_input_tokens: 1_000_000 },
			{ id: "claude-opus-4-1-20250805", max_input_tokens: 200_000 },
		]);
		const call = resolveContextWindow({
			endpoint: "https://api.anthropic.com",
			model: "claude-opus-4",
			listModels,
		});
		await expect(call).rejects.toThrow(/does not list it/);
		await expect(call).rejects.not.toThrow(/Did you mean/);
	});

	test("the miss names the endpoint, the model and every id on offer", async () => {
		const { listModels } = listing([
			{ id: "k3", context_length: 1_048_576 },
			{ id: "k3-256k", context_length: 262_144 },
		]);
		await expect(
			resolveContextWindow({
				endpoint: "https://api.kimi.com/coding/",
				model: "gpt-4o",
				listModels,
			}),
		).rejects.toThrow(
			/"gpt-4o".*https:\/\/api\.kimi\.com\/coding\/.*k3, k3-256k/s,
		);
	});

	/**
	 * ⭐ An empty list is a REFUSAL, not an answer — the third state this module
	 * had no name for. MEASURED 2026-07-30: the codex catalog answers 200 with
	 * zero models when `client_version` is below its floor, so the cause sits in
	 * a parameter WE send, not in the user's config.
	 *
	 * This test replaces one that asserted the miss wording with
	 * `Models it does list: (none)`. That sentence was about the user's model
	 * name, which is a remedy that cannot work — they would edit the config and
	 * nothing would change.
	 */
	test("an endpoint that enumerates nothing is a refusal, not a missing model", async () => {
		const call = resolveContextWindow({
			endpoint: "https://chatgpt.com/backend-api/codex",
			model: "gpt-5.5",
			listModels: async () => [],
		});
		await expect(call).rejects.toThrow(/enumerated no models at all/);
		await expect(call).rejects.toThrow(/refusal to answer/);
		// Must NOT read as a statement about the configured model.
		await expect(call).rejects.not.toThrow(/does not list it/);
		await expect(call).rejects.not.toThrow(/Did you mean/);
	});

	test("the refusal names the request, so the blame lands on the right suspect", async () => {
		await expect(
			resolveContextWindow({
				endpoint: "https://chatgpt.com/backend-api/codex",
				model: "gpt-5.5",
				listModels: async () => [],
				requestDetail:
					"GET https://chatgpt.com/backend-api/codex/models?client_version=999.0.0",
			}),
		).rejects.toThrow(/asked as: GET .*client_version=999\.0\.0/);
	});

	test("with no requestDetail the refusal still reads as a sentence", async () => {
		await expect(
			resolveContextWindow({
				endpoint: "https://empty.example",
				model: "m",
				listModels: async () => [],
			}),
		).rejects.toThrow(
			/is unavailable, so the cause is more likely the request than the configured model\.$/,
		);
	});

	test("an unreachable endpoint carries the underlying reason", async () => {
		await expect(
			resolveContextWindow({
				endpoint: "https://api.openai.com/v1",
				model: "gpt-5",
				listModels: async () => {
					throw new Error("GET .../models returned 401 Unauthorized");
				},
			}),
		).rejects.toThrow(/401 Unauthorized/);
	});

	test("malformed entries are skipped rather than crashing the lookup", async () => {
		const { listModels } = listing([
			null as unknown as Record<string, unknown>,
			"nonsense" as unknown as Record<string, unknown>,
			{ noId: true },
			{ id: 42 },
			{ id: "m", max_input_tokens: 200_000 },
		]);
		expect(
			await resolveContextWindow({ endpoint: "e", model: "m", listModels }),
		).toBe(200_000);
	});
});
