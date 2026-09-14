import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  type ConditionalCreateRequest,
  type ConditionalTombstoneRequest,
  type ConditionalUpdateRequest,
  CURRENT_NOTE_STATE_KIND,
  CurrentGenerationService,
  createApplicationRevision,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  MAX_NOTE_SIZE_BYTES,
  type MirrorGenerationCryptography,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  normalizeNotePath,
  RECOVERY_CONTENT_RESULT_KIND,
  RECOVERY_RETENTION_MILLISECONDS,
  RECOVERY_SNAPSHOT_STATE_KIND,
  type RecoveryPurgeRequest,
  RecoveryService,
  type RecoverySnapshotState,
  TOMBSTONE_WORKFLOW_STAGE_KIND,
} from "@obsidian-ai-bridge/core";
import type {
  R2ConditionalBucketPort,
  R2ConditionalObjectMetadata,
  R2ConditionalPutOptions,
  R2ConditionalStoredObject,
  R2ListResult,
} from "@worker/infrastructure/r2.types";
import { R2ConditionalCurrentNoteRepository } from "@worker/infrastructure/r2-conditional-current-note.repository";
import { R2RecoverySnapshotRepository } from "@worker/infrastructure/r2-recovery-snapshot.repository";
import {
  generateApplicationRevision,
  sha256Content,
} from "@worker/storage/storage-crypto";
import { describe, expect, it, vi } from "vitest";

const ASSOCIATION_ID = required(
  createMirrorAssociationId("11111111-1111-4111-8111-111111111111"),
);
const WRITER_ID = required(
  createMirrorWriterId("22222222-2222-4222-8222-222222222222"),
);
const PATH = required(normalizeNotePath("Service/Note.md"));

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
    precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
    content,
  };
}

function updateRequest(
  sequence: number,
  content: string,
  revision: string,
): ConditionalUpdateRequest {
  return {
    action: MUTATION_ACTION.update,
    associationId: ASSOCIATION_ID,
    writerId: WRITER_ID,
    operationId: operationId(sequence),
    path: PATH,
    precondition: {
      kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
      revision: required(createApplicationRevision(revision)),
    },
    content,
  };
}

interface MemoryGeneration {
  readonly body: string;
  readonly metadata: R2ConditionalObjectMetadata;
}

type BeforePut = (
  key: string,
  body: string,
  options: R2ConditionalPutOptions,
) => Promise<void>;

type AfterPut = (
  key: string,
  body: string,
  metadata: R2ConditionalObjectMetadata,
) => Promise<void>;

class MemoryMirrorBucket implements R2ConditionalBucketPort {
  beforePut: BeforePut | undefined;
  afterPut: AfterPut | undefined;
  throwOnGet = false;
  refuseNextPut = false;
  throwBeforeNextPut = false;
  throwAfterNextPut = false;
  throwAfterPutForKey: string | undefined;
  returnInvalidMetadataNext = false;
  readonly putAttempts: string[] = [];
  private generation = 0;
  private readonly objects = new Map<string, MemoryGeneration>();

  async get(key: string): Promise<R2ConditionalStoredObject | null> {
    if (this.throwOnGet) throw new Error("storage read unavailable");
    const generation = this.objects.get(key);
    if (generation === undefined) return null;
    const bytes = new TextEncoder().encode(generation.body);
    return {
      ...generation.metadata,
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
    const nextOffset = offset + selected.length;
    if (nextOffset < keys.length) {
      return { truncated: true, cursor: String(nextOffset), objects };
    }
    return { truncated: false, objects };
  }

  async put(
    key: string,
    body: string,
    options: R2ConditionalPutOptions,
  ): Promise<R2ConditionalObjectMetadata | null> {
    this.putAttempts.push(key);
    if (this.throwBeforeNextPut) {
      this.throwBeforeNextPut = false;
      throw new Error("storage unavailable");
    }
    await this.beforePut?.(key, body, options);
    if (this.refuseNextPut) {
      this.refuseNextPut = false;
      return null;
    }
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
      uploaded: new Date(
        `2027-01-01T00:00:${this.generation.toString().padStart(2, "0")}.000Z`,
      ),
      customMetadata: options.customMetadata,
    };
    this.objects.set(key, { body, metadata });
    await this.afterPut?.(key, body, metadata);
    if (this.throwAfterNextPut) {
      this.throwAfterNextPut = false;
      throw new Error("storage response lost");
    }
    if (this.throwAfterPutForKey === key) {
      this.throwAfterPutForKey = undefined;
      throw new Error("storage response lost");
    }
    if (this.returnInvalidMetadataNext) {
      this.returnInvalidMetadataNext = false;
      return { ...metadata, etag: "" };
    }
    return metadata;
  }

  snapshot(key = `vault/${PATH}`): MemoryGeneration | undefined {
    return this.objects.get(key);
  }

