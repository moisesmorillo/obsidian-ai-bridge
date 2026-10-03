import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  decodeSyncPathKey,
  syncContentKey,
  syncFeedEventKey,
  syncFeedLaneHeadKey,
  syncHeadKey,
  syncInventoryActiveKey,
  syncInventoryChunkKey,
  syncInventoryClaimKey,
  syncInventoryCursorWitnessKey,
  syncInventoryManifestKey,
  syncOperationKey,
  syncRecoveryKey,
  syncVaultMarkerKey,
  syncVaultPrefix,
  syncVersionKey,
} from "@protocol/sync.codec";
import {
  syncEventSequenceSchema,
  syncIdentifierSchema,
  syncInventoryIdSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncOperationIdDto, SyncVaultIdDto } from "@protocol/sync.types";
import type { SyncR2Key } from "@worker/infrastructure/sync/sync-r2.types";

/** Builds the Worker-private refusal receipt key adjacent to its operation journal.
 * @param vaultId Validated immutable protocol-v1 vault identity.
 * @param operationId Canonical operation UUID owning one receipt key.
 * @returns The private create-only receipt key; it is not a public protocol key.
 */
export function syncHeadRefusalReceiptKey(
  vaultId: SyncVaultIdDto,
  operationId: SyncOperationIdDto,
): string {
  return syncOperationKey(vaultId, operationId).replace(
    /\.json$/,
    ".head-refusal.json",
  );
}

/** Admits only exact M7.1 keys and the Worker-private refusal receipt below one vault prefix.
 * @param value Candidate full R2 object key.
 * @param vaultId Validated immutable protocol-v1 vault identity.
 * @returns Branded key when it reconstructs from an allowed M7.1 key builder.
 */
export function createSyncR2Key(
  value: string,
  vaultId: SyncVaultIdDto,
): SyncR2Key | undefined {
  if (!syncVaultIdSchema.safeParse(vaultId).success) return undefined;
  return isCanonicalSyncR2Key(value, vaultId)
    ? (value as SyncR2Key)
    : undefined;
}

/** Reconstructs each closed key family through its canonical protocol builder.
 * @param value Candidate full storage key.
 * @param vaultId Vault whose prefix is the only permitted namespace.
 * @returns Whether the candidate is exactly one allowed M7.1 key shape.
 */
