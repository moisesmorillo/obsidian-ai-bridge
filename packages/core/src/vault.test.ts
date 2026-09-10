import { describe, expect, it, vi } from "vitest";
import {
  MAX_NOTE_SIZE_BYTES,
  NotePayloadTooLargeError,
  normalizeNotePath,
  writeNote,
  type NotePath,
  type VaultRepository,
} from "@obsidian-ai-bridge/core";

function repository(): VaultRepository {
  return {
    list: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(false),
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe("writeNote", () => {
  it("rejects payloads larger than the byte limit", async () => {
    const vault = repository();
    const path = normalizeNotePath("Alpha.md") as NotePath;

    await expect(
      writeNote(vault, path, "a".repeat(MAX_NOTE_SIZE_BYTES + 1)),
    ).rejects.toBeInstanceOf(NotePayloadTooLargeError);
    expect(vault.write).not.toHaveBeenCalled();
  });
});
