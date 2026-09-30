import type {
  SyncChangeEvent,
  SyncMutationRequest,
} from "@core/sync/sync-store.types";
import type {
  SyncEventSequenceDto,
  SyncOperationIdDto,
  SyncSequenceDto,
  SyncVaultIdDto,
} from "@protocol/sync.types";

/** Private publication record families accepted below one protocol-v1 vault prefix. */
export type SyncPublicationKind = "journal" | "laneHead" | "feedEvent";

/** Exact private JSON envelope shared by publication records. */
export interface SyncPublicationEnvelope {
  /** Persisted schema generation for this record family. */
  readonly schemaVersion: 1;
  /** Protocol major whose closed publication contract governs this record. */
  readonly protocolMajor: 1;
  /** Immutable vault namespace that must agree with both key and request. */
  readonly vaultId: SyncVaultIdDto;
}

/** One allocation bound to the exact lane-head generation preceding reservation. */
export interface SyncLaneReservation {
  /** Protocol-stable lane selected from the normalized request path. */
  readonly lane: number;
  /** Non-zero sequence reserved for this operation. */
  readonly sequence: SyncEventSequenceDto;
  /** Previous committed event time that the next commit must strictly exceed. */
  readonly previousCommittedAtEpochMs: number;
}

/** Bounded exact R2 precondition captured before a publication step is attempted. */
export type SyncPublicationPrecondition =
  | {
      /** The derived protocol-v1 key was exactly absent at observation time. */
      readonly kind: "absent";
    }
  | {
      /** Prior R2 generation, bytes, and upload time are retained for original-ETag CAS recovery. */
      readonly kind: "observed";
      /** Original R2 ETag; recovery must never substitute a refreshed generation. */
      readonly etag: string;
      /** Exact prior record bytes encoded as canonical unpadded base64url. */
      readonly bytes: string;
      /** R2 server upload time used as one same-key write-cooldown lower bound. */
      readonly uploadedAtEpochMs: number;
    }
  | {
      /**
       * Journal-only transition is fenced by the complete current typed journal body
       * and phase, not a self-referential ETag witness. After exact prior-state read-back,
       * its observed ETag may condition only this journal transition; an exact target is
       * already done and divergent or unavailable evidence remains unknown.
       */
      readonly kind: "journal_phase";
      /** Only an exact pending journal may transition to its committed or aborted result. */
      readonly status: "pending";
    };

/** One in-flight publication target and its exact pre-dispatch recovery evidence. */
export interface SyncPublicationStepEvidence {
  /** Closed durable step; the matching key family and request identity are validated together. */
  readonly step:
    | "immutable_create"
    | "write_head"
    | "create_event"
    | "commit_journal"
    | "commit_lane";
  /** Exact canonical protocol-v1 key associated with the saved precondition. */
  readonly key: string;
  /**
   * Exact pre-dispatch absence or observed generation for this step. A journal-only
   * transition instead reads and matches the complete expected current journal body,
   * then uses that read's ETag; it never borrows this exception for lane/head CAS.
   */
  readonly precondition: SyncPublicationPrecondition;
  /**
   * Persisted lower bound after a known throttle or uncertain attempt, if one exists.
   * If the response floor was lost with an isolate, recovery must exactly observe this
   * precondition, defer the invocation using observation time plus the 1,100-ms R2
   * cooldown, and persist the new floor before a later write; it cannot refresh the ETag.
   */
  readonly retryAfterEpochMs: number | null;
}

/** Exact UTF-8 size evidence for the request's retained live mutation payload. */
export interface SyncJournalPayloadEvidence {
  /** UTF-8 payload size, bounded to the protocol's one-mebibyte Markdown limit. */
  readonly byteSize: number;
}

/** Exact prior lane state retained before this operation may attempt a reservation. */
export interface SyncJournalLaneObservation {
  /** Canonical lane-head key derived from the immutable request path. */
  readonly key: string;
  /** Verified absence for zero-head initialization or its exact observed R2 generation. */
  readonly precondition: Exclude<
    SyncPublicationPrecondition,
    { readonly kind: "journal_phase" }
  >;
  /** Known retry floor for the independent lane-head key, if a write was throttled or uncertain. */
  readonly retryAfterEpochMs: number | null;
}

/** Common immutable journal identity and request, retained for every terminal state. */
interface SyncJournalBase extends SyncPublicationEnvelope {
  /** Distinguishes this persisted family from lane heads and feed events. */
  readonly kind: "journal";
  /** Operation UUID encoded by the journal's immutable M7 key. */
  readonly operationId: SyncOperationIdDto;
  /** Original normalized request; its exact content text remains Worker-private. */
  readonly request: SyncMutationRequest;
  /** Digest-checked UTF-8 payload size, or null for body-free tombstones. */
  readonly payload: SyncJournalPayloadEvidence | null;
}