export function isCanonicalSyncR2Key(
  value: string,
  vaultId: SyncVaultIdDto,
): boolean {
  const prefix = syncVaultPrefix(vaultId);
  if (!value.startsWith(prefix)) return false;
  const tail = value.slice(prefix.length);
  if (value === syncVaultMarkerKey(vaultId)) return true;

  const pathMatch = /^heads\/([^/]+)\.json$/.exec(tail);
  if (pathMatch?.[1] !== undefined) {
    const path = decodeSyncPathKey(pathMatch[1]);
    return path !== undefined && syncHeadKey(vaultId, path) === value;
  }

  const receiptMatch = /^operations\/([^/]+)\.head-refusal\.json$/.exec(tail);
  if (
    receiptMatch?.[1] !== undefined &&
    syncOperationIdSchema.safeParse(receiptMatch[1]).success
  ) {
    return (
      syncHeadRefusalReceiptKey(
        vaultId,
        syncOperationIdSchema.parse(receiptMatch[1]),
      ) === value
    );
  }

  const uuidMatch = /^(versions|content|operations)\/([^/]+)\.(json|md)$/.exec(
    tail,
  );
  if (uuidMatch?.[1] !== undefined && uuidMatch[2] !== undefined) {
    const identifier = uuidMatch[2];
    if (!syncIdentifierSchema.safeParse(identifier).success) return false;
    switch (uuidMatch[1]) {
      case "versions":
        return (
          uuidMatch[3] === "json" &&
          syncVersionKey(vaultId, syncRevisionSchema.parse(identifier)) ===
            value
        );
      case "content":
        return (
          uuidMatch[3] === "md" &&
          syncContentKey(vaultId, syncRevisionSchema.parse(identifier)) ===
            value
        );
      case "operations":
        return (
          uuidMatch[3] === "json" &&
          syncOperationKey(vaultId, syncOperationIdSchema.parse(identifier)) ===
            value
        );
    }
  }

  const recoveryMatch = /^recovery\/([^/]+)\.(json|md)$/.exec(tail);
  if (
    recoveryMatch?.[1] !== undefined &&
    recoveryMatch[2] !== undefined &&
    syncOperationIdSchema.safeParse(recoveryMatch[1]).success
  ) {
    const kind = recoveryMatch[2] === "json" ? "metadata" : "content";
    return (
      syncRecoveryKey(
        vaultId,
        syncOperationIdSchema.parse(recoveryMatch[1]),
        kind,
      ) === value
    );
  }

  if (value === syncInventoryActiveKey(vaultId)) return true;
  const manifestMatch = /^inventories\/scans\/([^/]+)\/manifest\.json$/.exec(
    tail,
  );
  if (
    manifestMatch?.[1] !== undefined &&
    syncInventoryIdSchema.safeParse(manifestMatch[1]).success
  ) {
    return (
      syncInventoryManifestKey(
        vaultId,
        syncInventoryIdSchema.parse(manifestMatch[1]),
      ) === value
    );
  }
  const chunkMatch =
    /^inventories\/scans\/([^/]+)\/chunks\/(0|[1-9][0-9]*)\.json$/.exec(tail);
  if (
    chunkMatch?.[1] !== undefined &&
    chunkMatch[2] !== undefined &&
    syncInventoryIdSchema.safeParse(chunkMatch[1]).success
  ) {
    const step = Number(chunkMatch[2]);
    return (
      Number.isSafeInteger(step) &&
      syncInventoryChunkKey(
        vaultId,
        syncInventoryIdSchema.parse(chunkMatch[1]),
        step,
      ) === value
    );
  }

  const claimMatch =
    /^inventories\/scans\/([^/]+)\/chunks\/claims\/(0|[1-9][0-9]*)\.json$/.exec(
      tail,
    );
  if (
    claimMatch?.[1] !== undefined &&
    claimMatch[2] !== undefined &&
    syncInventoryIdSchema.safeParse(claimMatch[1]).success
  ) {
    const step = Number(claimMatch[2]);
    if (!Number.isSafeInteger(step)) return false;
    try {
      return (
        syncInventoryClaimKey(
          vaultId,
          syncInventoryIdSchema.parse(claimMatch[1]),
          step,
        ) === value
      );
    } catch {
      return false;
    }
  }
  const witnessMatch =
    /^inventories\/scans\/([^/]+)\/chunks\/cursors\/([0-9a-f]{64})\.json$/.exec(
      tail,
    );
  if (
    witnessMatch?.[1] !== undefined &&
    witnessMatch[2] !== undefined &&
    syncInventoryIdSchema.safeParse(witnessMatch[1]).success
  ) {
    const digest = createContentSha256(witnessMatch[2]);
    return (
      digest !== undefined &&
      syncInventoryCursorWitnessKey(
        vaultId,
        syncInventoryIdSchema.parse(witnessMatch[1]),
        digest,
      ) === value
    );
  }

  const laneHead = /^feed\/([0-3][0-9a-f])\/head\.json$/.exec(tail);
  if (laneHead?.[1] !== undefined) {
    const lane = Number.parseInt(laneHead[1], 16);
    return lane < 64 && syncFeedLaneHeadKey(vaultId, lane) === value;
  }
  const eventMatch = /^feed\/([0-3][0-9a-f])\/events\/([0-9]{20})\.json$/.exec(
    tail,
  );
  if (
    eventMatch?.[1] !== undefined &&
    eventMatch[2] !== undefined &&
    syncEventSequenceSchema.safeParse(eventMatch[2]).success
  ) {
    const lane = Number.parseInt(eventMatch[1], 16);
    return (
      lane < 64 &&
      syncFeedEventKey(
        vaultId,
        lane,
        syncEventSequenceSchema.parse(eventMatch[2]),
      ) === value
    );
  }
  return false;
}
