import { parseMediaType } from "@worker/http/media-type";
import { isSupportedNoteContentType } from "@worker/http/note-content-type";
import { describe, expect, it } from "vitest";

describe("parseMediaType", () => {
  it.each([
    [null, undefined],
    [undefined, undefined],
    ["", undefined],
    ["   ", undefined],
    ["TEXT/MARKDOWN", "text/markdown"],
    [" text/plain ; charset=utf-8 ", "text/plain"],
  ] as const)("normalizes %j to %j", (value, expected) => {
    expect(parseMediaType(value)).toBe(expected);
  });
});

describe("isSupportedNoteContentType", () => {
  it.each([
    [null, true],
    ["", true],
    ["text/markdown", true],
    ["TEXT/MARKDOWN; charset=utf-8", true],
    [" text/plain ; charset=utf-8 ", true],
    ["application/json", false],
    ["application/octet-stream", false],
  ] as const)("classifies %j as supported=%j", (value, expected) => {
    expect(isSupportedNoteContentType(value)).toBe(expected);
  });
});
