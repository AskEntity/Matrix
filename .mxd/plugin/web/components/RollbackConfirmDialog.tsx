import { memo } from "react";
import { useLocale } from "../i18n.ts";
import { hasSideEffects, type RollbackImpact } from "../rollback-impact.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

/** How many tool names to spell out before collapsing into "+N more". */
const MAX_TOOL_NAMES = 8;

/**
 * Confirmation for Rewind / Edit, carrying an honest account of what the
 * rollback does NOT undo.
 *
 * Rewind and Edit are the same operation on the backend (`/edit`): the
 * conversation chain jumps back to just before the target message, then a
 * message is sent (unchanged for Rewind, modified for Edit). Everything the
 * agent DID in between — files, tasks, delivered messages — is untouched, so
 * the dialog spells that out instead of a bare "are you sure?".
 */
export const RollbackConfirmDialog = memo(function RollbackConfirmDialog({
	kind,
	impact,
	onConfirm,
	onCancel,
}: {
	kind: "rewind" | "edit";
	impact: RollbackImpact;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const { t } = useLocale();
	const isRewind = kind === "rewind";
	const dirty = hasSideEffects(impact);

	const shownTools = impact.toolNames.slice(0, MAX_TOOL_NAMES);
	const restCount = impact.toolNames.length - shownTools.length;
	const toolList =
		restCount > 0
			? `${shownTools.join(", ")} +${restCount}`
			: shownTools.join(", ");

	return (
		<ConfirmDialog
			title={t(isRewind ? "rollback.rewindTitle" : "rollback.editTitle")}
			message={t(isRewind ? "rollback.rewindMessage" : "rollback.editMessage")}
			confirmLabel={t(
				isRewind ? "rollback.rewindConfirm" : "rollback.editConfirm",
			)}
			danger={isRewind}
			onConfirm={onConfirm}
			onCancel={onCancel}
		>
			{dirty ? (
				<div className="mxd-confirm-warnings">
					<div className="mxd-confirm-warnings-title">
						{t("rollback.warningsTitle")}
					</div>
					{impact.filesModified && (
						<div className="mxd-confirm-warning">
							<span className="mxd-confirm-warning-icon" aria-hidden="true">
								⚠
							</span>
							{t("rollback.warnFiles")}
						</div>
					)}
					{impact.tasksModified && (
						<div className="mxd-confirm-warning">
							<span className="mxd-confirm-warning-icon" aria-hidden="true">
								⚠
							</span>
							{t("rollback.warnTasks")}
						</div>
					)}
					{impact.messagesSent && (
						<div className="mxd-confirm-warning">
							<span className="mxd-confirm-warning-icon" aria-hidden="true">
								⚠
							</span>
							{t("rollback.warnMessages")}
						</div>
					)}
					{impact.otherSideEffects && (
						<div className="mxd-confirm-warning">
							<span className="mxd-confirm-warning-icon" aria-hidden="true">
								⚠
							</span>
							{t("rollback.warnOther")}
						</div>
					)}
					{toolList && (
						<div className="mxd-confirm-tools">
							{t("rollback.toolsRan", { tools: toolList })}
						</div>
					)}
				</div>
			) : (
				<div className="mxd-confirm-clean">
					<div>{t("rollback.noSideEffects")}</div>
					{toolList && (
						<div className="mxd-confirm-tools">
							{t("rollback.toolsRan", { tools: toolList })}
						</div>
					)}
				</div>
			)}
		</ConfirmDialog>
	);
});
