import { describe, expect, it } from "vitest";
import {
  decodeNotePath,
  encodeNotePath,
  isNormalizedNotePath,
  normalizeNotePath,
  type NotePath,
} from "@obsidian-ai-bridge/core";

describe("normalizeNotePath", () => {
  it.each(["Homelab/DNS/Technitium.md", "Career/Applications/Company.md"])(
    "accepts a valid nested Markdown path: %s",
    (path) => {
      expect(normalizeNotePath(path)).toBe(path);
    },
  );

  it("decodes safe percent-encoded characters without accepting traversal", () => {
    expect(normalizeNotePath("100%25.md")).toBe("100%.md");
    expect(isNormalizedNotePath("100%.md")).toBe(true);
    expect(isNormalizedNotePath("100%aa.md")).toBe(true);
    expect(isNormalizedNotePath("encoded%2Fname.md")).toBe(false);
  });

  it("round-trips nested paths through the URL-safe identifier", () => {
    const path = normalizeNotePath("Homelab/DNS/Technitium.md");

    expect(path).toBeDefined();
    const encodedPath = encodeNotePath(path as NotePath);
    expect(encodedPath).not.toMatch(/[./\\]/);
    expect(decodeNotePath(encodedPath)).toBe(path);
  });

  it.each(["", "not-base64!", "Li4vc2VjcmV0Lm1k", "SGVsbG8"])(
    "rejects an invalid URL-safe note identifier: %s",
    (encodedPath) => {
      expect(decodeNotePath(encodedPath)).toBeUndefined();
    },
  );

  it.each([
    "../secret.md",
    "../../secret.md",
    "/secret.md",
    "Homelab/../../../secret.md",
    "Homelab\\..\\secret.md",
    "%2e%2e/secret.md",
    "%252e%252e/secret.md",
    "",
    "notes.txt",
    "notes.md/",
  ])("rejects unsafe or unsupported path: %s", (path) => {
    expect(normalizeNotePath(path)).toBeUndefined();
  });

  it("rejects malformed encoded paths", () => {
    expect(normalizeNotePath("notes%2.md")).toBeUndefined();
  });
});
