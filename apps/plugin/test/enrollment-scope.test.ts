import { describe, expect, it } from "vitest";
import { classifyEnrollmentPath } from "../src/sync/enrollment-scope";

describe("classifyEnrollmentPath", () => {
	it.each([
		...[
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
		].map((extension) => [`notes/file.${extension}`, 24, "blob"] as const),
		["note.md", 24, "text"],
		["canvas.CANVAS", 24, "text"],
		["notes/photo.PNG", 24, "blob"],
		["notes/data.json", 24, "blob"],
		["notes/large.md", 1_000_001, "blob"],
		[".obsidian/plugins/x.md", 24, "excluded"],
		[".trash/old.md", 24, "excluded"],
		[".ai-bridge/pending/x", 24, "excluded"],
		["notes/.ai-bridge/note.md", 24, "text"],
		["notes/.DS_Store", 24, "excluded"],
		["notes/photo.icloud", 24, "excluded"],
		["notes/binary.exe", 24, "excluded"],
		["notes/too-large.png", 25_000_001, "unsupported"],
		["notes/too-large.exe", 25_000_001, "excluded"],
		[".obsidian/huge.png", 25_000_001, "excluded"],
		["notes/too-large.md", 25_000_001, "unsupported"],
		["notes/maximum.png", 25_000_000, "blob"],
		["notes/oversized.txt", 25_000_001, "unsupported"],
		["note.md", 1_000_000, "text"],
		["note.md", 1_000_001, "blob"],
		["../outside.md", 24, "excluded"],
	] as const)("classifies %s", (path, size, expected) => {
		expect(classifyEnrollmentPath(path, size)).toBe(expected);
	});
});
