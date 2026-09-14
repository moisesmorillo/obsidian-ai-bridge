import {
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  MAX_NOTE_SIZE_BYTES,
  normalizeNotePath,
  RECOVERY_SNAPSHOT_STATE_KIND,
} from "@obsidian-ai-bridge/core";
import {
  decodeRecoveryObject,
  encodePreparedRecoveryObject,
  encodePurgedRecoveryObject,
  encodeSealedRecoveryObject,
} from "@worker/infrastructure/recovery-object.codec";
import { BRIDGE_STORAGE_FORMAT } from "@worker/infrastructure/storage-object.constants";
import { STORED_OBJECT_DATA_ERROR_KIND } from "@worker/infrastructure/storage-object.errors";
import { sha256Content } from "@worker/storage/storage-crypto";
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
const SEAL_OPERATION_ID = required(
  createMirrorOperationId("77777777-7777-4777-8777-777777777777"),
);
const PURGE_OPERATION_ID = required(
  createMirrorOperationId("88888888-8888-4888-8888-888888888888"),
);
const TOMBSTONE_REVISION = required(
  createApplicationRevision("99999999-9999-4999-8999-999999999999"),
);
const PATH = required(normalizeNotePath("Recovery/Note.md"));
const CONTENT = "private deleted note 📝";
const CONTENT_SHA256 = required(
  createContentSha256(
    "ab38908c15c2b6a476b1533ddba179b31950c43bf10cad6aec7a9d1c8cd8b9e5",
  ),
);
const RECOVER_UNTIL = "2027-01-02T03:04:05.000Z";

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid test fixture");
  return value;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function preparedFixture() {
  return {
    kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
    id: ID,
    associationId: ASSOCIATION_ID,
    path: PATH,
    revision: PREPARED_REVISION,
    sourceRevision: SOURCE_REVISION,
    contentSha256: CONTENT_SHA256,
    operationId: ID,
    content: CONTENT,
  } as const;
}

