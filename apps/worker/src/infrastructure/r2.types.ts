/** Minimal R2 object metadata required by the vault storage adapter. */
export interface R2ObjectMetadata {
  readonly key: string;
  readonly size: number;
}

/** Minimal R2 object body required by the vault storage adapter. */
export interface R2StoredObject extends R2ObjectMetadata {
  text(): Promise<string>;
}

/** Paginated R2 listing shape consumed by the vault storage adapter. */
export interface R2ListResult {
  readonly objects: readonly R2ObjectMetadata[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

/** R2 binding subset used by the vault storage adapter. */
export interface R2BucketPort {
  list(options: {
    readonly prefix: string;
    readonly cursor?: string;
  }): Promise<R2ListResult>;
  head(key: string): Promise<R2ObjectMetadata | null>;
  get(key: string): Promise<R2StoredObject | null>;
  put(
    key: string,
    content: string,
    options: { readonly httpMetadata: { readonly contentType: string } },
  ): Promise<{ readonly key: string }>;
  delete(key: string): Promise<void>;
}
