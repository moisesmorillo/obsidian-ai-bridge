import { ETagPartsSchema, ETagSchema } from "@protocol/schemas/etag";
import type { ETagParts } from "@protocol/types/etag";

/** Formats a quoted tag; throws ZodError for an invalid epoch or revision. */
export function formatETag(epoch: string, rev: number): string {
	const parts = ETagPartsSchema.parse({ epoch, rev });
	return `"${parts.epoch}.${parts.rev}"`;
}

/** Parses a quoted tag into its epoch and revision; throws ZodError if invalid. */
export function parseETag(input: string): ETagParts {
	const value = ETagSchema.parse(input);
	const [identity, revision] = value.slice(1, -1).split(".");
	return ETagPartsSchema.parse({ epoch: identity, rev: Number(revision) });
}
