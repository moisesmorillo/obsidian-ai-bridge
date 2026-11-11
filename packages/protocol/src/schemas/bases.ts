import { z } from "zod";

/** Recursive filters validate their structure without interpreting expression text. */
const BaseFilterSchema: z.ZodType<unknown> = z.lazy(() =>
	z.union([
		z.string(),
		z
			.object({
				and: z.array(BaseFilterSchema).min(1).optional(),
				or: z.array(BaseFilterSchema).min(1).optional(),
				not: z.array(BaseFilterSchema).min(1).optional(),
			})
			.passthrough()
			.refine(
				(filter) =>
					[filter.and, filter.or, filter.not].filter(
						(operator) => operator !== undefined,
					).length === 1,
				{ message: "A filter object must contain one known operator" },
			),
	]),
);

/** Known view fields plus unknown plugin data retained by public schema parsing. */
const BaseViewSchema = z
	.object({
		type: z.string(),
		name: z.string().optional(),
		filters: BaseFilterSchema.optional(),
		formulas: z.record(z.string(), z.string()).optional(),
		properties: z.array(z.string()).optional(),
		summaries: z.record(z.string(), z.string()).optional(),
		groupBy: z
			.object({ property: z.string(), direction: z.enum(["ASC", "DESC"]) })
			.passthrough()
			.optional(),
		order: z.array(z.string()).optional(),
		groupOrder: z.array(z.union([z.string(), z.null()])).optional(),
	})
	.passthrough();

/** Known Base fields with unrecognized root and nested plugin fields retained. */
export const BaseContentSchema = z
	.object({
		filters: BaseFilterSchema.optional(),
		formulas: z.record(z.string(), z.string()).optional(),
		properties: z.record(z.string(), z.unknown()).optional(),
		summaries: z.record(z.string(), z.string()).optional(),
		views: z.array(BaseViewSchema).optional(),
	})
	.passthrough();

/** One human-readable validation diagnostic, limited to 256 characters. */
export const BaseDiagnosticSchema = z.string().max(256);

/** Public result reports structural validity without exposing parsed Base data. */
export const BaseValidationResultSchema = z.object({
	valid: z.boolean(),
	level: z.literal("structural-only"),
	diagnostics: z.array(BaseDiagnosticSchema).max(8),
});

/** Hard limits for YAML parsing work, completed syntax, and returned diagnostics. */
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
