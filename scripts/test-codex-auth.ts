import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CodexAuthFile {
	auth_mode?: string;
	tokens?: {
		id_token?: string;
		access_token?: string;
		refresh_token?: string;
		account_id?: string;
	};
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split(".");
	if (parts.length < 2) return null;
	try {
		const b64 = parts[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "";
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return null;
	}
}

function getStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];
}

async function main(): Promise<void> {
	const model = process.argv[2] ?? "gpt-4o-mini";
	const baseUrl = process.argv[3] ?? "https://api.openai.com/v1";
	const wireApi = process.argv[4] ?? "chat";
	const authPath = join(homedir(), ".codex", "auth.json");
	const auth = JSON.parse(readFileSync(authPath, "utf8")) as CodexAuthFile;

	const accessToken = auth.tokens?.access_token;
	if (!accessToken) {
		throw new Error(`No tokens.access_token found in ${authPath}`);
	}

	const payload = decodeJwtPayload(accessToken);
	const exp = typeof payload?.exp === "number" ? payload.exp : null;
	const scopes = getStringArray(payload?.scp);

	console.log("Auth diagnostics:");
	console.log(`  auth_mode: ${auth.auth_mode ?? "(unknown)"}`);
	console.log(`  model: ${model}`);
	console.log(`  baseUrl: ${baseUrl}`);
	console.log(`  wireApi: ${wireApi}`);
	console.log(`  accessTokenIsJwt: ${payload ? "yes" : "no"}`);
	console.log(
		`  exp: ${exp ? new Date(exp * 1000).toISOString() : "(missing)"}`,
	);
	console.log(
		`  scopes: ${scopes.length > 0 ? scopes.join(", ") : "(missing)"}`,
	);
	console.log("");

	const url =
		wireApi === "responses"
			? `${baseUrl}/responses`
			: `${baseUrl}/chat/completions`;
	const body =
		wireApi === "responses"
			? {
					model,
					input: "Reply with OK only.",
					max_output_tokens: 8,
				}
			: {
					model,
					messages: [{ role: "user", content: "Reply with OK only." }],
					max_tokens: 8,
				};

	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	const text = await response.text();
	console.log(`HTTP ${response.status} ${response.statusText}`);
	console.log(text);
}

await main();
