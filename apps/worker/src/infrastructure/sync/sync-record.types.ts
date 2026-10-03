import type { ContentSha256 } from "@obsidian-ai-bridge/core";
import type {
  SyncDeviceIdDto,
  SyncInventoryIdDto,
  SyncNotePathDto,
  SyncOperationIdDto,
  SyncRevisionDto,
  SyncSequenceDto,
  SyncVaultIdDto,
} from "@protocol/sync.types";

/** Private record families accepted below a protocol-major-one vault prefix. */
export type SyncRecordKind =
  | "vaultMarker"
  | "head"
  | "version"
  | "contentBody"
  | "recoveryMetadata"
  | "recoveryBody"
  | "activeSlot"
  | "manifest"
  | "chunk"
  | "cursorJournal"
  | "cursorWitness";

/** Exact wire metadata shared by every strict private JSON envelope. */
interface SyncRecordEnvelope {
  /** Schema generation for the private record representation. */
  readonly schemaVersion: 1;
  /** Protocol major whose closed storage contract governs the record. */
  readonly protocolMajor: 1;
  /** Vault namespace to which all enclosed authority-bearing data belongs. */
  readonly vaultId: SyncVaultIdDto;
}

/** Parent predicate binding an immutable revision to its observed predecessor. */
export type SyncRecordParent =
  | {
      /** No earlier sync generation existed for the path. */
      readonly kind: "never_seen";
    }
  | {
      /** Parent state is an exact immutable revision. */
      readonly kind: "revision";
      /** Revision whose observation authorized this next state. */
      readonly revision: SyncRevisionDto;
    };

/** Fields binding a live body or a tombstone's preserved parent body to version provenance. */
interface SyncVersionMetadataBase extends SyncRecordEnvelope {
  /** Canonical NotePath represented by this revision. */
  readonly path: SyncNotePathDto;
  /** Immutable version identifier encoded into the metadata and body keys. */
  readonly revision: SyncRevisionDto;
  /** Exact previously observed path state used as the mutation precondition. */
  readonly parent: SyncRecordParent;
  /** SHA-256 of live content, or of the parent body retained for a tombstone. */
  readonly contentSha256: ContentSha256;
  /** Exact UTF-8 byte count of the live or preserved parent body. */
  readonly byteSize: number;
  /** Fixed Markdown media type supported by this protocol major. */
  readonly mediaType: "text/markdown";
  /** Stable operation whose request published this revision. */
  readonly operationId: SyncOperationIdDto;
  /** Installation identity retained as non-authoritative mutation provenance. */
  readonly origin: SyncDeviceIdDto;
}

/** Strict current-head metadata stored separately from an immutable body. */
export type SyncHeadRecord = SyncVersionMetadataBase &
  (
    | { readonly kind: "live" }
    | {
        readonly kind: "tombstone";
        readonly parent: Extract<
          SyncRecordParent,
          { readonly kind: "revision" }
        >;
      }
  );

/** Strict immutable version metadata; only live revisions own content bodies. */
export type SyncVersionMetadata = SyncHeadRecord;

/** Tombstone-linked metadata for the exact preserved source body. */
export interface SyncRecoveryMetadata extends SyncRecordEnvelope {
  /** Canonical path to which the retained source body belongs. */
  readonly path: SyncNotePathDto;
  /** Tombstone operation that owns this recovery evidence. */
  readonly operationId: SyncOperationIdDto;
  /** Live source revision preserved by the tombstone. */
  readonly sourceRevision: SyncRevisionDto;
  /** Digest declared for the exact raw recovery body bytes. */
  readonly contentSha256: ContentSha256;
  /** Exact UTF-8 recovery body size in bytes. */
  readonly byteSize: number;
  /** Fixed supported media type of the preserved body. */
  readonly mediaType: "text/markdown";
  /** Installation identity retained from the source version. */
  readonly origin: SyncDeviceIdDto;
}

/** Computed evidence for an exact raw UTF-8 content or recovery body. */
export type SyncBodyRecord =
  | {
      /** Body stored under its immutable revision key. */
      readonly kind: "contentBody";
      /** Vault namespace validated from its storage key. */
      readonly vaultId: SyncVaultIdDto;
      /** Immutable revision validated from its storage key. */
      readonly revision: SyncRevisionDto;
      /** Exact stored bytes; no text normalization is applied. */
      readonly bytes: Uint8Array;
      /** Actual byte length of the exact stored body. */
      readonly byteSize: number;
      /** SHA-256 computed from the exact stored bytes. */
      readonly contentSha256: ContentSha256;
    }
  | {
      /** Body stored under its tombstone-operation recovery key. */
      readonly kind: "recoveryBody";
      /** Vault namespace validated from its storage key. */
      readonly vaultId: SyncVaultIdDto;
      /** Tombstone operation validated from its storage key. */
      readonly operationId: SyncOperationIdDto;
      /** Exact stored bytes; no text normalization is applied. */
      readonly bytes: Uint8Array;
      /** Actual byte length of the exact stored body. */
      readonly byteSize: number;
      /** SHA-256 computed from the exact stored bytes. */
      readonly contentSha256: ContentSha256;
    };

