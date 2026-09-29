import type { ContentSha256 } from "@core/mirror/mirror.types";
import type {
  SyncDeviceId,
  SyncEventSequence,
  SyncInventoryId,
  SyncNotePath,
  SyncOperationId,
  SyncRevision,
  SyncSequence,
  SyncVaultId,
} from "@core/sync/sync.types";
import type { SyncStore } from "@core/sync/sync-store.port";
import type {
  SyncCompleteInventory,
  SyncContinueInventoryInput,
  SyncInventoryResult,
  SyncMutationRequest,
  SyncMutationResult,
  SyncMutationSuccess,
  SyncReadChangesInput,
  SyncReadChangesResult,
  SyncReadCurrentInput,
  SyncReadCurrentResult,
  SyncReadInventoryPageInput,
  SyncReadInventoryPageResult,
  SyncReadRecoveryInput,
  SyncReadRecoveryResult,
  SyncReadVersionInput,
  SyncReadVersionResult,
  SyncResumeOperationInput,
  SyncStartInventoryInput,
  SyncStoreErrorCode,
  SyncTombstoneRequest,
} from "@core/sync/sync-store.types";
import { describe, expect, it } from "vitest";

const VAULT_ID = "8f4c6a20-2b51-4d86-9c55-df50d9390d96" as SyncVaultId;
const DEVICE_ID = "cb5760e7-b198-441e-b459-7187df4672dc" as SyncDeviceId;
const PATH = "notes/example.md" as SyncNotePath;
const REVISION = "1c79a710-b532-4c32-9e14-cda5fa23a06d" as SyncRevision;
const OPERATION_ID = "b03f51ea-581e-4e4a-bec3-b89d4325d7c7" as SyncOperationId;
const INVENTORY_ID = "a5eaa17e-6e5c-4fb7-8585-8a5da7e5133b" as SyncInventoryId;
const EVENT_SEQUENCE = "00000000000000000001" as SyncEventSequence;
const SEQUENCE = "00000000000000000000" as SyncSequence;
const CHECKPOINT_CURSOR = "validated-opaque-checkpoint";
const EVIDENCE_CURSOR = "validated-opaque-inventory-evidence";
const HASH = "a".repeat(64) as ContentSha256;

const fixture = {
  readCurrent: async (_input: SyncReadCurrentInput) => ({ kind: "never_seen" }),
  mutate: async (_request: SyncMutationRequest) => ({
    kind: "committed",
    revision: REVISION,
    operationId: OPERATION_ID,
    position: { lane: 7, sequence: EVENT_SEQUENCE },
  }),
  readVersion: async (_input: SyncReadVersionInput) => ({ kind: "absent" }),
  readRecovery: async (_input: SyncReadRecoveryInput) => ({ kind: "absent" }),
  readChanges: async (_input: SyncReadChangesInput) => ({
    kind: "page",
    events: [
      {
        kind: "changed",
        lane: 7,
        sequence: EVENT_SEQUENCE,
        path: PATH,
        result: { kind: "live", revision: REVISION },
        operationId: OPERATION_ID,
        origin: DEVICE_ID,
        committedAtEpochMs: 1_800_000_000_000,
      },
      {
        kind: "aborted",
        lane: 8,
        sequence: "00000000000000000002" as SyncEventSequence,
        operationId: OPERATION_ID,
        reason: "stale_revision",
        committedAtEpochMs: 1_800_000_000_001,
      },
    ],
    nextCursor: CHECKPOINT_CURSOR,
  }),
  startInventory: async (_input: SyncStartInventoryInput) => ({
    kind: "inventory_in_progress",
    vaultId: VAULT_ID,
    inventoryId: INVENTORY_ID,
  }),
  continueInventory: async (_input: SyncContinueInventoryInput) => ({
    kind: "complete",
    vaultId: VAULT_ID,
    inventoryId: INVENTORY_ID,
    vector: Array.from({ length: 64 }, () => SEQUENCE),
    entryCount: 0,
    chunkCount: 0,
    root: HASH,
  }),
  readInventoryPage: async (_input: SyncReadInventoryPageInput) => ({
    kind: "page",
    summaries: [],
    nextCursor: EVIDENCE_CURSOR,
    final: false,
  }),
  resumeOperation: async (_input: SyncResumeOperationInput) => ({
    kind: "error",
    code: "operation_pending",
    operationId: OPERATION_ID,
  }),
} satisfies SyncStore;

