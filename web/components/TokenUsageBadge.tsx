import { useLocale } from "../i18n.ts";

/** Format a token count compactly: 1234 → "1.2k", 1234567 → "1.2M" */
export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function TokenUsageBadge({
	inputTokens,
	contextWindow,
	estimated,
	onCompact,
}: {
	inputTokens: number;
	contextWindow: number;
	estimated?: boolean;
	onCompact?: () => void;
}) {
	const { t } = useLocale();
	const ratio = contextWindow > 0 ? inputTokens / contextWindow : 0;
	const level = ratio >= 0.8 ? "red" : ratio >= 0.5 ? "yellow" : "green";
	const tooltip = `${t("footer.contextWindow")}: ${formatTokenCount(inputTokens)} / ${formatTokenCount(contextWindow)}${estimated ? ` (${t("footer.estimated")})` : ""}`;
	return (
		<span className={`og-token-badge og-token-${level}`} title={tooltip}>
			{formatTokenCount(inputTokens)} / {formatTokenCount(contextWindow)}
			{estimated && <span className="og-token-estimated">~</span>}
			{onCompact && (
				<button
					type="button"
					className="og-compact-btn"
					onClick={onCompact}
					title={t("footer.compact")}
				>
					⌘
				</button>
			)}
		</span>
	);
}
