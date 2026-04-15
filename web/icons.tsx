/**
 * Shell icons — only what the shell UI needs.
 * Plugin has its own full icon set in .mxd/plugin/web/components/icons.tsx.
 */
export function IconHexagon({ size = 16 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<polygon points="12 2 22 7 22 17 12 22 2 17 2 7" />
		</svg>
	);
}
