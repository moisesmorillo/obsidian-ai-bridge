import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  type ConditionalCreateRequest,
  type ConditionalUpdateRequest,
  CURRENT_NOTE_STATE_KIND,
  createApplicationRevision,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  MAX_NOTE_SIZE_BYTES,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  normalizeNotePath,
} from "@obsidian-ai-bridge/core";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
  R2ConditionalPutOptions,
  R2ConditionalStoredObject,
} from "@worker/infrastructure/r2.types";
import { R2ConditionalCurrentNoteRepository } from "@worker/infrastructure/r2-conditional-current-note.repository";
import {
  BRIDGE_STORAGE_FORMAT_METADATA_KEY,
  BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
  MAX_LIVE_CURRENT_OBJECT_BYTES,
} from "@worker/infrastructure/storage-object.constants";
import { STORED_OBJECT_DATA_ERROR_KIND } from "@worker/infrastructure/storage-object.errors";
import { describe, expect, it } from "vitest";

const ASSOCIATION_ID = required(
  createMirrorAssociationId("11111111-1111-4111-8111-111111111111"),
);
const WRITER_ID = required(
  createMirrorWriterId("22222222-2222-4222-8222-222222222222"),
);
const PATH = required(normalizeNotePath("Current/Note.md"));

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

function createRequest(
  sequence: number,
  content: string,
): ConditionalCreateRequest {
  return {
    action: MUTATION_ACTION.create,
    associationId: ASSOCIATION_ID,
    writerId: WRITER_ID,
    operationId: operationId(sequence),
    path: PATH,
    precondition: {
      kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
    },
    content,
  };
}

function updateRequest(
  sequence: number,
  content: string,
  revision: string,
): ConditionalUpdateRequest {
  const applicationRevision = required(createApplicationRevision(revision));
  return {
    action: MUTATION_ACTION.update,
    associationId: ASSOCIATION_ID,
    writerId: WRITER_ID,
    operationId: operationId(sequence),
    path: PATH,
    precondition: {
      kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
      revision: applicationRevision,
    },
    content,
  };
}

interface MemoryGeneration {
  readonly body: string;
  readonly metadata: R2ConditionalObjectMetadata;
}

class MemoryConditionalBucket implements R2ConditionalBucketPort {
  readonly putOptions: R2ConditionalPutOptions[] = [];
  deleteCalls = 0;
  afterSuccessfulPut: (() => void) | undefined;
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
      etag: `storage-etag-${this.generation}`,
      uploaded: new Date(`2027-01-01T00:00:0${this.generation}.000Z`),
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body, metadata });
    this.afterSuccessfulPut?.();
    if (this.throwAfterSuccessfulPut) {
      throw new Error("binding failed after dispatch");
    }
    return this.returnInvalidMetadata ? { ...metadata, etag: "" } : metadata;
  }

  seed(
    body: string,
    customMetadata: Readonly<Record<string, string>> = {},
  ): void {
    this.generation += 1;
    this.objects.set(`vault/${PATH}`, {
      body,
      metadata: {
        key: `vault/${PATH}`,
        size: new TextEncoder().encode(body).byteLength,
        etag: `storage-etag-${this.generation}`,
        uploaded: new Date(`2027-01-01T00:00:0${this.generation}.000Z`),
        customMetadata,
      },
    });
  }

  snapshot(): MemoryGeneration | undefined {
    return this.objects.get(`vault/${PATH}`);
  }

  replaceMetadata(changes: Partial<R2ConditionalObjectMetadata>): void {
    const stored = this.snapshot();
    if (stored === undefined) throw new Error("Expected current fixture");
    this.objects.set(`vault/${PATH}`, {
      body: stored.body,
      metadata: { ...stored.metadata, ...changes },
    });
  }

  delete(): void {
    this.deleteCalls += 1;
  }
}

