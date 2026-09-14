import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  MAX_NOTE_SIZE_BYTES,
  MUTATION_EFFECT_CERTAINTY,
  normalizeNotePath,
  RECOVERY_SNAPSHOT_STATE_KIND,
  type RecoveryPreparationRequest,
} from "@obsidian-ai-bridge/core";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
  R2ConditionalPutOptions,
  R2ConditionalStoredObject,
} from "@worker/infrastructure/r2.types";
import { R2RecoverySnapshotRepository } from "@worker/infrastructure/r2-recovery-snapshot.repository";
import {
  BRIDGE_STORAGE_FORMAT_METADATA_KEY,
  BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
  MAX_RECOVERY_OBJECT_BYTES,
} from "@worker/infrastructure/storage-object.constants";
import { STORED_OBJECT_DATA_ERROR_KIND } from "@worker/infrastructure/storage-object.errors";
import { describe, expect, it } from "vitest";

const ID = required(
  createMirrorOperationId("11111111-1111-4111-8111-111111111111"),
);
const OTHER_ID = required(
  createMirrorOperationId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
);
const ASSOCIATION_ID = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const WRITER_ID = required(
  createMirrorWriterId("33333333-3333-4333-8333-333333333333"),
);
const SOURCE_REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const TOMBSTONE_REVISION = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const CONTENT_SHA256 = required(
  createContentSha256(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ),
);
const PATH = required(normalizeNotePath("Recovery/Empty.md"));
const RECOVER_UNTIL = "2027-02-01T00:00:01.000Z";

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid test fixture");
  return value;
}

