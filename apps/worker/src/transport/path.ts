import { normalizePath } from "@obsidian-ai-bridge/protocol";

/** Decode one raw URI path segment sequence once, then apply canonical path rules. */
export function decodeAndNormalizePath(
	rawEncodedPath: string,
): string | undefined {
	try {
		return normalizePath(decodeURIComponent(rawEncodedPath));
	} catch {
		return undefined;
	}
}