/** Pending request bound to an exact lane observation but not authorized for publication. */
export interface SyncUnallocatedPendingJournalRecord extends SyncJournalBase {
  /** Pending is never a committed mutation result. */
  readonly status: "pending";
  /** Explicit authority phase; unallocated journals carry no sequence or step evidence. */
  readonly allocationState: "unallocated";
  /** SHA-256-selected lane derived from the normalized request path. */
  readonly lane: number;
  /** Exact lane-head absence or generation observed before any reservation attempt. */
  readonly laneObservation: SyncJournalLaneObservation;
}

/** Shared allocation authority retained after the operation wins its lane marker. */
interface SyncAllocatedJournalBase extends SyncJournalBase {
  /** Allocation can only be persisted after exact own-marker read-back. */
  readonly allocationState: "allocated";
  /** Won lane sequence and its exact predecessor committed clock. */
  readonly reservation: SyncLaneReservation;
  /** Last durable publication step evidence, including original CAS conditions. */
  readonly stepEvidence: SyncPublicationStepEvidence;
}

/** Allocated unresolved operation whose next durable step survives isolate loss. */
export interface SyncAllocatedPendingJournalRecord
  extends SyncAllocatedJournalBase {
  /** Pending is never a committed mutation result. */
  readonly status: "pending";
}

/** Either pending authority phase accepted for a private operation journal. */
export type SyncPendingJournalRecord =
  | SyncUnallocatedPendingJournalRecord
  | SyncAllocatedPendingJournalRecord;

/** Fully published operation bound to its changed-event revision and commit time. */
export interface SyncCommittedJournalRecord extends SyncAllocatedJournalBase {
  /** Feed evidence and journal state are committed; lane release remains R2-observable. */
  readonly status: "committed";
  /** Exact assigned feed position, equal to the reservation. */
  readonly position: {
    /** Zero-based protocol lane containing the event. */
    readonly lane: number;
    /** Non-zero committed event sequence. */
    readonly sequence: SyncEventSequenceDto;
  };
  /** Published revision, which must equal the immutable request's target revision. */
  readonly revision: SyncMutationRequest["revision"];
  /** Server commit time, strictly later than the predecessor lane clock. */
  readonly committedAtEpochMs: number;
}

/** Conclusively rejected parent precondition published at its reserved feed position. */
export interface SyncAbortedJournalRecord extends SyncAllocatedJournalBase {
  /** Aborted records describe a proven no-head-change result. */
  readonly status: "aborted";
  /** Closed feed position reserved for this no-change event. */
  readonly position: {
    /** Zero-based protocol lane containing the event. */
    readonly lane: number;
    /** Non-zero committed event sequence. */
    readonly sequence: SyncEventSequenceDto;
  };
  /** Only a proven stale parent is an allowed durable abort reason. */
  readonly reason: "stale_revision";
  /** Server commit time, strictly later than the predecessor lane clock. */
  readonly committedAtEpochMs: number;
}

/** Closed unallocated, allocated, committed, or conclusively aborted operation journal. */
export type SyncJournalRecord =
  | SyncPendingJournalRecord
  | SyncCommittedJournalRecord
  | SyncAbortedJournalRecord;

/** Mutable committed lane clock and at most one exact pending sequence reservation. */
export interface SyncLaneHeadRecord extends SyncPublicationEnvelope {
  /** Distinguishes a lane clock from the immutable event records below it. */
  readonly kind: "laneHead";
  /** Lane encoded by the canonical lane-head key. */
  readonly lane: number;
  /** Highest sequence whose immutable event is fully committed. */
  readonly committedSequence: SyncSequenceDto;
  /** Commit time at that sequence, or zero for the initial all-zero head. */
  readonly committedAtEpochMs: number;
  /** Sole next-operation reservation, omitted only while the lane is unreserved. */
  readonly pending?:
    | {
        /** Operation that owns the lane until its event and journal settle. */
        readonly operationId: SyncOperationIdDto;
        /** Exact next sequence; no skipped or reused positions are representable. */
        readonly nextSequence: SyncEventSequenceDto;
      }
    | undefined;
}

/** Immutable changed or aborted event stored at its exact lane and sequence key. */
export type SyncFeedEventRecord = SyncPublicationEnvelope & SyncChangeEvent;

/** Every private journal, lane-head, and feed-event record accepted by the codec. */
export type SyncPublicationRecord =
  | SyncJournalRecord
  | SyncLaneHeadRecord
  | SyncFeedEventRecord;
