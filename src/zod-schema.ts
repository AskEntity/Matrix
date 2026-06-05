/**
 * Zod → JSON Schema conversion helpers, shared by tool-def.ts and
 * tool-definition.ts. Leaf module: depends only on zod, so neither importer
 * forms a cycle. (Previously these two functions were duplicated verbatim in
 * both files — "delete until ONE remains".)
 */

import { type ZodRawShape, z } from "zod";

/**
 * Strip $schema and additionalProperties from Zod's toJSONSchema output.
 * Provider APIs and MCP don't expect these in tool parameter schemas.
 */
function stripZodMeta(obj: unknown): unknown {
	if (Array.isArray(obj)) {
		return obj.map(stripZodMeta);
	}
	if (obj && typeof obj === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			if (key === "$schema" || key === "additionalProperties") continue;
			result[key] = stripZodMeta(value);
		}
		return result;
	}
	return obj;
}

/** Convert a Zod raw shape to JSON Schema (provider/MCP-ready). */
export function shapeToJsonSchema(shape: ZodRawShape): Record<string, unknown> {
	return stripZodMeta(z.toJSONSchema(z.object(shape))) as Record<
		string,
		unknown
	>;
}
