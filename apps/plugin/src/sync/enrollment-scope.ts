import { classifyFilePath, PathSchema } from "@obsidian-ai-bridge/protocol";

/** Server-matched raw-byte ceiling for inline Markdown and Canvas enrollment. */
const INLINE_TEXT_LIMIT_BYTES = 1_000_000;
/** Spec §7.8 attachment extensions admitted as blobs but not decoded as text. */
const ATTACHMENT_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"pdf",
	"mp3",
	"m4a",
	"wav",
	"mp4",
	"mov",
	"webm",
	"json",
	"csv",
	"txt",
]);

/** Classifies one local vault path for enrollment; size is the raw byte count. */
export function classifyEnrollmentPath(
	path: string,
	size: number,
): "text" | "blob" | "excluded" {
	if (
		!PathSchema.safeParse(path).success ||
		!Number.isSafeInteger(size) ||
		size < 0
	)
		return "excluded";
	const segments = path.split("/");
	if (
		[".obsidian", ".trash", ".ai-bridge"].includes(segments[0] ?? "") ||
		segments.at(-1) === ".DS_Store" ||
		segments.at(-1)?.toLowerCase().endsWith(".icloud")
	)
		return "excluded";
	const kind = classifyFilePath(path);
	if (kind === "markdown" || kind === "canvas")
		return size <= INLINE_TEXT_LIMIT_BYTES ? "text" : "blob";
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	return ATTACHMENT_EXTENSIONS.has(extension) ? "blob" : "excluded";
}
