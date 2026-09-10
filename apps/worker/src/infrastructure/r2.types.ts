/** Minimal R2 object metadata required by the vault storage adapter. */
export interface R2ObjectMetadata {
  readonly key: string;
  readonly size: number;
}

/** Minimal R2 object body required by the vault storage adapter. */
export interface R2StoredObject extends R2ObjectMetadata {
  text(): Promise<string>;
}

/** Fields shared by every paginated R2 listing result. */
interface R2ListResultBase {
  readonly objects: readonly R2ObjectMetadata[];
}

/** Terminal page returned by an R2 listing operation. */
export interface R2CompleteListResult extends R2ListResultBase {
  readonly truncated: false;
}

/** Continuation page returned by an R2 listing operation. */
export interface R2TruncatedListResult extends R2ListResultBase {
  readonly truncated: true;
  readonly cursor: string;
}

/** Paginated R2 listing shape consumed by the vault storage adapter. */
export type R2ListResult = R2CompleteListResult | R2TruncatedListResult;

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
