import { PathSchema } from "#protocol/schemas/path";

/** Normalizes a relative path; throws ZodError when it violates path constraints. */
export function normalizePath(input: string): string {
	return PathSchema.parse(input);
}

/** Returns the normalized, Unicode-lowercase key for a relative path. */
export function pathKey(input: string): string {
	return PathSchema.parse(input).toLowerCase();
}