describe("recovery-object storage codec", () => {
  it("round-trips prepared recovery content without inventing an expiry", async () => {
    const prepared = preparedFixture();
    const encoded = encodePreparedRecoveryObject(prepared);

    expect(JSON.parse(encoded)).toEqual({
      format: BRIDGE_STORAGE_FORMAT,
      ...prepared,
    });
    await expect(decodeRecoveryObject(bytes(encoded))).resolves.toEqual(
      prepared,
    );
  });

  it("round-trips sealed recovery content and immutable tombstone evidence", async () => {
    const prepared = preparedFixture();
    const sealed = {
      ...prepared,
      kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
      revision: SEALED_REVISION,
      operationId: SEAL_OPERATION_ID,
      previousRevision: PREPARED_REVISION,
      tombstoneRevision: TOMBSTONE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    } as const;
    const encoded = encodeSealedRecoveryObject(sealed);

    await expect(decodeRecoveryObject(bytes(encoded))).resolves.toEqual(sealed);
  });

  it("round-trips a purged marker that retains no note plaintext", async () => {
    const prepared = preparedFixture();
    const purged = {
      kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
      id: prepared.id,
      associationId: prepared.associationId,
      path: prepared.path,
      revision: PURGED_REVISION,
      sourceRevision: prepared.sourceRevision,
      contentSha256: prepared.contentSha256,
      operationId: PURGE_OPERATION_ID,
      previousRevision: SEALED_REVISION,
      tombstoneRevision: TOMBSTONE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    } as const;
    const contaminatedCandidate = { ...purged, content: CONTENT };
    const encoded = encodePurgedRecoveryObject(contaminatedCandidate);

    expect(encoded).not.toContain(CONTENT);
    expect(JSON.parse(encoded)).not.toHaveProperty("content");
    await expect(decodeRecoveryObject(bytes(encoded))).resolves.toEqual(purged);
  });

  it.each([
    [
      "prepared with an expiry",
      {
        format: BRIDGE_STORAGE_FORMAT,
        ...preparedFixture(),
        recoverUntil: RECOVER_UNTIL,
      },
    ],
    [
      "sealed without content",
      {
        format: BRIDGE_STORAGE_FORMAT,
        ...preparedFixture(),
        kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
        revision: SEALED_REVISION,
        operationId: SEAL_OPERATION_ID,
        previousRevision: PREPARED_REVISION,
        tombstoneRevision: TOMBSTONE_REVISION,
        recoverUntil: RECOVER_UNTIL,
        content: undefined,
      },
    ],
    [
      "purged with plaintext",
      {
        format: BRIDGE_STORAGE_FORMAT,
        ...preparedFixture(),
        kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
        revision: PURGED_REVISION,
        operationId: PURGE_OPERATION_ID,
        previousRevision: SEALED_REVISION,
        tombstoneRevision: TOMBSTONE_REVISION,
        recoverUntil: RECOVER_UNTIL,
      },
    ],
  ])("rejects malformed %s state", async (_name, malformed) => {
    await expect(
      decodeRecoveryObject(bytes(JSON.stringify(malformed))),
    ).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });
  });

  it("rejects recoverable content whose digest does not match exact UTF-8 bytes", async () => {
    const prepared = preparedFixture();
    const malformed = JSON.stringify({
      format: BRIDGE_STORAGE_FORMAT,
      ...prepared,
      content: `${CONTENT}!`,
    });

    await expect(decodeRecoveryObject(bytes(malformed))).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.contentHashMismatch,
    });
  });

  it("rejects invalid UTF-8, invalid JSON, and oversized recovery bytes", async () => {
    await expect(
      decodeRecoveryObject(new Uint8Array([0xff])),
    ).rejects.toMatchObject({ kind: STORED_OBJECT_DATA_ERROR_KIND.malformed });
    await expect(decodeRecoveryObject(bytes("{"))).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
    });

    const oversized = "x".repeat(MAX_NOTE_SIZE_BYTES + 1);
    const malformed = JSON.stringify({
      format: BRIDGE_STORAGE_FORMAT,
      ...preparedFixture(),
      contentSha256: await sha256Content(oversized),
      content: oversized,
    });
    await expect(decodeRecoveryObject(bytes(malformed))).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.tooLarge,
    });
  });

  it("rejects reused preparation and transition revisions", async () => {
    const reusedPreparation = JSON.stringify({
      format: BRIDGE_STORAGE_FORMAT,
      ...preparedFixture(),
      revision: SOURCE_REVISION,
    });
    const reusedTransition = JSON.stringify({
      format: BRIDGE_STORAGE_FORMAT,
      ...preparedFixture(),
      kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
      revision: PREPARED_REVISION,
      operationId: SEAL_OPERATION_ID,
      previousRevision: PREPARED_REVISION,
      tombstoneRevision: TOMBSTONE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    });
    const staleTombstone = JSON.stringify({
      format: BRIDGE_STORAGE_FORMAT,
      ...preparedFixture(),
      kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
      revision: SEALED_REVISION,
      operationId: SEAL_OPERATION_ID,
      previousRevision: PREPARED_REVISION,
      tombstoneRevision: SOURCE_REVISION,
      recoverUntil: RECOVER_UNTIL,
    });

    await expect(
      decodeRecoveryObject(bytes(reusedPreparation)),
    ).rejects.toMatchObject({ kind: STORED_OBJECT_DATA_ERROR_KIND.malformed });
    await expect(
      decodeRecoveryObject(bytes(reusedTransition)),
    ).rejects.toMatchObject({ kind: STORED_OBJECT_DATA_ERROR_KIND.malformed });
    await expect(
      decodeRecoveryObject(bytes(staleTombstone)),
    ).rejects.toMatchObject({ kind: STORED_OBJECT_DATA_ERROR_KIND.malformed });
  });
});
