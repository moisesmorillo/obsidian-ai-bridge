import type { ContentSha256 } from "@core/mirror/mirror.types";
import type {
  SyncEventSequence,
  SyncInventoryId,
  SyncNotePath,
  SyncOperationId,
  SyncOrigin,
  SyncRevision,
  SyncSequence,
  SyncVaultId,
} from "@core/sync/sync.types";

/** Exact parent evidence required before a new path generation can be published. */
export type SyncMutationParent =
  | { readonly kind: "never_seen" }
  | { readonly kind: "revision"; readonly revision: SyncRevision };

/** Closed protocol-major-one failure authority for core sync-store operations. */
export type SyncStoreErrorCode =
  | "invalid_input"
  | "unsupported_protocol_version"
  | "vault_not_found"
  | "stale_revision"
  | "operation_id_reused"
  | "cursor_expired"
  | "invalid_cursor"
  | "inventory_incomplete"
  | "inventory_limit_exceeded"
  | "inventory_expired"
  | "inventory_id_reused"
  | "sequence_exhausted"
  | "storage_throttled"
  | "operation_pending"
  | "effect_unknown"
  | "storage_unavailable";

/** Error-code subset whose failures need no operation, inventory, or retry context. */
type SyncContextFreeErrorCode = Exclude<
  SyncStoreErrorCode,
  | "storage_throttled"
  | "operation_pending"
  | "effect_unknown"
  | "storage_unavailable"
>;

/** Typed failure outcomes; contextual IDs and safe retry times appear only when applicable. */
export type SyncStoreFailure =
  | { readonly kind: "error"; readonly code: SyncContextFreeErrorCode }
  | {
      readonly kind: "error";
      readonly code: "storage_throttled";
      /** Earliest safe retry time in Unix epoch milliseconds. */
      readonly retryAfterEpochMs: number;
    }
  | {
      readonly kind: "error";
      readonly code: "operation_pending";
      /** Stable identity required to resume the incomplete mutation. */
      readonly operationId: SyncOperationId;
      /** Earliest safe retry time when a known storage cooldown applies. */
      readonly retryAfterEpochMs?: number;
    }
  | {
      readonly kind: "error";
      readonly code: "effect_unknown";
      /** Earliest safe retry time when a write outcome has a known cooldown. */
      readonly retryAfterEpochMs?: number;
    }
  | {
      readonly kind: "error";
      readonly code: "effect_unknown";
      /** Mutation whose durable effect could not be established. */
      readonly operationId: SyncOperationId;
      /** Earliest safe retry time when a write outcome has a known cooldown. */
      readonly retryAfterEpochMs?: number;
    }
  | {
      readonly kind: "error";
      readonly code: "effect_unknown";
      /** Inventory whose progress write could not be established. */
      readonly inventoryId: SyncInventoryId;
      /** Earliest safe retry time when a write outcome has a known cooldown. */
      readonly retryAfterEpochMs?: number;
    }
  | { readonly kind: "error"; readonly code: "storage_unavailable" }
  | {
      readonly kind: "error";
      readonly code: "storage_unavailable";
      /** Stable scan identity retained for a same-ID inventory retry. */
      readonly inventoryId: SyncInventoryId;
    };

/** Current path-head evidence; `never_seen` is valid only after a successful read. */
export type SyncCurrentState =
  | SyncNeverSeenState
  | SyncLiveCurrentState
  | SyncTombstoneCurrentState;

/** Successful observation proving that a path has no prior sync revision. */
export interface SyncNeverSeenState {
  /** Distinguishes verified absence from incomplete or uncertain storage evidence. */
  readonly kind: "never_seen";
}

/** Immutable metadata for the live revision currently published at a path. */
export interface SyncLiveCurrentState {
  /** Identifies a current live note body. */
  readonly kind: "live";
  /** Exact published generation; it is never an R2 ETag. */
  readonly revision: SyncRevision;
  /** Parent generation or verified never-seen state used to publish this head. */
  readonly parent: SyncMutationParent;
  /** SHA-256 of the exact UTF-8 body bytes. */
  readonly contentSha256: ContentSha256;
  /** Exact body size measured in UTF-8 bytes. */
  readonly byteSize: number;
  /** Only Markdown bodies are supported by this protocol major. */
  readonly mediaType: "text/markdown";
  /** Mutation that published this generation. */
  readonly operationId: SyncOperationId;
  /** Typed installation identity recorded as the mutation origin. */
  readonly origin: SyncOrigin;
}

