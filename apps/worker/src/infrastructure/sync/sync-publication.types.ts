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

/** Exact version-one JSON envelope retained by mutable lane heads and immutable feed events. */
export interface SyncPublicationEnvelope {
  /** Persisted schema generation for the lane-head or feed-event family. */
  readonly schemaVersion: 1;
  /** Protocol major whose closed publication contract governs this record. */
  readonly protocolMajor: 1;
  /** Immutable vault namespace that must agree with both key and request. */
  readonly vaultId: SyncVaultIdDto;
}

/** Version-two envelope used only by operation journals with strict attempt authority. */
export interface SyncJournalPublicationEnvelope {
  /** Persisted journal schema generation; version-one journals are never rehydrated. */
  readonly schemaVersion: 2;
  /** Protocol major whose closed publication contract governs this journal. */
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

/** One durable external-write claim or its recovery wait, scoped to one step tuple. */
export type SyncPublicationAttemptState =
  | {
      /** New target tuple with no external write claim. */
      readonly state: "ready";
      /** Every fresh target tuple begins at generation zero. */
      readonly generation: 0;
    }
  | {
      /** Exact journal claim authorizing one target PUT by its creator only. */
      readonly state: "attempting";
      /** Fresh UUID identifying the invocation that owns this one dispatch. */
      readonly claimId: SyncOperationIdDto;
      /** Positive safe generation scoped to the exact step, key, and precondition. */
      readonly generation: number;
      /** Claim creation time in Unix epoch milliseconds. */
      readonly claimedAtEpochMs: number;
    }
  | {
      /** Recovery has observed the original target state and fixed a safe retry floor. */
      readonly state: "retry_wait";
      /** Claim whose one target PUT is being reconciled. */
      readonly claimId: SyncOperationIdDto;
      /** Positive safe generation of the claim being reconciled. */
      readonly generation: number;
      /** Exact-read observation time in Unix epoch milliseconds. */
      readonly observedAtEpochMs: number;
      /** Fixed retry floor, also retained as the step's authoritative retry time. */
      readonly retryAfterEpochMs: number;
    };

/** Event kind a pending create-event step is authorized to publish. */
export type SyncEventOutcomeIntent = SyncChangeEvent["kind"];

/** Journal-only transition that deliberately has no external attempt claim. */
export type SyncPublicationJournalStep = "commit_journal";

/** Closed external publication step whose effect must be preceded by a durable claim. */
export type SyncPublicationExternalStep =
  | "immutable_create"
  | "write_head"
  | "create_event"
  | "commit_lane";

/** Common exact key, precondition, and cooldown fields for one journal step. */
interface SyncPublicationStepBase {
  /** Exact canonical protocol-v1 key associated with the saved precondition. */
  readonly key: string;
  /** Exact R2 precondition for the external target or exact journal-only prior phase. */
  readonly precondition: SyncPublicationPrecondition;
  /** One authoritative retry lower bound for the target key, when known. */
  readonly retryAfterEpochMs: number | null;
}

/** Durable step evidence separates external claims from journal-only CAS authority. */
export type SyncPublicationStepEvidence =
  | (SyncPublicationStepBase & {
      /** Event publication binds its server commit time before any event claim or PUT. */
      readonly step: "create_event";
      /** Fixed monotonic event time shared by every attempt and terminal journal. */
      readonly committedAtEpochMs: number;
      /** Persisted changed-versus-aborted outcome, immutable for this event-step tuple. */
      readonly outcomeIntent: SyncEventOutcomeIntent;
      /** Persisted tagged authority for the exact external step tuple. */
      readonly attempt: SyncPublicationAttemptState;
      /** External targets cannot use a journal-phase precondition. */
      readonly precondition: Exclude<
        SyncPublicationPrecondition,
        { readonly kind: "journal_phase" }
      >;
    })
  | (SyncPublicationStepBase & {
      /** Other external writes require a persisted attempt claim before dispatch. */
      readonly step: Exclude<SyncPublicationExternalStep, "create_event">;
      /** Persisted tagged authority for the exact external step tuple. */
      readonly attempt: SyncPublicationAttemptState;
      /** External targets cannot use a journal-phase precondition. */
      readonly precondition: Exclude<
        SyncPublicationPrecondition,
        { readonly kind: "journal_phase" }
      >;
    })
  | (SyncPublicationStepBase & {
      /** Journal-only progression uses its exact typed pending prior state. */
      readonly step: SyncPublicationJournalStep;
      /** Journal-only CAS never carries external target claim state. */
      readonly precondition: Extract<
        SyncPublicationPrecondition,
        { readonly kind: "journal_phase" }
      >;
    });

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
interface SyncJournalBase extends SyncJournalPublicationEnvelope {
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

/** Original absence or exact observed generation retained for a refused head predicate. */
export type SyncHeadRefusalPrecondition = Exclude<
  SyncPublicationPrecondition,
  { readonly kind: "journal_phase" }
>;

/** Authoritative no-effect source allowed to create a head-refusal receipt. */
export type SyncHeadRefusalSource =
  | "preflight_no_dispatch"
  | "conditional_null";

/** Exact R2 generation of the stale head that prevented the claimed target write. */
export interface SyncCompetingHeadObservation {
  /** Opaque R2 generation token observed with these exact bytes. */
  readonly etag: string;
  /** Exact canonical head record bytes encoded as unpadded base64url. */
  readonly bytes: string;
  /** R2 server upload time in Unix epoch milliseconds. */
  readonly uploadedAtEpochMs: number;
}

/** Worker-private generation-one receipt binding one head attempt to proven no-effect evidence. */
export interface SyncHeadRefusalReceiptRecord {
  /** Version of this private receipt representation, independent of protocol major. */
  readonly schemaVersion: 1;
  /** Protocol major of the private sync namespace containing its evidence. */
  readonly protocolMajor: 1;
  /** Immutable vault namespace bound by both receipt and private key. */
  readonly vaultId: SyncVaultIdDto;
  /** Operation identity encoded by the one canonical receipt key. */
  readonly operationId: SyncOperationIdDto;
  /** Exact attempt owner currently persisted in the operation journal. */
  readonly claimId: SyncOperationIdDto;
  /** Receipt-assisted abort is authority-limited to the first write-head claim. */
  readonly generation: 1;
  /** Canonical current-head key whose original conditional target was refused. */
  readonly headKey: string;
  /** SHA-256 of the canonical intended target-head JSON bytes. */
  readonly headTargetSha256: SyncMutationRequest["contentSha256"];
  /** Original absent or exact observed generation condition; never refreshed. */
  readonly headPrecondition: SyncHeadRefusalPrecondition;
  /** Fixed path-derived feed lane reserved by the operation. */
  readonly lane: number;
  /** Exact feed sequence reserved by the operation. */
  readonly sequence: SyncEventSequenceDto;
  /** Directly observed reason that this particular head PUT had no effect. */
  readonly refusalSource: SyncHeadRefusalSource;
  /** Exact typed competitor generation that still makes the request parent stale. */
  readonly competingHead: SyncCompetingHeadObservation;
}

/** Every versioned operation journal, lane-head, and feed-event publication record. */
export type SyncPublicationRecord =
  | SyncJournalRecord
  | SyncLaneHeadRecord
  | SyncFeedEventRecord;
