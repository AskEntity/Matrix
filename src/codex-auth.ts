import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenAIAuthGroup } from "./config.ts";

/**
 * Expand a leading `~/`, because the documented location of this file IS
 * `~/.codex/auth.json` and the two places a user types it — a settings text
 * field and a JSON config file — do not go through a shell.
 *
 * Without this the failure is invisible rather than merely inconvenient: the
 * error would quote back the exact path they typed, which looks correct, while
 * the read was attempted somewhere under the process's cwd.
 */
function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/**
 * The credential material one OpenAI call needs.
 *
 * `accountId` is the `ChatGPT-Account-Id` header's value on the codex path.
 * MEASURED 2026-07-30 against a live token: `GET
 * chatgpt.com/backend-api/codex/models` answers 200 identically with and
 * without that header, so it is NOT required there. It is still sent, because
 * the codex CLI sends it and the responses path has never been probed without
 * it — "not required by /models" is not "not required anywhere".
 */
export interface OpenAICredential {
	authToken: string;
	accountId?: string;
}

/**
 * Asked at EVERY use, never resolved once and kept.
 *
 * ⭐ This is the whole point of the design rather than an implementation
 * detail. The codex CLI refreshes `auth.json` behind us — measured: the file on
 * this machine was rewritten one minute after the task to read it was filed —
 * and OpenAI ROTATES the refresh token on each refresh, invalidating the
 * previous one. So a value we read once and hold is not a snapshot that merely
 * goes stale; it is a second claimant to a chain we do not own. Reading at each
 * use is what makes codex the owner and matrix the reader.
 *
 * "Every use" is per HTTP REQUEST, not per agent turn: `streamResponsesAPI`
 * hands this function to the OpenAI SDK's `apiKey` slot, which invokes it before
 * every attempt, so an SDK retry inside one call re-reads the file. The one
 * place that is not true is the `ChatGPT-Account-Id` header — see the line
 * drawn in that function.
 *
 * Cost is one `readFile` of a small local JSON file per request — the same trade
 * `readAuthData` makes, and for the same reason: the alternative failure is "the
 * user re-authenticated and the running daemon never noticed".
 */
export type OpenAICredentialSource = () => Promise<OpenAICredential>;

/** The subset of codex's `auth.json` we read. Everything else is ignored. */
interface CodexAuthFile {
	tokens?: {
		access_token?: string;
		account_id?: string;
	};
}

/**
 * Seconds-since-epoch `exp` from a JWT, or null when it cannot be read.
 *
 * Null means "we cannot judge freshness", NOT "expired": a token we fail to
 * parse is still handed to the API, which is the authority on whether it works.
 * Failing locally on an unparseable token would turn a working call into an
 * error on our guess.
 */
function jwtExpiry(token: string): number | null {
	const segments = token.split(".");
	if (segments.length !== 3) return null;
	try {
		const payload = JSON.parse(
			Buffer.from(segments[1] as string, "base64url").toString("utf-8"),
		) as { exp?: unknown };
		return typeof payload.exp === "number" ? payload.exp : null;
	} catch {
		return null;
	}
}

/**
 * Read codex's `auth.json` and return the credential it holds.
 *
 * ⚠️ READ ONLY. We never write this file, and must not: the refresh chain
 * belongs to the codex CLI, and rewriting it from an older copy throws away the
 * tokens codex just refreshed. An expired token is therefore an ERROR with an
 * instruction, never something we try to refresh ourselves.
 */
export async function readCodexAuth(
	configuredPath: string,
): Promise<OpenAICredential> {
	// Errors quote the RESOLVED path, not what was configured: "~/.codex/auth.json
	// does not exist" is unfalsifiable to the reader, the absolute path is not.
	const path = expandHome(configuredPath);
	let text: string;
	try {
		text = await readFile(path, "utf-8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
			throw new Error(
				`OpenAI auth: "${path}" does not exist. On a machine with the codex CLI, run \`codex login\` to create it.`,
			);
		}
		throw new Error(
			`OpenAI auth: cannot read "${path}": ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	let parsed: CodexAuthFile;
	try {
		parsed = JSON.parse(text) as CodexAuthFile;
	} catch (e) {
		throw new Error(
			`OpenAI auth: "${path}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	// ⚠️ A null `OPENAI_API_KEY` in this file is NORMAL — it is the marker of the
	// ChatGPT OAuth path, not damage. We never look at that field; the token we
	// want is always `tokens.access_token`.
	const accessToken = parsed.tokens?.access_token;
	if (!accessToken) {
		throw new Error(
			`OpenAI auth: "${path}" has no \`tokens.access_token\`. On a machine with the codex CLI, run \`codex login\` to refresh it.`,
		);
	}

	const exp = jwtExpiry(accessToken);
	if (exp !== null && exp * 1000 <= Date.now()) {
		throw new Error(
			`OpenAI auth: the token in "${path}" expired on ${new Date(exp * 1000).toISOString()}. ` +
				"On a machine with the codex CLI, run `codex login` to refresh it. " +
				"matrix only reads this file — refreshing it belongs to codex, so we cannot renew it for you.",
		);
	}

	return { authToken: accessToken, accountId: parsed.tokens?.account_id };
}

/**
 * The credential source for one OpenAI auth group.
 *
 * The two sources are mutually exclusive and reach different endpoints:
 * `apiKey` is a platform key for `api.openai.com`, `authJsonPath` is codex's
 * OAuth token for the codex endpoint. ⚠️ They must not cross — the ChatGPT
 * OAuth token lacks the scope the platform API requires, and every platform
 * endpoint rejects it.
 *
 * A group carrying neither fails at first USE rather than at construction, so
 * that a misconfigured group cannot take down a daemon that was never going to
 * call it.
 */
export function openAICredentialSource(
	group: OpenAIAuthGroup,
): OpenAICredentialSource {
	if (group.apiKey) {
		const credential: OpenAICredential = { authToken: group.apiKey };
		return async () => credential;
	}
	if (group.authJsonPath) {
		const path = group.authJsonPath;
		return () => readCodexAuth(path);
	}
	return async () => {
		throw new Error(
			'OpenAI auth: group has neither "apiKey" nor "authJsonPath". Set "apiKey" for the OpenAI platform API, or "authJsonPath" pointing at the auth.json the codex CLI writes (usually ~/.codex/auth.json).',
		);
	};
}

/** A fixed credential — for callers that already hold a token (tests, probes). */
export function staticCredential(
	authToken: string,
	accountId?: string,
): OpenAICredentialSource {
	const credential: OpenAICredential = { authToken, accountId };
	return async () => credential;
}
