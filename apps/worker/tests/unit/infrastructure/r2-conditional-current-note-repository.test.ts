import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CURRENT_NOTE_STATE_KIND,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  type LiveCurrentGenerationCandidate,
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
  R2ListResult,
} from "@worker/infrastructure/r2.types";
import { R2ConditionalCurrentNoteRepository } from "@worker/infrastructure/r2-conditional-current-note.repository";
import {
  BRIDGE_STORAGE_FORMAT_METADATA_KEY,
  BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
  MAX_LIVE_CURRENT_OBJECT_BYTES,
} from "@worker/infrastructure/storage-object.constants";
import { STORED_OBJECT_DATA_ERROR_KIND } from "@worker/infrastructure/storage-object.errors";
import { sha256Content } from "@worker/storage/storage-crypto";
import { describe, expect, it } from "vitest";

const ASSOCIATION_ID = required(
  createMirrorAssociationId("11111111-1111-4111-8111-111111111111"),
);
const OPERATION_ID = required(
  createMirrorOperationId("22222222-2222-4222-8222-222222222222"),
);
const PATH = required(normalizeNotePath("Current/Note.md"));
const REVISION_A = required(
  createApplicationRevision("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
);
const REVISION_B = required(
  createApplicationRevision("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
);

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture");
  return value;
}

async function liveCandidate(
  content: string,
  revision = REVISION_A,
): Promise<LiveCurrentGenerationCandidate> {
  const contentSha256 = await sha256Content(content);
  return {
    kind: CURRENT_NOTE_STATE_KIND.live,
    revision,
    receipt: {
      action: MUTATION_ACTION.create,
      associationId: ASSOCIATION_ID,
      operationId: OPERATION_ID,
      precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
      contentSha256,
    },
    contentSha256,
    content,
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
    if (this.throwOnPut) throw new Error("unknown write effect");
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
    return this.invalidPutMetadata ? { ...metadata, etag: "" } : metadata;
  }

  seed(
    body: string,
    customMetadata: Readonly<Record<string, string>> = {},
  ): void {
    this.sequence += 1;
    this.objects.set(`vault/${PATH}`, {
      body,
      metadata: {
        key: `vault/${PATH}`,
        size: new TextEncoder().encode(body).byteLength,
        etag: `etag-${this.sequence}`,
        uploaded: new Date(`2027-01-01T00:00:0${this.sequence}.000Z`),
        customMetadata,
      },
    });
  }

  replaceMetadata(changes: Partial<R2ConditionalObjectMetadata>): void {
    const stored = required(this.objects.get(`vault/${PATH}`));
    this.objects.set(`vault/${PATH}`, {
      body: stored.body,
      metadata: { ...stored.metadata, ...changes },
    });
  }
}

describe("R2ConditionalCurrentNoteRepository", () => {
  it("classifies absence and untagged JSON-looking text as legacy", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    await expect(repository.read(PATH)).resolves.toEqual({
      kind: CURRENT_NOTE_STATE_KIND.absent,
      state: { kind: CURRENT_NOTE_STATE_KIND.absent, path: PATH },
    });

    const legacy = JSON.stringify({ format: 2, kind: "live" });
    bucket.seed(legacy);
    await expect(repository.read(PATH)).resolves.toEqual({
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      state: { kind: CURRENT_NOTE_STATE_KIND.legacy, path: PATH },
      content: legacy,
    });
  });

  it("creates only on absence and returns metadata from the exact successful PUT", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    const candidate = await liveCandidate("exact");

    const created = await repository.create(PATH, candidate);
    const refused = await repository.create(PATH, candidate);

    expect(created).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: {
        state: { revision: REVISION_A, receipt: candidate.receipt },
        uploaded: new Date("2027-01-01T00:00:01.000Z"),
      },
    });
    expect(refused).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    expect(bucket.options[0]?.onlyIf).toBeInstanceOf(Headers);
  });

  it("binds replacement to the observed R2 generation and safely refuses stale reuse", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    await repository.create(PATH, await liveCandidate("A"));
    const observed = await repository.read(PATH);
    if (observed.kind !== CURRENT_NOTE_STATE_KIND.live) {
      throw new Error("Expected live observation");
    }
    const digest = await sha256Content("B");
    const updated = await observed.replacement.writeLive({
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision: REVISION_B,
      receipt: {
        action: MUTATION_ACTION.update,
        associationId: ASSOCIATION_ID,
        operationId: OPERATION_ID,
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: REVISION_A,
        },
        contentSha256: digest,
      },
      contentSha256: digest,
      content: "B",
    });
    const stale = await observed.replacement.writeLive(
      await liveCandidate("stale"),
    );

    expect(updated.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    expect(stale).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    expect(bucket.options.at(-1)?.onlyIf).toEqual({ etagMatches: "etag-1" });
    const winner = await repository.read(PATH);
    expect(winner).toMatchObject({
      kind: CURRENT_NOTE_STATE_KIND.live,
      content: "B",
    });
  });

  it("stores a content-free tombstone through the exact observed CAS", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    await repository.create(PATH, await liveCandidate("source"));
    const observed = await repository.read(PATH);
    if (observed.kind !== CURRENT_NOTE_STATE_KIND.live) {
      throw new Error("Expected live observation");
    }

    const result = await observed.replacement.writeTombstone({
      kind: CURRENT_NOTE_STATE_KIND.tombstone,
      revision: REVISION_B,
      receipt: {
        action: MUTATION_ACTION.tombstone,
        associationId: ASSOCIATION_ID,
        operationId: OPERATION_ID,
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: REVISION_A,
        },
      },
      deletedRevision: REVISION_A,
      recoveryId: OPERATION_ID,
    });

    expect(result).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: { state: { kind: CURRENT_NOTE_STATE_KIND.tombstone } },
    });
    const stored = await repository.read(PATH);
    expect(stored.kind).toBe(CURRENT_NOTE_STATE_KIND.tombstone);
    expect(stored).not.toHaveProperty("content");
  });

  it("surfaces malformed, unsupported, oversized, and invalid generation metadata", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    bucket.seed("{}", {
      [BRIDGE_STORAGE_FORMAT_METADATA_KEY]:
        BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
    });
    await expect(repository.read(PATH)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
    bucket.seed("legacy", { [BRIDGE_STORAGE_FORMAT_METADATA_KEY]: "99" });
    await expect(repository.read(PATH)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.unsupportedFormat,
    });
    bucket.replaceMetadata({
      customMetadata: {},
      etag: "",
      size: MAX_LIVE_CURRENT_OBJECT_BYTES + 1,
    });
    await expect(repository.read(PATH)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
  });

  it("preserves unknown PUT effects and rejects invalid candidates before dispatch", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    bucket.throwOnPut = true;
    await expect(
      repository.create(PATH, await liveCandidate("unknown")),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.unknown,
    });
    bucket.throwOnPut = false;
    bucket.invalidPutMetadata = true;
    await expect(
      repository.create(PATH, await liveCandidate("stored")),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.unknown,
    });

    const invalidDigest = required(createContentSha256("00".repeat(32)));
    await expect(
      new R2ConditionalCurrentNoteRepository(new MemoryBucket()).create(PATH, {
        ...(await liveCandidate("x".repeat(MAX_NOTE_SIZE_BYTES + 1))),
        contentSha256: invalidDigest,
        receipt: {
          ...(await liveCandidate("x")).receipt,
          contentSha256: invalidDigest,
        },
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
  });

  it("lists recognized current metadata in a bounded storage page", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    await repository.create(PATH, await liveCandidate("listed"));

    await expect(repository.list()).resolves.toMatchObject({
      states: [{ kind: CURRENT_NOTE_STATE_KIND.live, path: PATH }],
      nextCursor: null,
    });
  });

  it("filters only oversized untagged legacy objects during listing", async () => {
    const bucket = new MemoryBucket();
    const repository = new R2ConditionalCurrentNoteRepository(bucket);
    bucket.seed("x".repeat(MAX_NOTE_SIZE_BYTES + 1));

    await expect(repository.list()).resolves.toEqual({
      states: [],
      nextCursor: null,
    });
    await expect(repository.read(PATH)).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.tooLarge,
    });

    bucket.seed("x".repeat(MAX_NOTE_SIZE_BYTES + 1), {
      [BRIDGE_STORAGE_FORMAT_METADATA_KEY]:
        BRIDGE_STORAGE_FORMAT_METADATA_VALUE,
    });
    await expect(repository.list()).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
  });
});
