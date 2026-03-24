import { memo, useEffect, useRef } from "react";

export interface SlashCommand {
	name: string;
	description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "compact", description: "Compact agent context" },
	{ name: "stop", description: "Stop the running agent" },
	{ name: "clear", description: "Clear all session history" },
	{ name: "settings", description: "Open settings panel" },
];

export const SlashCommandMenu = memo(function SlashCommandMenu({
	commands,
	selectedIndex,
	onSelect,
}: {
	commands: SlashCommand[];
	selectedIndex: number;
	onSelect: (command: SlashCommand) => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);

	// Scroll selected item into view
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const item = list.children[selectedIndex] as HTMLElement | undefined;
		item?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	if (commands.length === 0) return null;

	return (
		<div className="og-slash-menu" ref={listRef}>
			{commands.map((cmd, i) => (
				<button
					type="button"
					key={cmd.name}
					className={`og-slash-menu-item${i === selectedIndex ? " og-slash-menu-item-selected" : ""}`}
					onMouseDown={(e) => {
						// Use mousedown instead of click to fire before textarea blur
						e.preventDefault();
						onSelect(cmd);
					}}
				>
					<span className="og-slash-menu-name">/{cmd.name}</span>
					<span className="og-slash-menu-desc">{cmd.description}</span>
				</button>
			))}
		</div>
	);
});
