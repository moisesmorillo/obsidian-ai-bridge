import { z } from "zod";

/** Checks path byte length, segment count, separators, and control characters. */
function isValidPath(path: string): boolean {
	if (new TextEncoder().encode(path).byteLength > 512) return false;
	const segments = path.split("/");
	return (
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
