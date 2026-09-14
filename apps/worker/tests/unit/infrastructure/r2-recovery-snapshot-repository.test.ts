import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  MUTATION_EFFECT_CERTAINTY,
  normalizeNotePath,
  type PreparedRecoveryGenerationCandidate,
  RECOVERY_SNAPSHOT_STATE_KIND,
} from "@obsidian-ai-bridge/core";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
  R2ConditionalPutOptions,
  R2ConditionalStoredObject,
  R2ListResult,
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
const ASSOCIATION_ID = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const SOURCE_REVISION = required(
  createApplicationRevision("33333333-3333-4333-8333-333333333333"),
);
const PREPARED_REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const SEALED_REVISION = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const PURGED_REVISION = required(
  createApplicationRevision("66666666-6666-4666-8666-666666666666"),
);
const TOMBSTONE_REVISION = required(
  createApplicationRevision("77777777-7777-4777-8777-777777777777"),
);
const PATH = required(normalizeNotePath("Recovery/Note.md"));
const CONTENT = "private recovery";
const DIGEST = required(
  createContentSha256(
    "5d3e1fa0038a008f901af80dd18d8b9c16af8bdec368f099e0e13f65239b0a61",
  ),
);
const RECOVER_UNTIL = "2027-02-01T00:00:00.000Z";

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture");
  return value;
}

function prepared(): PreparedRecoveryGenerationCandidate {
  return {
    kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
    id: ID,
    associationId: ASSOCIATION_ID,
    path: PATH,
    revision: PREPARED_REVISION,
    sourceRevision: SOURCE_REVISION,
    contentSha256: DIGEST,
    operationId: ID,
    content: CONTENT,
  };
}

interface MemoryGeneration {
  readonly body: string;
  readonly metadata: R2ConditionalObjectMetadata;
}

class MemoryBucket implements R2ConditionalBucketPort {
  readonly options: R2ConditionalPutOptions[] = [];
  throwOnPut = false;
  invalidPutMetadata = false;
  private sequence = 0;
  private readonly objects = new Map<string, MemoryGeneration>();

  async list(options: {
    readonly prefix: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<R2ListResult> {
    const objects = [...this.objects.values()]
      .map((entry) => entry.metadata)
      .filter((entry) => entry.key.startsWith(options.prefix));
    return { truncated: false, objects };
  }

  async get(key: string): Promise<R2ConditionalStoredObject | null> {
    const stored = this.objects.get(key);
    if (stored === undefined) return null;
    const bytes = new TextEncoder().encode(stored.body);
    return {
      ...stored.metadata,
      arrayBuffer: async () => bytes.buffer.slice(0),
    };
  }

  async put(
    key: string,
    body: string,
    options: R2ConditionalPutOptions,
  ): Promise<R2ConditionalObjectMetadata | null> {
    this.options.push(options);
    if (this.throwOnPut) throw new Error("unknown effect");
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
    this.sequence += 1;
    const metadata = {
      key,
      size: new TextEncoder().encode(body).byteLength,
      etag: `etag-${this.sequence}`,
      uploaded: new Date(`2027-01-01T00:00:0${this.sequence}.000Z`),
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body, metadata });
    return this.invalidPutMetadata
      ? { ...metadata, uploaded: new Date("invalid") }
      : metadata;
  }

  snapshot(): MemoryGeneration | undefined {
    return this.objects.get(`recovery/${ID}`);
  }

  replace(
    body: string,
    metadata: Partial<R2ConditionalObjectMetadata> = {},
  ): void {
    const stored = required(this.snapshot());
    this.objects.set(`recovery/${ID}`, {
      body,
      metadata: {
        ...stored.metadata,
        size: new TextEncoder().encode(body).byteLength,
        ...metadata,
      },
    });
  }
}

describe("R2RecoverySnapshotRepository", () => {
  it("creates prepared content only once and returns an exact CAS observation", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);

    const created = await repository.create(prepared());
    const duplicate = await repository.create(prepared());

    expect(created).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
        state: { revision: PREPARED_REVISION },
        content: CONTENT,
      },
    });
    expect(duplicate).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    expect(bucket.options[0]?.onlyIf).toBeInstanceOf(Headers);
  });

  it("seals and purges only through the exact observed recovery generation", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);
    const created = await repository.create(prepared());
    if (created.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected prepared generation");
    }

    const sealed = await created.confirmed.replacement.seal({
      ...prepared(),
      kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
      revision: SEALED_REVISION,
      operationId: required(
        createMirrorOperationId("88888888-8888-4888-8888-888888888888"),
      ),
      previousRevision: PREPARED_REVISION,
      tombstoneRevision: TOMBSTONE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    });
    if (sealed.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected sealed generation");
    }
    expect(sealed.confirmed).toMatchObject({
      operationId: "88888888-8888-4888-8888-888888888888",
      previousRevision: PREPARED_REVISION,
    });
    const staleSeal = await created.confirmed.replacement.seal({
      ...prepared(),
      kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
      revision: SEALED_REVISION,
      operationId: ID,
      previousRevision: PREPARED_REVISION,
      tombstoneRevision: TOMBSTONE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    });
    const purged = await sealed.confirmed.replacement.purge({
      kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
      id: ID,
      associationId: ASSOCIATION_ID,
      path: PATH,
      revision: PURGED_REVISION,
      sourceRevision: SOURCE_REVISION,
      contentSha256: DIGEST,
      operationId: ID,
      previousRevision: SEALED_REVISION,
      tombstoneRevision: TOMBSTONE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    });

    expect(staleSeal).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    expect(purged).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
        operationId: ID,
        previousRevision: SEALED_REVISION,
      },
    });
    expect(JSON.parse(required(bucket.snapshot()).body)).not.toHaveProperty(
      "content",
    );
  });

  it("reads and lists metadata without leaking prepared plaintext", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);
    await repository.create(prepared());

    const observed = await repository.read(ID);
    expect(observed).toMatchObject({
      kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
      content: CONTENT,
    });
    await expect(repository.list()).resolves.toEqual({
      states: [observed?.state],
      nextCursor: null,
    });
  });

  it("fails closed for malformed identity, metadata, format, size, and envelope", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2RecoverySnapshotRepository(bucket);
    await repository.create(prepared());

    bucket.replace("{}", { customMetadata: {} });
    await expect(repository.read(ID)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
    bucket.replace("{}", {
      customMetadata: { [BRIDGE_STORAGE_FORMAT_METADATA_KEY]: "99" },
    });
    await expect(repository.read(ID)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.unsupportedFormat,
    });
    bucket.replace("{}", {
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

  it("preserves unknown conditional effects and rejects wrong-key candidates", async () => {
    const bucket = new MemoryBucket();
    bucket.throwOnPut = true;
    const repository = new R2RecoverySnapshotRepository(bucket);
    await expect(repository.create(prepared())).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.unknown,
    });
    bucket.throwOnPut = false;
    bucket.invalidPutMetadata = true;
    await expect(repository.create(prepared())).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.unknown,
    });

    const otherId = required(
      createMirrorOperationId("99999999-9999-4999-8999-999999999999"),
    );
    await expect(
      new R2RecoverySnapshotRepository(new MemoryBucket()).create({
        ...prepared(),
        id: otherId,
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
  });
});