/** Mutable active-scan slot whose empty state is explicit rather than deleted. */
export type SyncInventorySlot = SyncRecordEnvelope &
  (
    | { readonly state: "empty" }
    | { readonly state: "active"; readonly inventoryId: SyncInventoryIdDto }
  );

/** Shared bounded inventory counters and cursor state across historical and witnessed manifests. */
interface SyncInventoryManifestFields
  extends Omit<SyncRecordEnvelope, "schemaVersion"> {
  /** Stable scan identity appearing in the canonical manifest key. */
  readonly inventoryId: SyncInventoryIdDto;
  /** Durable scan lifecycle stage used only by inventory recovery. */
  readonly phase: "starting" | "scanning" | "complete" | "failed";
  /** Captured 64-lane generation vector guarding scan completeness. */
  readonly startVector: readonly SyncSequenceDto[];
  /** Unpadded-base64url-encoded opaque R2 listing cursor, or terminal null. */
  readonly cursor: string | null;
  /** Last strictly ordered head key accepted from the scan. */
  readonly lastKey: string | null;
  /** Number of empty truncated pages already consumed. */
  readonly emptyPageCount: number;
  /** Next immutable chunk step reserved by this manifest. */
  readonly nextStep: number;
  /** Count of complete list pages incorporated by this scan. */
  readonly listPageCount: number;
  /** Number of unique validated head summaries observed. */
  readonly headCount: number;
  /** Actual R2 LIST attempts including bounded same-step replay. */
  readonly listAttemptCount: number;
  /** Actual head-body GET attempts including bounded replay. */
  readonly headGetAttemptCount: number;
  /** Unique validated head-body bytes counted once. */
  readonly uniqueHeadBodyBytes: number;
  /** Actual head-body response bytes including replay reads. */
  readonly actualHeadBodyBytes: number;
  /** Serialized unique inventory evidence bytes retained by the scan. */
  readonly evidenceBytes: number;
  /** Number of contiguous immutable evidence chunks. */
  readonly chunkCount: number;
  /** SHA-256 rolling root of the verified contiguous chunk chain. */
  readonly chunkHash: ContentSha256 | null;
  /** Persisted data-read reservation: no attempt, first attempt, or replay. */
  readonly reservedAttempt: 0 | 1 | 2;
  /** Absolute server expiry time in Unix epoch milliseconds. */
  readonly expiresAtEpochMs: number;
}

/** Historical v1 scan evidence retained for expiry/no-reuse but never upgraded to witness authority. */
export interface SyncInventoryManifestV1 extends SyncInventoryManifestFields {
  /** Frozen historical manifest schema. */
  readonly schemaVersion: 1;
}

/** New scan authority whose every truncated cursor advance requires a durable witness. */
export interface SyncInventoryManifestV2 extends SyncInventoryManifestFields {
  /** Strict witnessed scan schema. */
  readonly schemaVersion: 2;
  /** Fixed closed witness algorithm; other modes require a new schema. */
  readonly cursorWitnessMode: 1;
}

/** Versioned manifest boundary; callers must fail closed on v1 authority. */
export type SyncInventoryManifest =
  | SyncInventoryManifestV1
  | SyncInventoryManifestV2;

/** Canonical path and published revision recorded for one listed inventory head. */
export interface SyncHeadSummary {
  /** Canonical M7.1 unpadded base64url path key, not display-normalized text. */
  readonly pathKey: string;
  /** Exact live or tombstone revision represented by this listing entry. */
  readonly revision: SyncRevisionDto;
  /** Current state of the summarized revision. */
  readonly kind: "live" | "tombstone";
}

/** One immutable replayable listing transcript and optional validated head summary. */
export interface SyncInventoryPageChunk extends SyncRecordEnvelope {
  /** Stable scan identity appearing in the chunk key. */
  readonly inventoryId: SyncInventoryIdDto;
  /** Monotonic step encoded in the chunk key. */
  readonly step: number;
  /** Previous verified chunk hash, null only for step zero. */
  readonly previousChunkHash: ContentSha256 | null;
  /** Digest of the exact input cursor bytes at this step. */
  readonly inputCursorDigest: ContentSha256;
  /** Digest of the exact decoded output cursor bytes, or empty bytes at terminal. */
  readonly outputCursorDigest: ContentSha256;
  /** Exact output cursor encoded as unpadded base64url for replay. */
  readonly outputCursor: string | null;
  /** Whether the saved listing page requires continuation. */
  readonly truncated: boolean;
  /** Strict serialized list-page transcript, bounded to the protocol page cap. */
  readonly transcript: string;
  /** Validated head summary returned by this single page, if any. */
  readonly headSummary: SyncHeadSummary | null;
}

