/**
 * A model's context window comes from the endpoint, and from nowhere else.
 *
 * There is no local table, no substring guess and no default constant. All
 * three lived here until 2026-07-29, and on that day every one of them was
 * measured wrong against the real APIs — in BOTH directions:
 *
 * | model                      | endpoint  | we guessed |
 * |----------------------------|-----------|------------|
 * | `claude-sonnet-5`          | 1,000,000 |    200,000 |
 * | `k3` (kimi)                | 1,048,576 |    200,000 |
 * | `claude-opus-4-5-20251101` |   200,000 |  1,000,000 |
 *
 * Under-estimating throws context away silently. **Over-estimating is the
 * dangerous one**: it makes us wait until ~900K to compact against an API that
 * refuses at 200K, which walks straight into the compaction deadlock (a
 * session too short to auto-compact keeps calling the API until the window
 * rejects it — `01KXNZHYSJFF0BVQJVPG2WC1RV`). Neither direction reddens
 * anything, because 200000 and 1000000 are both entirely normal numbers.
 *
 * So when the endpoint will not answer, we THROW. A number nobody chose,
 * silently deciding when we compact, is the defect being removed here — the
 * same defect as `?? DEFAULT_MODEL`, deleted the same night for the same
 * reason. A fallback would reinstate it wearing a different name.
 */

/**
 * Cached windows, keyed by endpoint AND model.
 *
 * ⚠️ Never key on the model alone. **The window is a property of the
 * DEPLOYMENT, not of the model**: `k3` is 1M and `k3-256k` is 256K at the same
 * host, and GPT-5.5 is 1,050,000 on OpenAI's own API but caps at 272,000 of
 * input through the codex endpoint. A model-keyed cache reports one
 * deployment's number for another's traffic.
 *
 * One model does not even have one NAME across deployments — Haiku 4.5 is
 * `claude-haiku-4-5-20251001` on the Claude API,
 * `anthropic.claude-haiku-4-5-20251001-v1:0` on Bedrock and
 * `claude-haiku-4-5@20251001` on Vertex. The endpoint is the thing that knows.
 */
const cache = new Map<string, number>();

/** NUL cannot appear in a URL or a model id, so the key cannot be ambiguous. */
function cacheKey(endpoint: string, model: string): string {
	return `${endpoint}\u0000${model}`;
}

/** Drop every cached window. Tests only — a window does not change under a running process. */
export function clearContextWindowCache(): void {
	cache.clear();
}

export interface ContextWindowLookup {
	/**
	 * The deployment being asked — its base URL. Used as the cache key and
	 * named in every error, so the reader knows which endpoint refused.
	 */
	endpoint: string;
	model: string;
	/**
	 * Return the endpoint's model-list entries.
	 *
	 * Supplied by the provider because only the provider knows how to
	 * authenticate to its own endpoint; this module owns what the answer
	 * MEANS. Throwing from here is expected and gets wrapped with the endpoint
	 * and model names.
	 */
	listModels: () => Promise<unknown[]>;
	/**
	 * How the model list was asked for — a URL, typically. Appended to the
	 * error when the endpoint answers with NO entries at all.
	 *
	 * It exists because that particular failure is usually OUR fault rather
	 * than the user's: the codex catalog filters its whole list on a
	 * `client_version` query parameter we send, so an empty answer points at
	 * the request, not at the config. Naming the request is what makes the
	 * error land on the right suspect. Optional — an endpoint with no such
	 * parameter has nothing to disclose.
	 */
	requestDetail?: string;
}

/**
 * Where an entry's NAME lives. Three dialects, one lookup.
 *
 * OpenAI and Anthropic both say `id`; the codex catalog says `slug` and carries
 * no `id` at all. This list extends the same rule the window keys follow — read
 * every dialect's spelling and let the response decide — rather than branching
 * on which endpoint we think we are talking to.
 */
const ID_KEYS = ["id", "slug"] as const;

