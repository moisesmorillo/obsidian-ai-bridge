import type {
  SyncCurrentState,
  SyncReadCurrentInput,
  SyncReadCurrentResult,
  SyncReadRecoveryInput,
  SyncReadRecoveryResult,
  SyncReadVersionInput,
  SyncReadVersionResult,
} from "@core/sync/sync-store.types";
import { decodeUtf8 } from "@obsidian-ai-bridge/core";
import {
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@protocol/sync.schemas";
import type { SyncVaultIdDto } from "@protocol/sync.types";
import type { SyncR2Records } from "@worker/infrastructure/sync/sync-r2-records";
import type {
  SyncBodyRecord,
  SyncHeadRecord,
  SyncVersionMetadata,
} from "@worker/infrastructure/sync/sync-record.types";

/** Verified live metadata and exact parent bytes required before a tombstone write. */
export interface SyncR2TombstoneSource {
  /** Immutable source version whose path, digest, and origin authorize recovery. */
  readonly version: Extract<SyncVersionMetadata, { readonly kind: "live" }>;
  /** Exact validated UTF-8 source bytes copied into operation-bound recovery storage. */
  readonly body: Extract<SyncBodyRecord, { readonly kind: "contentBody" }>;
}

/** Reads current, immutable version, and recovery evidence through the marker-gated record adapter.
 * @param records Marker-gated validated-record persistence capability.
 * @returns Read methods that expose only records with exact linked evidence.
 */
export function syncR2MutationReads(records: SyncR2Records) {
  /** Reads a head only when its linked immutable version is complete and exact.
   * @param input Validated-vault and canonical-path request for the current head.
   * @returns Never-seen state, exact current state, or a typed read failure.
   */
  async function readCurrent(
    input: SyncReadCurrentInput,
  ): Promise<SyncReadCurrentResult> {
    const vault = syncVaultIdSchema.safeParse(input.vaultId);
    const path = syncNotePathSchema.safeParse(input.path);
    if (!vault.success || !path.success) {
      return { kind: "error", code: "invalid_input" };
    }

    try {
      const result = await records.readHead(vault.data, path.data);
      if (result.kind === "unavailable") {
        return { kind: "error", code: "storage_unavailable" };
      }
      if (result.kind === "absent") return { kind: "never_seen" };
      const head = result.observation.value;
      const version = await records.readVersion(vault.data, head.revision);
      if (
        version.kind !== "observed" ||
        !syncR2SameVersionMetadata(head, version.observation.value)
      ) {
        return { kind: "error", code: "storage_unavailable" };
      }
      return syncR2CurrentStateFromHead(head);
    } catch {
      return { kind: "error", code: "storage_unavailable" };
    }
  }

  /** Reads immutable metadata and live bytes only after their exact evidence verifies.
   * @param input Validated-vault and revision request for one immutable version.
   * @returns The verified live or tombstone version, absence, or a typed failure.
   */
  async function readVersion(
    input: SyncReadVersionInput,
  ): Promise<SyncReadVersionResult> {
    const vault = syncVaultIdSchema.safeParse(input.vaultId);
    const revision = syncRevisionSchema.safeParse(input.revision);
    if (!vault.success || !revision.success) {
      return { kind: "error", code: "invalid_input" };
    }

    try {
      const result = await records.readVersion(vault.data, revision.data);
      if (result.kind === "absent") return { kind: "absent" };
      if (result.kind === "unavailable") {
        return { kind: "error", code: "storage_unavailable" };
      }
      const version = result.observation.value;
      if (version.kind === "tombstone") {
        return {
          kind: "present",
          version: {
            kind: "tombstone",
            vaultId: version.vaultId,
            path: version.path,
            revision: version.revision,
            parent: version.parent,
            contentSha256: version.contentSha256,
            byteSize: version.byteSize,
            mediaType: version.mediaType,
            operationId: version.operationId,
            origin: version.origin,
          },
        };
      }
      const body = await records.readContent(vault.data, revision.data);
      if (
        body.kind !== "observed" ||
        body.observation.value.byteSize !== version.byteSize ||
        body.observation.value.contentSha256 !== version.contentSha256
      ) {
        return { kind: "error", code: "storage_unavailable" };
      }
      const content = decodeUtf8(body.observation.value.bytes);
      if (content === undefined) {
        return { kind: "error", code: "storage_unavailable" };
      }
      return {
        kind: "present",
        version: {
          kind: "live",
          vaultId: version.vaultId,
          path: version.path,
          revision: version.revision,
          parent: version.parent,
          contentSha256: version.contentSha256,
          byteSize: version.byteSize,
          mediaType: version.mediaType,
          content,
          operationId: version.operationId,
          origin: version.origin,
        },
      };
    } catch {
      return { kind: "error", code: "storage_unavailable" };
    }
  }

  /** Reads recovery bytes only when metadata matches the retained live version exactly.
   * @param input Validated-vault and operation identity for retained recovery evidence.
   * @returns Exact recovery content, absence, or a typed read failure.
   */
  async function readRecovery(
    input: SyncReadRecoveryInput,
  ): Promise<SyncReadRecoveryResult> {
    const vault = syncVaultIdSchema.safeParse(input.vaultId);
    if (!vault.success || !syncOperationId(input.operationId)) {
      return { kind: "error", code: "invalid_input" };
    }

    try {
      const operationId = input.operationId;
      const result = await records.readRecovery(vault.data, operationId);
      if (result.kind === "absent") return { kind: "absent" };
      if (result.kind === "unavailable") {
        return { kind: "error", code: "storage_unavailable" };
      }
      const recovery = result.observation.value;
      const source = await syncR2ReadTombstoneSource(
        records,
        vault.data,
        recovery.path,
        recovery.sourceRevision,
        recovery.contentSha256,
        recovery.byteSize,
      );
      if (source === undefined || source.version.origin !== recovery.origin) {
        return { kind: "error", code: "storage_unavailable" };
      }
      const content = decodeUtf8(source.body.bytes);
      if (content === undefined) {
        return { kind: "error", code: "storage_unavailable" };
      }
      return {
        kind: "present",
        recovery: {
          vaultId: recovery.vaultId,
          path: recovery.path,
          operationId: recovery.operationId,
          sourceRevision: recovery.sourceRevision,
          contentSha256: recovery.contentSha256,
          byteSize: recovery.byteSize,
          mediaType: recovery.mediaType,
          content,
          origin: recovery.origin,
        },
      };
    } catch {
      return { kind: "error", code: "storage_unavailable" };
    }
  }

  return { readCurrent, readVersion, readRecovery };
}

/** Rechecks a persisted tombstone source and its exact body before recovery publication.
 * @param records Validated-record reader for the immutable source objects.
 * @param vaultId Validated namespace containing the source revision.
 * @param path Exact canonical path bound to the source head.
 * @param revision Immutable source revision retained by the tombstone.
 * @param contentSha256 Expected digest recorded by the tombstone request.
 * @param expectedByteSize Optional exact source size persisted in recovery metadata.
 * @returns Verified live source metadata and bytes, or undefined when evidence diverges.
 */
export async function syncR2ReadTombstoneSource(
  records: SyncR2Records,
  vaultId: SyncVaultIdDto,
  path: SyncHeadRecord["path"],
  revision: SyncHeadRecord["revision"],
  contentSha256: SyncHeadRecord["contentSha256"],
  expectedByteSize?: number,
): Promise<SyncR2TombstoneSource | undefined> {
  const version = await records.readVersion(vaultId, revision);
  if (
    version.kind !== "observed" ||
    version.observation.value.kind !== "live" ||
    version.observation.value.path !== path ||
    version.observation.value.contentSha256 !== contentSha256 ||
    (expectedByteSize !== undefined &&
      version.observation.value.byteSize !== expectedByteSize)
  ) {
    return undefined;
  }
  const body = await records.readContent(vaultId, revision);
  if (
    body.kind !== "observed" ||
    body.observation.value.byteSize !== version.observation.value.byteSize ||
    body.observation.value.contentSha256 !==
      version.observation.value.contentSha256
  ) {
    return undefined;
  }
  return {
    version: version.observation.value,
    body: body.observation.value,
  };
}

/** Projects validated persisted head metadata into the storage-independent current-state union.
 * @param head Strictly validated current-head record.
 * @returns The corresponding live or tombstone core state without adapter evidence.
 */
export function syncR2CurrentStateFromHead(
  head: SyncHeadRecord,
): SyncCurrentState {
  if (head.kind === "live") {
    return {
      kind: "live",
      revision: head.revision,
      parent: head.parent,
      contentSha256: head.contentSha256,
      byteSize: head.byteSize,
      mediaType: head.mediaType,
      operationId: head.operationId,
      origin: head.origin,
    };
  }
  return {
    kind: "tombstone",
    revision: head.revision,
    parent: head.parent,
    contentSha256: head.contentSha256,
    byteSize: head.byteSize,
    mediaType: head.mediaType,
    operationId: head.operationId,
    origin: head.origin,
  };
}

/** Requires a mutable head and its immutable version to agree on every authority field.
 * @param head Mutable current-head record being verified against its immutable version.
 * @param version Immutable version metadata referenced by that head.
 * @returns Whether vault, revision, ancestry, content, and provenance fields all agree.
 */
export function syncR2SameVersionMetadata(
  head: SyncHeadRecord,
  version: SyncVersionMetadata,
): boolean {
  return (
    head.kind === version.kind &&
    head.vaultId === version.vaultId &&
    head.path === version.path &&
    head.revision === version.revision &&
    head.parent.kind === version.parent.kind &&
    (head.parent.kind === "never_seen" ||
      (version.parent.kind === "revision" &&
        head.parent.revision === version.parent.revision)) &&
    head.contentSha256 === version.contentSha256 &&
    head.byteSize === version.byteSize &&
    head.mediaType === version.mediaType &&
    head.operationId === version.operationId &&
    head.origin === version.origin
  );
}

/** Validates one operation identity before recovery metadata can be addressed.
 * @param value Caller-provided operation identity.
 * @returns Whether the value is a canonical protocol operation UUID.
 */
function syncOperationId(value: string): boolean {
  return syncOperationIdSchema.safeParse(value).success;
}