/** Immutable terminal step evidence occupying the chunk key without authorizing page progress.
 * Schema v2 is a failure latch, not a repaired or upgraded historical v1 page.
 */
export interface SyncInventoryStepFailure
  extends Omit<SyncRecordEnvelope, "schemaVersion"> {
  /** Version separating failure evidence from historical page transcripts. */
  readonly schemaVersion: 2;
  /** Stable scan identity whose reserved step observed the deterministic failure. */
  readonly inventoryId: SyncInventoryIdDto;
  /** Exact reserved step; the create-only key prevents a later successful page replacing this latch. */
  readonly step: number;
  /** Original prefix root, retained to prevent adopting evidence from another scan position. */
  readonly previousChunkHash: ContentSha256 | null;
  /** Closed terminal reason; never storage/transport uncertainty. */
  readonly failureCode: "inventory_incomplete" | "inventory_limit_exceeded";
}

/** Create-only step outcome: exact historical page evidence or explicit terminal failure. */
export type SyncInventoryChunk =
  | SyncInventoryPageChunk
  | SyncInventoryStepFailure;

/** Validated random UUID electing exactly one inventory witness-dispatch generation. */
export type SyncInventoryClaimId = string & {
  readonly __syncInventoryClaimId: unique symbol;
};

/** Fields linking one cursor claim or witness to the exact verified immutable chunk. */
interface SyncInventoryCursorEvidence extends SyncRecordEnvelope {
  /** Stable scan identity beneath the isolated scratch prefix. */
  readonly inventoryId: SyncInventoryIdDto;
  /** Zero-based producing chunk step. */
  readonly step: number;
  /** SHA-256 over exact canonical chunk bytes, not a listing ETag. */
  readonly chunkHash: ContentSha256;
  /** SHA-256 over the raw R2 output cursor, never the raw token itself. */
  readonly cursorDigest: ContentSha256;
}

/** Immutable digest-indexed claim that this verified step produced a cursor. */
export interface SyncInventoryCursorWitness
  extends SyncInventoryCursorEvidence {}

/** Durable exact-CAS attempt journal for a step's conditional witness write. */
export type SyncInventoryCursorJournal = SyncInventoryCursorEvidence &
  (
    | {
        /** This exact UUID generation may dispatch one create-only target PUT. */
        readonly state: "attempting";
        /** Unique generation fence, never reused for a second target dispatch. */
        readonly claimId: SyncInventoryClaimId;
      }
    | {
        /** A later generation must wait for exact absence and both cooldown floors. */
        readonly state: "retry_wait";
        /** Previously attempted UUID, retained as exact causal history. */
        readonly claimId: SyncInventoryClaimId;
        /** Earliest safe server epoch milliseconds for the next generation. */
        readonly retryAfterEpochMs: number;
      }
  );

/** Closed discriminated output of strict sync-record decoding. */
export type SyncDecodedRecord =
  | {
      readonly kind: "vaultMarker";
      readonly vaultId: SyncVaultIdDto;
      readonly schemaVersion: 1;
      readonly protocolMajor: 1;
    }
  | { readonly kind: "head"; readonly record: SyncHeadRecord }
  | { readonly kind: "version"; readonly record: SyncVersionMetadata }
  | {
      readonly kind: "contentBody";
      readonly record: Extract<
        SyncBodyRecord,
        { readonly kind: "contentBody" }
      >;
    }
  | { readonly kind: "recoveryMetadata"; readonly record: SyncRecoveryMetadata }
  | {
      readonly kind: "recoveryBody";
      readonly record: Extract<
        SyncBodyRecord,
        { readonly kind: "recoveryBody" }
      >;
    }
  | { readonly kind: "activeSlot"; readonly record: SyncInventorySlot }
  | { readonly kind: "manifest"; readonly record: SyncInventoryManifest }
  | { readonly kind: "chunk"; readonly record: SyncInventoryChunk }
  | {
      readonly kind: "cursorJournal";
      readonly record: SyncInventoryCursorJournal;
    }
  | {
      readonly kind: "cursorWitness";
      readonly record: SyncInventoryCursorWitness;
    };
