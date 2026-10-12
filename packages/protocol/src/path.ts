import { z } from "zod";

function isValidPath(path: string): boolean {
	const segments = path.split("/");
	return (
		new TextEncoder().encode(path).byteLength <= 512 &&
		segments.length <= 32 &&
		segments.every(
			(segment) => segment !== "" && segment !== "." && segment !== "..",
		) &&
		!/[\\\\\p{Cc}]/u.test(path) &&
		!path.startsWith("/")
	);
}

export const PathSchema = z
	.string()
	.transform((path) => path.normalize("NFC"))
	.pipe(z.string().refine(isValidPath));
export type Path = z.infer<typeof PathSchema>;

export function normalizePath(input: string): string {
	return PathSchema.parse(input);
}

export function pathKey(input: string): string {
	return PathSchema.parse(input).toLowerCase();
}
