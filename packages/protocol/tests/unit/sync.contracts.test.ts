import type {
  NotePath,
  SyncCheckpoint,
  SyncDeviceId,
  SyncEventSequence,
  SyncInventoryId,
  SyncNotePath,
  SyncOperationId,
  SyncRevision,
  SyncSequence,
  SyncStoreErrorCode,
  SyncVaultId,
} from "@obsidian-ai-bridge/core";
import { encodeBase64Url, encodeNotePath } from "@obsidian-ai-bridge/core";
import type { SyncErrorCodeDto } from "@obsidian-ai-bridge/protocol";
import {
  decodeSyncCursor,
  decodeSyncPathKey,
  encodeSyncCursor,
  MAX_SYNC_NOTE_PATH_BYTES,
  SYNC_ERROR_CODES,
  SYNC_FEED_LANE_COUNT,
  SYNC_NAMESPACE_PREFIX,
  SYNC_PROTOCOL_MAJOR,
  syncCheckpointSchema,
  syncContentKey,
  syncDeviceIdSchema,
  syncErrorCodeSchema,
  syncEventSequenceSchema,
  syncFeedEventKey,
  syncFeedLaneForPath,
  syncFeedLaneHeadKey,
  syncHeadKey,
  syncIdentifierSchema,
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryIdSchema,
  syncInventoryManifestKey,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncOperationKey,
  syncRecoveryKey,
  syncRevisionSchema,
  syncSequenceSchema,
  syncVaultIdSchema,
  syncVaultMarkerKey,
  syncVaultMarkerSchema,
  syncVaultPrefix,
  syncVersionKey,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";

const VAULT_ID = syncVaultIdSchema.parse(
  "8f4c6a20-2b51-4d86-9c55-df50d9390d96",
);
const OTHER_VAULT_ID = syncVaultIdSchema.parse(
  "a8b7c6d5-e4f3-4120-9a8b-7c6d5e4f3210",
);
const DEVICE_ID = syncDeviceIdSchema.parse(
  "cb5760e7-b198-441e-b459-7187df4672dc",
);
const REVISION = syncRevisionSchema.parse(
  "1c79a710-b532-4c32-9e14-cda5fa23a06d",
);
const OPERATION_ID = syncOperationIdSchema.parse(
  "b03f51ea-581e-4e4a-bec3-b89d4325d7c7",
);
const INVENTORY_ID = syncInventoryIdSchema.parse(
  "a5eaa17e-6e5c-4fb7-8585-8a5da7e5133b",
);
const ZERO_SEQUENCE = "0".repeat(20);

type TypeEqual<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
const syncStoreErrorCodesMatchProtocol: TypeEqual<
  SyncErrorCodeDto,
  SyncStoreErrorCode
> = true;

describe("M7 versioned sync contracts", () => {
  it("keeps validated outputs core-owned and round-trips the cursor codec", () => {
    const vaultId: SyncVaultId = syncVaultIdSchema.parse(
      "8f4c6a20-2b51-4d86-9c55-df50d9390d96",
    );
    const deviceId: SyncDeviceId = syncDeviceIdSchema.parse(
      "cb5760e7-b198-441e-b459-7187df4672dc",
    );
    const revision: SyncRevision = syncRevisionSchema.parse(
      "1c79a710-b532-4c32-9e14-cda5fa23a06d",
    );
    const operationId: SyncOperationId = syncOperationIdSchema.parse(
      "b03f51ea-581e-4e4a-bec3-b89d4325d7c7",
    );
    const inventoryId: SyncInventoryId = syncInventoryIdSchema.parse(
      "a5eaa17e-6e5c-4fb7-8585-8a5da7e5133b",
    );
    const path: SyncNotePath = syncNotePathSchema.parse("nested/note.md");
    const notePath: NotePath = path;
    const sequence: SyncSequence = syncSequenceSchema.parse(ZERO_SEQUENCE);
    const eventSequence: SyncEventSequence = syncEventSequenceSchema.parse(
      "00000000000000000001",
    );
    const checkpoint: SyncCheckpoint = syncCheckpointSchema.parse({
      protocolMajor: 1,
      vaultId,
      laneSequences: Array.from({ length: SYNC_FEED_LANE_COUNT }, () =>
        syncSequenceSchema.parse(ZERO_SEQUENCE),
      ),
      nextLane: 0,
    });

    // @ts-expect-error A device identity cannot be used as a vault identity.
    const vaultIdFromDevice: SyncVaultId = deviceId;
    // @ts-expect-error A vault identity cannot be used as a device identity.
    const deviceIdFromVault: SyncDeviceId = vaultId;
    // @ts-expect-error A revision identity cannot be used as a vault identity.
    const vaultIdFromRevision: SyncVaultId = revision;
    // @ts-expect-error Unvalidated strings are not core-owned identifiers.
    const unvalidatedVaultId: SyncVaultId =
      "8f4c6a20-2b51-4d86-9c55-df50d9390d96";
    // @ts-expect-error A possibly-zero sequence is not an event sequence.
    const eventSequenceFromCheckpointSequence: SyncEventSequence = sequence;
    const invalidCheckpoint: SyncCheckpoint = {
      protocolMajor: 1,
      // @ts-expect-error A checkpoint cannot use a device identity as its vault.
      vaultId: deviceId,
      // @ts-expect-error Checkpoint lane positions must be validated sequences.
      laneSequences: [ZERO_SEQUENCE],
      nextLane: 64,
    };

    expect(decodeSyncCursor(encodeSyncCursor(checkpoint), vaultId)).toEqual(
      checkpoint,
    );
    expect({
      vaultId,
      deviceId,
      revision,
      operationId,
      inventoryId,
      path,
      notePath,
      sequence,
      eventSequence,
    }).toEqual({
      vaultId: VAULT_ID,
      deviceId: DEVICE_ID,
      revision: REVISION,
      operationId: OPERATION_ID,
      inventoryId: INVENTORY_ID,
      path: "nested/note.md",
      notePath: "nested/note.md",
      sequence: ZERO_SEQUENCE,
      eventSequence: "00000000000000000001",
    });
    void [
      vaultIdFromDevice,
      deviceIdFromVault,
      vaultIdFromRevision,
      unvalidatedVaultId,
      eventSequenceFromCheckpointSequence,
      invalidCheckpoint,
    ];
  });

  it("defines protocol major one without changing the v2 envelope", () => {
    expect(SYNC_PROTOCOL_MAJOR).toBe(1);
    expect(syncStoreErrorCodesMatchProtocol).toBe(true);
    expect(SYNC_NAMESPACE_PREFIX).toBe("sync/v1/vaults");
    expect(
      syncVaultMarkerSchema.safeParse({
        schemaVersion: 1,
        protocolMajor: 1,
        vaultId: VAULT_ID,
      }).success,
    ).toBe(true);
    expect(
      syncVaultMarkerSchema.safeParse({
        schemaVersion: 2,
        protocolMajor: 1,
        vaultId: VAULT_ID,
      }).success,
    ).toBe(false);
    expect(
      syncVaultMarkerSchema.safeParse({
        schemaVersion: 1,
        protocolMajor: 2,
        vaultId: VAULT_ID,
        authority: "unexpected",
      }).success,
    ).toBe(false);
  });

  it("accepts only canonical immutable UUID-v4 identifiers", () => {
    expect(syncIdentifierSchema.safeParse(VAULT_ID).success).toBe(true);
    expect(syncIdentifierSchema.safeParse(VAULT_ID.toUpperCase()).success).toBe(
      false,
    );
    expect(syncIdentifierSchema.safeParse("../vault").success).toBe(false);
    expect(
      syncIdentifierSchema.safeParse("00000000-0000-0000-0000-000000000000")
        .success,
    ).toBe(false);
  });

  it("keeps identifier roles distinct at compile time while sharing UUID validation", () => {
    expect(DEVICE_ID).toBe("cb5760e7-b198-441e-b459-7187df4672dc");
    expect(syncDeviceIdSchema.safeParse("../device").success).toBe(false);
  });

  it("enforces canonical note paths and the UTF-8 key-length boundary", () => {
    const path720 = `${"a".repeat(MAX_SYNC_NOTE_PATH_BYTES - 3)}.md`;
    const path721 = `${"a".repeat(MAX_SYNC_NOTE_PATH_BYTES - 2)}.md`;
    expect(new TextEncoder().encode(path720).byteLength).toBe(720);
    expect(syncNotePathSchema.safeParse(path720).success).toBe(true);
    expect(syncNotePathSchema.safeParse(path721).success).toBe(false);
    expect(syncNotePathSchema.safeParse(`${"雪".repeat(240)}.md`).success).toBe(
      false,
    );
    expect(syncNotePathSchema.safeParse("../private.md").success).toBe(false);
  });

  it("keeps sequences exact beyond JavaScript's safe integer range", () => {
    const maximum = "99999999999999999999";
    expect(syncSequenceSchema.parse(ZERO_SEQUENCE)).toBe(ZERO_SEQUENCE);
    expect(syncEventSequenceSchema.parse(maximum)).toBe(maximum);
    expect(syncEventSequenceSchema.safeParse(ZERO_SEQUENCE).success).toBe(
      false,
    );
    expect(syncSequenceSchema.safeParse("100000000000000000000").success).toBe(
      false,
    );
    expect(syncSequenceSchema.safeParse("0000000000000000000x").success).toBe(
      false,
    );
  });

  it("exposes exactly the M7 closed error set", () => {
    expect(SYNC_ERROR_CODES).toEqual([
      "invalid_input",
      "unsupported_protocol_version",
      "vault_not_found",
      "stale_revision",
      "operation_id_reused",
      "cursor_expired",
      "invalid_cursor",
      "inventory_incomplete",
      "inventory_limit_exceeded",
      "inventory_expired",
      "inventory_id_reused",
      "sequence_exhausted",
      "storage_throttled",
      "operation_pending",
      "effect_unknown",
      "storage_unavailable",
    ]);
    expect(syncErrorCodeSchema.safeParse("storage_unavailable").success).toBe(
      true,
    );
    expect(syncErrorCodeSchema.safeParse("unknown_error").success).toBe(false);
  });

  it("builds fixed keys only within the isolated versioned prefix", () => {
    const path = syncNotePathSchema.parse("nested/雪.md");
    expect(syncVaultPrefix(VAULT_ID)).toBe(`sync/v1/vaults/${VAULT_ID}/`);
    expect(syncVaultMarkerKey(VAULT_ID)).toBe(
      `sync/v1/vaults/${VAULT_ID}/vault.json`,
    );
    expect(syncHeadKey(VAULT_ID, path)).toBe(
      `sync/v1/vaults/${VAULT_ID}/heads/${encodeNotePath(path)}.json`,
    );
    expect(syncVersionKey(VAULT_ID, REVISION)).toBe(
      `sync/v1/vaults/${VAULT_ID}/versions/${REVISION}.json`,
    );
    expect(syncContentKey(VAULT_ID, REVISION)).toBe(
      `sync/v1/vaults/${VAULT_ID}/content/${REVISION}.md`,
    );
    expect(syncRecoveryKey(VAULT_ID, OPERATION_ID, "metadata")).toBe(
      `sync/v1/vaults/${VAULT_ID}/recovery/${OPERATION_ID}.json`,
    );
    expect(syncRecoveryKey(VAULT_ID, OPERATION_ID, "content")).toBe(
      `sync/v1/vaults/${VAULT_ID}/recovery/${OPERATION_ID}.md`,
    );
    expect(syncOperationKey(VAULT_ID, OPERATION_ID)).toBe(
      `sync/v1/vaults/${VAULT_ID}/operations/${OPERATION_ID}.json`,
    );
    expect(syncFeedLaneHeadKey(VAULT_ID, 63)).toBe(
      `sync/v1/vaults/${VAULT_ID}/feed/3f/head.json`,
    );
    expect(
      syncFeedEventKey(
        VAULT_ID,
        0,
        syncEventSequenceSchema.parse("00000000000000000001"),
      ),
    ).toBe(
      `sync/v1/vaults/${VAULT_ID}/feed/00/events/00000000000000000001.json`,
    );
    expect(syncInventoryActiveKey(VAULT_ID)).toBe(
      `sync/v1/vaults/${VAULT_ID}/inventories/active.json`,
    );
    expect(syncInventoryManifestKey(VAULT_ID, INVENTORY_ID)).toBe(
      `sync/v1/vaults/${VAULT_ID}/inventories/scans/${INVENTORY_ID}/manifest.json`,
    );
    expect(syncInventoryChunkKey(VAULT_ID, INVENTORY_ID, 12)).toBe(
      `sync/v1/vaults/${VAULT_ID}/inventories/scans/${INVENTORY_ID}/chunks/12.json`,
    );
    expect(() => syncFeedLaneHeadKey(VAULT_ID, 64)).toThrow(RangeError);
  });

  it("rejects invalid key components rather than interpolating hostile values", () => {
    expect(() => syncFeedLaneHeadKey(VAULT_ID, -1)).toThrow(RangeError);
    // @ts-expect-error Untrusted sequence text is rejected before it can be a key component.
    expect(() => syncFeedEventKey(VAULT_ID, 1, "1")).toThrow(TypeError);
    expect(() => syncInventoryChunkKey(VAULT_ID, INVENTORY_ID, -1)).toThrow(
      TypeError,
    );
  });

  it("round-trips only strict, vault-bound 64-lane checkpoint cursors", () => {
    const checkpoint = syncCheckpointSchema.parse({
      protocolMajor: 1,
      vaultId: VAULT_ID,
      laneSequences: Array.from(
        { length: SYNC_FEED_LANE_COUNT },
        () => ZERO_SEQUENCE,
      ),
      nextLane: 0,
    });
    const cursor = encodeSyncCursor(checkpoint);
    expect(decodeSyncCursor(cursor, VAULT_ID)).toEqual(checkpoint);
    expect(decodeSyncCursor(`${cursor}=`, VAULT_ID)).toBeUndefined();
    expect(
      decodeSyncCursor(
        btoa('{"protocolMajor":2}').replace(/=+$/, ""),
        VAULT_ID,
      ),
    ).toBeUndefined();
    const foreignCursor = encodeSyncCursor({
      ...checkpoint,
      vaultId: OTHER_VAULT_ID,
    });
    expect(decodeSyncCursor(foreignCursor, VAULT_ID)).toBeUndefined();
    expect(decodeSyncCursor(foreignCursor, OTHER_VAULT_ID)).toEqual({
      ...checkpoint,
      vaultId: OTHER_VAULT_ID,
    });
    expect(
      syncCheckpointSchema.safeParse({ ...checkpoint, nextLane: 64 }).success,
    ).toBe(false);
    expect(
      syncCheckpointSchema.safeParse({ ...checkpoint, authority: true })
        .success,
    ).toBe(false);
    expect(
      syncCheckpointSchema.safeParse({
        ...checkpoint,
        laneSequences: [ZERO_SEQUENCE],
      }).success,
    ).toBe(false);
  });

  it("rejects malformed UTF-8, JSON, path bytes, and non-canonical cursor encodings", () => {
    expect(
      decodeSyncCursor(encodeBase64Url(new Uint8Array([0xff])), VAULT_ID),
    ).toBeUndefined();
    expect(
      decodeSyncCursor(
        encodeBase64Url(new TextEncoder().encode("{")),
        VAULT_ID,
      ),
    ).toBeUndefined();

    const nonCanonicalCursor = encodeBase64Url(
      new TextEncoder().encode('{"protocolMajor":1 }'),
    );
    expect(decodeSyncCursor(nonCanonicalCursor, VAULT_ID)).toBeUndefined();
    expect(decodeSyncPathKey("!")).toBeUndefined();
    expect(decodeSyncPathKey(encodeBase64Url(new Uint8Array([0xff])))).toBe(
      undefined,
    );
    expect(
      decodeSyncPathKey(
        encodeBase64Url(new TextEncoder().encode(`${"a".repeat(718)}.md`)),
      ),
    ).toBeUndefined();
    expect(
      decodeSyncPathKey(
        encodeBase64Url(new TextEncoder().encode("../private.md")),
      ),
    ).toBeUndefined();
  });

  it("assigns the same canonical path to one stable hash lane and validates path keys", async () => {
    const path = syncNotePathSchema.parse("nested/雪.md");
    expect(await syncFeedLaneForPath(path)).toBe(61);
    const headKey = syncHeadKey(VAULT_ID, path);
    const pathKey = headKey.split("/heads/")[1]?.replace(/\.json$/, "");
    expect(pathKey).toBeDefined();
    expect(decodeSyncPathKey(pathKey ?? "")).toBe(path);
    expect(decodeSyncPathKey(`${pathKey}=`)).toBeUndefined();
  });
});
