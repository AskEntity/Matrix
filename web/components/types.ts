/** Project info from daemon API */
export interface Project {
	id: string;
	name: string;
	path: string;
	pathExists?: boolean;
}

/** Three-layer config (global + repo + local) */
export interface ThreeLayerConfig {
	global: Record<string, unknown>;
	repo: Record<string, unknown>;
	local: Record<string, unknown>;
	resolved: Record<string, unknown>;
}
