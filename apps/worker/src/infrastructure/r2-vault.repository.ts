import type { NotePath, VaultRepository } from "@obsidian-ai-bridge/core";
import {
  isNormalizedNotePath,
  MAX_NOTE_SIZE_BYTES,
  StoredNoteTooLargeError,
} from "@obsidian-ai-bridge/core";
import { R2_NOTE_CONTENT_TYPE } from "@worker/infrastructure/r2.constants";
import type { R2BucketPort } from "@worker/infrastructure/r2.types";

const VAULT_OBJECT_PREFIX = "vault/";

/** R2 implementation of the vault repository port. */
export class R2VaultRepository implements VaultRepository {
  constructor(private readonly bucket: R2BucketPort) {}

  async list(): Promise<readonly NotePath[]> {
    const paths = new Set<NotePath>();
    let cursor: string | undefined;

    while (true) {
      const result = await this.bucket.list({
        prefix: VAULT_OBJECT_PREFIX,
        ...(cursor === undefined ? {} : { cursor }),
      });

      for (const object of result.objects) {
        if (
          !object.key.startsWith(VAULT_OBJECT_PREFIX) ||
          object.size > MAX_NOTE_SIZE_BYTES
        ) {
          continue;
        }

        const rawPath = object.key.slice(VAULT_OBJECT_PREFIX.length);
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
      throw new StoredNoteTooLargeError();
    }

    return object.text();
  }

  async write(path: NotePath, content: string): Promise<void> {
    await this.bucket.put(this.objectKey(path), content, {
      httpMetadata: { contentType: R2_NOTE_CONTENT_TYPE },
    });
  }

  delete(path: NotePath): Promise<void> {
    return this.bucket.delete(this.objectKey(path));
  }

  /** Adds the non-public R2 key namespace after core has validated the path. */
  private objectKey(path: NotePath): string {
    return `${VAULT_OBJECT_PREFIX}${path}`;
  }
}
