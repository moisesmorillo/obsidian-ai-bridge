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
  | "chunk";

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

/** Fields binding one version and its body evidence to path and operation provenance. */
interface SyncVersionMetadataBase extends SyncRecordEnvelope {
  /** Canonical NotePath represented by this revision. */
  readonly path: SyncNotePathDto;
  /** Immutable version identifier encoded into the metadata and body keys. */
  readonly revision: SyncRevisionDto;
  /** Exact previously observed path state used as the mutation precondition. */
  readonly parent: SyncRecordParent;
  /** SHA-256 declared for the separately stored exact body bytes. */
  readonly contentSha256: ContentSha256;
  /** Exact UTF-8 body byte count declared for linked body verification. */
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

/** Strict immutable version metadata; content remains in a separate raw body object. */
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

/** Strict bounded inventory continuation state private to the R2 adapter. */
export interface SyncInventoryManifest extends SyncRecordEnvelope {
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
export interface SyncInventoryChunk extends SyncRecordEnvelope {
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
  | { readonly kind: "chunk"; readonly record: SyncInventoryChunk };