/** Immutable metadata for a revisioned deletion with retained recovery evidence. */
export interface SyncTombstoneCurrentState {
  /** Distinguishes a tombstone from a path that has never existed. */
  readonly kind: "tombstone";
  /** Exact published tombstone generation. */
  readonly revision: SyncRevision;
  /** Exact live parent whose content is preserved for recovery. */
  readonly parent: Extract<SyncMutationParent, { readonly kind: "revision" }>;
  /** Digest of the preserved parent body, not a body stored in the tombstone. */
  readonly contentSha256: ContentSha256;
  /** UTF-8 byte size of the preserved parent body. */
  readonly byteSize: number;
  /** Media type of the preserved parent body. */
  readonly mediaType: "text/markdown";
  /** Mutation that published this tombstone. */
  readonly operationId: SyncOperationId;
  /** Typed installation identity recorded as the mutation origin. */
  readonly origin: SyncOrigin;
}

/** Shared immutable identity fields for each create, update, or tombstone request. */
interface SyncMutationIdentity {
  /** Validated vault namespace receiving the mutation. */
  readonly vaultId: SyncVaultId;
  /** Canonical, validated Markdown path whose head is conditionally changed. */
  readonly path: SyncNotePath;
  /** Stable idempotency identity bound to every request field. */
  readonly operationId: SyncOperationId;
  /** Fresh application-owned revision to publish if the request proceeds. */
  readonly revision: SyncRevision;
  /** Installation identity retained as immutable mutation provenance. */
  readonly origin: SyncOrigin;
}

/** Create-only request whose parent explicitly proves the path was never seen. */
export interface SyncCreateRequest extends SyncMutationIdentity {
  /** Selects the create-only transition. */
  readonly kind: "create";
  /** Create is valid only against verified never-seen absence. */
  readonly parent: Extract<SyncMutationParent, { readonly kind: "never_seen" }>;
  /** Expected SHA-256 of the exact UTF-8 content bytes. */
  readonly contentSha256: ContentSha256;
  /** Exact transient Markdown payload; whitespace and bytes are not normalized. */
  readonly content: string;
  /** Fixed supported media type for live sync content. */
  readonly mediaType: "text/markdown";
}

/** Conditional replacement request bound to one exact live or tombstone revision. */
export interface SyncUpdateRequest extends SyncMutationIdentity {
  /** Selects a new live revision over an established path head. */
  readonly kind: "update";
  /** Exact previously observed live or tombstone generation. */
  readonly parent: Extract<SyncMutationParent, { readonly kind: "revision" }>;
  /** Expected SHA-256 of the exact UTF-8 replacement bytes. */
  readonly contentSha256: ContentSha256;
  /** Exact transient Markdown payload; whitespace and bytes are not normalized. */
  readonly content: string;
  /** Fixed supported media type for live sync content. */
  readonly mediaType: "text/markdown";
}

/** Conditional tombstone request that preserves the exact observed live parent. */
export interface SyncTombstoneRequest extends SyncMutationIdentity {
  /** Selects revisioned deletion; never represents never-seen absence. */
  readonly kind: "tombstone";
  /** Exact live revision whose body and digest must be retained for recovery. */
  readonly parent: Extract<SyncMutationParent, { readonly kind: "revision" }>;
  /** Digest expected for the preserved parent body. */
  readonly contentSha256: ContentSha256;
}

/** Closed set of immutable conditional mutations accepted by the port. */
export type SyncMutationRequest =
  | SyncCreateRequest
  | SyncUpdateRequest
  | SyncTombstoneRequest;

/** Resulting event position after its feed record has been committed and verified. */
export interface SyncCommittedPosition {
  /** Zero-based lane in the protocol's fixed 64-lane feed. */
  readonly lane: number;
  /** Non-zero sequence of the committed event, never a pending reservation. */
  readonly sequence: SyncEventSequence;
}

