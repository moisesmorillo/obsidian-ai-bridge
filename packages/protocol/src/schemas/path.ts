import { z } from "zod";

/** Checks path byte length, segment count, separators, and control characters. */
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

/** Validates relative paths, normalizing Unicode to NFC before 512-byte/32-segment checks. */
export const PathSchema = z
	.string()
	.transform((path) => path.normalize("NFC"))
	.pipe(z.string().refine(isValidPath));
