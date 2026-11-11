import type {
	BaseContentSchema,
	BaseValidationResultSchema,
} from "@protocol/schemas/bases";
import type { z } from "zod";

/** Native Base structure accepted by the bounded structural validator. */
export type BaseContent = z.infer<typeof BaseContentSchema>;

/** Structural-only validator result with bounded diagnostics. */
export type BaseValidationResult = z.infer<typeof BaseValidationResultSchema>;