/** Exact durable success returned only after the change-feed event is committed. */
export interface SyncMutationSuccess {
  /** Confirms a committed operation, not merely a reservation or uncertain effect. */
  readonly kind: "committed";
  /** Exact new live or tombstone revision published by this operation. */
  readonly revision: SyncRevision;
  /** Stable idempotency identity of the committed mutation. */
  readonly operationId: SyncOperationId;
  /** Verified feed position assigned to the committed event. */
  readonly position: SyncCommittedPosition;
}

/** Complete mutation outcome, including typed non-success storage states. */
export type SyncMutationResult = SyncMutationSuccess | SyncStoreFailure;

/** Live or tombstone head state produced by an immutable version record. */
export type SyncVersionRecord =
  | {
      /** Live versions expose their exact body only to a version read. */
      readonly kind: "live";
      /** Vault and canonical path bound into the immutable version. */
      readonly vaultId: SyncVaultId;
      readonly path: SyncNotePath;
      /** Revision key identifying this immutable generation. */
      readonly revision: SyncRevision;
      /** Exact parent evidence used when publishing this revision. */
      readonly parent: SyncMutationParent;
      /** Digest of the stored body's exact UTF-8 bytes. */
      readonly contentSha256: ContentSha256;
      /** Exact stored body size in UTF-8 bytes. */
      readonly byteSize: number;
      /** Fixed media type for the stored body. */
      readonly mediaType: "text/markdown";
      /** Exact UTF-8 body decoded without normalization. */
      readonly content: string;
      /** Operation that created the immutable version. */
      readonly operationId: SyncOperationId;
      /** Typed installation identity recorded as the version origin. */
      readonly origin: SyncOrigin;
    }
  | {
      /** Tombstone versions preserve metadata but do not contain note text. */
      readonly kind: "tombstone";
      /** Vault and canonical path bound into the immutable version. */
      readonly vaultId: SyncVaultId;
      readonly path: SyncNotePath;
      /** Revision key identifying this immutable tombstone. */
      readonly revision: SyncRevision;
      /** Exact live parent whose content is retained as recovery evidence. */
      readonly parent: Extract<
        SyncMutationParent,
        { readonly kind: "revision" }
      >;
      /** Digest of the preserved parent body. */
      readonly contentSha256: ContentSha256;
      /** UTF-8 byte size of the preserved parent body. */
      readonly byteSize: number;
      /** Media type of the preserved parent body. */
      readonly mediaType: "text/markdown";
      /** Operation that created the immutable tombstone. */
      readonly operationId: SyncOperationId;
      /** Typed installation identity recorded as the tombstone origin. */
      readonly origin: SyncOrigin;
    };

/** Immutable recovery body and provenance retained for a tombstoned live revision. */
export interface SyncRecoveryRecord {
  /** Vault and canonical path to which the recovery body belongs. */
  readonly vaultId: SyncVaultId;
  readonly path: SyncNotePath;
  /** Tombstone operation whose recovery material this record serves. */
  readonly operationId: SyncOperationId;
  /** Exact live revision preserved before the tombstone was published. */
  readonly sourceRevision: SyncRevision;
  /** Digest of the exact recovered UTF-8 body bytes. */
  readonly contentSha256: ContentSha256;
  /** Exact recovered body size in UTF-8 bytes. */
  readonly byteSize: number;
  /** Fixed media type for recovered sync content. */
  readonly mediaType: "text/markdown";
  /** Exact stored recovery body decoded without normalization. */
  readonly content: string;
  /** Typed installation identity retained from the source revision. */
  readonly origin: SyncOrigin;
}

/** Input to a vault-scoped current-head observation. */
export interface SyncReadCurrentInput {
  /** Validated immutable vault identity. */
  readonly vaultId: SyncVaultId;
  /** Canonical path whose live, tombstone, or never-seen state is requested. */
  readonly path: SyncNotePath;
}

/** Current-head observation or a typed failure; never-seen is a successful read only. */
export type SyncReadCurrentResult = SyncCurrentState | SyncStoreFailure;

/** Input to read one immutable version by its vault-unique revision identity. */
export interface SyncReadVersionInput {
  /** Validated immutable vault identity. */
  readonly vaultId: SyncVaultId;
  /** Exact immutable revision identity to retrieve. */
  readonly revision: SyncRevision;
}

/** Closed present-or-absent result for one immutable version lookup. */
export type SyncReadVersionResult =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly version: SyncVersionRecord }
  | SyncStoreFailure;

