import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CURRENT_NOTE_STATE_KIND,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  MAX_NOTE_SIZE_BYTES,
  MUTATION_ACTION,
} from "@obsidian-ai-bridge/core";
import {
  decodeCurrentObject,
  encodeLiveCurrentObject,
  encodeTombstoneCurrentObject,
} from "@worker/infrastructure/current-object.codec";
import {
  BRIDGE_STORAGE_FORMAT,
  BRIDGE_STORAGE_FORMAT_METADATA_KEY,
} from "@worker/infrastructure/storage-object.constants";
import {
  STORED_OBJECT_DATA_ERROR_KIND,
  StoredObjectDataError,
} from "@worker/infrastructure/storage-object.errors";
import { sha256Content } from "@worker/storage/storage-crypto";
import { describe, expect, it } from "vitest";

const ASSOCIATION_ID = required(
  createMirrorAssociationId("11111111-1111-4111-8111-111111111111"),
);
const OPERATION_ID = required(
  createMirrorOperationId("22222222-2222-4222-8222-222222222222"),
);
const LIVE_REVISION = required(
  createApplicationRevision("33333333-3333-4333-8333-333333333333"),
);
const TOMBSTONE_REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const CONTENT = "# Exact Markdown\n";

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid test fixture");
  return value;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("current-object storage codec", () => {
  it.each([
    ["plain legacy Markdown", "# Legacy\n"],
    [
      "JSON-looking legacy Markdown",
      JSON.stringify({
        format: BRIDGE_STORAGE_FORMAT,
        kind: CURRENT_NOTE_STATE_KIND.live,
        revision: LIVE_REVISION,
      }),
    ],
  ])(
    "classifies untagged %s without interpreting its body",
    async (_name, body) => {
      await expect(
        decodeCurrentObject(bytes(body), undefined),
      ).resolves.toEqual({
        kind: CURRENT_NOTE_STATE_KIND.legacy,
        content: body,
      });
    },
  );

  it("round-trips a valid live generation with its exact receipt and digest", async () => {
    const contentSha256 = await sha256Content(CONTENT);
    const receipt = {
      action: MUTATION_ACTION.create,
      associationId: ASSOCIATION_ID,
      operationId: OPERATION_ID,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
      },
      contentSha256,
    } as const;

    const encoded = encodeLiveCurrentObject({
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision: LIVE_REVISION,
      receipt,
      contentSha256,
      content: CONTENT,
    });

    expect(JSON.parse(encoded)).toEqual({
      format: BRIDGE_STORAGE_FORMAT,
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision: LIVE_REVISION,
      receipt,
      contentSha256,
      content: CONTENT,
    });
    await expect(
      decodeCurrentObject(bytes(encoded), String(BRIDGE_STORAGE_FORMAT)),
    ).resolves.toEqual({
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision: LIVE_REVISION,
      receipt,
      contentSha256,
      content: CONTENT,
    });
  });

  it("round-trips a valid tombstone without exposing it as Markdown", async () => {
    const receipt = {
      action: MUTATION_ACTION.tombstone,
      associationId: ASSOCIATION_ID,
      operationId: OPERATION_ID,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: LIVE_REVISION,
      },
    } as const;
    const encoded = encodeTombstoneCurrentObject({
      kind: CURRENT_NOTE_STATE_KIND.tombstone,
      revision: TOMBSTONE_REVISION,
      receipt,
      deletedRevision: LIVE_REVISION,
      recoveryId: OPERATION_ID,
    });

    expect(JSON.parse(encoded)).toEqual({
      format: BRIDGE_STORAGE_FORMAT,
      kind: CURRENT_NOTE_STATE_KIND.tombstone,
      revision: TOMBSTONE_REVISION,
      receipt,
      deletedRevision: LIVE_REVISION,
      recoveryId: OPERATION_ID,
    });
    await expect(
      decodeCurrentObject(bytes(encoded), String(BRIDGE_STORAGE_FORMAT)),
    ).resolves.toEqual({
      kind: CURRENT_NOTE_STATE_KIND.tombstone,
      revision: TOMBSTONE_REVISION,
      receipt,
      deletedRevision: LIVE_REVISION,
      recoveryId: OPERATION_ID,
    });
  });

  it.each([
    [
      "live",
      {
        format: BRIDGE_STORAGE_FORMAT,
        kind: CURRENT_NOTE_STATE_KIND.live,
        revision: LIVE_REVISION,
        receipt: {},
        contentSha256: "invalid",
        content: CONTENT,
      },
    ],
    [
      "tombstone",
      {
        format: BRIDGE_STORAGE_FORMAT,
        kind: CURRENT_NOTE_STATE_KIND.tombstone,
        revision: TOMBSTONE_REVISION,
        receipt: {},
        deletedRevision: LIVE_REVISION,
        recoveryId: OPERATION_ID,
      },
    ],
  ])(
    "rejects malformed format-2 %s objects as typed data errors",
    async (_name, body) => {
      await expect(
        decodeCurrentObject(
          bytes(JSON.stringify(body)),
          String(BRIDGE_STORAGE_FORMAT),
        ),
      ).rejects.toMatchObject({
        name: StoredObjectDataError.name,
        kind: STORED_OBJECT_DATA_ERROR_KIND.malformed,
      });
    },
  );

  it("rejects unsupported tagged formats before interpreting their bytes", async () => {
    await expect(
      decodeCurrentObject(new Uint8Array([0xff]), "99"),
    ).rejects.toMatchObject({
      name: StoredObjectDataError.name,
      kind: STORED_OBJECT_DATA_ERROR_KIND.unsupportedFormat,
    });
  });

  it("rejects invalid UTF-8 and invalid tagged JSON as malformed data", async () => {
    await expect(
      decodeCurrentObject(
        new Uint8Array([0xff]),
        String(BRIDGE_STORAGE_FORMAT),
      ),
    ).rejects.toMatchObject({ kind: STORED_OBJECT_DATA_ERROR_KIND.malformed });
    await expect(
      decodeCurrentObject(bytes("{"), String(BRIDGE_STORAGE_FORMAT)),
    ).rejects.toMatchObject({ kind: STORED_OBJECT_DATA_ERROR_KIND.malformed });
  });

  it("enforces exact live/tombstone cross-field invariants", async () => {
    const contentSha256 = await sha256Content(CONTENT);
    const matchingReceipt = {
      action: MUTATION_ACTION.update,
      associationId: ASSOCIATION_ID,
      operationId: OPERATION_ID,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: LIVE_REVISION,
      },
      contentSha256,
    } as const;
    const inconsistentLive = JSON.stringify({
      format: BRIDGE_STORAGE_FORMAT,
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision: LIVE_REVISION,
      receipt: matchingReceipt,
      contentSha256,
      content: CONTENT,
    });
    const disagreeingHashes = JSON.stringify({
      format: BRIDGE_STORAGE_FORMAT,
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision: TOMBSTONE_REVISION,
      receipt: {
        action: MUTATION_ACTION.create,
        associationId: ASSOCIATION_ID,
        operationId: OPERATION_ID,
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
        },
        contentSha256,
      },
      contentSha256: "00".repeat(32),
      content: CONTENT,
    });
    const inconsistentTombstone = JSON.stringify({
      format: BRIDGE_STORAGE_FORMAT,
      kind: CURRENT_NOTE_STATE_KIND.tombstone,
      revision: TOMBSTONE_REVISION,
      receipt: {
        action: MUTATION_ACTION.tombstone,
        associationId: ASSOCIATION_ID,
        operationId: OPERATION_ID,
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
          revision: LIVE_REVISION,
        },
      },
      deletedRevision: TOMBSTONE_REVISION,
      recoveryId: OPERATION_ID,
    });

    await expect(
      decodeCurrentObject(
        bytes(inconsistentLive),
        String(BRIDGE_STORAGE_FORMAT),
      ),
    ).rejects.toMatchObject({ kind: STORED_OBJECT_DATA_ERROR_KIND.malformed });
    await expect(
      decodeCurrentObject(
        bytes(disagreeingHashes),
        String(BRIDGE_STORAGE_FORMAT),
      ),
    ).rejects.toMatchObject({ kind: STORED_OBJECT_DATA_ERROR_KIND.malformed });
    await expect(
      decodeCurrentObject(
        bytes(inconsistentTombstone),
        String(BRIDGE_STORAGE_FORMAT),
      ),
    ).rejects.toMatchObject({ kind: STORED_OBJECT_DATA_ERROR_KIND.malformed });
  });

  it("rejects oversized legacy and decoded live Markdown", async () => {
    const oversized = "x".repeat(MAX_NOTE_SIZE_BYTES + 1);
    const contentSha256 = await sha256Content(oversized);
    const live = JSON.stringify({
      format: BRIDGE_STORAGE_FORMAT,
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision: LIVE_REVISION,
      receipt: {
        action: MUTATION_ACTION.create,
        associationId: ASSOCIATION_ID,
        operationId: OPERATION_ID,
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
        },
        contentSha256,
      },
      contentSha256,
      content: oversized,
    });

    await expect(
      decodeCurrentObject(bytes(oversized), undefined),
    ).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.tooLarge,
    });
    await expect(
      decodeCurrentObject(bytes(live), String(BRIDGE_STORAGE_FORMAT)),
    ).rejects.toMatchObject({ kind: STORED_OBJECT_DATA_ERROR_KIND.tooLarge });
  });

  it("rejects live content whose exact UTF-8 digest does not match the envelope", async () => {
    const wrongDigest = required(createContentSha256("00".repeat(32)));
    const encoded = JSON.stringify({
      format: BRIDGE_STORAGE_FORMAT,
      kind: CURRENT_NOTE_STATE_KIND.live,
      revision: LIVE_REVISION,
      receipt: {
        action: MUTATION_ACTION.create,
        associationId: ASSOCIATION_ID,
        operationId: OPERATION_ID,
        precondition: {
          kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
        },
        contentSha256: wrongDigest,
      },
      contentSha256: wrongDigest,
      content: CONTENT,
    });

    await expect(
      decodeCurrentObject(bytes(encoded), String(BRIDGE_STORAGE_FORMAT)),
    ).rejects.toMatchObject({
      kind: STORED_OBJECT_DATA_ERROR_KIND.contentHashMismatch,
    });
  });

  it("uses the explicit custom-metadata discriminator name", () => {
    expect(BRIDGE_STORAGE_FORMAT_METADATA_KEY).toBe("bridgeFormat");
  });
});
