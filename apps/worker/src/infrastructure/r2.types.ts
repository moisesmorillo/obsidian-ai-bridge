/** Minimal R2 object metadata required by the vault storage adapter. */
export interface R2ObjectMetadata {
  /** Full object key, including the private vault namespace. */
  readonly key: string;

  /** Persisted object size in bytes. */
  readonly size: number;
}

/** Minimal R2 object body required by the vault storage adapter. */
export interface R2StoredObject extends R2ObjectMetadata {
  /**
   * Reads the object body as text after metadata validation.
   *
   * @returns The stored object text.
   */
  text(): Promise<string>;
}

/** Fields shared by every paginated R2 listing result. */
interface R2ListResultBase {
  /** Objects returned by this listing page. */
  readonly objects: readonly R2ObjectMetadata[];
}

/** Terminal page returned by an R2 listing operation. */
export interface R2CompleteListResult extends R2ListResultBase {
  /** Marks that this page has no continuation cursor. */
  readonly truncated: false;
}

/** Continuation page returned by an R2 listing operation. */
export interface R2TruncatedListResult extends R2ListResultBase {
  /** Marks that a subsequent page must be requested. */
  readonly truncated: true;

  /** Cursor passed to the next listing request. */
  readonly cursor: string;
}

/** Paginated R2 listing shape consumed by the vault storage adapter. */
export type R2ListResult = R2CompleteListResult | R2TruncatedListResult;

/** R2 binding subset used by the vault storage adapter. */
export interface R2BucketPort {
  /**
   * Lists objects in the configured namespace.
   *
   * @param options - Namespace prefix and optional continuation cursor.
   * @returns One page of object metadata.
   */
  list(options: {
    readonly prefix: string;
    readonly cursor?: string;
  }): Promise<R2ListResult>;

  /**
   * Reads metadata for one object.
   *
   * @param key - Full namespaced object key.
   * @returns Metadata, or `null` when the object is absent.
   */
  head(key: string): Promise<R2ObjectMetadata | null>;

  /**
   * Retrieves one object.
   *
   * @param key - Full namespaced object key.
   * @returns Stored object, or `null` when the object is absent.
   */
  get(key: string): Promise<R2StoredObject | null>;

  /**
   * Stores one object with HTTP metadata.
   *
   * @param key - Full namespaced object key.
   * @param content - Text content to persist.
   * @param options - Storage metadata applied to the object.
   * @returns The stored object's key.
   */
  put(
    key: string,
    content: string,
    options: { readonly httpMetadata: { readonly contentType: string } },
  ): Promise<{ readonly key: string }>;

  /**
   * Deletes one object.
   *
   * @param key - Full namespaced object key.
   * @returns A promise that settles after the deletion attempt.
   */
  delete(key: string): Promise<void>;
}
