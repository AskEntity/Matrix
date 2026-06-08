/**
 * Plugin SDK — the stable public surface for out-of-tree matrix plugins.
 *
 * Import via the bare specifier `mxd/plugin-sdk` (wired by the `exports` map in
 * matrix's package.json). A plugin installs matrix ONCE (`bun add <matrix>` /
 * `bun link mxd` → a `node_modules/mxd` entry) and imports everything from
 * here — no `../../../matrix/src/...` relative-path counting, depth-independent
 * across the plugin's own git worktrees.
 *
 * ⭐ THIN RE-EXPORT, NEVER A BUNDLE. Every symbol below is re-exported from
 * matrix's own module files via RELATIVE paths. Bun/Node dedupe modules by
 * realpath, so a plugin importing `mxd/plugin-sdk` through its `node_modules/mxd`
 * symlink resolves to the SAME physical files — hence the SAME process
 * singletons — that matrix's own agent loop uses. In particular `deliverToNode`
 * / `listNodes` operate on the one in-process tracker/session registry the loop
 * uses (the module-level `_ctx` in resource-registry.ts), so a delivered peer
 * message actually ARRIVES (enqueued to a live peer, or auto-launched if idle)
 * instead of being silently dropped against a different tracker instance. If a
 * packaging change ever caused a plugin to get its OWN copy of resource-registry
 * (different `_ctx`), peer delivery would no-op with NO error — that exact trap
 * is guarded by src/plugin-sdk.test.ts (singleton-through-symlink test).
 *
 * ⭐ ONE ZOD IDENTITY. `z` is re-exported here so plugins build tool schemas
 * with matrix's exact zod instance. matrix's `shapeToJsonSchema` does
 * `z.toJSONSchema(z.object(pluginShape))` — matrix's `z` wrapping the plugin's
 * schemas; that only works when both sides are the same ZodString/ZodObject
 * class. A plugin that imported its own (drifted) zod would fail `defineTool`
 * typecheck with two distinct ZodString types. Importing `z` from here removes
 * the drift entirely — the plugin need not depend on zod at all.
 *
 * The surface is intentionally NARROW: it grows only when a real consumer needs
 * a symbol, never on speculation. (No `checkPermission`, no LLM facility — those
 * are not imported by any plugin today.)
 */

// ── Single shared zod identity (see ⭐ ONE ZOD IDENTITY above) ──
export { z } from "zod";
// ── Manifest type (declared with scope: "global" | "project") ──
export type { PluginManifest } from "./plugin.ts";
// ── Queue message factory (build a QueueMessage to deliver) ──
export { createUserMessage } from "./queue-message-factory.ts";
// ── Narrowed intra-project peer messaging ──
// The stable, named surface — NOT raw getTracker/deliverMessage (the registry
// singleton stays internal). A plugin composes its own routing policy on top.
export { deliverToNode, listNodes } from "./resource-registry.ts";
// ── Types (erased at runtime — no bundling weight) ──
export type {
	BaseDoneData,
	PluginTypes,
	RuntimeContext,
	ScopeOpts,
} from "./runtime/context.ts";
export type { Auth } from "./tool-auth.ts";
// ── Tool definition (zod schemas appear in these signatures) ──
export { defineTool, toToolDefinition } from "./tool-def.ts";
// ── Runtime primitive tools (every plugin needs yield + done) ──
export { createDoneTool, createYieldTool } from "./tools/prefab.ts";
export type { BaseTaskNode, TaskStatus } from "./types.ts";
// ── Tree node helper (filter launchable nodes out of listNodes) ──
export { isTask } from "./types.ts";
