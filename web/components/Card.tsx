import { type ReactNode, useState } from "react";
import { IconChevron } from "./icons.tsx";

interface CardProps {
	/** Header title — always visible */
	title: string | ReactNode;
	/** Right-aligned detail text in header */
	detail?: string | ReactNode;
	/** Additional CSS class on the mxd-tool-card element (e.g. status/variant classes) */
	className?: string;
	/** Whether clicking header toggles body (default: true if children provided) */
	collapsible?: boolean;
	/** Initial expand state (default: false) */
	defaultExpanded?: boolean;
	/** Body content (shown when expanded) */
	children?: ReactNode;
	/** Status indicator in header (replaces toggle chevron position) */
	statusSlot?: ReactNode;
}

/**
 * Base card component for all activity log entries.
 * Uses existing mxd-tool-card CSS classes for consistent styling.
 */
export function Card({
	title,
	detail,
	className,
	collapsible,
	defaultExpanded = false,
	children,
	statusSlot,
}: CardProps) {
	const hasBody = children != null;
	const isCollapsible = collapsible ?? hasBody;
	const [expanded, setExpanded] = useState(defaultExpanded);

	return (
		<div className={`mxd-tool-card ${className ?? ""}`}>
			{isCollapsible ? (
				<button
					type="button"
					className="mxd-tool-card-header"
					onClick={() => setExpanded(!expanded)}
				>
					<span className="mxd-tool-card-name">{title}</span>
					{detail && <span className="mxd-tool-card-detail">{detail}</span>}
					{statusSlot}
					<span className="mxd-tool-card-toggle">
						<IconChevron size={10} expanded={expanded} />
					</span>
				</button>
			) : (
				<div className="mxd-tool-card-header">
					<span className="mxd-tool-card-name">{title}</span>
					{detail && <span className="mxd-tool-card-detail">{detail}</span>}
					{statusSlot}
				</div>
			)}
			{expanded && hasBody && children}
		</div>
	);
}
