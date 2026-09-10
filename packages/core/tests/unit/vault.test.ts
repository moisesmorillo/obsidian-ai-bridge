import {
  MAX_NOTE_SIZE_BYTES,
  type NotePath,
  NotePayloadTooLargeError,
  normalizeNotePath,
  VaultNoteService,
  type VaultRepository,
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

describe("VaultNoteService", () => {
  it("rejects payloads larger than the byte limit", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const vault: VaultRepository = {
      ...repository(),
      write,
    };
    const path = validPath("Alpha.md");

    await expect(
      new VaultNoteService(vault).write(
        path,
        "a".repeat(MAX_NOTE_SIZE_BYTES + 1),
      ),
    ).rejects.toBeInstanceOf(NotePayloadTooLargeError);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("vault note services", () => {
  it("delegates reads and deletes and sorts listed paths", async () => {
    const alpha = validPath("Alpha.md");
    const zeta = validPath("Zeta.md");
    const read = vi.fn().mockResolvedValue("content");
    const remove = vi.fn().mockResolvedValue(undefined);
    const vault: VaultRepository = {
      list: vi.fn().mockResolvedValue([zeta, alpha]),
      exists: vi.fn().mockResolvedValue(false),
      read,
      write: vi.fn().mockResolvedValue(undefined),
      delete: remove,
    };

    const service = new VaultNoteService(vault);

    await expect(service.list()).resolves.toEqual([alpha, zeta]);
    await expect(service.read(alpha)).resolves.toBe("content");
    await expect(service.delete(alpha)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith(alpha);
    expect(remove).toHaveBeenCalledWith(alpha);
  });
});
