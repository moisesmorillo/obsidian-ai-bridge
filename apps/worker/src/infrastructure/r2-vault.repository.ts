import type { NotePath, VaultRepository } from "@obsidian-ai-bridge/core";
import {
  isNormalizedNotePath,
  MAX_NOTE_SIZE_BYTES,
  StoredNoteTooLargeError,
} from "@obsidian-ai-bridge/core";
import {
  R2_NOTE_CONTENT_TYPE,
  VAULT_OBJECT_PREFIX,
} from "@worker/infrastructure/r2.constants";
import type {
  R2BucketPort,
  R2ListResult,
} from "@worker/infrastructure/r2.types";

/** R2 implementation of the vault repository port. */
export class R2VaultRepository implements VaultRepository {
  constructor(private readonly bucket: R2BucketPort) {}

  async list(): Promise<readonly NotePath[]> {
    const paths = new Set<NotePath>();
    let page: R2ListResult | undefined = await this.bucket.list({
      prefix: VAULT_OBJECT_PREFIX,
    });

    while (page !== undefined) {
      this.addValidPaths(paths, page);
      page = page.truncated
        ? await this.bucket.list({
            prefix: VAULT_OBJECT_PREFIX,
            cursor: page.cursor,
          })
        : undefined;
    }

    return [...paths];
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

  /** Adds safe and in-limit paths from one untrusted R2 listing page. */
  private addValidPaths(paths: Set<NotePath>, page: R2ListResult): void {
    for (const object of page.objects) {
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
  }
}
