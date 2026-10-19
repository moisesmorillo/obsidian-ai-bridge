import { z } from "zod";

/** Validates exact idempotency keys with 8–128 Unicode code points. */
export const IdempotencyKeySchema = z
	.string()
	.refine((value) => [...value].length >= 8 && [...value].length <= 128);
