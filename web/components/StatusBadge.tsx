import { useLocale } from "../i18n.ts";

export function statusDotClass(status: string): string {
	const map: Record<string, string> = {
		pending: "status-dot-pending",
		in_progress: "status-dot-in_progress",
		testing: "status-dot-testing",
		passed: "status-dot-passed",
		failed: "status-dot-failed",
		stuck: "status-dot-stuck",
	};
	return map[status] ?? "status-dot-pending";
}

export function StatusBadge({ status }: { status: string }) {
	const { t } = useLocale();
	const key = `status.${status}`;
	return (
		<span className={`og-status-badge ${status}`}>
			<span className="badge-dot" />
			{t(key)}
		</span>
	);
}
