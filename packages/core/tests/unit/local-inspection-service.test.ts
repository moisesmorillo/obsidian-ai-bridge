import {
  isNormalizedNotePath,
  LocalInspectionKind,
  LocalInspectionService,
  type LocalNoteEntry,
  type LocalReadResult,
  type LocalSkippedCounts,
  LocalSkipReason,
  LocalVaultFailureReason,
  type ReadOnlyLocalVault,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it, vi } from "vitest";

const policy = { configDirectory: "config" };
const skipped: LocalSkippedCounts = {
  [LocalSkipReason.unsupportedFile]: 2,
  [LocalSkipReason.excludedLocation]: 3,
  [LocalSkipReason.invalidPath]: 4,
  [LocalSkipReason.oversized]: 5,
};

/**
 * Builds literal validated metadata without URI decoding or an unchecked cast.
 * @param path - Literal fixture path to validate.
 * @returns Metadata satisfying the core path invariant.
 */
function entry(path: string): LocalNoteEntry {
  if (!isNormalizedNotePath(path)) throw new Error("Invalid test fixture");
  return { path, sizeBytes: 42 };
}

/**
 * Provides a narrow, deterministic port with no mutation capabilities.
 * @returns Typed spies for the two read-only operations.
 */
function vault() {
  return {
    list: vi.fn<ReadOnlyLocalVault["list"]>().mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries: [],
      skipped,
    }),
    read: vi.fn<ReadOnlyLocalVault["read"]>().mockResolvedValue({
      kind: LocalInspectionKind.ok,
      content: "sensitive",
      sizeBytes: 9,
    }),
  };
}

describe("LocalInspectionService", () => {
  it("returns an explicit empty list and preserves grouped skip counts", async () => {
    const port = vault();
    await expect(
      new LocalInspectionService(port, policy).list(),
    ).resolves.toEqual({ kind: LocalInspectionKind.ok, entries: [], skipped });
    expect(port.list).toHaveBeenCalledTimes(1);
    expect(port.read).not.toHaveBeenCalled();
  });

  it("sorts by literal lexical order without modifying port metadata", async () => {
    const port = vault();
    const entries = [
      entry("é.md"),
      entry("z.md"),
      entry("a%20b.md"),
      entry("A.md"),
      entry("a b.md"),
      entry("A.md"),
    ];
    const original = [...entries];
    port.list.mockResolvedValue({
      kind: LocalInspectionKind.ok,
      entries,
      skipped,
    });
    const result = await new LocalInspectionService(port, policy).list();
    expect(result).toEqual({
      kind: LocalInspectionKind.ok,
      entries: [
        original[3],
        original[5],
        original[4],
        original[2],
        original[1],
        original[0],
      ],
      skipped,
    });
    expect(entries).toEqual(original);
    expect(port.read).not.toHaveBeenCalled();
  });

  it.each([
    [null, LocalVaultFailureReason.noActiveFile],
    ["photo.png", LocalSkipReason.unsupportedFile],
    ["config/Note.md", LocalSkipReason.excludedLocation],
    ["a%2fb.md", LocalSkipReason.invalidPath],
  ] as const)(
    "refuses active input %j before invoking the port",
    async (path, reason) => {
      const port = vault();
      await expect(
        new LocalInspectionService(port, policy).inspectActivePath(path),
      ).resolves.toEqual({ kind: LocalInspectionKind.failed, reason });
      expect(port.read).not.toHaveBeenCalled();
      expect(port.list).not.toHaveBeenCalled();
    },
  );

  it.each(["100%.md", "a%20b.md", "a b.md", "日本語.md"])(
    "reads exact captured literal %j once and strips content",
    async (path) => {
      const port = vault();
      const result = await new LocalInspectionService(
        port,
        policy,
      ).inspectActivePath(path);
      expect(result).toEqual({
        kind: LocalInspectionKind.ok,
        entry: { path, sizeBytes: 9 },
      });
      expect(JSON.stringify(result)).not.toContain("sensitive");
      expect(port.read).toHaveBeenCalledExactlyOnceWith(path);
      expect(port.list).not.toHaveBeenCalled();
    },
  );

  it.each([
    LocalSkipReason.unsupportedFile,
    LocalSkipReason.excludedLocation,
    LocalSkipReason.invalidPath,
    LocalSkipReason.oversized,
    LocalVaultFailureReason.missingFile,
    LocalVaultFailureReason.changedDuringRead,
    LocalVaultFailureReason.unavailable,
  ])("preserves typed read failure %j without retry", async (reason) => {
    const port = vault();
    const result: LocalReadResult = {
      kind: LocalInspectionKind.failed,
      reason,
    };
    port.read.mockResolvedValue(result);
    await expect(
      new LocalInspectionService(port, policy).inspectActivePath("Note.md"),
    ).resolves.toEqual(result);
    expect(port.read).toHaveBeenCalledTimes(1);
  });

  it("preserves typed enumeration failure instead of an empty success", async () => {
    const port = vault();
    const result = {
      kind: LocalInspectionKind.failed,
      reason: LocalVaultFailureReason.unavailable,
    } as const;
    port.list.mockResolvedValue(result);
    await expect(
      new LocalInspectionService(port, policy).list(),
    ).resolves.toEqual(result);
  });

  it("sanitizes rejected operations and permits explicit retry", async () => {
    const port = vault();
    port.list.mockRejectedValueOnce(new Error("private/path.md: sensitive"));
    port.read.mockRejectedValueOnce(new Error("private/path.md: sensitive"));
    const service = new LocalInspectionService(port, policy);
    const failed = {
      kind: LocalInspectionKind.failed,
      reason: LocalVaultFailureReason.unavailable,
    };
    await expect(service.list()).resolves.toEqual(failed);
    await expect(service.inspectActivePath("Note.md")).resolves.toEqual(failed);
    await expect(service.list()).resolves.toHaveProperty(
      "kind",
      LocalInspectionKind.ok,
    );
    await expect(service.inspectActivePath("Note.md")).resolves.toHaveProperty(
      "kind",
      LocalInspectionKind.ok,
    );
    expect(port.list).toHaveBeenCalledTimes(2);
    expect(port.read).toHaveBeenCalledTimes(2);
  });
});
