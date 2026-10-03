import {
  decodeSyncPathKey,
  syncHeadKey,
  syncVaultPrefix,
} from "@protocol/sync.codec";
import { syncVaultIdSchema } from "@protocol/sync.schemas";
import type { SyncVaultIdDto } from "@protocol/sync.types";
import type {
  R2ConditionalBucketPort,
  R2ListResult,
} from "@worker/infrastructure/r2.types";
import type { SyncRecordRead } from "@worker/infrastructure/sync/sync-r2.types";
import { createSyncR2Key } from "@worker/infrastructure/sync/sync-r2-key";
import { syncR2ObjectStore } from "@worker/infrastructure/sync/sync-r2-object";
import { decodeSyncRecord } from "@worker/infrastructure/sync/sync-record.codec";
import { SYNC_RECORD_LIMITS } from "@worker/infrastructure/sync/sync-record.schemas";
import type { SyncHeadRecord } from "@worker/infrastructure/sync/sync-record.types";

/** Bounded private listing read that never accepts a caller-controlled namespace prefix. */
export type SyncInventoryListRead =
  | { readonly kind: "page"; readonly page: R2ListResult }
  | { readonly kind: "unavailable" };

/** R2-only listing and head-body reads restricted to exact protocol-v1 vault heads. */
export interface SyncR2InventoryListing {
  /** Lists at most one entry from the isolated heads prefix; the cursor remains private.
   * @param vaultId Validated sync-v1 namespace.
   * @param cursor Opaque R2 continuation supplied only by durable manifest evidence.
   * @returns A full raw page or unavailable evidence; partial pages are not accepted.
   */
  listHeads(
    vaultId: SyncVaultIdDto,
    cursor: string | null,
  ): Promise<SyncInventoryListRead>;
  /** Reads only a canonical key within this vault's head prefix and bounded body.
   * @param vaultId Validated sync-v1 namespace.
   * @param key Canonical head key found in this scan's bounded list page.
   * @param maxBytes Upper bound no greater than the strict head-record limit.
   * @returns Validated head with exact observation, absence, or unavailable evidence.
   */
  readHead(
    vaultId: SyncVaultIdDto,
    key: string,
    maxBytes: number,
  ): Promise<SyncRecordRead<SyncHeadRecord>>;
}

/** Builds a prefix-limited reader atop an invocation-counted raw R2 binding.
 * @param bucket R2 capability already wrapped by the inventory invocation budget.
 * @returns Only vault-scoped one-entry list and validated head-body reads.
 */
export function syncR2InventoryListing(
  bucket: R2ConditionalBucketPort,
): SyncR2InventoryListing {
  const objects = syncR2ObjectStore(bucket);
  return {
    async listHeads(vaultId, cursor) {
      if (
        !syncVaultIdSchema.safeParse(vaultId).success ||
        (cursor !== null && cursor.length === 0)
      ) {
        return { kind: "unavailable" };
      }
      try {
        const prefix = `${syncVaultPrefix(vaultId)}heads/`;
        const page = await bucket.list(
          cursor === null ? { prefix, limit: 1 } : { prefix, cursor, limit: 1 },
        );
        if (
          !Array.isArray(page.objects) ||
          page.objects.length > 1 ||
          (page.truncated &&
            (typeof page.cursor !== "string" ||
              page.cursor.length === 0 ||
              new TextEncoder().encode(page.cursor).byteLength >
                SYNC_RECORD_LIMITS.cursorBytes)) ||
          (!page.truncated && "cursor" in page && page.cursor !== undefined)
        )
          return { kind: "unavailable" };
        return { kind: "page", page };
      } catch {
        return { kind: "unavailable" };
      }
    },
    async readHead(vaultId, key, maxBytes) {
      if (
        !syncVaultIdSchema.safeParse(vaultId).success ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 0 ||
        maxBytes > SYNC_RECORD_LIMITS.headBytes
      ) {
        return { kind: "unavailable" };
      }
      const prefix = `${syncVaultPrefix(vaultId)}heads/`;
      if (!key.startsWith(prefix) || !key.endsWith(".json"))
        return { kind: "unavailable" };
      const path = decodeSyncPathKey(key.slice(prefix.length, -5));
      if (path === undefined || syncHeadKey(vaultId, path) !== key)
        return { kind: "unavailable" };
      const validated = createSyncR2Key(key, vaultId);
      if (validated === undefined) return { kind: "unavailable" };
      const result = await objects.read(validated, maxBytes);
      if (result.kind !== "observed") return result;
      try {
        const record = await decodeSyncRecord(
          "head",
          key,
          result.observation.bytes,
          vaultId,
        );
        return record.kind === "head"
          ? {
              kind: "observed",
              observation: {
                value: record.record,
                observed: result.observation,
              },
            }
          : { kind: "unavailable" };
      } catch {
        return { kind: "unavailable" };
      }
    },
  };
}
