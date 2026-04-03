import { memo } from "react";
import { useLocale } from "../i18n.ts";

/** Format a token count compactly: 1234 → "1.2k", 1234567 → "1.2M" */
export function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/**
 * Compute the compaction threshold from the context window.
 * Mirrors getCompactionThresholds() in src/compaction.ts.
 * Smaller windows need more buffer (17%), 1M+ windows use 8%.
 */
export function getCompactThreshold(contextWindow: number): number {
	const ratio = contextWindow >= 1_000_000 ? 0.08 : 0.17;
	return Math.floor(contextWindow * (1 - ratio));
}

export const TokenUsageBadge = memo(function TokenUsageBadge({
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
	const threshold = getCompactThreshold(contextWindow);
	const ratio = threshold > 0 ? inputTokens / threshold : 0;
	const level = ratio >= 0.95 ? "red" : ratio >= 0.8 ? "yellow" : "green";
	const tooltip = `${t("footer.contextWindow")}: ${formatTokenCount(inputTokens)} / ${formatTokenCount(threshold)}${estimated ? ` (${t("footer.estimated")})` : ""}\n${t("footer.compactAt")} ${formatTokenCount(threshold)}`;
	return (
		<>
			{onCompact && (
				<button
					type="button"
					className="mxd-compact-trigger-btn"
					onClick={onCompact}
					title={t("footer.compact")}
				>
					⌘
				</button>
			)}
			<span className={`mxd-token-badge mxd-token-${level}`} title={tooltip}>
				{formatTokenCount(inputTokens)} / {formatTokenCount(threshold)}
				{estimated && <span className="mxd-token-estimated">~</span>}
			</span>
		</>
	);
});