const neverSeen: SyncReadCurrentResult = { kind: "never_seen" };
const tombstone: SyncReadCurrentResult = {
  kind: "tombstone",
  revision: REVISION,
  parent: { kind: "revision", revision: REVISION },
  contentSha256: HASH,
  byteSize: 4,
  mediaType: "text/markdown",
  operationId: OPERATION_ID,
  origin: DEVICE_ID,
};
const completeHandle: SyncCompleteInventory = {
  kind: "complete",
  vaultId: VAULT_ID,
  inventoryId: INVENTORY_ID,
  vector: Array.from({ length: 64 }, () => SEQUENCE),
  entryCount: 0,
  chunkCount: 0,
  root: HASH,
};
const completeMutation: SyncMutationSuccess = {
  kind: "committed",
  revision: REVISION,
  operationId: OPERATION_ID,
  position: { lane: 7, sequence: EVENT_SEQUENCE },
};
// @ts-expect-error A committed mutation must include its committed feed position.
const mutationWithoutPosition: SyncMutationSuccess = {
  kind: "committed",
  revision: REVISION,
  operationId: OPERATION_ID,
};

// @ts-expect-error A live mutation must carry its expected digest.
const mutationWithoutDigest: SyncMutationRequest = {
  kind: "create",
  vaultId: VAULT_ID,
  path: PATH,
  operationId: OPERATION_ID,
  revision: REVISION,
  parent: { kind: "never_seen" },
  origin: DEVICE_ID,
  content: "note",
  mediaType: "text/markdown",
};
const tombstoneWithoutPreservedParent: SyncTombstoneRequest = {
  kind: "tombstone",
  vaultId: VAULT_ID,
  path: PATH,
  operationId: OPERATION_ID,
  revision: REVISION,
  // @ts-expect-error A tombstone must identify the live revision to preserve.
  parent: { kind: "never_seen" },
  contentSha256: HASH,
  origin: DEVICE_ID,
};

const readWithR2Etag: SyncReadCurrentInput = {
  vaultId: VAULT_ID,
  path: PATH,
  // @ts-expect-error R2 entity tags are private to storage adapters.
  etag: '"storage-generation"',
};
const continueWithR2Cursor: SyncContinueInventoryInput = {
  vaultId: VAULT_ID,
  inventoryId: INVENTORY_ID,
  // @ts-expect-error R2 listing cursors never cross the core port.
  r2Cursor: "opaque-storage-cursor",
};

/** Forces each closed current-state case to be handled.
 * @param result Current observation or typed failure.
 * @returns A visible label for the exhaustive state assertion.
 */
function currentStateLabel(result: SyncReadCurrentResult): string {
  switch (result.kind) {
    case "never_seen":
      return "never-seen";
    case "live":
      return result.revision;
    case "tombstone":
      return result.revision;
    case "error":
      return result.code;
  }
}

/** Forces each complete/progress/error inventory outcome to be handled.
 * @param result Inventory progress, complete handle, or typed failure.
 * @returns A visible label for the exhaustive result assertion.
 */
function inventoryLabel(result: SyncInventoryResult): string {
  switch (result.kind) {
    case "inventory_in_progress":
      return result.inventoryId;
    case "complete":
      return String(result.entryCount);
    case "error":
      return result.code;
  }
}

/** Forces each changed/aborted event variant to be handled without content.
 * @param result Bounded change page or typed read failure.
 * @returns Operation ID from the first metadata-only event, if any.
 */
function eventOperationId(
  result: SyncReadChangesResult,
): SyncOperationId | undefined {
  if (result.kind !== "page") return undefined;

  return result.events.flatMap((event) => {
    switch (event.kind) {
      case "changed":
        return [event.operationId];
      case "aborted":
        return [event.operationId];
      default:
        return assertNever(event);
    }
  })[0];
}

/** Forces present/absent/error version results to remain distinguishable.
 * @param result Closed immutable-version lookup outcome.
 * @returns A visible label for the exhaustive result assertion.
 */