  seed(
    key: string,
    body: string,
    customMetadata: Record<string, string> = {},
  ): void {
    this.generation += 1;
    this.objects.set(key, {
      body,
      metadata: {
        key,
        size: new TextEncoder().encode(body).byteLength,
        etag: `storage-etag-${this.generation}`,
        uploaded: new Date(
          `2027-01-01T00:00:${this.generation.toString().padStart(2, "0")}.000Z`,
        ),
        customMetadata,
      },
    });
  }
}

function serviceSet(
  bucket: MemoryMirrorBucket,
  now = new Date("2027-01-02T00:00:00.000Z"),
  cryptography: MirrorGenerationCryptography = {
    digest: sha256Content,
    generateRevision: generateApplicationRevision,
  },
) {
  const currentRepository = new R2ConditionalCurrentNoteRepository(bucket);
  const recoveryRepository = new R2RecoverySnapshotRepository(bucket);
  const recovery = new RecoveryService(
    recoveryRepository,
    currentRepository,
    cryptography,
    { now: () => now },
  );
  const current = new CurrentGenerationService(
    currentRepository,
    recovery,
    cryptography,
  );
  return { current, recovery, currentRepository, recoveryRepository };
}

function services(bucket: MemoryMirrorBucket) {
  return serviceSet(bucket).current;
}

function tombstoneRequest(
  sequence: number,
  revision: string,
): ConditionalTombstoneRequest {
  return {
    action: MUTATION_ACTION.tombstone,
    associationId: ASSOCIATION_ID,
    writerId: WRITER_ID,
    operationId: operationId(sequence),
    path: PATH,
    precondition: {
      kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
      revision: required(createApplicationRevision(revision)),
    },
  };
}

function sealedState(
  state: RecoverySnapshotState,
): Extract<RecoverySnapshotState, { readonly kind: "sealed" }> {
  if (state.kind !== RECOVERY_SNAPSHOT_STATE_KIND.sealed) {
    throw new Error("Expected sealed recovery state");
  }
  return state;
}

function purgeRequest(
  sequence: number,
  id: RecoveryPurgeRequest["id"],
  expectedRevision: string,
): RecoveryPurgeRequest {
  return {
    id,
    associationId: ASSOCIATION_ID,
    writerId: WRITER_ID,
    operationId: operationId(sequence),
    expectedRevision: required(createApplicationRevision(expectedRevision)),
  };
}

async function confirmedCreate(
  service: CurrentGenerationService,
  sequence: number,
  content: string,
) {
  const result = await service.create(createRequest(sequence, content));
  if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
    throw new Error("Expected confirmed create");
  }
  return result.confirmed;
}

