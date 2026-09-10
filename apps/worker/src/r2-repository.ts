/// <reference types="@cloudflare/workers-types" />

import {
  isNormalizedNotePath,
  MAX_NOTE_SIZE_BYTES,
} from "@obsidian-ai-bridge/core";
import type { NotePath, VaultRepository } from "@obsidian-ai-bridge/core";

const vaultPrefix = "vault/";

export class R2VaultRepository implements VaultRepository {
  constructor(private readonly bucket: R2Bucket) {}

  async list(): Promise<readonly NotePath[]> {
    const paths = new Set<NotePath>();
    let cursor: string | undefined;

    while (true) {
      const result =
        cursor === undefined
          ? await this.bucket.list({ prefix: vaultPrefix })
          : await this.bucket.list({ prefix: vaultPrefix, cursor });

      for (const object of result.objects) {
        if (
          !object.key.startsWith(vaultPrefix) ||
          object.size > MAX_NOTE_SIZE_BYTES
        ) {
          continue;
        }

        const rawPath = object.key.slice(vaultPrefix.length);
        if (isNormalizedNotePath(rawPath)) {
          paths.add(rawPath);
        }
      }

      if (!result.truncated) {
        return [...paths];
      }

      cursor = result.cursor;
    }
  }

  async exists(path: NotePath): Promise<boolean> {
    return (await this.bucket.head(this.objectKey(path))) !== null;
  }

  async read(path: NotePath): Promise<string | null> {
    const object = await this.bucket.get(this.objectKey(path));
    if (object === null) {
      return null;
    }
    if (object.size > MAX_NOTE_SIZE_BYTES) {
      throw new Error("Stored note exceeds the maximum supported size.");
    }

    return object.text();
  }

  async write(path: NotePath, content: string): Promise<void> {
    await this.bucket.put(this.objectKey(path), content, {
      httpMetadata: {
        contentType: "text/markdown; charset=utf-8",
      },
    });
  }

  delete(path: NotePath): Promise<void> {
    return this.bucket.delete(this.objectKey(path));
  }

  private objectKey(path: NotePath): string {
    return `${vaultPrefix}${path}`;
  }
}
