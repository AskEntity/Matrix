/**
 * Tests for the plugin SDK surface (src/plugin-sdk.ts) — the stable public
 * `mxd/plugin-sdk` bare-specifier package an out-of-tree plugin depends on.
 *
 * Three properties this file guards (the headline constraints of the SDK task):
 *
 *  1. THIN RE-EXPORT, NOT A COPY. Every re-exported value is reference-identical
 *     to its origin module symbol. The SDK bundles nothing; it forwards matrix's
 *     own live modules. (in-process reference equality)
 *
 *  2. PACKAGING PRESERVES THE SINGLETON. A plugin importing `mxd/plugin-sdk`
 *     through a `node_modules/mxd` symlink (the realistic `bun add mxd` / `bun
 *     link` shape) resolves — via Bun's realpath module dedup — to the SAME
 *     resource-registry singleton the agent loop uses. So `deliverToNode`
 *     actually DELIVERS (the message lands in the app's own JSONL) and
 *     `listNodes` reads the app's own tracker. A vendored copy would get a
 *     different `_ctx` → silent no-op; that trap is what these tests catch.
 *
 *  3. ONE ZOD IDENTITY + NARROW SURFACE. `z` is the same zod instance, so a
 *     plugin's schemas pass matrix's `toToolDefinition`/`shapeToJsonSchema`
 *     (no cross-instance ZodString drift). The `exports` map gates deep imports,
 *     so the internal `getTracker`/`deliverMessage` stay un-importable — only the
 *     narrowed `deliverToNode`/`listNodes` are reachable.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z as zodZ } from "zod";
import * as sdk from "./plugin-sdk.ts";
import { createUserMessage as qmCreateUser } from "./queue-message-factory.ts";
import {
	deliverToNode as regDeliver,
	listNodes as regListNodes,
	resetResourceRegistry,
} from "./resource-registry.ts";
import { createMatrixApp } from "./test-utils/create-matrix-app.ts";
import { createHumanAuth } from "./tool-auth.ts";
import {
	defineTool as tdDefineTool,
	toToolDefinition as tdToToolDef,
} from "./tool-def.ts";
import {
	createDoneTool as prefabDone,
	createYieldTool as prefabYield,
} from "./tools/prefab.ts";
import { isTask as typesIsTask } from "./types.ts";
import { ulid } from "./ulid.ts";

/** matrix repo root — import.meta.dir is `<root>/src`. */
const MATRIX_ROOT = resolve(import.meta.dir, "..");

// ── 1. Thin re-export (same module objects, not a bundled copy) ──

describe("plugin-sdk: thin re-export (same modules, never a copy)", () => {
	test("re-exported values are reference-identical to their origin modules", () => {
		// If any of these is a copy/wrapper instead of the live symbol, the
		// singleton + zod identity guarantees collapse.
		expect(sdk.deliverToNode).toBe(regDeliver);
		expect(sdk.listNodes).toBe(regListNodes);
		expect(sdk.defineTool).toBe(tdDefineTool);
		expect(sdk.toToolDefinition).toBe(tdToToolDef);
		expect(sdk.createYieldTool).toBe(prefabYield);
		expect(sdk.createDoneTool).toBe(prefabDone);
		expect(sdk.createUserMessage).toBe(qmCreateUser);
		expect(sdk.isTask).toBe(typesIsTask);
	});

	test("re-exported z is the one zod instance (single identity)", () => {
		expect(sdk.z).toBe(zodZ);
	});
});

// ── 3a. Zod identity end-to-end (in-process) ──

describe("plugin-sdk: zod identity end-to-end", () => {
	test("a tool built with the SDK's z passes matrix's toToolDefinition + shapeToJsonSchema", () => {
		// This is the Gap-B fix: matrix's shapeToJsonSchema does
		// `z.toJSONSchema(z.object(pluginShape))` — matrix's z wrapping the
		// plugin's schema. It only succeeds when both are the SAME zod class.
		const def = sdk.defineTool({
			name: "probe_tool",
			availability: "internal",
			description: "d",
			params: {
				city: { schema: sdk.z.string(), decl: { kind: "explicit" } },
			},
			handler: async () => ({ content: [], isError: false }),
		});
		const td = sdk.toToolDefinition(def, createHumanAuth());
		expect(td.jsonSchema).toEqual({
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
		});
	});
});

// ── 2 + 3b. Bare specifier `mxd/plugin-sdk` through a node_modules symlink ──
//
// The realistic out-of-tree shape: a plugin lives OUTSIDE matrix's tree, depends
// on matrix as a package, and imports the SDK via the bare specifier. We wire the
// runtime singleton (createMatrixApp → initResourceRegistry), then load a probe
// that reaches the SDK through `node_modules/mxd` and prove it operates on the
// app's OWN live tracker.
//
// The complementary literal proof — a dummy plugin tool calling the SDK's
// `deliverToNode` inside a REAL agent loop, the message arriving + waking an idle
// peer — lives in src/plugin-messaging.test.ts, whose dummy plugin consumes the
// public SDK surface (`./plugin-sdk.ts`). `registerSideEffects` (which backs
// deliverMessage) is wired at agent launch, so the delivery path is only
// exercisable from within a loop; the reference-identity test above proves the
// SDK's deliverToNode IS resource-registry's, so that arrival coverage transfers.