function versionResultLabel(result: SyncReadVersionResult): string {
  switch (result.kind) {
    case "absent":
      return result.kind;
    case "present":
      return result.version.kind;
    case "error":
      return result.code;
  }
}

/** Forces present/absent/error recovery results to remain distinguishable.
 * @param result Closed recovery lookup outcome.
 * @returns A visible label for the exhaustive result assertion.
 */
function recoveryResultLabel(result: SyncReadRecoveryResult): string {
  switch (result.kind) {
    case "absent":
      return result.kind;
    case "present":
      return result.recovery.operationId;
    case "error":
      return result.code;
  }
}

/** Forces committed success and typed mutation failures to remain distinct.
 * @param result Committed mutation outcome or typed failure.
 * @returns The event sequence on success or failure code otherwise.
 */
function mutationResultLabel(result: SyncMutationResult): string {
  switch (result.kind) {
    case "committed":
      return result.position.sequence;
    case "error":
      return result.code;
  }
}

/** Forces progress, verified completion, and failures to remain distinct.
 * @param result Bounded evidence page, verified terminal page, or typed failure.
 * @returns A visible label for the exhaustive result assertion.
 */
function inventoryPageLabel(result: SyncReadInventoryPageResult): string {
  switch (result.kind) {
    case "page":
      return String(result.summaries.length);
    case "complete":
      return String(result.final);
    case "error":
      return result.code;
  }
}

/** Fails compilation if a result union gains an unhandled state.
 * @param value Exhaustively handled contract value.
 * @returns Never; an unexpected value is a programming defect.
 * @throws Error when called with a runtime value outside the closed union.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled sync contract value: ${String(value)}`);
}

describe("SyncStore contract shapes", () => {
  it("distinguishes absence from tombstones and complete inventory from progress", async () => {
    expect(currentStateLabel(neverSeen)).toBe("never-seen");
    expect(currentStateLabel(tombstone)).toBe(REVISION);
    expect(
      inventoryLabel(
        await fixture.startInventory({
          vaultId: VAULT_ID,
          inventoryId: INVENTORY_ID,
        }),
      ),
    ).toBe(INVENTORY_ID);
    expect(
      inventoryLabel(
        await fixture.continueInventory({
          vaultId: VAULT_ID,
          inventoryId: INVENTORY_ID,
        }),
      ),
    ).toBe("0");
  });

  it("keeps changed and aborted feed events metadata-only and bounded", async () => {
    const page = await fixture.readChanges({
      vaultId: VAULT_ID,
      cursor: CHECKPOINT_CURSOR,
    });
    expect(page.kind).toBe("page");
    if (page.kind !== "page") return;

    expect(page.events).toHaveLength(2);
    expect(eventOperationId(page)).toBe(OPERATION_ID);
    expect(page.events.every((event) => !("content" in event))).toBe(true);
  });

  it("requires a complete marker for inventory evidence and committed mutation position", async () => {
    const page = await fixture.readInventoryPage({
      vaultId: VAULT_ID,
      handle: completeHandle,
      cursor: EVIDENCE_CURSOR,
    });
    const success = await fixture.mutate({
      kind: "create",
      vaultId: VAULT_ID,
      path: PATH,
      operationId: OPERATION_ID,
      revision: REVISION,
      parent: { kind: "never_seen" },
      contentSha256: HASH,
      origin: DEVICE_ID,
      content: "note",
      mediaType: "text/markdown",
    });

    expect(inventoryPageLabel(page)).toBe("0");
    expect(mutationResultLabel(success)).toBe(EVENT_SEQUENCE);
    expect(completeMutation.position).toEqual(success.position);
  });

  it("keeps the error code set closed to the M7 protocol values", () => {
    const codes: readonly SyncStoreErrorCode[] = [
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
    ];

    expect(codes).toHaveLength(16);
    expect(versionResultLabel({ kind: "absent" })).toBe("absent");
    expect(recoveryResultLabel({ kind: "absent" })).toBe("absent");
    void [
      mutationWithoutPosition,
      mutationWithoutDigest,
      tombstoneWithoutPreservedParent,
      readWithR2Etag,
      continueWithR2Cursor,
    ];
  });
});