/** Input to read tombstone recovery material by its deleting operation identity. */
export interface SyncReadRecoveryInput {
  /** Validated immutable vault identity. */
  readonly vaultId: SyncVaultId;
  /** Tombstone operation whose immutable recovery body is requested. */
  readonly operationId: SyncOperationId;
}

/** Closed present-or-absent result for one immutable recovery lookup. */
export type SyncReadRecoveryResult =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly recovery: SyncRecoveryRecord }
  | SyncStoreFailure;

/** Opaque, validated protocol checkpoint cursor bound to one vault. */
export type SyncCheckpointCursor = string;

/** Input to one bounded page of metadata-only committed change events. */
export interface SyncReadChangesInput {
  /** Validated immutable vault identity. */
  readonly vaultId: SyncVaultId;
  /** Opaque protocol checkpoint cursor previously issued for this vault. */
  readonly cursor: SyncCheckpointCursor;
}

/** Metadata-only resulting state carried by a changed feed event. */
export type SyncChangedResult =
  | { readonly kind: "live"; readonly revision: SyncRevision }
  | { readonly kind: "tombstone"; readonly revision: SyncRevision };

/** Typed reason recorded when an operation aborts before changing the current head. */
export type SyncAbortedChangeReason = SyncStoreErrorCode;

/** One committed metadata-only changed or aborted event in the feed. */
export type SyncChangeEvent =
  | {
      /** A committed mutation published the described current generation. */
      readonly kind: "changed";
      /** Zero-based lane containing the committed event. */
      readonly lane: number;
      /** Non-zero committed event sequence within its lane. */
      readonly sequence: SyncEventSequence;
      /** Canonical path whose resulting head changed. */
      readonly path: SyncNotePath;
      /** New live or tombstone revision; note content is never included. */
      readonly result: SyncChangedResult;
      /** Stable operation responsible for the published generation. */
      readonly operationId: SyncOperationId;
      /** Typed installation identity recorded as the mutation origin. */
      readonly origin: SyncOrigin;
      /** Server commit time in Unix epoch milliseconds, monotonic per lane. */
      readonly committedAtEpochMs: number;
    }
  | {
      /** A reserved operation was conclusively aborted without changing its head. */
      readonly kind: "aborted";
      /** Zero-based lane containing the committed abort event. */
      readonly lane: number;
      /** Non-zero committed event sequence within its lane. */
      readonly sequence: SyncEventSequence;
      /** Stable identity of the aborted operation. */
      readonly operationId: SyncOperationId;
      /** Closed storage failure reason proving why publication was aborted. */
      readonly reason: SyncAbortedChangeReason;
      /** Server commit time in Unix epoch milliseconds, monotonic per lane. */
      readonly committedAtEpochMs: number;
    };

/** One page of changes or a typed failure; errors never become empty-success pages. */
export type SyncReadChangesResult =
  | {
      readonly kind: "page";
      readonly events: readonly SyncChangeEvent[];
      readonly nextCursor: SyncCheckpointCursor;
    }
  | SyncStoreFailure;

/** Input to create or resume one explicitly identified bounded inventory scan. */
export interface SyncStartInventoryInput {
  /** Validated immutable vault identity. */
  readonly vaultId: SyncVaultId;
  /** Stable identity reused only to resume this exact scan. */
  readonly inventoryId: SyncInventoryId;
}

/** Input to perform one bounded continuation step for the same inventory scan. */
export interface SyncContinueInventoryInput {
  /** Validated immutable vault identity. */
  readonly vaultId: SyncVaultId;
  /** Exact scan identity previously returned for this vault. */
  readonly inventoryId: SyncInventoryId;
}

/** Progress that cannot prove a complete inventory or establish absence. */
export interface SyncInventoryProgress {
  /** Identifies resumable progress rather than a complete snapshot. */
  readonly kind: "inventory_in_progress";
  /** Vault namespace containing the scan. */
  readonly vaultId: SyncVaultId;
  /** Stable scan identity required for continuation. */
  readonly inventoryId: SyncInventoryId;
  /** Earliest safe continuation time when storage supplies a cooldown. */
  readonly retryAfterEpochMs?: number;
}