function readId(entry: Record<string, unknown>): string | null {
	for (const key of ID_KEYS) {
		const value = entry[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

/**
 * The three keys we read, and the ONLY three.
 *
 * ⚠️ The key name follows the PROTOCOL DIALECT, not the configured provider —
 * so read all of them and let the response decide. kimi's auth group is
 * `provider: "anthropic"` and its response looks Anthropic all over (`type`,
 * `display_name`, `created_at`, an envelope with `first_id`/`has_more`) while
 * putting the number under OpenAI's `context_length`. A client that picks the
 * key from the provider type looks for `max_input_tokens`, does not find it,
 * and reports 200000 with 1M sitting in the next field. The codex catalog is a
 * third dialect again: `context_window`, keyed by `slug`, wrapped in `models`.
 *
 * ⚠️ And nothing outside this list, however much it looks like a limit. Three
 * measured members of that family now, which is why this warning is a list and
 * not an anecdote:
 *
 * - Anthropic's `max_tokens` sits right beside `max_input_tokens` and is the
 *   OUTPUT cap — 128,000 next to a 1,000,000 window. LiteLLM #14876.
 * - xAI's `long_context_threshold` is a PRICING breakpoint. OpenClaw #88596
 *   read it as the window and reported a 1M model as 200K.
 * - ⭐ codex's **`max_context_window`** is the model's ceiling SOMEWHERE ELSE,
 *   not what this deployment grants. MEASURED 2026-07-30: `gpt-5.4` reports
 *   `context_window: 272000` and `max_context_window: 1000000` in the same
 *   entry — **3.68× apart**, and the same for `codex-auto-review`. Five of the
 *   seven models have them equal, so a fixture drawn from those five cannot
 *   tell the two keys apart; only `gpt-5.4` can. Reading the wrong one
 *   over-estimates, which is the direction that walks into the compaction
 *   deadlock.
 */
const WINDOW_KEYS = [
	"max_input_tokens",
	"context_length",
	"context_window",
] as const;

function readWindow(entry: Record<string, unknown>): number | null {
	for (const key of WINDOW_KEYS) {
		const value = entry[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return value;
		}
	}
	return null;
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * The one remedy a missing id can carry: if EXACTLY ONE listed id starts with
 * what was configured, name it.
 *
 * Suggest, never resolve. The difference is who chooses — an id the user then
 * writes into their config is chosen and auditable; an id we prefix-resolved
 * on their behalf is guessed and invisible, which is the whole defect. It also
 * keeps the error to a remedy that actually works: one config edit.
 *
 * ⚠️ Strictly the exactly-one case. Two or more candidates IS the ambiguity
 * being deleted (`k3` matching `k3-256k` alongside `k3` itself), so there the
 * caller lists everything and suggests nothing.
 */
function suggestId(model: string, ids: string[]): string | null {
	const candidates = ids.filter((id) => id.startsWith(model));
	return candidates.length === 1 ? (candidates[0] as string) : null;
}

/**
 * Ask `endpoint` what `model`'s context window is.
 *
 * Matching is EXACT on the model id, deliberately — prefix matching used to
 * live in the OpenAI provider and was deleted with the rest of the guessing.
 * It reads as harmless because model names usually nest, so state the reason
 * that survives someone re-proposing it:
 *
 * ⭐ **`/v1/models` is keyed by model ID. An ALIAS is a separate documented
 * name that the server resolves to whatever snapshot it currently points at,
 * and it is DESIGNED TO MOVE.** Anthropic's own table carries the two as
 * separate columns: `claude-haiku-4-5-20251001` is the ID, `claude-haiku-4-5`
 * is its alias, and the list returns only the former. So there is no correct
 * client-side alias→ID mapping — only the server knows where an alias points
 * today. Prefix-matching an alias onto a listed ID gets today's answer right
 * because of a naming convention, and the day an alias is repointed it
 * silently follows list order instead of the official mapping.
 *
 * ⚠️ Do NOT "fix" that by reading `response.model` off a probe request. It
 * does expand aliases, and memory.md records it measured as NOT ground truth:
 * a client declaring model X received model Y's output while `response.model`
 * kept reporting X. It would also cost a real inference call for something one
 * config edit fixes.
 *
 * The same rule catches the non-alias cases for free: `k3` is a prefix of
 * `k3-256k` (1M vs 256K at one host), and `claude-opus-4` is a prefix of both
 * a 1M ID and a 200K one with list order deciding. A prefix match IS a
 * fallback, which is the thing being removed.
 *
 * ⚠️ MEASURED COST, accepted with the user's decision: `claude-haiku-4-5` is
 * NOT among the 11 IDs `api.anthropic.com` lists, and the messages API accepts
 * it (HTTP 200, probed 2026-07-29). So a config naming an alias now hard-errors
 * where it used to work. That is why a miss SUGGESTS rather than resolves —
 * see `suggestId`.
 *
 * ⭐ **An EMPTY list is a refusal, not an answer**, and it is a third state this
 * module originally had no name for. The thesis is "the endpoint is the only
 * source; if it will not answer, throw" — which quietly assumes an endpoint
 * either answers or fails. A 200 carrying `[]` is neither: it is a refusal
 * wearing the shape of a complete reply. MEASURED 2026-07-30: the codex catalog
 * returns 200 with zero models for `client_version=0.50.0`, seven for
 * `0.144.0`, and **four** for `0.143.0` — so the list is silently filtered by a
 * parameter WE send.
 *
 * Classifying it as "the endpoint does not list your model" is wrong twice: it
 * blames a config field the user would then edit, and editing it cannot help.
 * That is *never offer a remedy that will not work*. So an empty list gets its
 * own error, which says the endpoint declined to enumerate anything and names
 * the request that produced it.
 *
 * @throws if the endpoint cannot be reached, enumerates nothing, does not list
 * the model, or lists it without a window. There is no fallback and no config
 * override by design.
 */
export async function resolveContextWindow({
	endpoint,
	model,
	listModels,
	requestDetail,
}: ContextWindowLookup): Promise<number> {
	const key = cacheKey(endpoint, model);
	const cached = cache.get(key);
	if (cached !== undefined) return cached;

	let entries: unknown[];
	try {
		entries = await listModels();
	} catch (err) {
		throw new Error(
			`Cannot determine the context window for "${model}": asking ${endpoint} for its model list failed — ${describe(err)}. ` +
				`Matrix reads the window from the endpoint and keeps no local table, so there is nothing to fall back on.`,
		);
	}

	const ids: string[] = [];
	let match: Record<string, unknown> | undefined;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const id = readId(record);
		if (id === null) continue;
		ids.push(id);
		if (id === model) match = record;
	}

	// The refusal case, kept ahead of the miss case so it cannot be reported as
	// a statement about `model` — see the doc above.
	if (ids.length === 0) {
		throw new Error(
			`Cannot determine the context window for "${model}": ${endpoint} enumerated no models at all. ` +
				`That is a refusal to answer rather than a statement that "${model}" is unavailable, so the cause is more likely the request than the configured model` +
				(requestDetail ? ` — asked as: ${requestDetail}` : "") +
				".",
		);
	}

	if (!match) {
		const suggestion = suggestId(model, ids);
		throw new Error(
			`Cannot determine the context window for "${model}": ${endpoint} does not list it. ` +
				(suggestion ? `Did you mean "${suggestion}"? ` : "") +
				`Models it does list: ${ids.join(", ")}.`,
		);
	}

	const window = readWindow(match);
	if (window === null) {
		throw new Error(
			`Cannot determine the context window for "${model}": ${endpoint} lists it but reports neither ` +
				`${WINDOW_KEYS.join(" nor ")}. The entry carries: ${Object.keys(match).join(", ")}.`,
		);
	}

	cache.set(key, window);
	return window;
}
