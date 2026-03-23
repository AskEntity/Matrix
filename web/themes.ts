/** Data-driven theme system. Each theme is a set of CSS variable overrides. */

interface ThemeConfig {
	/** i18n key for display name */
	name: string;
	/** CSS variable overrides (applied on document.documentElement.style) */
	variables: Record<string, string>;
	/** Show the cute cat animation */
	hasCat?: boolean;
}

/**
 * All CSS variables that themes can override.
 * Used to reset before applying a new theme.
 */
const themeVariables = [
	"--bg-base",
	"--bg-surface",
	"--bg-raised",
	"--bg-overlay",
	"--bg-subtle",
	"--border",
	"--border-subtle",
	"--border-muted",
	"--text-primary",
	"--text-secondary",
	"--text-muted",
	"--text-faint",
	"--color-pending",
	"--color-in-progress",
	"--color-testing",
	"--color-passed",
	"--color-failed",
	"--color-stuck",
	"--accent",
	"--accent-hover",
	"--accent-muted",
	"--bg-pending",
	"--bg-in-progress",
	"--bg-testing",
	"--bg-passed",
	"--bg-failed",
	"--bg-stuck",
	"--radius-md",
	"--radius-lg",
	"--radius-xl",
	"--shadow-sm",
	"--shadow-md",
	"--shadow-lg",
] as const;

/** Dark theme — base defaults (no overrides needed, :root has these) */
const dark: ThemeConfig = {
	name: "theme.dark",
	variables: {},
};

/** Light theme */
const light: ThemeConfig = {
	name: "theme.light",
	variables: {
		"--bg-base": "#ffffff",
		"--bg-surface": "#f6f8fa",
		"--bg-raised": "#f0f2f5",
		"--bg-overlay": "#e9ecef",
		"--bg-subtle": "#dfe3e8",

		"--border": "#d0d7de",
		"--border-subtle": "#e6e8eb",
		"--border-muted": "#eaeef2",

		"--text-primary": "#1f2328",
		"--text-secondary": "#656d76",
		"--text-muted": "#848d97",
		"--text-faint": "#afb8c1",

		"--color-pending": "#848d97",
		"--color-in-progress": "#0969da",
		"--color-testing": "#8250df",
		"--color-passed": "#1a7f37",
		"--color-failed": "#cf222e",
		"--color-stuck": "#9a6700",

		"--accent": "#0969da",
		"--accent-hover": "#0550ae",
		"--accent-muted": "rgba(9, 105, 218, 0.1)",

		"--bg-pending": "rgba(132, 141, 151, 0.1)",
		"--bg-in-progress": "rgba(9, 105, 218, 0.1)",
		"--bg-testing": "rgba(130, 80, 223, 0.1)",
		"--bg-passed": "rgba(26, 127, 55, 0.1)",
		"--bg-failed": "rgba(207, 34, 46, 0.1)",
		"--bg-stuck": "rgba(154, 103, 0, 0.1)",

		"--shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.08)",
		"--shadow-md": "0 4px 12px rgba(0, 0, 0, 0.1)",
		"--shadow-lg": "0 8px 24px rgba(0, 0, 0, 0.15)",
	},
};

/** Cute Light theme */
const cuteLight: ThemeConfig = {
	name: "theme.cuteLight",
	hasCat: true,
	variables: {
		"--bg-base": "#fff5f7",
		"--bg-surface": "#fff0f3",
		"--bg-raised": "#ffe8ed",
		"--bg-overlay": "#ffd6e0",
		"--bg-subtle": "#ffc8d6",

		"--border": "#fbb1c4",
		"--border-subtle": "#fcc8d6",
		"--border-muted": "#fddce5",

		"--text-primary": "#4a2030",
		"--text-secondary": "#8b5068",
		"--text-muted": "#b07088",
		"--text-faint": "#d4a0b4",

		"--color-pending": "#d4a0b4",
		"--color-in-progress": "#ff6b9d",
		"--color-testing": "#c77dba",
		"--color-passed": "#4caf50",
		"--color-failed": "#ff5252",
		"--color-stuck": "#e3b341",

		"--accent": "#ff6b9d",
		"--accent-hover": "#ff4785",
		"--accent-muted": "rgba(255, 107, 157, 0.15)",

		"--bg-pending": "rgba(212, 160, 180, 0.12)",
		"--bg-in-progress": "rgba(255, 107, 157, 0.12)",
		"--bg-testing": "rgba(199, 125, 186, 0.12)",
		"--bg-passed": "rgba(76, 175, 80, 0.12)",
		"--bg-failed": "rgba(255, 82, 82, 0.12)",
		"--bg-stuck": "rgba(227, 179, 65, 0.12)",

		"--radius-md": "10px",
		"--radius-lg": "14px",
		"--radius-xl": "18px",

		"--shadow-sm": "0 1px 3px rgba(255, 107, 157, 0.1)",
		"--shadow-md": "0 4px 14px rgba(255, 107, 157, 0.12)",
		"--shadow-lg": "0 8px 28px rgba(255, 107, 157, 0.15)",
	},
};

/** Cute Dark theme */
const cuteDark: ThemeConfig = {
	name: "theme.cuteDark",
	hasCat: true,
	variables: {
		"--bg-base": "#1a0a10",
		"--bg-surface": "#2a1520",
		"--bg-raised": "#3a2030",
		"--bg-overlay": "#4a2a40",
		"--bg-subtle": "#5a3550",

		"--border": "#6b3050",
		"--border-subtle": "#4a2540",
		"--border-muted": "#3a1a30",

		"--text-primary": "#ffcce0",
		"--text-secondary": "#d4a0b8",
		"--text-muted": "#b07090",
		"--text-faint": "#8a5070",

		"--color-pending": "#8a5070",
		"--color-in-progress": "#ff6b9d",
		"--color-testing": "#c77dba",
		"--color-passed": "#4caf50",
		"--color-failed": "#ff5252",
		"--color-stuck": "#e3b341",

		"--accent": "#ff6b9d",
		"--accent-hover": "#ff4785",
		"--accent-muted": "rgba(255, 107, 157, 0.2)",

		"--bg-pending": "rgba(138, 80, 112, 0.15)",
		"--bg-in-progress": "rgba(255, 107, 157, 0.15)",
		"--bg-testing": "rgba(199, 125, 186, 0.15)",
		"--bg-passed": "rgba(76, 175, 80, 0.15)",
		"--bg-failed": "rgba(255, 82, 82, 0.15)",
		"--bg-stuck": "rgba(227, 179, 65, 0.15)",

		"--radius-md": "10px",
		"--radius-lg": "14px",
		"--radius-xl": "18px",

		"--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.3)",
		"--shadow-md": "0 4px 14px rgba(0, 0, 0, 0.35)",
		"--shadow-lg": "0 8px 28px rgba(0, 0, 0, 0.4)",
	},
};

/** Registry of built-in themes */
export const themes: Record<string, ThemeConfig> = {
	dark,
	light,
	"cute-light": cuteLight,
	"cute-dark": cuteDark,
};

/**
 * Apply a theme by setting CSS variables on document.documentElement.style.
 * First resets all theme variables (so :root defaults apply), then sets overrides.
 */
export function applyTheme(theme: ThemeConfig): void {
	const root = document.documentElement;

	// Reset all theme-able variables so :root defaults take effect
	for (const key of themeVariables) {
		root.style.removeProperty(key);
	}

	// Apply theme overrides
	for (const [key, value] of Object.entries(theme.variables)) {
		root.style.setProperty(key, value);
	}
}
