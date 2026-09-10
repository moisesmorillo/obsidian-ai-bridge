/// <reference types="@cloudflare/workers-types" />

import { describe, expect, it, vi } from "vitest";
import { MAX_NOTE_SIZE_BYTES, type NotePath } from "@obsidian-ai-bridge/core";
import { R2VaultRepository } from "./r2-repository";

describe("R2VaultRepository", () => {
  it("follows R2 list cursors and exposes only safe Markdown paths", async () => {
    const list = vi
      .fn()
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
    const bucket = { list } as unknown as R2Bucket;

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
    const head = vi.fn().mockResolvedValue(null);
    const get = vi.fn().mockResolvedValue(null);
    const put = vi.fn().mockResolvedValue({});
    const remove = vi.fn().mockResolvedValue(undefined);
    const bucket = { head, get, put, delete: remove } as unknown as R2Bucket;
    const path = "Alpha.md" as NotePath;
    const repository = new R2VaultRepository(bucket);

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
    const text = vi.fn();
    const get = vi.fn().mockResolvedValue({
      size: MAX_NOTE_SIZE_BYTES + 1,
      text,
    });
    const bucket = { get } as unknown as R2Bucket;
    const repository = new R2VaultRepository(bucket);

    await expect(repository.read("Alpha.md" as NotePath)).rejects.toThrow(
      "Stored note exceeds the maximum supported size.",
    );
    expect(text).not.toHaveBeenCalled();
  });
});