describe("CurrentGenerationService", () => {
  it("allows exactly one competing create on recognized absence", async () => {
    const bucket = new MemoryMirrorBucket();
    const service = services(bucket);

    const results = await Promise.all([
      service.create(createRequest(1, "first")),
      service.create(createRequest(2, "second")),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      MUTATION_EFFECT_CERTAINTY.confirmed,
      MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    ]);
    expect(
      bucket.putAttempts.filter((key) => key === `vault/${PATH}`),
    ).toHaveLength(2);
    const state = await service.inspect(PATH);
    expect(state.kind).toBe(CURRENT_NOTE_STATE_KIND.live);
    expect(await service.read(PATH)).toMatch(/^(first|second)$/);
  });

  it("refuses create for live, tombstone, legacy, and malformed storage", async () => {
    const liveBucket = new MemoryMirrorBucket();
    const liveService = services(liveBucket);
    await confirmedCreate(liveService, 3, "live");
    await expect(
      liveService.create(createRequest(4, "replace")),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });

    const legacyBucket = new MemoryMirrorBucket();
    legacyBucket.seed(`vault/${PATH}`, "legacy");
    await expect(
      services(legacyBucket).create(createRequest(5, "replace")),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });

    const tombstoneBucket = new MemoryMirrorBucket();
    const tombstoneService = services(tombstoneBucket);
    const tombstoneSource = await confirmedCreate(
      tombstoneService,
      6,
      "deleted",
    );
    const deleted = await tombstoneService.tombstone({
      action: MUTATION_ACTION.tombstone,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(7),
      path: PATH,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: tombstoneSource.revision,
      },
    });
    expect(deleted).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      stage: TOMBSTONE_WORKFLOW_STAGE_KIND.complete,
    });
    await expect(
      tombstoneService.create(createRequest(8, "replace")),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });

    const malformedBucket = new MemoryMirrorBucket();
    malformedBucket.seed(`vault/${PATH}`, "{}", { bridgeFormat: "2" });
    await expect(
      services(malformedBucket).create(createRequest(8, "replace")),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
  });

  it("lets one of two updates observed at A commit B and refuses the stale competitor", async () => {
    const bucket = new MemoryMirrorBucket();
    const service = services(bucket);
    const created = await confirmedCreate(service, 9, "A");
    let waiting = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    bucket.beforePut = async (_key, _body, options) => {
      if (options.onlyIf instanceof Headers) return;
      waiting += 1;
      if (waiting === 2) release?.();
      await barrier;
    };

    const results = await Promise.all([
      service.update(updateRequest(10, "B", created.revision)),
      service.update(updateRequest(11, "C", created.revision)),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      MUTATION_EFFECT_CERTAINTY.confirmed,
      MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    ]);
    expect(["B", "C"]).toContain(await service.read(PATH));
  });

  it("does not refresh and retry when a competitor mutates between read and put", async () => {
    const bucket = new MemoryMirrorBucket();
    const service = services(bucket);
    const created = await confirmedCreate(service, 12, "A");
    let intervened = false;
    bucket.beforePut = async (_key, _body, options) => {
      if (intervened || options.onlyIf instanceof Headers) return;
      intervened = true;
      bucket.beforePut = undefined;
      const winner = await service.update(
        updateRequest(13, "B", created.revision),
      );
      expect(winner.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    };

    const stale = await service.update(
      updateRequest(14, "stale", created.revision),
    );

    expect(stale).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    await expect(service.read(PATH)).resolves.toBe("B");
  });

  it("protects same-text ABA with application revisions rather than content equality", async () => {
    const bucket = new MemoryMirrorBucket();
    const service = services(bucket);
    const a = await confirmedCreate(service, 15, "X");
    const b = await service.update(updateRequest(16, "Y", a.revision));
    if (b.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected B");
    }
    const c = await service.update(
      updateRequest(17, "X", b.confirmed.revision),
    );
    if (c.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected C");
    }

    const stale = await service.update(updateRequest(18, "stale", a.revision));

    expect(c.confirmed.revision).not.toBe(a.revision);
    expect(stale).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    await expect(service.read(PATH)).resolves.toBe("X");
  });

  it("returns the exact successful B acknowledgement even when C wins before B returns", async () => {
    const bucket = new MemoryMirrorBucket();
    const service = services(bucket);
    const a = await confirmedCreate(service, 19, "A");
    let bRevision: string | undefined;
    let cRevision: string | undefined;
    bucket.afterPut = async (key, body) => {
      if (key !== `vault/${PATH}`) return;
      bucket.afterPut = undefined;
      const bEnvelope = JSON.parse(body);
      bRevision = bEnvelope.revision;
      const c = await service.update(
        updateRequest(21, "C", bEnvelope.revision),
      );
      if (c.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
        throw new Error("Expected C");
      }
      cRevision = c.confirmed.revision;
    };

    const b = await service.update(updateRequest(20, "B", a.revision));

    if (b.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected B");
    }
    expect(b.confirmed.receipt.operationId).toBe(operationId(20));
    expect(b.confirmed.revision).toBe(bRevision);
    expect(b.confirmed.revision).not.toBe(cRevision);
    await expect(service.read(PATH)).resolves.toBe("C");
  });

  it("returns metadata-only state while normal read/list show legacy and live but hide tombstones", async () => {
    const bucket = new MemoryMirrorBucket();
    const service = services(bucket);
    const live = await confirmedCreate(service, 22, "secret body");
    const legacyPath = required(normalizeNotePath("Service/Legacy.md"));
    bucket.seed(`vault/${legacyPath}`, "legacy body");

    const state = await service.inspect(PATH);
    expect(state).toMatchObject({
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision: live.revision,
      receipt: live.receipt,
    });
    expect(state).not.toHaveProperty("content");
    await expect(service.read(legacyPath)).resolves.toBe("legacy body");
    await expect(service.list()).resolves.toEqual({
      notes: [legacyPath, PATH].sort(),
      nextCursor: null,
    });
  });

  it("refuses invalid target states and classifies pre-dispatch failures", async () => {
    const oversizedBucket = new MemoryMirrorBucket();
    const oversized = services(oversizedBucket);
    await expect(
      oversized.create(createRequest(23, "x".repeat(MAX_NOTE_SIZE_BYTES + 1))),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    const live = await confirmedCreate(oversized, 24, "live");
    await expect(
      oversized.update(
        updateRequest(25, "x".repeat(MAX_NOTE_SIZE_BYTES + 1), live.revision),
      ),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });

    const absent = services(new MemoryMirrorBucket());
    await expect(
      absent.update(updateRequest(26, "candidate", live.revision)),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused });
    await expect(
      absent.tombstone(tombstoneRequest(26, live.revision)),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
      stage: TOMBSTONE_WORKFLOW_STAGE_KIND.current,
    });

    const readFailureBucket = new MemoryMirrorBucket();
    readFailureBucket.throwOnGet = true;
    const readFailure = services(readFailureBucket);
    await expect(
      readFailure.create(createRequest(27, "candidate")),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
    });
    await expect(
      readFailure.tombstone(tombstoneRequest(28, live.revision)),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
      stage: TOMBSTONE_WORKFLOW_STAGE_KIND.current,
    });

    const failingCryptography: MirrorGenerationCryptography = {
      digest: async () => {
        throw new Error("digest unavailable");
      },
      generateRevision: generateApplicationRevision,
    };
    const failing = serviceSet(
      new MemoryMirrorBucket(),
      new Date("2027-03-01T00:00:00.000Z"),
      failingCryptography,
    ).current;
    await expect(
      failing.create(createRequest(29, "candidate")),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
    });
  });
});

