import {
  deleteNote,
  listNotes,
  MAX_NOTE_SIZE_BYTES,
  type NotePath,
  NotePayloadTooLargeError,
  normalizeNotePath,
  readNote,
  type VaultRepository,
  writeNote,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it, vi } from "vitest";

function validPath(value: string): NotePath {
  const path = normalizeNotePath(value);
  if (path === undefined) {
    throw new Error(`Invalid test path: ${value}`);
  }

  return path;
}

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
    const path = validPath("Alpha.md");

    await expect(
      writeNote(vault, path, "a".repeat(MAX_NOTE_SIZE_BYTES + 1)),
    ).rejects.toBeInstanceOf(NotePayloadTooLargeError);
    expect(vault.write).not.toHaveBeenCalled();
  });
});

describe("vault note services", () => {
  it("delegates reads and deletes and sorts listed paths", async () => {
    const alpha = validPath("Alpha.md");
    const zeta = validPath("Zeta.md");
    const vault: VaultRepository = {
      list: vi.fn().mockResolvedValue([zeta, alpha]),
      exists: vi.fn().mockResolvedValue(false),
      read: vi.fn().mockResolvedValue("content"),
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    await expect(listNotes(vault)).resolves.toEqual([alpha, zeta]);
    await expect(readNote(vault, alpha)).resolves.toBe("content");
    await expect(deleteNote(vault, alpha)).resolves.toBeUndefined();
    expect(vault.read).toHaveBeenCalledWith(alpha);
    expect(vault.delete).toHaveBeenCalledWith(alpha);
  });
});
