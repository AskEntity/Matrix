import type { TaskStatus } from "../hooks.ts";
import { useLocale } from "../i18n.ts";

export function statusDotClass(status: TaskStatus): string {
	const map: Record<TaskStatus, string> = {
		draft: "status-dot-draft",
		pending: "status-dot-pending",
		in_progress: "status-dot-in_progress",
		testing: "status-dot-testing",
		passed: "status-dot-passed",
		failed: "status-dot-failed",
		stuck: "status-dot-stuck",
		closed: "status-dot-closed",
	};
	return map[status];
}

export function StatusBadge({ status }: { status: TaskStatus }) {
	const { t } = useLocale();
	const key = `status.${status}`;
	return (
		<span className={`og-status-badge ${status}`}>
			<span className="badge-dot" />
			{t(key)}
		</span>
	);
}
