import {
  CurrentGenerationService,
  createApplicationRevision,
  createMirrorAssociationId,
  createMirrorWriterId,
  type MirrorGenerationCryptography,
  RecoveryService,
} from "@obsidian-ai-bridge/core";
import type {
  MirrorDesignation,
  WorkerMirrorServices,
} from "@worker/app.types";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
  R2ConditionalPutOptions,
  R2ConditionalStoredObject,
  R2ListResult,
} from "@worker/infrastructure/r2.types";
import { R2ConditionalCurrentNoteRepository } from "@worker/infrastructure/r2-conditional-current-note.repository";
import { R2RecoverySnapshotRepository } from "@worker/infrastructure/r2-recovery-snapshot.repository";
import { sha256Content } from "@worker/storage/storage-crypto";

/** Stable test association accepted by composed Worker HTTP tests. */
export const TEST_ASSOCIATION_ID = required(
  createMirrorAssociationId("11111111-1111-4111-8111-111111111111"),
);

/** Stable test writer accepted by composed Worker HTTP tests. */
export const TEST_WRITER_ID = required(
  createMirrorWriterId("22222222-2222-4222-8222-222222222222"),
);

interface StoredGeneration {
  readonly body: string;
  readonly metadata: R2ConditionalObjectMetadata;
}

/** Deferred seam invoked immediately before a conditional predicate is evaluated. */
type BeforeConditionalPut = (
  key: string,
  body: string,
  options: R2ConditionalPutOptions,
) => Promise<void>;

/** Deferred seam invoked after bytes commit but before successful metadata returns. */
type AfterConditionalPut = (
  key: string,
  body: string,
  metadata: R2ConditionalObjectMetadata,
) => Promise<void>;

/** Deterministic delete-free conditional R2 double used through real adapters. */
export class MemoryMirrorBucket implements R2ConditionalBucketPort {
  readonly putKeys: string[] = [];
  readonly putOptions: R2ConditionalPutOptions[] = [];
  readonly refusedPutCalls = new Set<number>();
  beforeConditionalPut: BeforeConditionalPut | undefined;
  afterConditionalPut: AfterConditionalPut | undefined;
  getCount = 0;
  throwOnGet = false;
  throwBeforePut = false;
  returnInvalidPutMetadata = false;
  private generation = 0;
  private revision = 0;
  private readonly objects = new Map<string, StoredGeneration>();

  async get(key: string): Promise<R2ConditionalStoredObject | null> {
    this.getCount += 1;
    if (this.throwOnGet) throw new Error("private storage detail");
    const stored = this.objects.get(key);
    if (stored === undefined) return null;
    const bytes = new TextEncoder().encode(stored.body);
    return {
      ...stored.metadata,
      arrayBuffer: async () => bytes.buffer.slice(0),
    };
  }

  async list(options: {
    readonly prefix: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<R2ListResult> {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix))
      .sort();
    const offset = options.cursor === undefined ? 0 : Number(options.cursor);
    const limit = options.limit ?? keys.length;
    const selected = keys.slice(offset, offset + limit);
    const objects = selected.map(
      (key) => required(this.objects.get(key)).metadata,
    );
    const next = offset + selected.length;
    return next < keys.length
      ? { objects, truncated: true, cursor: String(next) }
      : { objects, truncated: false };
  }

  async put(
    key: string,
    body: string,
    options: R2ConditionalPutOptions,
  ): Promise<R2ConditionalObjectMetadata | null> {
    this.putKeys.push(key);
    this.putOptions.push(options);
    if (this.throwBeforePut) throw new Error("private storage detail");
    await this.beforeConditionalPut?.(key, body, options);
    if (this.refusedPutCalls.has(this.putKeys.length)) return null;
    const existing = this.objects.get(key);
    if (options.onlyIf instanceof Headers) {
      if (
        options.onlyIf.get("If-None-Match") !== "*" ||
        existing !== undefined
      ) {
        return null;
      }
    } else if (existing?.metadata.etag !== options.onlyIf.etagMatches) {
      return null;
    }

    this.generation += 1;
    const metadata: R2ConditionalObjectMetadata = {
      key,
      size: new TextEncoder().encode(body).byteLength,
      etag: `storage-${this.generation}`,
      uploaded: new Date(
        `2027-01-01T00:00:${String(this.generation).padStart(2, "0")}.000Z`,
      ),
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body, metadata });
    await this.afterConditionalPut?.(key, body, metadata);
    return this.returnInvalidPutMetadata ? { ...metadata, etag: "" } : metadata;
  }

  /** @returns A unique deterministic revision across service recreation. */
  nextApplicationRevision() {
    this.revision += 1;
    return required(
      createApplicationRevision(
        `aaaaaaaa-aaaa-4aaa-8aaa-${String(this.revision).padStart(12, "0")}`,
      ),
    );
  }

  /**
   * Seeds raw or malformed storage for compatibility tests.
   *
   * @param key - Exact private object key.
   * @param body - Exact stored bytes represented as text.
   * @param customMetadata - Optional storage format marker.
   */
  seed(
    key: string,
    body: string,
    customMetadata?: Record<string, string>,
  ): void {
    this.generation += 1;
    this.objects.set(key, {
      body,
      metadata: {
        key,
        size: new TextEncoder().encode(body).byteLength,
        etag: `storage-${this.generation}`,
        uploaded: new Date("2027-01-01T00:00:00.000Z"),
        ...(customMetadata === undefined ? {} : { customMetadata }),
      },
    });
  }

  /**
   * Reads exact stored bytes for test assertions.
   *
   * @param key - Exact private object key.
   * @returns Stored text, or `undefined` when absent.
   */
  body(key: string): string | undefined {
    return this.objects.get(key)?.body;
  }
}

/**
 * Composes real 2B services and 2A adapters over a deterministic local bucket.
 *
 * @param bucket - Conditional in-memory R2 seam.
 * @param options - Optional designation and deterministic clock.
 * @returns Complete request services used by Worker integration tests.
 */
export function createTestMirrorServices(
  bucket: MemoryMirrorBucket,
  options: {
    readonly designation?: MirrorDesignation | null;
    readonly now?: Date;
  } = {},
): WorkerMirrorServices {
  const cryptography: MirrorGenerationCryptography = {
    digest: sha256Content,
    generateRevision: () => bucket.nextApplicationRevision(),
  };
  const currentRepository = new R2ConditionalCurrentNoteRepository(bucket);
  const recoveryRepository = new R2RecoverySnapshotRepository(bucket);
  const recovery = new RecoveryService(
    recoveryRepository,
    currentRepository,
    cryptography,
    { now: () => options.now ?? new Date("2027-01-02T00:00:00.000Z") },
  );
  return {
    current: new CurrentGenerationService(
      currentRepository,
      recovery,
      cryptography,
    ),
    recovery,
    designation:
      options.designation === undefined
        ? {
            associationId: TEST_ASSOCIATION_ID,
            writerId: TEST_WRITER_ID,
          }
        : options.designation,
  };
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid test fixture");
  return value;
}
