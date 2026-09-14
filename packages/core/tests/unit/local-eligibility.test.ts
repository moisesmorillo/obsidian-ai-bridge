import {
  evaluateLocalNote,
  evaluateLocalNotePath,
  evaluateLocalNoteSize,
  LocalInspectionKind,
  LocalSkipReason,
  LocalVaultFailureReason,
  type LocalVaultFailureReasonCode,
  MAX_NOTE_SIZE_BYTES,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it } from "vitest";

const policy = { configDirectory: "config" };

/**
 * Builds a sanitized expectation without paths or content.
 * @param reason - Closed expected policy failure.
 * @returns Only the failure discriminant and reason.
 */
function failure(reason: LocalVaultFailureReasonCode) {
  return { kind: LocalInspectionKind.failed, reason };
}

describe("local eligibility", () => {
  it.each([
    "Note.md",
    "Folder/Note.md",
    "a b.md",
    "日本語/é.md",
    "100%.md",
    "a%20b.md",
  ])("preserves eligible literal name %j", (path) => {
    expect(evaluateLocalNotePath(path, policy)).toEqual({
      kind: LocalInspectionKind.ok,
      path,
    });
    expect(evaluateLocalNote(path, 0, policy)).toEqual({
      kind: LocalInspectionKind.ok,
      entry: { path, sizeBytes: 0 },
    });
  });

  it.each([
    "",
    "Note.MD",
    "Note.txt",
    "image.png",
    ".hidden/image.png",
    "../file.txt",
  ])("classifies unsupported %j first", (path) => {
    expect(evaluateLocalNote(path, Number.NaN, policy)).toEqual(
      failure(LocalSkipReason.unsupportedFile),
    );
  });

  it.each([
    ".hidden.md",
    "Folder/.private/Note.md",
    "config/secret.md",
    "../Note.md",
    "./Note.md",
    "/.hidden/Note.md",
  ])("excludes %j before syntax and size checks", (path) => {
    expect(evaluateLocalNote(path, Number.NaN, policy)).toEqual(
      failure(LocalSkipReason.excludedLocation),
    );
  });

  it("compares the exact configured directory boundary", () => {
    for (const path of [
      "configuration/Note.md",
      "Folder/config/Note.md",
      "config.md",
      "Config/Note.md",
    ]) {
      expect(evaluateLocalNotePath(path, policy).kind).toBe(
        LocalInspectionKind.ok,
      );
    }
    expect(
      evaluateLocalNotePath("private/settings/Note.md", {
        configDirectory: "private/settings",
      }),
    ).toEqual(failure(LocalSkipReason.excludedLocation));
    expect(
      evaluateLocalNotePath("private/settings.md", {
        configDirectory: "private/settings.md",
      }),
    ).toEqual(failure(LocalSkipReason.excludedLocation));
  });

  it.each([
    "/Note.md",
    "C:/Note.md",
    "C:Note.md",
    "Folder\\Note.md",
    "Folder/\0Note.md",
    "Folder//Note.md",
    "%2e%2e/Note.md",
    "a%2fb.md",
    "a%5cb.md",
    "a%00b.md",
    "%252e%252e/Note.md",
  ])("rejects unsafe literal %j before size checks", (path) => {
    expect(evaluateLocalNote(path, Number.NaN, policy)).toEqual(
      failure(LocalSkipReason.invalidPath),
    );
  });

  it.each([0, 1, MAX_NOTE_SIZE_BYTES])("accepts byte size %j", (sizeBytes) => {
    expect(evaluateLocalNoteSize(sizeBytes)).toEqual({
      kind: LocalInspectionKind.ok,
      sizeBytes,
    });
  });

  it("rejects oversized metadata without returning an entry", () => {
    expect(
      evaluateLocalNote("Note.md", MAX_NOTE_SIZE_BYTES + 1, policy),
    ).toEqual(failure(LocalSkipReason.oversized));
  });

  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("fails unavailable for malformed eligible size %j", (sizeBytes) => {
    expect(evaluateLocalNote("Note.md", sizeBytes, policy)).toEqual(
      failure(LocalVaultFailureReason.unavailable),
    );
  });
});
