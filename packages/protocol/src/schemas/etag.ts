import { z } from "zod";

/** Validates a 32-character lowercase hexadecimal epoch containing a letter. */
export const EpochSchema = z.string().regex(/^(?=.*[a-f])[0-9a-f]{32}$/);

/** Validates quoted epoch/revision tags with a positive safe-integer revision. */
export const ETagSchema = z
	.string()
	.regex(/^"(?=.*[a-f])[0-9a-f]{32}\.[1-9][0-9]*"$/)
	.refine((value) =>
		Number.isSafeInteger(Number(value.slice(value.lastIndexOf(".") + 1, -1))),
	);

/** Canonical validated fields used by the ETag codecs. */
export const ETagPartsSchema = z.object({
	epoch: EpochSchema,
	rev: z.number().int().positive().safe(),
});