const PROBE_SRC = `
import { listNodes, defineTool, toToolDefinition, z } from "mxd/plugin-sdk";

export function peerIds(projectId) {
  return listNodes(projectId).map((n) => n.id);
}
// Returns the ACTUAL node object the bare-specifier listNodes yields. Reference
// equality against the app's own tracker.getTask(...) proves the probe reads the
// SAME live tracker the agent loop uses (not a separate copy of resource-registry).
export function findNode(projectId, nodeId) {
  return listNodes(projectId).find((n) => n.id === nodeId) ?? null;
}
export function toolSchema() {
  const def = defineTool({
    name: "probe_tool", availability: "internal", description: "d",
    params: { city: { schema: z.string(), decl: { kind: "explicit" } } },
    handler: async () => ({ content: [], isError: false }),
  });
  return JSON.stringify(toToolDefinition(def, {}).jsonSchema);
}
`;

// A separate probe that imports a DEEP path. The exports map must gate this so
// getTracker / deliverMessage stay internal.
const GATED_SRC = `
import { getTracker } from "mxd/src/resource-registry.ts";
export const x = getTracker;
`;

describe("plugin-sdk: bare specifier `mxd/plugin-sdk` preserves the singleton", () => {
	let probeDir = "";
	let dataDir = "";
	let projectDir = "";
	let projectId = "";
	let peerId = "";
	// biome-ignore lint/suspicious/noExplicitAny: dynamic probe module shape
	let probe: any;
	let app: ReturnType<typeof createMatrixApp> | undefined;
	let appTracker: Awaited<
		ReturnType<ReturnType<typeof createMatrixApp>["getTracker"]>
	>;

	beforeAll(async () => {
		// 1) A temp "plugin repo" whose node_modules/mxd → matrix root (the
		//    package install a real plugin gets from `bun add` / `bun link`).
		probeDir = await mkdtemp(join(tmpdir(), "mxd-sdk-probe-"));
		await mkdir(join(probeDir, "node_modules"));
		await symlink(MATRIX_ROOT, join(probeDir, "node_modules", "mxd"), "dir");
		await writeFile(join(probeDir, "probe.ts"), PROBE_SRC);
		await writeFile(join(probeDir, "gated.ts"), GATED_SRC);

		// 2) Wire the REAL runtime singleton via createMatrixApp.
		dataDir = await mkdtemp(join(tmpdir(), "mxd-sdk-data-"));
		projectDir = await mkdtemp(join(tmpdir(), "mxd-sdk-project-"));
		projectId = ulid();
		app = createMatrixApp({
			dataDir,
			projects: [
				{ id: projectId, name: basename(projectDir), path: projectDir },
			],
		});
		app.markReady();

		// 3) Seed an idle peer node — pending, no session, no worktree.
		appTracker = await app.getTracker(projectId);
		const peer = appTracker.addChild(
			appTracker.rootNodeId,
			"Peer",
			"a peer node",
		);
		peerId = peer.id;
		await appTracker.save();

		// 4) Load the probe — its `mxd/plugin-sdk` resolves through the symlink.
		probe = await import(join(probeDir, "probe.ts"));
	});

	afterAll(async () => {
		if (app) await app.shutdown();
		resetResourceRegistry();
		await rm(probeDir, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
		await rm(projectDir, { recursive: true, force: true });
	});

	test("listNodes via the bare specifier reads the app's own tracker", () => {
		// If the probe got a different resource-registry copy, _ctx would be null
		// and this would be [] — instead it sees the app's own peer node.
		expect(probe.peerIds(projectId)).toContain(peerId);
	});

	test("the bare specifier hits the SAME live tracker the agent loop uses (reference identity, not a copy)", () => {
		// THE headline singleton proof. The node object the bare-specifier
		// listNodes yields is REFERENTIALLY the same object the app's tracker
		// holds — i.e. the probe and the agent loop operate on one in-process
		// tracker. A vendored copy of resource-registry would read a different
		// _ctx (a different tracker, or null), so this `toBe` would fail. Because
		// it is the same tracker, a deliverToNode here targets the very queue /
		// eventStore the loop drains — the message ARRIVES, it is not dropped.
		const probeNode = probe.findNode(projectId, peerId);
		expect(probeNode).not.toBeNull();
		expect(probeNode).toBe(appTracker.getTask(peerId));
	});

	test("a tool schema built with the bare-specifier z works (zod identity through packaging)", () => {
		expect(JSON.parse(probe.toolSchema())).toEqual({
			type: "object",
			properties: { city: { type: "string" } },
			required: ["city"],
		});
	});

	test("deep imports are gated by the exports map (getTracker/deliverMessage stay internal)", async () => {
		// The exports map exposes only `./plugin-sdk` (+ package.json), so a deep
		// `mxd/src/resource-registry.ts` import must fail to resolve — proving the
		// internal singleton accessors are NOT part of the public surface.
		await expect(import(join(probeDir, "gated.ts"))).rejects.toThrow(
			/Cannot find module|not exported|failed to resolve/i,
		);
	});
});
