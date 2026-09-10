import {
  containsDangerousEncoding,
  isSafeDecodedPath,
} from "@core/note-path/note-path-validation";
import { describe, expect, it } from "vitest";

describe("note-path validation utilities", () => {
  it.each([
    ["Folder/Note.md", true],
    ["Note.md", true],
    ["../Note.md", false],
    ["Folder//Note.md", false],
    ["Folder\\Note.md", false],
    ["/Note.md", false],
    ["Note.txt", false],
  ] as const)("classifies decoded path %j as safe=%j", (value, expected) => {
    expect(isSafeDecodedPath(value)).toBe(expected);
  });

  it.each([
    ["%2e%2e/Note.md", true],
    ["%252e%252e/Note.md", true],
    ["Folder/Note.md", false],
    ["100%aa.md", false],
  ] as const)(
    "classifies dangerous encoding %j as dangerous=%j",
    (value, expected) => {
      expect(containsDangerousEncoding(value)).toBe(expected);
    },
  );
});
