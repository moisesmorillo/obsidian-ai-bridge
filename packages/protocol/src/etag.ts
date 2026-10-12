import { z } from "zod";

export const EpochSchema = z.string().regex(/^(?=.*[a-f])[0-9a-f]{32}$/);
export const ETagSchema = z
	.string()
	.regex(/^"(?=.*[a-f])[0-9a-f]{32}\.[1-9][0-9]*"$/)
	.refine((value) =>
		Number.isSafeInteger(Number(value.slice(value.lastIndexOf(".") + 1, -1))),
	);

const ETagPartsSchema = z.object({
	epoch: EpochSchema,
	rev: z.number().int().positive().safe(),
});

export function formatETag(epoch: string, rev: number): string {
	const parts = ETagPartsSchema.parse({ epoch, rev });
	return `"${parts.epoch}.${parts.rev}"`;
}

export type ETagParts = z.infer<typeof ETagPartsSchema>;

export function parseETag(input: string): ETagParts {
	const value = ETagSchema.parse(input);
	const [identity, revision] = value.slice(1, -1).split(".");
	return ETagPartsSchema.parse({ epoch: identity, rev: Number(revision) });
}
