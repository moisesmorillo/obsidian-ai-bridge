import { z } from "zod";

/** Structural Base filter expression; expressions remain opaque strings. */
/** Recursive filter shape validates structure but never interprets expression text. */
const BaseFilterSchema: z.ZodType<unknown> = z.lazy(() =>
	z.union([
		z.string(),
		z.object({
			and: z.array(BaseFilterSchema).min(1),
		}),
		z.object({
			or: z.array(BaseFilterSchema).min(1),
		}),
		z.object({
			not: z.array(BaseFilterSchema).min(1),
		}),
	]),
);

/** Known view fields accepted by the native Bases syntax. */
/** Known native view fields; default Zod object behavior preserves forward compatibility. */
const BaseViewSchema = z.object({
	type: z.string(),
	name: z.string().optional(),
	filters: BaseFilterSchema.optional(),
	formulas: z.record(z.string(), z.string()).optional(),
	properties: z.array(z.string()).optional(),
	summaries: z.record(z.string(), z.string()).optional(),
	groupBy: z
		.object({ property: z.string(), direction: z.enum(["ASC", "DESC"]) })
		.optional(),
	order: z.array(z.string()).optional(),
	groupOrder: z.array(z.union([z.string(), z.null()])).optional(),
});

/** Structural configuration fields supported by Obsidian Bases. */
/** Known Base configuration fields with unknown plugin fields accepted. */
export const BaseContentSchema = z.object({
	filters: BaseFilterSchema.optional(),
	formulas: z.record(z.string(), z.string()).optional(),
	properties: z.record(z.string(), z.unknown()).optional(),
	summaries: z.record(z.string(), z.string()).optional(),
	views: z.array(BaseViewSchema).optional(),
});

/** Bounded diagnostic text for structural Base validation. */
/** One bounded human-readable diagnostic from structural validation. */
export const BaseDiagnosticSchema = z.string().max(256);

/** Result shape does not expose converted or parsed note data. */
/** Public result that reports validation state without exposing parsed content. */
export const BaseValidationResultSchema = z.object({
	valid: z.boolean(),
	level: z.literal("structural-only"),
	diagnostics: z.array(BaseDiagnosticSchema).max(8),
});

/** Limits consumed by the incremental YAML parser and structural walk. */
/** Shared hard limits that bound YAML work and returned diagnostics. */
export const BASE_VALIDATION_LIMITS = {
	bytes: 65_536,
	tokens: 16_384,
	stack: 34,
	indicatorsPerLine: 32,
	depth: 32,
	nodes: 16_384,
	diagnostics: 8,
	diagnosticCharacters: 256,
} as const;
