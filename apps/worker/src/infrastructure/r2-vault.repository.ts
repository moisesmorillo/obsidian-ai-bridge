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

/**
 * R2 implementation of the vault repository port.
 *
 * All public methods accept normalized paths from the core boundary and keep
 * the private `vault/` object namespace out of the application layer.
 */
export class R2VaultRepository implements VaultRepository {
  /**
   * Creates a repository backed by one R2 bucket binding.
   *
   * @param bucket - R2 port used for object metadata and content operations.
   */
  constructor(private readonly bucket: R2BucketPort) {}

  /**
   * Lists safe, in-limit Markdown paths from the private object namespace.
   *
   * @returns All valid normalized paths across the paginated R2 listing.
   */
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

  /**
   * Checks whether the namespaced object exists.
   *
   * @param path - Normalized note path supplied by the core boundary.
   * @returns Whether an object with the corresponding private key exists.
   */
  async exists(path: NotePath): Promise<boolean> {
    return (await this.bucket.head(this.objectKey(path))) !== null;
  }

  /**
   * Reads a note without buffering a persisted object known to be oversized.
   *
   * @param path - Normalized note path supplied by the core boundary.
   * @returns Note text, or `null` when the namespaced object does not exist.
   * @throws {StoredNoteTooLargeError} When persisted metadata exceeds the note size limit.
   */
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

  /**
   * Writes note content with the established Markdown storage metadata.
   *
   * @param path - Normalized note path supplied by the core boundary.
   * @param content - UTF-8 note text whose size was checked by the application service.
   * @returns A promise that settles after R2 stores the namespaced object.
   */
  async write(path: NotePath, content: string): Promise<void> {
    await this.bucket.put(this.objectKey(path), content, {
      httpMetadata: { contentType: R2_NOTE_CONTENT_TYPE },
    });
  }

  /**
   * Deletes a namespaced note object.
   *
   * @param path - Normalized note path supplied by the core boundary.
   * @returns A promise that settles after deletion; absent objects remain successful.
   */
  delete(path: NotePath): Promise<void> {
    return this.bucket.delete(this.objectKey(path));
  }

  /**
   * Adds the private R2 namespace to a validated note path.
   *
   * @param path - Normalized note path supplied by the core boundary.
   * @returns The storage key hidden from transport and application callers.
   */
  private objectKey(path: NotePath): string {
    return `${VAULT_OBJECT_PREFIX}${path}`;
  }

  /**
   * Adds safe and in-limit paths from one untrusted R2 listing page.
   *
   * @param paths - Accumulator for validated paths across listing pages.
   * @param page - R2 page whose keys and metadata require boundary validation.
   */
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