describe("R2ConditionalCurrentNoteRepository", () => {
  it("classifies exact keys as absent or untagged legacy Markdown", async () => {
    const bucket = new MemoryConditionalBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);

    await expect(repository.readCurrent(PATH)).resolves.toEqual({
      kind: CURRENT_NOTE_STATE_KIND.absent,
      path: PATH,
    });

    bucket.seed(JSON.stringify({ format: 2, kind: "live" }));
    await expect(repository.readCurrent(PATH)).resolves.toEqual({
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      path: PATH,
    });
  });

  it("surfaces malformed and unsupported tagged objects as storage data errors", async () => {
    const bucket = new MemoryConditionalBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);

    bucket.seed("{}", {
      [BRIDGE_STORAGE_FORMAT_METADATA_KEY]:
        BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
    });
    await expect(repository.readCurrent(PATH)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
    await expect(
      repository.mutate(
        updateRequest(16, "candidate", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      ),
    ).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
    expect(bucket.putOptions).toHaveLength(0);

    bucket.seed("# unknown", {
      [BRIDGE_STORAGE_FORMAT_METADATA_KEY]: "99",
    });
    await expect(repository.readCurrent(PATH)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.unsupportedFormat,
    });
  });

  it("rejects invalid or oversized observed R2 generation metadata", async () => {
    const bucket = new MemoryConditionalBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    bucket.seed("# legacy");

    bucket.replaceMetadata({ etag: "" });
    await expect(repository.readCurrent(PATH)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
    bucket.replaceMetadata({
      etag: "valid-again",
      size: MAX_LIVE_CURRENT_OBJECT_BYTES + 1,
    });
    await expect(repository.readCurrent(PATH)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.tooLarge,
    });
  });

  it("reports a failed prerequisite read as not dispatched", async () => {
    const bucket = new MemoryConditionalBucket();
    bucket.throwOnGet = true;
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    const revision = required(
      createApplicationRevision("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    );

    await expect(
      repository.mutate(updateRequest(15, "candidate", revision)),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    expect(bucket.putOptions).toHaveLength(0);
  });

  it("does not dispatch oversized content to R2", async () => {
    const bucket = new MemoryConditionalBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);

    await expect(
      repository.mutate(createRequest(14, "x".repeat(MAX_NOTE_SIZE_BYTES + 1))),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    expect(bucket.putOptions).toHaveLength(0);
  });

  it("allows exactly one of two competing absent creates using If-None-Match wildcard", async () => {
    const bucket = new MemoryConditionalBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);

    const results = await Promise.all([
      repository.mutate(createRequest(1, "first")),
      repository.mutate(createRequest(2, "second")),
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
    await expect(repository.readCurrent(PATH)).resolves.toMatchObject({
      kind: CURRENT_NOTE_STATE_KIND.live,
    });
    expect(bucket.deleteCalls).toBe(0);
  });

  it("uses the observed private R2 ETag for matching CAS and changes same-text generations", async () => {
    const bucket = new MemoryConditionalBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    const created = await repository.mutate(createRequest(3, "same text"));
    if (created.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected create confirmation");
    }
    const firstStorage = bucket.snapshot();

    const updated = await repository.mutate(
      updateRequest(4, "same text", created.confirmed.revision),
    );
    if (updated.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected update confirmation");
    }
    const secondStorage = bucket.snapshot();

    expect(updated.confirmed.revision).not.toBe(created.confirmed.revision);
    expect(secondStorage?.metadata.etag).not.toBe(firstStorage?.metadata.etag);
    expect(secondStorage?.body).not.toBe(firstStorage?.body);
    expect(bucket.putOptions.at(-1)?.onlyIf).toEqual({
      etagMatches: firstStorage?.metadata.etag,
    });
  });

  it("conditionally tombstones a live generation and recreates only from that tombstone", async () => {
    const bucket = new MemoryConditionalBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    const created = await repository.mutate(createRequest(10, "recoverable"));
    if (created.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected create confirmation");
    }

    const tombstoned = await repository.mutateStored({
      action: MUTATION_ACTION.tombstone,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(11),
      path: PATH,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: created.confirmed.revision,
      },
    });
    if (tombstoned.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected tombstone confirmation");
    }
    const tombstoneAcknowledgement = tombstoned.confirmed.acknowledgement;
    expect(tombstoned.confirmed.uploaded).toEqual(
      bucket.snapshot()?.metadata.uploaded,
    );
    await expect(repository.readCurrent(PATH)).resolves.toMatchObject({
      kind: CURRENT_NOTE_STATE_KIND.tombstone,
      revision: tombstoneAcknowledgement.revision,
      deletedRevision: created.confirmed.revision,
      recoveryId: operationId(11),
    });

    const recreated = await repository.mutate({
      action: MUTATION_ACTION.recreate,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(12),
      path: PATH,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: tombstoneAcknowledgement.revision,
      },
      content: "recoverable",
    });

    expect(recreated.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    await expect(repository.readCurrent(PATH)).resolves.toMatchObject({
      kind: CURRENT_NOTE_STATE_KIND.live,
    });
    expect(bucket.deleteCalls).toBe(0);
  });

  it("refuses stale CAS without changing winning bytes or metadata", async () => {
    const bucket = new MemoryConditionalBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    const created = await repository.mutate(createRequest(5, "base"));
    if (created.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected create confirmation");
    }

    const firstUpdate = await repository.mutate(
      updateRequest(6, "winner", created.confirmed.revision),
    );
    expect(firstUpdate.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    const winner = bucket.snapshot();

    const stale = await repository.mutate(
      updateRequest(7, "stale", created.confirmed.revision),
    );

    expect(stale).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    expect(bucket.snapshot()).toEqual(winner);
    expect(bucket.putOptions).toHaveLength(2);
  });

  it("returns ACK storage metadata from the actual successful PUT without a later HEAD", async () => {
    const bucket = new MemoryConditionalBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    bucket.afterSuccessfulPut = () => {
      bucket.afterSuccessfulPut = undefined;
      bucket.seed("later legacy overwrite");
    };

    const result = await repository.mutateStored(createRequest(8, "stored"));

    if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected stored confirmation");
    }
    expect(result.confirmed.uploaded).toEqual(
      new Date("2027-01-01T00:00:01.000Z"),
    );
    expect(result.confirmed.storageEtag).toBe("storage-etag-1");
    expect(bucket.snapshot()?.metadata.uploaded).toEqual(
      new Date("2027-01-01T00:00:02.000Z"),
    );
  });

  it("classifies a binding exception after write dispatch conservatively as unknown", async () => {
    const bucket = new MemoryConditionalBucket();
    bucket.throwAfterSuccessfulPut = true;
    const repository = new R2ConditionalCurrentNoteRepository(bucket);

    await expect(
      repository.mutate(createRequest(9, "possibly stored")),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.unknown,
    });
    expect(bucket.snapshot()).toBeDefined();
    expect(bucket.deleteCalls).toBe(0);
  });

  it("does not confirm a dispatched write when returned generation metadata is invalid", async () => {
    const bucket = new MemoryConditionalBucket();
    bucket.returnInvalidMetadata = true;
    const repository = new R2ConditionalCurrentNoteRepository(bucket);

    await expect(
      repository.mutate(createRequest(13, "stored")),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.unknown,
    });
    expect(bucket.snapshot()).toBeDefined();
  });
});
