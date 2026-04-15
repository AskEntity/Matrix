import { memo, useState } from "react";
import { useLocale } from "../i18n.ts";

export const RelocateBanner = memo(function RelocateBanner({
	projectPath,
	onRelocate,
}: {
	projectPath: string;
	onRelocate: (newPath: string) => Promise<void>;
}) {
	const { t } = useLocale();
	const [newPath, setNewPath] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!newPath.trim()) return;
		setError(null);
		setLoading(true);
		try {
			await onRelocate(newPath.trim());
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to relocate");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="mxd-relocate-banner">
			<div className="mxd-relocate-banner-icon">⚠</div>
			<div className="mxd-relocate-banner-body">
				<div className="mxd-relocate-banner-title">
					{t("project.pathMissing")}
				</div>
				<div className="mxd-relocate-banner-path">{projectPath}</div>
				<form className="mxd-relocate-banner-form" onSubmit={handleSubmit}>
					<input
						type="text"
						className="mxd-relocate-banner-input"
						placeholder={t("project.newPathPlaceholder")}
						value={newPath}
						onChange={(e) => setNewPath(e.target.value)}
						disabled={loading}
					/>
					<button
						type="submit"
						className="mxd-btn mxd-btn-primary mxd-btn-sm"
						disabled={loading || !newPath.trim()}
					>
						{loading ? t("project.relocating") : t("project.relocate")}
					</button>
				</form>
				{error && <div className="mxd-relocate-banner-error">{error}</div>}
			</div>
		</div>
	);
});
