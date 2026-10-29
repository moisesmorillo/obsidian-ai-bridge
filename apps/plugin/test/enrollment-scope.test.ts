import { describe, expect, it } from "vitest";
import { classifyEnrollmentPath } from "../src/sync/enrollment-scope";

describe("classifyEnrollmentPath", () => {
	it.each([
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
		["../outside.md", 24, "excluded"],
	] as const)("classifies %s", (path, size, expected) => {
		expect(classifyEnrollmentPath(path, size)).toBe(expected);
	});
});
