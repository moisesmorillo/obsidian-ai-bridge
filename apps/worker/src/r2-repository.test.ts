import {
  MAX_NOTE_SIZE_BYTES,
  normalizeNotePath,
  StoredNoteTooLargeError,
} from "@obsidian-ai-bridge/core";
import type { R2BucketPort } from "@worker/infrastructure/r2.types";
import { R2VaultRepository } from "@worker/infrastructure/r2-vault.repository";
import { describe, expect, it, vi } from "vitest";

function notePath(value: string) {
  const path = normalizeNotePath(value);
  if (path === undefined) {
    throw new Error(`Invalid test path: ${value}`);
  }

  return path;
}

function emptyBucket(): R2BucketPort {
  return {
    list: async () => ({ objects: [], truncated: false }),
    head: async () => null,
    get: async () => null,
    put: async (key) => ({ key }),
    delete: async () => undefined,
  };
}

describe("R2VaultRepository", () => {
  it("follows R2 list cursors and exposes only safe Markdown paths", async () => {
    const list = vi
      .fn<R2BucketPort["list"]>()
      .mockResolvedValueOnce({
        objects: [
          { key: "vault/Career/Applications/Company.md", size: 10 },
          { key: "vault/ignored.txt", size: 10 },
        ],
        truncated: true,
        cursor: "next-page",
      })
      .mockResolvedValueOnce({
        objects: [
          { key: "vault/Homelab/DNS/Technitium.md", size: 10 },
          { key: "vault/../secret.md", size: 10 },
          { key: "vault/too-large.md", size: MAX_NOTE_SIZE_BYTES + 1 },
          { key: "vault/encoded%2Fname.md", size: 10 },
        ],
        truncated: false,
      });
    const bucket = { ...emptyBucket(), list };

    const paths = await new R2VaultRepository(bucket).list();

    expect(paths).toEqual([
      "Career/Applications/Company.md",
      "Homelab/DNS/Technitium.md",
    ]);
    expect(list).toHaveBeenNthCalledWith(1, { prefix: "vault/" });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "vault/",
      cursor: "next-page",
    });
  });

  it("uses the vault prefix for note operations", async () => {
    const head = vi.fn<R2BucketPort["head"]>().mockResolvedValue(null);
    const get = vi.fn<R2BucketPort["get"]>().mockResolvedValue(null);
    const put = vi
      .fn<R2BucketPort["put"]>()
      .mockImplementation(async (key) => ({ key }));
    const remove = vi.fn<R2BucketPort["delete"]>().mockResolvedValue(undefined);
    const bucket = { ...emptyBucket(), head, get, put, delete: remove };
    const repository = new R2VaultRepository(bucket);
    const path = notePath("Alpha.md");

    expect(await repository.exists(path)).toBe(false);
    expect(await repository.read(path)).toBeNull();
    await repository.write(path, "alpha");
    await repository.delete(path);

    expect(head).toHaveBeenCalledWith("vault/Alpha.md");
    expect(get).toHaveBeenCalledWith("vault/Alpha.md");
    expect(put).toHaveBeenCalledWith("vault/Alpha.md", "alpha", {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    expect(remove).toHaveBeenCalledWith("vault/Alpha.md");
  });

  it("does not buffer an oversized stored object", async () => {
    const text = vi.fn<() => Promise<string>>();
    const get = vi.fn<R2BucketPort["get"]>().mockResolvedValue({
      key: "vault/Alpha.md",
      size: MAX_NOTE_SIZE_BYTES + 1,
      text,
    });
    const repository = new R2VaultRepository({ ...emptyBucket(), get });

    await expect(repository.read(notePath("Alpha.md"))).rejects.toBeInstanceOf(
      StoredNoteTooLargeError,
    );
    expect(text).not.toHaveBeenCalled();
  });
});
