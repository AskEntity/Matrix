import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocale } from "../i18n.ts";

interface Props {
	children: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
	showStack: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
	override state: State = { hasError: false, error: null, showStack: false };

	static getDerivedStateFromError(error: Error): Partial<State> {
		return { hasError: true, error };
	}

	override componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("[ErrorBoundary]", error, info.componentStack);
	}

	handleReload = () => {
		window.location.reload();
	};

	toggleStack = () => {
		this.setState((s) => ({ showStack: !s.showStack }));
	};

	override render() {
		if (!this.state.hasError) return this.props.children;

		return (
			<ErrorFallback
				error={this.state.error}
				showStack={this.state.showStack}
				onReload={this.handleReload}
				onToggleStack={this.toggleStack}
			/>
		);
	}
}

/**
 * The fallback is a function component purely so it can reach `useLocale()` —
 * a class cannot call hooks, and every visible string here needs t().
 *
 * Safe as a last-resort UI: `useLocale` outside a LocaleProvider falls back to
 * the default context (`t: (key) => key`) rather than throwing, and the
 * boundary is mounted INSIDE the provider anyway, so a provider crash was never
 * something this component could have caught.
 */
function ErrorFallback({
	error,
	showStack,
	onReload,
	onToggleStack,
}: {
	error: Error | null;
	showStack: boolean;
	onReload: () => void;
	onToggleStack: () => void;
}) {
	const { t } = useLocale();
	return (
		<div style={styles.container}>
			<div style={styles.card}>
				<div style={styles.icon}>⚠️</div>
				<h1 style={styles.title}>{t("error.title")}</h1>
				<p style={styles.message}>{error?.message || t("error.unexpected")}</p>
				<button type="button" style={styles.button} onClick={onReload}>
					{t("error.reload")}
				</button>
				{error?.stack && (
					<>
						<button type="button" style={styles.toggle} onClick={onToggleStack}>
							{showStack ? t("error.hideStack") : t("error.showStack")}
						</button>
						{showStack && <pre style={styles.stack}>{error.stack}</pre>}
					</>
				)}
			</div>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		minHeight: "100vh",
		background: "var(--bg-base)",
		color: "var(--text-primary)",
		fontFamily: "var(--font-sans)",
		padding: "24px",
	},
	card: {
		maxWidth: 520,
		width: "100%",
		background: "var(--bg-surface)",
		border: "1px solid var(--border)",
		borderRadius: "var(--radius-lg, 12px)",
		padding: "40px 32px",
		textAlign: "center" as const,
		boxShadow: "var(--shadow-lg)",
	},
	icon: {
		fontSize: 48,
		marginBottom: 16,
	},
	title: {
		margin: "0 0 8px",
		fontSize: 20,
		fontWeight: 600,
		color: "var(--text-primary)",
	},
	message: {
		margin: "0 0 24px",
		fontSize: 14,
		color: "var(--text-secondary)",
		lineHeight: 1.5,
		wordBreak: "break-word" as const,
	},
	button: {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		padding: "8px 20px",
		fontSize: 14,
		fontWeight: 500,
		color: "#fff",
		background: "var(--accent)",
		border: "none",
		borderRadius: "var(--radius-md, 8px)",
		cursor: "pointer",
		transition: "background var(--t-fast, 120ms ease)",
	},
	toggle: {
		display: "block",
		margin: "20px auto 0",
		padding: "4px 8px",
		fontSize: 12,
		color: "var(--text-muted)",
		background: "none",
		border: "none",
		cursor: "pointer",
		fontFamily: "var(--font-sans)",
	},
	stack: {
		marginTop: 12,
		padding: 16,
		fontSize: 11,
		lineHeight: 1.5,
		color: "var(--text-secondary)",
		background: "var(--bg-raised)",
		border: "1px solid var(--border-subtle)",
		borderRadius: "var(--radius-md, 8px)",
		textAlign: "left" as const,
		overflow: "auto",
		maxHeight: 240,
		whiteSpace: "pre-wrap" as const,
		wordBreak: "break-all" as const,
		fontFamily: "var(--font-mono)",
	},
};