function operationId(sequence: number) {
  return required(
    createMirrorOperationId(
      `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
    ),
  );
}

function preparation(): RecoveryPreparationRequest {
  return {
    id: ID,
    associationId: ASSOCIATION_ID,
    operationId: ID,
    path: PATH,
    sourceRevision: SOURCE_REVISION,
    contentSha256: CONTENT_SHA256,
    content: "",
  };
}

interface MemoryGeneration {
  readonly body: string;
  readonly metadata: R2ConditionalObjectMetadata;
}

class MemoryRecoveryBucket implements R2ConditionalBucketPort {
  readonly putOptions: R2ConditionalPutOptions[] = [];
  deleteCalls = 0;
  throwAfterSuccessfulPut = false;
  throwOnGet = false;
  returnInvalidMetadata = false;
  private generation = 0;
  private readonly objects = new Map<string, MemoryGeneration>();

  async get(key: string): Promise<R2ConditionalStoredObject | null> {
    if (this.throwOnGet) throw new Error("read unavailable");
    const generation = this.objects.get(key);
    if (generation === undefined) return null;
    const bytes = new TextEncoder().encode(generation.body);
    return {
      ...generation.metadata,
      arrayBuffer: async () => bytes.buffer.slice(0),
    };
  }

  async put(
    key: string,
    body: string,
    options: R2ConditionalPutOptions,
  ): Promise<R2ConditionalObjectMetadata | null> {
    this.putOptions.push(options);
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
    const metadata = {
      key,
      size: new TextEncoder().encode(body).byteLength,
      etag: `recovery-etag-${this.generation}`,
      uploaded: new Date(`2027-01-01T00:00:0${this.generation}.000Z`),
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body, metadata });
    if (this.throwAfterSuccessfulPut) {
      throw new Error("binding failed after dispatch");
    }
    return this.returnInvalidMetadata
      ? { ...metadata, uploaded: new Date("invalid") }
      : metadata;
  }

  snapshot(): MemoryGeneration | undefined {
    return this.objects.get(`recovery/${ID}`);
  }

  replaceBody(body: string): void {
    const stored = this.snapshot();
    if (stored === undefined) throw new Error("Expected recovery fixture");
    this.objects.set(`recovery/${ID}`, {
      body,
      metadata: {
        ...stored.metadata,
        size: new TextEncoder().encode(body).byteLength,
      },
    });
  }

  replaceMetadata(changes: Partial<R2ConditionalObjectMetadata>): void {
    const stored = this.snapshot();
    if (stored === undefined) throw new Error("Expected recovery fixture");
    this.objects.set(`recovery/${ID}`, {
      body: stored.body,
      metadata: { ...stored.metadata, ...changes },
    });
  }

  delete(): void {
    this.deleteCalls += 1;
  }
}

describe("R2RecoverySnapshotRepository", () => {
  it("reports exact absence and rejects invalid preparation before dispatch", async () => {
    const bucket = new MemoryRecoveryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);

    await expect(repository.read(ID)).resolves.toBeNull();
    bucket.throwOnGet = true;
    await expect(
      repository.seal({
        id: ID,
        associationId: ASSOCIATION_ID,
        writerId: WRITER_ID,
        operationId: operationId(9),
        expectedRevision: SOURCE_REVISION,
        tombstoneRevision: TOMBSTONE_REVISION,
        recoverUntil: RECOVER_UNTIL,
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    bucket.throwOnGet = false;

    await expect(
      repository.prepare({ ...preparation(), content: "not empty" }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    await expect(
      repository.prepare({
        ...preparation(),
        content: "x".repeat(MAX_NOTE_SIZE_BYTES + 1),
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    expect(bucket.putOptions).toHaveLength(0);
  });

  it("prepares with create-only semantics and refuses a competing duplicate", async () => {
    const bucket = new MemoryRecoveryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);

    const results = await Promise.all([
      repository.prepare(preparation()),
      repository.prepare(preparation()),
    ]);

    expect(
      results
        .map((result) => result.kind)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual([
      MUTATION_EFFECT_CERTAINTY.confirmed,
      MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    ]);
    expect(bucket.putOptions).toHaveLength(2);
    for (const options of bucket.putOptions) {
      expect(options.onlyIf).toBeInstanceOf(Headers);
      if (options.onlyIf instanceof Headers) {
        expect(options.onlyIf.get("If-None-Match")).toBe("*");
      }
      expect(options.customMetadata).toEqual({
        [BRIDGE_STORAGE_FORMAT_METADATA_KEY]:
          BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
      });
      expect(options.httpMetadata.contentType).toBe(
        "application/json; charset=utf-8",
      );
    }
    await expect(repository.read(ID)).resolves.toMatchObject({
      kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
      id: ID,
      path: PATH,
    });
    expect(bucket.deleteCalls).toBe(0);
  });

  it("seals a matching prepared generation using its private observed R2 ETag", async () => {
    const bucket = new MemoryRecoveryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);
    const prepared = await repository.prepare(preparation());
    if (prepared.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected preparation confirmation");
    }
    const preparedStorage = bucket.snapshot();

    await expect(
      repository.seal({
        id: ID,
        associationId: ASSOCIATION_ID,
        writerId: WRITER_ID,
        operationId: operationId(11),
        expectedRevision: prepared.confirmed.revision,
        tombstoneRevision: TOMBSTONE_REVISION,
        recoverUntil: "not-a-timestamp",
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    expect(bucket.putOptions).toHaveLength(1);

    const sealed = await repository.seal({
      id: ID,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(1),
      expectedRevision: prepared.confirmed.revision,
      tombstoneRevision: TOMBSTONE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    });

    expect(sealed).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
        recoverUntil: RECOVER_UNTIL,
      },
    });
    expect(bucket.putOptions.at(-1)?.onlyIf).toEqual({
      etagMatches: preparedStorage?.metadata.etag,
    });
  });

  it("refuses stale recovery CAS and preserves the winner bytes and metadata", async () => {
    const bucket = new MemoryRecoveryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);
    const prepared = await repository.prepare(preparation());
    if (prepared.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected preparation confirmation");
    }
    const staleRevision = prepared.confirmed.revision;
    const sealed = await repository.seal({
      id: ID,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(2),
      expectedRevision: staleRevision,
      tombstoneRevision: TOMBSTONE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    });
    expect(sealed.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    const winner = bucket.snapshot();

    const stale = await repository.seal({
      id: ID,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(3),
      expectedRevision: staleRevision,
      tombstoneRevision: TOMBSTONE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    });

    expect(stale).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    expect(bucket.snapshot()).toEqual(winner);
    expect(bucket.putOptions).toHaveLength(2);
  });

  it("rejects a valid recovery envelope whose identity does not match its exact key", async () => {
    const bucket = new MemoryRecoveryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);
    const prepared = await repository.prepare(preparation());
    if (prepared.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected preparation confirmation");
    }
    const body = JSON.parse(required(bucket.snapshot()).body);
    bucket.replaceBody(
      JSON.stringify({ ...body, id: OTHER_ID, operationId: OTHER_ID }),
    );

    await expect(repository.read(ID)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
    await expect(
      repository.seal({
        id: ID,
        associationId: ASSOCIATION_ID,
        writerId: WRITER_ID,
        operationId: operationId(10),
        expectedRevision: prepared.confirmed.revision,
        tombstoneRevision: TOMBSTONE_REVISION,
        recoverUntil: RECOVER_UNTIL,
      }),
    ).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
    expect(bucket.putOptions).toHaveLength(1);
  });

  it("rejects missing, unsupported, and oversized tagged recovery data", async () => {
    const bucket = new MemoryRecoveryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);
    const prepared = await repository.prepare(preparation());
    expect(prepared.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);

    bucket.replaceMetadata({ etag: "" });
    await expect(repository.read(ID)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
    bucket.replaceMetadata({
      etag: "valid-again",
      customMetadata: {},
    });
    await expect(repository.read(ID)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
    bucket.replaceMetadata({
      customMetadata: { [BRIDGE_STORAGE_FORMAT_METADATA_KEY]: "99" },
    });
    await expect(repository.read(ID)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.unsupportedFormat,
    });
    bucket.replaceMetadata({
      customMetadata: {
        [BRIDGE_STORAGE_FORMAT_METADATA_KEY]:
          BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
      },
      size: MAX_RECOVERY_OBJECT_BYTES + 1,
    });
    await expect(repository.read(ID)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.tooLarge,
    });
  });

  it("conditionally purges sealed content to a plaintext-free retained marker", async () => {
    const bucket = new MemoryRecoveryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);
    const prepared = await repository.prepare(preparation());
    if (prepared.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected preparation confirmation");
    }
    const sealed = await repository.seal({
      id: ID,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(4),
      expectedRevision: prepared.confirmed.revision,
      tombstoneRevision: TOMBSTONE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    });
    if (sealed.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected seal confirmation");
    }

    const purged = await repository.purge({
      id: ID,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(5),
      expectedRevision: sealed.confirmed.revision,
    });

    expect(purged).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
        recoverUntil: RECOVER_UNTIL,
      },
    });
    expect(JSON.parse(required(bucket.snapshot()).body)).not.toHaveProperty(
      "content",
    );

    const stalePurge = await repository.purge({
      id: ID,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(6),
      expectedRevision: sealed.confirmed.revision,
    });
    expect(stalePurge).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    expect(bucket.deleteCalls).toBe(0);
  });

  it("returns successful PUT metadata directly for later transition evidence", async () => {
    const bucket = new MemoryRecoveryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);

    const result = await repository.prepareStored(preparation());

    if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected stored preparation confirmation");
    }
    expect(result.confirmed.storageEtag).toBe("recovery-etag-1");
    expect(result.confirmed.uploaded).toEqual(
      new Date("2027-01-01T00:00:01.000Z"),
    );
  });

  it("does not confirm a dispatched write with invalid returned metadata", async () => {
    const bucket = new MemoryRecoveryBucket();
    bucket.returnInvalidMetadata = true;
    const repository = new R2RecoverySnapshotRepository(bucket);

    await expect(repository.prepare(preparation())).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.unknown,
    });
    expect(bucket.snapshot()).toBeDefined();
  });

  it("classifies exceptions after conditional dispatch as unknown without cleanup", async () => {
    const bucket = new MemoryRecoveryBucket();
    bucket.throwAfterSuccessfulPut = true;
    const repository = new R2RecoverySnapshotRepository(bucket);

    await expect(repository.prepare(preparation())).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.unknown,
    });
    expect(bucket.snapshot()).toBeDefined();
    expect(bucket.deleteCalls).toBe(0);
  });
});