async function confirmedTombstone(
  current: CurrentGenerationService,
  createSequence: number,
  tombstoneSequence: number,
  content = "recoverable",
) {
  const live = await confirmedCreate(current, createSequence, content);
  const result = await current.tombstone(
    tombstoneRequest(tombstoneSequence, live.revision),
  );
  if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
    throw new Error("Expected confirmed tombstone");
  }
  expect(result.stage).toBe(TOMBSTONE_WORKFLOW_STAGE_KIND.complete);
  return result.confirmed;
}

describe("recoverable tombstone and recovery lifecycle", () => {
  it("keeps the live head when malformed recovery prevents duplicate proof", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current } = serviceSet(bucket);
    const live = await confirmedCreate(current, 30, "source");
    bucket.seed(`recovery/${operationId(31)}`, "{}", { bridgeFormat: "2" });

    const result = await current.tombstone(tombstoneRequest(31, live.revision));

    expect(result).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
      stage: TOMBSTONE_WORKFLOW_STAGE_KIND.recoveryPreparation,
    });
    await expect(current.read(PATH)).resolves.toBe("source");
    await expect(current.inspect(PATH)).resolves.toMatchObject({
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision: live.revision,
    });
  });

  it("keeps the head untouched when recovery preparation has unknown effect", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current, recovery } = serviceSet(bucket);
    const live = await confirmedCreate(current, 32, "source");
    bucket.throwAfterNextPut = true;

    const result = await current.tombstone(tombstoneRequest(33, live.revision));

    expect(result).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.unknown,
      stage: TOMBSTONE_WORKFLOW_STAGE_KIND.recoveryPreparation,
    });
    await expect(current.read(PATH)).resolves.toBe("source");
    await expect(recovery.inspect(operationId(33))).resolves.toMatchObject({
      kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
    });
  });

  it("preserves current-head certainty when a recovery dependency rejects", async () => {
    const preparationBucket = new MemoryMirrorBucket();
    const preparationServices = serviceSet(preparationBucket);
    const preparationLive = await confirmedCreate(
      preparationServices.current,
      84,
      "source",
    );
    vi.spyOn(
      preparationServices.recovery,
      "prepareForDeletion",
    ).mockRejectedValueOnce(new Error("unexpected preparation failure"));

    await expect(
      preparationServices.current.tombstone(
        tombstoneRequest(85, preparationLive.revision),
      ),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
      stage: TOMBSTONE_WORKFLOW_STAGE_KIND.recoveryPreparation,
    });
    await expect(preparationServices.current.read(PATH)).resolves.toBe(
      "source",
    );

    const sealingBucket = new MemoryMirrorBucket();
    const sealingServices = serviceSet(sealingBucket);
    const sealingLive = await confirmedCreate(
      sealingServices.current,
      86,
      "source",
    );
    vi.spyOn(
      sealingServices.recovery,
      "sealConfirmedTombstone",
    ).mockRejectedValueOnce(new Error("unexpected sealing failure"));

    const result = await sealingServices.current.tombstone(
      tombstoneRequest(87, sealingLive.revision),
    );
    if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Deletion must remain confirmed");
    }
    expect(result.confirmed.sealing).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
    });
    await expect(sealingServices.current.read(PATH)).resolves.toBeNull();
  });

  it("accepts only an exact duplicate prepared snapshot as deletion evidence", async () => {
    const bucket = new MemoryMirrorBucket();
    const { recovery } = serviceSet(bucket);
    const digest = await sha256Content("source");
    const sourceRevision = required(
      createApplicationRevision("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    );
    const preparation = {
      id: operationId(34),
      associationId: ASSOCIATION_ID,
      operationId: operationId(34),
      path: PATH,
      sourceRevision,
      contentSha256: digest,
      content: "source",
    } as const;

    const first = await recovery.prepareForDeletion(preparation);
    const duplicate = await recovery.prepareForDeletion(preparation);
    const otherContent = "different source";
    const conflicts = await Promise.all([
      recovery.prepareForDeletion({
        ...preparation,
        path: required(normalizeNotePath("Service/Other.md")),
      }),
      recovery.prepareForDeletion({
        ...preparation,
        associationId: required(
          createMirrorAssociationId("99999999-9999-4999-8999-999999999999"),
        ),
      }),
      recovery.prepareForDeletion({
        ...preparation,
        sourceRevision: required(
          createApplicationRevision("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
        ),
      }),
      recovery.prepareForDeletion({
        ...preparation,
        content: otherContent,
        contentSha256: await sha256Content(otherContent),
      }),
    ]);

    expect(first.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    expect(duplicate.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    for (const conflict of conflicts) {
      expect(conflict).toEqual({
        kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
      });
    }
  });

  it("leaves prepared recovery orphaned when a concurrent live update wins tombstone CAS", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current, recovery } = serviceSet(bucket);
    const live = await confirmedCreate(current, 35, "A");
    let intervened = false;
    bucket.beforePut = async (key, body, options) => {
      if (
        intervened ||
        key !== `vault/${PATH}` ||
        options.onlyIf instanceof Headers ||
        JSON.parse(body).kind !== CURRENT_NOTE_STATE_KIND.tombstone
      ) {
        return;
      }
      intervened = true;
      bucket.beforePut = undefined;
      const winner = await current.update(
        updateRequest(36, "B", live.revision),
      );
      expect(winner.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    };

    const result = await current.tombstone(tombstoneRequest(37, live.revision));

    expect(result).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
      stage: TOMBSTONE_WORKFLOW_STAGE_KIND.tombstone,
    });
    await expect(current.read(PATH)).resolves.toBe("B");
    await expect(recovery.inspect(operationId(37))).resolves.toMatchObject({
      kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
    });
  });

  it("does not claim deletion state or seal when tombstone CAS outcome is unknown", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current, recovery } = serviceSet(bucket);
    const live = await confirmedCreate(current, 38, "source");
    bucket.afterPut = async (key, body) => {
      if (
        key === `vault/${PATH}` &&
        JSON.parse(body).kind === CURRENT_NOTE_STATE_KIND.tombstone
      ) {
        bucket.afterPut = undefined;
        bucket.throwAfterNextPut = true;
      }
    };

    const result = await current.tombstone(tombstoneRequest(39, live.revision));

    expect(result).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.unknown,
      stage: TOMBSTONE_WORKFLOW_STAGE_KIND.tombstone,
    });
    await expect(current.inspect(PATH)).resolves.toMatchObject({
      kind: CURRENT_NOTE_STATE_KIND.tombstone,
      deletedRevision: live.revision,
      receipt: {
        action: MUTATION_ACTION.tombstone,
        associationId: ASSOCIATION_ID,
        operationId: operationId(39),
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: live.revision,
        },
      },
    });
    await expect(recovery.inspect(operationId(39))).resolves.toMatchObject({
      kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
    });
  });

  it.each([
    ["definitely-refused", "refuse"],
    ["unknown", "unknown"],
  ] as const)(
    "keeps a confirmed tombstone when sealing is %s",
    async (expectedKind, mode) => {
      const bucket = new MemoryMirrorBucket();
      const { current, recovery } = serviceSet(bucket);
      const live = await confirmedCreate(
        current,
        mode === "refuse" ? 40 : 42,
        "source",
      );
      bucket.afterPut = async (key, body) => {
        if (
          key === `vault/${PATH}` &&
          JSON.parse(body).kind === CURRENT_NOTE_STATE_KIND.tombstone
        ) {
          bucket.afterPut = undefined;
          if (mode === "refuse") bucket.refuseNextPut = true;
          if (mode === "unknown") {
            bucket.throwAfterPutForKey = `recovery/${operationId(43)}`;
          }
        }
      };
      const deleteSequence = mode === "refuse" ? 41 : 43;

      const result = await current.tombstone(
        tombstoneRequest(deleteSequence, live.revision),
      );

      if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
        throw new Error("Deletion must remain confirmed");
      }
      expect(result.confirmed.sealing.kind).toBe(expectedKind);
      await expect(current.read(PATH)).resolves.toBeNull();
      await expect(current.inspect(PATH)).resolves.toMatchObject({
        kind: CURRENT_NOTE_STATE_KIND.tombstone,
      });
      const recoveryState = await recovery.inspect(operationId(deleteSequence));
      expect([
        RECOVERY_SNAPSHOT_STATE_KIND.prepared,
        RECOVERY_SNAPSHOT_STATE_KIND.sealed,
      ]).toContain(recoveryState?.kind);
      if (mode === "unknown") {
        await expect(
          recovery.seal({
            id: operationId(deleteSequence),
            associationId: ASSOCIATION_ID,
            writerId: WRITER_ID,
            operationId: operationId(deleteSequence),
            expectedRevision: result.confirmed.recovery.revision,
          }),
        ).resolves.toMatchObject({
          kind: MUTATION_EFFECT_CERTAINTY.confirmed,
          confirmed: { kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed },
        });
      }
    },
  );

  it("keeps deletion committed when seal candidate construction fails before dispatch", async () => {
    const bucket = new MemoryMirrorBucket();
    const revisions = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000002",
    ].map((value) => required(createApplicationRevision(value)));
    const cryptography: MirrorGenerationCryptography = {
      digest: sha256Content,
      generateRevision: () => required(revisions.shift()),
    };
    const { current } = serviceSet(
      bucket,
      new Date("2027-03-01T00:00:00.000Z"),
      cryptography,
    );
    const live = await confirmedCreate(current, 44, "source");

    const result = await current.tombstone(tombstoneRequest(45, live.revision));

    if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Deletion must remain confirmed");
    }
    expect(result.confirmed.sealing).toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.notDispatched,
    });
    await expect(current.read(PATH)).resolves.toBeNull();
  });

  it("derives recoverUntil from the exact confirmed tombstone upload timestamp", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current, recovery } = serviceSet(bucket);

    const deleted = await confirmedTombstone(current, 46, 47);

    if (deleted.sealing.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected sealed recovery");
    }
    const sealed = sealedState(deleted.sealing.confirmed);
    const tombstoneUploaded = required(bucket.snapshot()).metadata.uploaded;
    expect(sealed.recoverUntil).toBe(
      new Date(
        tombstoneUploaded.getTime() + RECOVERY_RETENTION_MILLISECONDS,
      ).toISOString(),
    );
    await expect(recovery.retrieve(operationId(47))).resolves.toMatchObject({
      kind: RECOVERY_CONTENT_RESULT_KIND.recoverable,
      content: "recoverable",
    });
  });

  it("recreates from the exact tombstone without modifying its recovery snapshot", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current } = serviceSet(bucket);
    const deleted = await confirmedTombstone(current, 48, 49, "old source");
    const recoveryBefore = bucket.snapshot(`recovery/${operationId(49)}`);

    const recreated = await current.recreate({
      action: MUTATION_ACTION.recreate,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(50),
      path: PATH,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: deleted.acknowledgement.revision,
      },
      content: "new source",
    });

    expect(recreated.kind).toBe(MUTATION_EFFECT_CERTAINTY.confirmed);
    expect(bucket.snapshot(`recovery/${operationId(49)}`)).toEqual(
      recoveryBefore,
    );
    await expect(current.read(PATH)).resolves.toBe("new source");
  });

  it("refuses create against a tombstone and hides it from normal reads and lists", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current } = serviceSet(bucket);
    await confirmedTombstone(current, 51, 52);

    await expect(current.create(createRequest(53, "unsafe"))).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    await expect(current.read(PATH)).resolves.toBeNull();
    await expect(current.list()).resolves.toEqual({
      notes: [],
      nextCursor: null,
    });
  });

  it("refuses prepared and unexpired purge, then CAS-purges at the exact deadline", async () => {
    const bucket = new MemoryMirrorBucket();
    const initial = serviceSet(bucket);
    const deleted = await confirmedTombstone(
      initial.current,
      54,
      55,
      "purge me",
    );
    if (deleted.sealing.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected sealed recovery");
    }
    const sealed = sealedState(deleted.sealing.confirmed);
    const beforeDeadline = serviceSet(
      bucket,
      new Date(Date.parse(sealed.recoverUntil) - 1),
    ).recovery;
    await expect(
      beforeDeadline.purge(purgeRequest(56, operationId(55), sealed.revision)),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused });
    await expect(
      beforeDeadline.retrieve(operationId(55)),
    ).resolves.toMatchObject({
      kind: RECOVERY_CONTENT_RESULT_KIND.recoverable,
      content: "purge me",
    });

    const atDeadline = serviceSet(
      bucket,
      new Date(sealed.recoverUntil),
    ).recovery;
    await expect(atDeadline.retrieve(operationId(55))).resolves.toEqual({
      kind: RECOVERY_CONTENT_RESULT_KIND.expired,
      state: sealed,
    });
    const purged = await atDeadline.purge(
      purgeRequest(57, operationId(55), sealed.revision),
    );

    expect(purged).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: { kind: RECOVERY_SNAPSHOT_STATE_KIND.purged },
    });
    expect(
      JSON.parse(required(bucket.snapshot(`recovery/${operationId(55)}`)).body),
    ).not.toHaveProperty("content");
    await expect(initial.current.inspect(PATH)).resolves.toMatchObject({
      kind: CURRENT_NOTE_STATE_KIND.tombstone,
    });
  });

  it("never purges prepared recovery", async () => {
    const bucket = new MemoryMirrorBucket();
    const { recovery } = serviceSet(
      bucket,
      new Date("2028-01-01T00:00:00.000Z"),
    );
    const digest = await sha256Content("prepared");
    const sourceRevision = required(
      createApplicationRevision("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    );
    const prepared = await recovery.prepareForDeletion({
      id: operationId(58),
      associationId: ASSOCIATION_ID,
      operationId: operationId(58),
      path: PATH,
      sourceRevision,
      contentSha256: digest,
      content: "prepared",
    });
    if (prepared.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected prepared recovery");
    }

    await expect(
      recovery.purge(
        purgeRequest(59, operationId(58), prepared.confirmed.state.revision),
      ),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused });
    await expect(recovery.retrieve(operationId(58))).resolves.toMatchObject({
      kind: RECOVERY_CONTENT_RESULT_KIND.recoverable,
      content: "prepared",
    });
  });

  it("lets one concurrent purge win and prevents stale seal or purge from restoring plaintext", async () => {
    const bucket = new MemoryMirrorBucket();
    const initial = serviceSet(bucket);
    const live = await confirmedCreate(initial.current, 60, "private");
    const preparation = await initial.recovery.prepareForDeletion({
      id: operationId(61),
      associationId: ASSOCIATION_ID,
      operationId: operationId(61),
      path: PATH,
      sourceRevision: live.revision,
      contentSha256: await sha256Content("private"),
      content: "private",
    });
    if (preparation.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected prepared recovery");
    }
    const deletedResult = await initial.current.tombstone(
      tombstoneRequest(61, live.revision),
    );
    if (deletedResult.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected tombstone");
    }
    const deleted = deletedResult.confirmed;
    if (deleted.sealing.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected sealed recovery");
    }
    const sealed = sealedState(deleted.sealing.confirmed);
    const first = serviceSet(bucket, new Date(sealed.recoverUntil)).recovery;
    const second = serviceSet(bucket, new Date(sealed.recoverUntil)).recovery;
    let waiting = 0;
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    bucket.beforePut = async (key, _body, options) => {
      if (
        key !== `recovery/${operationId(61)}` ||
        options.onlyIf instanceof Headers
      ) {
        return;
      }
      waiting += 1;
      if (waiting === 2) release?.();
      await barrier;
    };

    const results = await Promise.all([
      first.purge(purgeRequest(62, operationId(61), sealed.revision)),
      second.purge(purgeRequest(63, operationId(61), sealed.revision)),
    ]);
    bucket.beforePut = undefined;

    expect(results.map((result) => result.kind).sort()).toEqual([
      MUTATION_EFFECT_CERTAINTY.confirmed,
      MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    ]);
    await expect(
      initial.recovery.prepareForDeletion({
        id: operationId(61),
        associationId: ASSOCIATION_ID,
        operationId: operationId(61),
        path: PATH,
        sourceRevision: live.revision,
        contentSha256: await sha256Content("private"),
        content: "private",
      }),
    ).resolves.toEqual({
      kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
    await expect(
      preparation.confirmed.replacement.seal({
        kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
        id: operationId(61),
        associationId: ASSOCIATION_ID,
        path: PATH,
        revision: generateApplicationRevision(),
        sourceRevision: live.revision,
        contentSha256: await sha256Content("private"),
        operationId: operationId(64),
        previousRevision: preparation.confirmed.state.revision,
        tombstoneRevision: deleted.acknowledgement.revision,
        recoverUntil: sealed.recoverUntil,
        content: "private",
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused });
    const recoveryBody = JSON.parse(
      required(bucket.snapshot(`recovery/${operationId(61)}`)).body,
    );
    expect(recoveryBody.kind).toBe(RECOVERY_SNAPSHOT_STATE_KIND.purged);
    expect(recoveryBody).not.toHaveProperty("content");
  });

  it("inspects, retrieves, and lists bounded recovery metadata without plaintext", async () => {
    const bucket = new MemoryMirrorBucket();
    const { current, recovery } = serviceSet(bucket);
    await confirmedTombstone(current, 65, 66, "private metadata test");

    const state = await recovery.inspect(operationId(66));
    expect(state).not.toHaveProperty("content");
    const page = await recovery.list();
    expect(page.recoveries).toEqual([state]);
    expect(page.recoveries[0]).not.toHaveProperty("content");
    await expect(recovery.retrieve(operationId(66))).resolves.toMatchObject({
      kind: RECOVERY_CONTENT_RESULT_KIND.recoverable,
      content: "private metadata test",
    });
    await expect(recovery.retrieve(operationId(99))).resolves.toEqual({
      kind: RECOVERY_CONTENT_RESULT_KIND.missing,
    });
  });

  it("explicitly seals prepared recovery only while its matching tombstone remains current", async () => {
    const bucket = new MemoryMirrorBucket();
    const first = serviceSet(bucket);
    const live = await confirmedCreate(first.current, 67, "source");
    bucket.afterPut = async (key, body) => {
      if (
        key === `vault/${PATH}` &&
        JSON.parse(body).kind === CURRENT_NOTE_STATE_KIND.tombstone
      ) {
        bucket.afterPut = undefined;
        bucket.refuseNextPut = true;
      }
    };
    const deleted = await first.current.tombstone(
      tombstoneRequest(68, live.revision),
    );
    if (deleted.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected confirmed tombstone");
    }
    expect(deleted.confirmed.sealing.kind).toBe(
      MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    );

    const sealRequest = {
      id: operationId(68),
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(69),
      expectedRevision: deleted.confirmed.recovery.revision,
    } as const;
    const sealed = await first.recovery.seal(sealRequest);

    expect(sealed).toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: { kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed },
    });
    await expect(first.recovery.seal(sealRequest)).resolves.toEqual(sealed);
    await expect(
      first.recovery.seal({
        ...sealRequest,
        operationId: operationId(70),
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused });
  });

  it("refuses explicit sealing when current tombstone proof has advanced", async () => {
    const bucket = new MemoryMirrorBucket();
    const first = serviceSet(bucket);
    const live = await confirmedCreate(first.current, 70, "source");
    bucket.afterPut = async (key, body) => {
      if (
        key === `vault/${PATH}` &&
        JSON.parse(body).kind === CURRENT_NOTE_STATE_KIND.tombstone
      ) {
        bucket.afterPut = undefined;
        bucket.refuseNextPut = true;
      }
    };
    const deleted = await first.current.tombstone(
      tombstoneRequest(71, live.revision),
    );
    if (deleted.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected confirmed tombstone");
    }
    await first.current.recreate({
      action: MUTATION_ACTION.recreate,
      associationId: ASSOCIATION_ID,
      writerId: WRITER_ID,
      operationId: operationId(72),
      path: PATH,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: deleted.confirmed.acknowledgement.revision,
      },
      content: "recreated",
    });

    await expect(
      first.recovery.seal({
        id: operationId(71),
        associationId: ASSOCIATION_ID,
        writerId: WRITER_ID,
        operationId: operationId(73),
        expectedRevision: deleted.confirmed.recovery.revision,
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused });
  });

  it("preserves purge uncertainty and exposes only the resulting purged marker", async () => {
    const bucket = new MemoryMirrorBucket();
    const initial = serviceSet(bucket);
    const deleted = await confirmedTombstone(
      initial.current,
      74,
      75,
      "private",
    );
    if (deleted.sealing.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected sealed recovery");
    }
    const sealed = sealedState(deleted.sealing.confirmed);
    bucket.throwAfterPutForKey = `recovery/${operationId(75)}`;
    const recovery = serviceSet(bucket, new Date(sealed.recoverUntil)).recovery;

    const request = purgeRequest(76, operationId(75), sealed.revision);
    const purge = await recovery.purge(request);

    expect(purge).toEqual({ kind: MUTATION_EFFECT_CERTAINTY.unknown });
    await expect(recovery.purge(request)).resolves.toMatchObject({
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: { kind: RECOVERY_SNAPSHOT_STATE_KIND.purged },
    });
    await expect(
      recovery.purge({ ...request, operationId: operationId(77) }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused });
    await expect(recovery.retrieve(operationId(75))).resolves.toMatchObject({
      kind: RECOVERY_CONTENT_RESULT_KIND.purged,
      state: { kind: RECOVERY_SNAPSHOT_STATE_KIND.purged },
    });
  });

  it("fails closed for invalid preparation evidence, timestamps, and storage reads", async () => {
    const bucket = new MemoryMirrorBucket();
    const { recovery } = serviceSet(bucket);
    const sourceRevision = required(
      createApplicationRevision("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    );
    const digest = await sha256Content("source");
    await expect(
      recovery.prepareForDeletion({
        id: operationId(77),
        associationId: ASSOCIATION_ID,
        operationId: operationId(78),
        path: PATH,
        sourceRevision,
        contentSha256: digest,
        content: "source",
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    await expect(
      recovery.prepareForDeletion({
        id: operationId(77),
        associationId: ASSOCIATION_ID,
        operationId: operationId(77),
        path: PATH,
        sourceRevision,
        contentSha256: digest,
        content: "different",
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    await expect(
      recovery.prepareForDeletion({
        id: operationId(77),
        associationId: ASSOCIATION_ID,
        operationId: operationId(77),
        path: PATH,
        sourceRevision,
        contentSha256: digest,
        content: "x".repeat(MAX_NOTE_SIZE_BYTES + 1),
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });

    const prepared = await recovery.prepareForDeletion({
      id: operationId(79),
      associationId: ASSOCIATION_ID,
      operationId: operationId(79),
      path: PATH,
      sourceRevision,
      contentSha256: digest,
      content: "source",
    });
    if (prepared.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      throw new Error("Expected preparation");
    }
    const tombstoneRevision = required(
      createApplicationRevision("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    );
    const tombstone = {
      state: {
        kind: CURRENT_NOTE_STATE_KIND.tombstone,
        path: PATH,
        revision: tombstoneRevision,
        deletedRevision: sourceRevision,
        recoveryId: operationId(79),
        receipt: {
          action: MUTATION_ACTION.tombstone,
          associationId: ASSOCIATION_ID,
          operationId: operationId(79),
          precondition: {
            kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
            revision: sourceRevision,
          },
        },
      },
      uploaded: new Date("invalid"),
    } as const;
    await expect(
      recovery.sealConfirmedTombstone({
        preparation: prepared.confirmed,
        tombstone: {
          ...tombstone,
          state: { ...tombstone.state, recoveryId: operationId(80) },
        },
        writerId: WRITER_ID,
        operationId: operationId(81),
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    await expect(
      recovery.sealConfirmedTombstone({
        preparation: prepared.confirmed,
        tombstone,
        writerId: WRITER_ID,
        operationId: operationId(79),
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    await expect(
      recovery.sealConfirmedTombstone({
        preparation: prepared.confirmed,
        tombstone: {
          ...tombstone,
          uploaded: new Date("2027-03-01T00:00:00.000Z"),
        },
        writerId: WRITER_ID,
        operationId: operationId(82),
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });

    bucket.throwOnGet = true;
    await expect(
      recovery.seal({
        id: operationId(79),
        associationId: ASSOCIATION_ID,
        writerId: WRITER_ID,
        operationId: operationId(83),
        expectedRevision: prepared.confirmed.state.revision,
      }),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
    await expect(
      recovery.purge(
        purgeRequest(84, operationId(79), prepared.confirmed.state.revision),
      ),
    ).resolves.toEqual({ kind: MUTATION_EFFECT_CERTAINTY.notDispatched });
  });
});