/** Fully verified inventory snapshot handle; no entries are exposed by this result. */
export interface SyncCompleteInventory {
  /** Distinguishes a verified handle from partial scan progress. */
  readonly kind: "complete";
  /** Vault namespace whose snapshot vector was captured. */
  readonly vaultId: SyncVaultId;
  /** Stable scan identity whose evidence chain was verified. */
  readonly inventoryId: SyncInventoryId;
  /** Stable 64-lane feed generation vector surrounding the scan. */
  readonly vector: readonly SyncSequence[];
  /** Total verified live and tombstone path summaries in the snapshot. */
  readonly entryCount: number;
  /** Number of immutable evidence chunks bound by the final root. */
  readonly chunkCount: number;
  /** SHA-256 root of the verified contiguous evidence chain. */
  readonly root: ContentSha256;
}

/** Inventory progress, complete handle, or closed store failure. */
export type SyncInventoryResult =
  | SyncInventoryProgress
  | SyncCompleteInventory
  | SyncStoreFailure;

/** Opaque continuation over verified inventory evidence, never an R2 listing cursor. */
export type SyncInventoryEvidenceCursor = string;

/** Content-free summary of one live or tombstone head in verified inventory evidence. */
export interface SyncInventorySummary {
  /** Canonical note path represented by this head. */
  readonly path: SyncNotePath;
  /** Current head state, including tombstones but excluding never-seen paths. */
  readonly kind: "live" | "tombstone";
  /** Exact current revision represented by the summary. */
  readonly revision: SyncRevision;
}

/** Input to page through evidence only after receiving a complete inventory handle. */
export interface SyncReadInventoryPageInput {
  /** Validated immutable vault identity matching the handle. */
  readonly vaultId: SyncVaultId;
  /** Complete snapshot handle returned by start or continue. */
  readonly handle: SyncCompleteInventory;
  /** Opaque evidence cursor from the previous verified page, or initial cursor. */
  readonly cursor: SyncInventoryEvidenceCursor;
}

/** Bounded nonterminal page; an empty page may still have continuation evidence. */
export interface SyncInventoryEvidencePage {
  /** At most 16 verified content-free head summaries. */
  readonly kind: "page";
  /** Contiguous summaries whose chunk evidence was validated. */
  readonly summaries: readonly SyncInventorySummary[];
  /** Continuation cursor; its presence does not imply inventory completion. */
  readonly nextCursor: SyncInventoryEvidenceCursor;
  /** False until the complete count and root have been verified. */
  readonly final: false;
}

/** Terminal page marker returned only after verifying the complete count and root. */
export interface SyncCompleteInventoryEvidencePage {
  /** Distinguishes verified completion from evidence-page progress. */
  readonly kind: "complete";
  /** Final contiguous summaries, bounded to 16. */
  readonly summaries: readonly SyncInventorySummary[];
  /** No further evidence remains after terminal verification. */
  readonly nextCursor: null;
  /** True only after the handle's full count and root have been verified. */
  readonly final: true;
}

/** Bounded evidence page, verified terminal marker, or typed failure. */
export type SyncReadInventoryPageResult =
  | SyncInventoryEvidencePage
  | SyncCompleteInventoryEvidencePage
  | SyncStoreFailure;

/** Input to resume an existing mutation journal by its stable operation identity. */
export interface SyncResumeOperationInput {
  /** Validated immutable vault identity. */
  readonly vaultId: SyncVaultId;
  /** Operation identity originally bound to the immutable request. */
  readonly operationId: SyncOperationId;
}

/** Operation state after resumption; pending or uncertain work is never success. */
export type SyncResumeOperationResult = SyncMutationResult;

/** Durable journal observation used to evaluate idempotent mutation replay. */
export type SyncOperationRecord =
  | {
      /** Exact request is journaled but has not reached verified commit. */
      readonly kind: "pending";
      /** Full immutable request bound by the operation identity. */
      readonly request: SyncMutationRequest;
    }
  | {
      /** Exact request and committed feed position have been verified. */
      readonly kind: "committed";
      /** Full immutable request bound by the operation identity. */
      readonly request: SyncMutationRequest;
      /** Position is committed, never a pending lane reservation. */
      readonly position: SyncCommittedPosition;
    }
  | {
      /** Read-back could not establish whether the original durable effect occurred. */
      readonly kind: "unknown";
      /** Original request identity retained for safe same-ID retry only. */
      readonly request: SyncMutationRequest;
    };
