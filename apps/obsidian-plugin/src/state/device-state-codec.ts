import {
  type ConditionalMutationPrecondition,
  type ContentOperationReceipt,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  HANDOFF_ALIGNMENT_KIND,
  HISTORY_CLEANUP_STEP_KIND,
  HISTORY_CLEANUP_STEP_PHASE,
  HISTORY_DECISION_KIND,
  HISTORY_PROGRESS_KIND,
  HISTORY_REMOTE_EFFECT_KIND,
  type HistoryCleanupStep,
  isHistoryReconciliationOperation,
  isMirrorDeviceStateConsistent,
  isNormalizedNotePath,
  type LegacyV3HistoryProgress,
  LOCAL_EFFECT_OBSERVATION_KIND,
  type LocalEffectObservation,
  MAX_MIRROR_TRACKED_PATHS,
  MAX_RECONCILIATION_OPERATIONS,
  MAX_RECONCILIATION_PRESERVATION_RECEIPTS,
  MAX_RECONCILIATION_REVIEWS,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DESIRED_STATE_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  MIRROR_DEVICE_STATE_VERSION,
  MIRROR_GLOBAL_BLOCK_REASON,
  MIRROR_MUTATION_PHASE,
  MIRROR_PATH_BLOCK_REASON,
  MIRROR_PAUSE_REASON,
  MIRROR_RENAME_PHASE,
  type MirrorAcknowledgement,
  type MirrorDesiredState,
  type MirrorDeviceLifecycle,
  type MirrorDeviceState,
  type MirrorPathState,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  type NotePath,
  type OperationReceipt,
  RECONCILIATION_ACTION,
  RECONCILIATION_AUTHORITY_SOURCE,
  RECONCILIATION_CLASSIFICATION,
  RECONCILIATION_EVENT_KIND,
  RECONCILIATION_LOCAL_EVIDENCE_KIND,
  RECONCILIATION_LOCAL_STABILITY,
  RECONCILIATION_OPERATION_PHASE,
  RECONCILIATION_PATH_REFERENCE_KIND,
  RECONCILIATION_PRESERVATION_PROOF_STATE,
  RECONCILIATION_PRESERVATION_SCOPE,
  RECONCILIATION_PRESERVATION_SIDE,
  RECONCILIATION_REMOTE_EVIDENCE_KIND,
  RECONCILIATION_REVIEW_RETENTION,
  RECONCILIATION_REVIEW_STATUS,
  RECOVERY_SNAPSHOT_STATE_KIND,
  type ReconciliationOperation,
  type ReconciliationPathEvidence,
  type ReconciliationPreservationReceipt,
  type ReconciliationRecoveryEvidence,
  type ReconciliationReview,
  type ReconciliationReviewSnapshot,
  type ReconciliationRuntimeIdentity,
  type RefinedHistoryProgress,
  type RenameDeferredMirrorState,
  type StagedHandoff,
  type TransferableAcknowledgement,
  type UnresolvedMutationIntent,
} from "@obsidian-ai-bridge/core";
import {
  operationReceiptSchema,
  unresolvedMutationIntentSchema,
} from "@obsidian-ai-bridge/protocol";
import { parsePersistedMirrorOrigin } from "@obsidian-plugin/configuration/mirror-endpoint";
import {
  type HandoffIntegrity,
  verifyHandoffPayloadChecksum,
  WebCryptoHandoffIntegrity,
} from "@obsidian-plugin/state/handoff-codec";
import { z } from "zod";

/** Host-local key reserved for the device-owned mirror ledger. */
export const MIRROR_DEVICE_STATE_STORAGE_KEY = "ai-bridge:mirror-device-state";

/** Closed serialized format identifier independent from synced plugin data. */
export const MIRROR_DEVICE_STATE_FORMAT = "obsidian-ai-bridge-device-state";

/** Maximum UTF-8 bytes accepted for one host-local version-4 device-state snapshot. */
export const MAX_MIRROR_DEVICE_STATE_BYTES = 12 * 1024 * 1024;

/** Strict v4 DTO discriminants separating aggregate and history operation shapes. */
const MIRROR_OPERATION_DTO_KIND = {
  ordinary: "ordinary",
  history: "history",
  legacyV3History: "legacy-v3-history",
} as const;

/** Strict host-local decode result; incompatible data is never treated as missing. */
export type MirrorDeviceStateDecodeResult =
  | { readonly kind: "missing" }
  | { readonly kind: "valid"; readonly state: MirrorDeviceState }
  | { readonly kind: "corrupt" }
  | { readonly kind: "unsupported-version"; readonly version: number };

/** Strict serialized M3 baseline variants; revision/hash/ID branding follows shape validation. */
const acknowledgementSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.unassociated) })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.live),
      revision: z.string(),
      contentSha256: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.tombstone),
      revision: z.string(),
      recoveryId: z.string(),
    })
    .strict(),
]);

/** Persisted deferred-rename evidence shared by current desired state and immutable M4 samples. */
const renameDeferredStateSchema = z
  .object({
    kind: z.literal(MIRROR_DESIRED_STATE_KIND.renameDeferred),
    observationGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    renameId: z.string(),
    associationId: z.string(),
    sourcePath: z.string(),
    destinationPath: z.string().nullable(),
    sourceExpectedRevision: z.string(),
    destinationObservationGeneration: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    destinationAcknowledgedRevision: z.string().nullable(),
    graceDeadlineMilliseconds: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    phase: z.enum([
      MIRROR_RENAME_PHASE.destinationRequired,
      MIRROR_RENAME_PHASE.sourceCleanupRequired,
      MIRROR_RENAME_PHASE.invalidated,
    ]),
  })
  .strict();

/** Closed pending M3 work, preserving event generations, delete authority and destination prerequisites. */
const desiredStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(MIRROR_DESIRED_STATE_KIND.none) }).strict(),
  z
    .object({
      kind: z.literal(MIRROR_DESIRED_STATE_KIND.dirtyPresent),
      observationGeneration: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DESIRED_STATE_KIND.runtimeDelete),
      observationGeneration: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER),
      evidenceId: z.string(),
      associationId: z.string(),
      expectedRevision: z.string(),
      graceDeadlineMilliseconds: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  renameDeferredStateSchema,
]);

/** Persisted exact intent/budget and phase; no note body or renewed retry authority is encoded. */
const unresolvedMutationStateSchema = z
  .object({
    intent: unresolvedMutationIntentSchema,
    phase: z.enum([
      MIRROR_MUTATION_PHASE.intentPersisted,
      MIRROR_MUTATION_PHASE.dispatched,
      MIRROR_MUTATION_PHASE.evidenceRequired,
      MIRROR_MUTATION_PHASE.recoveryPreparation,
      MIRROR_MUTATION_PHASE.tombstoneCommit,
    ]),
  })
  .strict();

/** Strict per-path M3 ledger retained by v4 without per-path M4 placeholders. */
const pathStateSchema = z
  .object({
    path: z.string(),
    acknowledgement: acknowledgementSchema,
    unresolvedMutation: unresolvedMutationStateSchema.nullable(),
    desired: desiredStateSchema,
    blockedReason: z
      .enum([
        MIRROR_PATH_BLOCK_REASON.diverged,
        MIRROR_PATH_BLOCK_REASON.retryExhausted,
        MIRROR_PATH_BLOCK_REASON.unresolvedEffect,
        MIRROR_PATH_BLOCK_REASON.renameDeferred,
        MIRROR_PATH_BLOCK_REASON.handoffMismatch,
      ])
      .nullable(),
  })
  .strict();

/** Serialized association/origin shape for enabled lifecycles; canonical origin validation belongs to conversion. */
const bindingFields = {
  associationId: z.string(),
  origin: z.string().min(1).max(2048),
};
/** Closed persisted activation/pause/handoff variants; disabled carries no binding and paused retains its reason. */
const lifecycleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.disabled) }).strict(),
  z
    .object({
      kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.active),
      ...bindingFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.paused),
      ...bindingFields,
      reason: z.enum([
        MIRROR_PAUSE_REASON.manual,
        MIRROR_PAUSE_REASON.persistenceFailure,
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining),
      ...bindingFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained),
      ...bindingFields,
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged),
      ...bindingFields,
    })
    .strict(),
]);

/** Established ACKs allowed in staged handoff; unassociated paths cannot transfer authority. */
const transferableAcknowledgementSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.live),
      revision: z.string(),
      contentSha256: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(MIRROR_ACKNOWLEDGEMENT_KIND.tombstone),
      revision: z.string(),
      recoveryId: z.string(),
    })
    .strict(),
]);
/** Bounded staged ACKs with checksum and local/remote alignment generations; decode also verifies payload integrity. */
const stagedHandoffSchema = z
  .object({
    associationId: z.string(),
    origin: z.string().min(1).max(2048),
    checksum: z.string(),
    entries: z
      .array(
        z
          .object({
            path: z.string(),
            acknowledgement: transferableAcknowledgementSchema,
            localAlignment: z.enum([
              HANDOFF_ALIGNMENT_KIND.pending,
              HANDOFF_ALIGNMENT_KIND.matched,
              HANDOFF_ALIGNMENT_KIND.mismatch,
            ]),
            remoteVerification: z.enum([
              HANDOFF_ALIGNMENT_KIND.pending,
              HANDOFF_ALIGNMENT_KIND.matched,
              HANDOFF_ALIGNMENT_KIND.mismatch,
            ]),
            observationGeneration: z
              .number()
              .int()
              .min(1)
              .max(Number.MAX_SAFE_INTEGER),
          })
          .strict(),
      )
      .max(MAX_MIRROR_TRACKED_PATHS),
  })
  .strict();

/** Content-free local sample: exact stable absence/live evidence has a generation; unknown cannot claim a hash. */
const reconciliationLocalEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(RECONCILIATION_LOCAL_EVIDENCE_KIND.absent),
      stability: z.literal(RECONCILIATION_LOCAL_STABILITY.stable),
      observationGeneration: z
        .number()
        .int()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      kind: z.literal(RECONCILIATION_LOCAL_EVIDENCE_KIND.live),
      stability: z.literal(RECONCILIATION_LOCAL_STABILITY.stable),
      observationGeneration: z
        .number()
        .int()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER),
      byteSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      contentSha256: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown),
      stability: z.literal(RECONCILIATION_LOCAL_STABILITY.unknown),
    })
    .strict(),
]);

/** Persisted remote observations distinguish physical absence, legacy bytes and revisioned generations with exact receipts. */
const reconciliationRemoteEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal(RECONCILIATION_REMOTE_EVIDENCE_KIND.absent) })
    .strict(),
  z
    .object({
      kind: z.literal(RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy),
      contentSha256: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(RECONCILIATION_REMOTE_EVIDENCE_KIND.live),
      associationId: z.string(),
      revision: z.string(),
      contentSha256: z.string(),
      receipt: operationReceiptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal(RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone),
      associationId: z.string(),
      revision: z.string(),
      deletedRevision: z.string(),
      recoveryId: z.string(),
      receipt: operationReceiptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal(RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable),
    })
    .strict(),
]);

/** One immutable path sample including baseline and M3 blockers; these are observations, not new mutation authority. */
const reconciliationPathEvidenceSchema = z
  .object({
    path: z.string(),
    local: reconciliationLocalEvidenceSchema,
    baseline: acknowledgementSchema,
    remote: reconciliationRemoteEvidenceSchema,
    m3: z
      .object({
        unresolvedMutation: unresolvedMutationStateSchema.nullable(),
        deferredHistory: renameDeferredStateSchema.nullable(),
      })
      .strict(),
  })
  .strict();

/** Selected recovery metadata including retention state, never recovery content; expiry policy is not evaluated by this schema. */
const reconciliationRecoveryEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(RECOVERY_SNAPSHOT_STATE_KIND.prepared),
      id: z.string(),
      associationId: z.string(),
      path: z.string(),
      revision: z.string(),
      sourceRevision: z.string(),
      contentSha256: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(RECOVERY_SNAPSHOT_STATE_KIND.sealed),
      id: z.string(),
      associationId: z.string(),
      path: z.string(),
      revision: z.string(),
      sourceRevision: z.string(),
      contentSha256: z.string(),
      recoverUntil: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal(RECOVERY_SNAPSHOT_STATE_KIND.purged),
      id: z.string(),
      associationId: z.string(),
      path: z.string(),
      revision: z.string(),
      sourceRevision: z.string(),
      contentSha256: z.string(),
      recoverUntil: z.string(),
    })
    .strict(),
]);

/** Persisted stale-decision identity across owner, configuration, listener, writer and full lifecycle dimensions. */
const reconciliationRuntimeIdentitySchema = z
  .object({
    runtimeOwnerVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    configurationGeneration: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    listenerEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    deviceId: z.string(),
    designatedWriterId: z.string(),
    lifecycle: lifecycleSchema,
  })
  .strict();

/** Bounded immutable runtime/path/recovery sample copied into both review and admitted operation; equality is enforced in core. */
const reconciliationReviewSnapshotSchema = z
  .object({
    runtime: reconciliationRuntimeIdentitySchema,
    targetPath: z.string(),
    paths: z
      .array(reconciliationPathEvidenceSchema)
      .min(1)
      .max(MAX_MIRROR_TRACKED_PATHS),
    recovery: reconciliationRecoveryEvidenceSchema.nullable(),
  })
  .strict();

/** Closed non-history action representation, with an explicit primary side only for keep-both. */
const reconciliationNonHistoryActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal(RECONCILIATION_ACTION.keepLocal) }).strict(),
  z.object({ kind: z.literal(RECONCILIATION_ACTION.useRemote) }).strict(),
  z
    .object({
      kind: z.literal(RECONCILIATION_ACTION.keepBoth),
      primarySide: z.enum([
        RECONCILIATION_PRESERVATION_SIDE.local,
        RECONCILIATION_PRESERVATION_SIDE.remote,
      ]),
    })
    .strict(),
  z.object({ kind: z.literal(RECONCILIATION_ACTION.adoptRevision) }).strict(),
  z.object({ kind: z.literal(RECONCILIATION_ACTION.acceptTombstone) }).strict(),
  z.object({ kind: z.literal(RECONCILIATION_ACTION.recreateRemote) }).strict(),
  z.object({ kind: z.literal(RECONCILIATION_ACTION.restoreRecovery) }).strict(),
  z.object({ kind: z.literal(RECONCILIATION_ACTION.forkLegacy) }).strict(),
  z.object({ kind: z.literal(RECONCILIATION_ACTION.defer) }).strict(),
]);

/** Durable refined history decision; canonical paths are derived before persistence. */
const historyDecisionSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal(HISTORY_DECISION_KIND.retainIndependent) })
    .strict(),
  z.object({ kind: z.literal(HISTORY_DECISION_KIND.deferHistory) }).strict(),
  z
    .object({
      kind: z.literal(HISTORY_DECISION_KIND.executeCleanupPlan),
      canonicalPath: z.string().nullable(),
    })
    .strict(),
]);

/** Refined history action carrying the exact admitted closed decision. */
const refinedHistoryActionSchema = z
  .object({
    kind: z.literal(RECONCILIATION_ACTION.resolveHistory),
    decision: historyDecisionSchema,
  })
  .strict();

/** Frozen kind-only history action retained only by a migrated attention blocker. */
const legacyHistoryActionSchema = z
  .object({ kind: z.literal(RECONCILIATION_ACTION.resolveHistory) })
  .strict();

/** Durable content-free review record; classification/status and optional operation linkage require core relationship validation. */
const reconciliationReviewSchema = z
  .object({
    retention: z.literal(RECONCILIATION_REVIEW_RETENTION.durable),
    reviewId: z.string(),
    classification: z.enum([
      RECONCILIATION_CLASSIFICATION.aligned,
      RECONCILIATION_CLASSIFICATION.localAhead,
      RECONCILIATION_CLASSIFICATION.remoteAhead,
      RECONCILIATION_CLASSIFICATION.bothChanged,
      RECONCILIATION_CLASSIFICATION.remoteTombstoned,
      RECONCILIATION_CLASSIFICATION.localMissing,
      RECONCILIATION_CLASSIFICATION.legacyRemote,
      RECONCILIATION_CLASSIFICATION.unknownLocal,
      RECONCILIATION_CLASSIFICATION.remoteUnavailable,
      RECONCILIATION_CLASSIFICATION.unresolvedM3Effect,
      RECONCILIATION_CLASSIFICATION.deferredHistory,
    ]),
    status: z.enum([
      RECONCILIATION_REVIEW_STATUS.pending,
      RECONCILIATION_REVIEW_STATUS.staged,
      RECONCILIATION_REVIEW_STATUS.stale,
      RECONCILIATION_REVIEW_STATUS.blocked,
      RECONCILIATION_REVIEW_STATUS.completed,
    ]),
    snapshot: reconciliationReviewSnapshotSchema,
    operationId: z.string().nullable(),
  })
  .strict();

/** Persisted path ownership role; core verifies tracked/target/new-destination claims against sampled and current state. */
const reconciliationReservationSchema = z
  .object({
    path: z.string(),
    kind: z.enum([
      RECONCILIATION_PATH_REFERENCE_KIND.tracked,
      RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget,
      RECONCILIATION_PATH_REFERENCE_KIND.newDestination,
    ]),
  })
  .strict();

/** Fields shared by operation- and history-step-scoped preservation receipts. */
const preservationReceiptFields = {
  operationId: z.string(),
  originalPath: z.string(),
  side: z.enum([
    RECONCILIATION_PRESERVATION_SIDE.local,
    RECONCILIATION_PRESERVATION_SIDE.remote,
  ]),
  sourceRevision: z.string().nullable(),
  contentSha256: z.string(),
  preservationPath: z.string().min(1).max(512),
  proofState: z.enum([
    RECONCILIATION_PRESERVATION_PROOF_STATE.pending,
    RECONCILIATION_PRESERVATION_PROOF_STATE.verified,
    RECONCILIATION_PRESERVATION_PROOF_STATE.evidenceRequired,
    RECONCILIATION_PRESERVATION_PROOF_STATE.blocked,
  ]),
};

/** Closed receipt identity preserving old paths while adding exact history provenance. */
const reconciliationPreservationReceiptSchema = z.discriminatedUnion("scope", [
  z
    .object({
      scope: z.literal(RECONCILIATION_PRESERVATION_SCOPE.operation),
      ...preservationReceiptFields,
    })
    .strict(),
  z
    .object({
      scope: z.literal(RECONCILIATION_PRESERVATION_SCOPE.historyStep),
      stepId: z.string(),
      ...preservationReceiptFields,
    })
    .strict(),
]);

/** Bounded durable successor event range; no body or causal-host claim is persisted. */
const successorRangeSchema = z
  .object({
    firstGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    latestGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    eventKinds: z
      .array(
        z.enum([
          RECONCILIATION_EVENT_KIND.create,
          RECONCILIATION_EVENT_KIND.modify,
          RECONCILIATION_EVENT_KIND.delete,
          RECONCILIATION_EVENT_KIND.rename,
        ]),
      )
      .min(1)
      .max(4),
  })
  .strict();

/** Exact synthetic local-effect observation or conservative migration attention. */
const localEffectObservationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal(LOCAL_EFFECT_OBSERVATION_KIND.notRequired),
      path: z.string(),
      listenerEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      beforeGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      successor: successorRangeSchema.nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal(LOCAL_EFFECT_OBSERVATION_KIND.notStarted) })
    .strict(),
  z
    .object({ kind: z.literal(LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced) })
    .strict(),
  ...[
    LOCAL_EFFECT_OBSERVATION_KIND.prepared,
    LOCAL_EFFECT_OBSERVATION_KIND.confirmed,
    LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3,
  ].map((kind) =>
    z
      .object({
        kind: z.literal(kind),
        effectId: z.string(),
        path: z.string(),
        expectedHash: z.string(),
        listenerEpoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        beforeGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        postconditionHash: z.string().nullable(),
        successor: successorRangeSchema.nullable(),
      })
      .strict(),
  ),
]);

/** Closed operation-level phase shared by non-history and parent history records. */
const reconciliationOperationPhaseSchema = z.enum([
  RECONCILIATION_OPERATION_PHASE.admitted,
  RECONCILIATION_OPERATION_PHASE.preserving,
  RECONCILIATION_OPERATION_PHASE.mutatingLocal,
  RECONCILIATION_OPERATION_PHASE.mutatingRemote,
  RECONCILIATION_OPERATION_PHASE.evidenceRequired,
  RECONCILIATION_OPERATION_PHASE.partial,
  RECONCILIATION_OPERATION_PHASE.restoredPendingReview,
  RECONCILIATION_OPERATION_PHASE.successorReviewRequired,
  RECONCILIATION_OPERATION_PHASE.stale,
  RECONCILIATION_OPERATION_PHASE.blocked,
  RECONCILIATION_OPERATION_PHASE.completed,
]);

/** Exact history remote-effect evidence; confirmed receipt identity is step-bound. */
const historyRemoteEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-dispatched") }).strict(),
  z.object({ kind: z.literal("definitely-refused") }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
  z
    .object({
      kind: z.literal(
        HISTORY_REMOTE_EFFECT_KIND.confirmedExactTombstoneReceipt,
      ),
      revision: z.string(),
      receipt: operationReceiptSchema,
    })
    .strict(),
]);

/** One bounded ordered history cleanup step with original sampled predicates. */
const historyCleanupStepSchema = z
  .object({
    stepId: z.string(),
    kind: z.literal(HISTORY_CLEANUP_STEP_KIND.remoteFormerSourceCleanup),
    sourcePath: z.string(),
    prerequisitePath: z.string().nullable(),
    sourceRevision: z.string(),
    sourceContentSha256: z.string(),
    prerequisiteRevision: z.string().nullable(),
    localAbsenceGeneration: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER),
    phase: z.enum([
      HISTORY_CLEANUP_STEP_PHASE.pending,
      HISTORY_CLEANUP_STEP_PHASE.preserving,
      HISTORY_CLEANUP_STEP_PHASE.ready,
      HISTORY_CLEANUP_STEP_PHASE.mutatingRemote,
      HISTORY_CLEANUP_STEP_PHASE.evidenceRequired,
      HISTORY_CLEANUP_STEP_PHASE.blocked,
      HISTORY_CLEANUP_STEP_PHASE.completed,
    ]),
    remoteEffect: historyRemoteEffectSchema,
  })
  .strict();

/** Refined ordered history progress schema. */
const refinedHistoryProgressSchema = z
  .object({
    kind: z.literal(HISTORY_PROGRESS_KIND.refined),
    decision: historyDecisionSchema,
    steps: z.array(historyCleanupStepSchema).max(MAX_MIRROR_TRACKED_PATHS),
    nextStepIndex: z
      .number()
      .int()
      .min(0)
      .max(MAX_MIRROR_TRACKED_PATHS)
      .nullable(),
  })
  .strict();

/** Frozen v3 aggregate history evidence retained only as a migration blocker. */
const legacyHistoryProgressSchema = z
  .object({
    kind: z.literal(HISTORY_PROGRESS_KIND.legacyV3Unrefined),
    aggregateLocalEffect: z.enum([
      MUTATION_EFFECT_CERTAINTY.notDispatched,
      MUTATION_EFFECT_CERTAINTY.definitelyRefused,
      MUTATION_EFFECT_CERTAINTY.confirmed,
      MUTATION_EFFECT_CERTAINTY.unknown,
    ]),
    aggregateRemoteEffect: z.enum([
      MUTATION_EFFECT_CERTAINTY.notDispatched,
      MUTATION_EFFECT_CERTAINTY.definitelyRefused,
      MUTATION_EFFECT_CERTAINTY.confirmed,
      MUTATION_EFFECT_CERTAINTY.unknown,
    ]),
  })
  .strict();

/** Common content-free operation fields shared by the action-discriminated v4 union. */
const operationFields = {
  operationId: z.string(),
  reviewId: z.string(),
  authority: z.enum([
    RECONCILIATION_AUTHORITY_SOURCE.reconciliationDecision,
    RECONCILIATION_AUTHORITY_SOURCE.adoptionDecision,
    RECONCILIATION_AUTHORITY_SOURCE.tombstoneDecision,
    RECONCILIATION_AUTHORITY_SOURCE.recoveryRestoreDecision,
    RECONCILIATION_AUTHORITY_SOURCE.historyDecision,
  ]),
  phase: reconciliationOperationPhaseSchema,
  snapshot: reconciliationReviewSnapshotSchema,
  destinationPath: z.string().nullable(),
  reservations: z
    .array(reconciliationReservationSchema)
    .min(1)
    .max(MAX_MIRROR_TRACKED_PATHS),
  preservationReceipts: z
    .array(reconciliationPreservationReceiptSchema)
    .max(MAX_RECONCILIATION_PRESERVATION_RECEIPTS),
  successorOperationId: z.string().nullable(),
};

/** Strict v4 operation union: aggregate effects for ordinary actions, ordered steps for history. */
const reconciliationOperationSchema = z.union([
  z
    .object({
      ...operationFields,
      operationKind: z.literal(MIRROR_OPERATION_DTO_KIND.ordinary),
      action: reconciliationNonHistoryActionSchema,
      localEffect: z.enum([
        MUTATION_EFFECT_CERTAINTY.notDispatched,
        MUTATION_EFFECT_CERTAINTY.definitelyRefused,
        MUTATION_EFFECT_CERTAINTY.confirmed,
        MUTATION_EFFECT_CERTAINTY.unknown,
      ]),
      remoteEffect: z.enum([
        MUTATION_EFFECT_CERTAINTY.notDispatched,
        MUTATION_EFFECT_CERTAINTY.definitelyRefused,
        MUTATION_EFFECT_CERTAINTY.confirmed,
        MUTATION_EFFECT_CERTAINTY.unknown,
      ]),
      localEffectObservation: localEffectObservationSchema,
    })
    .strict(),
  z
    .object({
      ...operationFields,
      operationKind: z.literal(MIRROR_OPERATION_DTO_KIND.history),
      action: refinedHistoryActionSchema,
      historyProgress: refinedHistoryProgressSchema,
    })
    .strict(),
  z
    .object({
      ...operationFields,
      operationKind: z.literal(MIRROR_OPERATION_DTO_KIND.legacyV3History),
      action: legacyHistoryActionSchema,
      historyProgress: legacyHistoryProgressSchema,
    })
    .strict(),
]);

/** Strict v4 host-local envelope with bounded sparse M4 collections; rejects unknown fields and all older/newer versions. */
const deviceStateSchema = z
  .object({
    format: z.literal(MIRROR_DEVICE_STATE_FORMAT),
    version: z.literal(MIRROR_DEVICE_STATE_VERSION),
    deviceId: z.string(),
    lifecycle: lifecycleSchema,
    globalBlockReason: z
      .enum([
        MIRROR_GLOBAL_BLOCK_REASON.configurationUnavailable,
        MIRROR_GLOBAL_BLOCK_REASON.stateUnavailable,
        MIRROR_GLOBAL_BLOCK_REASON.persistenceFailed,
        MIRROR_GLOBAL_BLOCK_REASON.designationMismatch,
        MIRROR_GLOBAL_BLOCK_REASON.missingSecret,
        MIRROR_GLOBAL_BLOCK_REASON.handoffMismatch,
        MIRROR_GLOBAL_BLOCK_REASON.runtimeUnavailable,
      ])
      .nullable(),
    paths: z.array(pathStateSchema).max(MAX_MIRROR_TRACKED_PATHS),
    stagedHandoff: stagedHandoffSchema.nullable(),
    reconciliationReviews: z
      .array(reconciliationReviewSchema)
      .max(MAX_RECONCILIATION_REVIEWS),
    reconciliationOperations: z
      .array(reconciliationOperationSchema)
      .max(MAX_RECONCILIATION_OPERATIONS),
  })
  .strict();
/** Reads format/version only for incompatibility reporting; accepting this header is not accepting the stored state. */
const stateHeaderSchema = z
  .object({
    format: z.literal(MIRROR_DEVICE_STATE_FORMAT),
    version: z.number().int(),
  })
  .loose();

/** Adapter-only v4 envelope after structural validation, before domain rehydration and consistency checks. */
type DeviceStateDto = z.infer<typeof deviceStateSchema>;
/** Serialized M3 path ledger retained inside v4, with identifiers still represented as strings. */
type PathStateDto = z.infer<typeof pathStateSchema>;
/** Persisted baseline variant used by both live ledger and sampled review evidence. */
type AcknowledgementDto = z.infer<typeof acknowledgementSchema>;
/** Serialized pending M3 work whose event/revision authority is preserved during conversion. */
type DesiredStateDto = z.infer<typeof desiredStateSchema>;
/** Serialized device lifecycle, also embedded verbatim in stale-decision identity. */
type LifecycleDto = z.infer<typeof lifecycleSchema>;
/** Adapter DTO for staged transferable baselines and their still-separate alignment evidence. */
type StagedHandoffDto = z.infer<typeof stagedHandoffSchema>;
/** Serialized established handoff baseline, excluding the unassociated variant. */
type TransferableAcknowledgementDto = z.infer<
  typeof transferableAcknowledgementSchema
>;
/** Content-free path observation DTO retaining local, baseline, remote receipt and M3 evidence identity. */
type ReconciliationPathEvidenceDto = z.infer<
  typeof reconciliationPathEvidenceSchema
>;
/** Selected recovery metadata DTO; null selection is represented by the enclosing snapshot, not this union. */
type ReconciliationRecoveryEvidenceDto = z.infer<
  typeof reconciliationRecoveryEvidenceSchema
>;
/** Serialized immutable review identity shared by durable review and confirmed operation. */
type ReconciliationReviewSnapshotDto = z.infer<
  typeof reconciliationReviewSnapshotSchema
>;
/** Adapter representation of owner/configuration/listener/writer/lifecycle identity before ID branding. */
type ReconciliationRuntimeIdentityDto = z.infer<
  typeof reconciliationRuntimeIdentitySchema
>;
/** Durable review DTO linking sampled evidence to an optional admitted operation. */
type ReconciliationReviewDto = z.infer<typeof reconciliationReviewSchema>;
/** Persisted restart authority DTO containing phases, reservations and effect/proof metadata, never note bodies. */
type ReconciliationOperationDto = z.infer<typeof reconciliationOperationSchema>;
/** Serialized preservation claim awaiting identifier conversion and evidence-bound core validation. */
type ReconciliationPreservationReceiptDto = z.infer<
  typeof reconciliationPreservationReceiptSchema
>;

/**
 * Strictly decodes one value returned by `App.loadLocalStorage`.
 *
 * @param stored - Untrusted host-local value.
 * @param integrity - Adapter-owned checksum capability for staged baselines.
 * @returns Missing, valid, corrupt, or unsupported-version outcome, including older formats.
 * @throws When staged-baseline integrity cannot be evaluated by the host.
 */
export async function decodeMirrorDeviceState(
  stored: unknown,
  integrity: HandoffIntegrity = new WebCryptoHandoffIntegrity(),
): Promise<MirrorDeviceStateDecodeResult> {
  if (stored === null || stored === undefined) return { kind: "missing" };
  if (typeof stored !== "string") return { kind: "corrupt" };
  if (byteLength(stored) > MAX_MIRROR_DEVICE_STATE_BYTES) {
    return { kind: "corrupt" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { kind: "corrupt" };
  }
  const header = stateHeaderSchema.safeParse(parsed);
  if (header.success && header.data.version !== MIRROR_DEVICE_STATE_VERSION) {
    return { kind: "unsupported-version", version: header.data.version };
  }
  const decoded = deviceStateSchema.safeParse(parsed);
  if (!decoded.success) return { kind: "corrupt" };
  let state: MirrorDeviceState;
  try {
    state = convertDeviceState(decoded.data);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isMirrorDeviceStateConsistent(state)) return { kind: "corrupt" };
  if (state.stagedHandoff !== null) {
    const checksumMatches = await verifyHandoffPayloadChecksum(
      {
        associationId: state.stagedHandoff.associationId,
        origin: state.stagedHandoff.origin,
        entries: state.stagedHandoff.entries.map((entry) => ({
          path: entry.path,
          acknowledgement: entry.acknowledgement,
        })),
      },
      state.stagedHandoff.checksum,
      integrity,
    );
    if (!checksumMatches) return { kind: "corrupt" };
  }
  return { kind: "valid", state };
}

/**
 * Encodes one validated device-local state as a closed bounded JSON record.
 *
 * @param state - Core-owned content-free durable state.
 * @returns JSON suitable only for `App.saveLocalStorage`.
 * @throws When a caller supplies inconsistent state or the practical size bound is exceeded.
 */
export function encodeMirrorDeviceState(state: MirrorDeviceState): string {
  if (!isMirrorDeviceStateConsistent(state)) {
    throw new Error("Invalid mirror device state invariant.");
  }
  const projected = projectDeviceState(state);
  const validated = deviceStateSchema.safeParse(projected);
  /* v8 ignore next -- projection from a validated v4 domain state is schema-total. */
  if (!validated.success) {
    throw new Error("Invalid mirror device state fields.");
  }
  try {
    /* v8 ignore next -- strict projection round-trip preserves validated invariants. */
    if (!isMirrorDeviceStateConsistent(convertDeviceState(validated.data))) {
      throw new Error("Invalid projected mirror device state invariant.");
    }
  } catch {
    /* v8 ignore next -- strict projection conversion accepts every schema-valid projection. */
    throw new Error("Invalid mirror device state fields.");
  }
  const encoded = JSON.stringify(validated.data);
  if (byteLength(encoded) > MAX_MIRROR_DEVICE_STATE_BYTES) {
    throw new Error("Mirror device state exceeds the storage bound.");
  }
  return encoded;
}

/**
 * Projects the core ledger into the v4 envelope for strict schema and round-trip validation before encoding.
 *
 * @returns The content-free v4 envelope projection.
 */
function projectDeviceState(state: MirrorDeviceState): DeviceStateDto {
  return {
    format: MIRROR_DEVICE_STATE_FORMAT,
    version: MIRROR_DEVICE_STATE_VERSION,
    deviceId: state.deviceId,
    lifecycle: projectLifecycle(state.lifecycle),
    globalBlockReason: state.globalBlockReason,
    paths: state.paths.map(projectPathState),
    stagedHandoff:
      state.stagedHandoff === null
        ? null
        : {
            associationId: state.stagedHandoff.associationId,
            origin: state.stagedHandoff.origin,
            checksum: state.stagedHandoff.checksum,
            entries: state.stagedHandoff.entries.map((entry) => ({
              path: entry.path,
              acknowledgement: projectTransferableAcknowledgement(
                entry.acknowledgement,
              ),
              localAlignment: entry.localAlignment,
              remoteVerification: entry.remoteVerification,
              observationGeneration: entry.observationGeneration,
            })),
          },
    reconciliationReviews: state.reconciliationReviews.map(projectReview),
    reconciliationOperations:
      state.reconciliationOperations.map(projectOperation),
  };
}

/**
 * Emits only the fields belonging to the current lifecycle variant, preserving binding and pause authority.
 *
 * @returns The exact lifecycle DTO variant.
 */
function projectLifecycle(lifecycle: MirrorDeviceLifecycle): LifecycleDto {
  switch (lifecycle.kind) {
    case MIRROR_DEVICE_LIFECYCLE_KIND.disabled:
      return { kind: lifecycle.kind };
    case MIRROR_DEVICE_LIFECYCLE_KIND.active:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDraining:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffDrained:
    case MIRROR_DEVICE_LIFECYCLE_KIND.handoffStaged:
      return {
        kind: lifecycle.kind,
        associationId: lifecycle.associationId,
        origin: lifecycle.origin,
      };
    case MIRROR_DEVICE_LIFECYCLE_KIND.paused:
      return {
        kind: lifecycle.kind,
        associationId: lifecycle.associationId,
        origin: lifecycle.origin,
        reason: lifecycle.reason,
      };
  }
}

/**
 * Serializes a path's ACK, pending work and blocker without clearing unresolved effects or storing content.
 *
 * @returns The restart-preserving path DTO.
 */
function projectPathState(state: MirrorPathState): PathStateDto {
  return {
    path: state.path,
    acknowledgement: projectAcknowledgement(state.acknowledgement),
    unresolvedMutation:
      state.unresolvedMutation === null
        ? null
        : {
            intent: projectUnresolvedMutation(state.unresolvedMutation.intent),
            phase: state.unresolvedMutation.phase,
          },
    desired: projectDesiredState(state.desired),
    blockedReason: state.blockedReason,
  };
}

/**
 * Serializes baseline identity without turning unassociated paths into live or tombstoned ACKs.
 *
 * @returns The baseline DTO without inferred association.
 */
function projectAcknowledgement(
  acknowledgement: MirrorAcknowledgement,
): AcknowledgementDto {
  switch (acknowledgement.kind) {
    case MIRROR_ACKNOWLEDGEMENT_KIND.unassociated:
      return { kind: acknowledgement.kind };
    case MIRROR_ACKNOWLEDGEMENT_KIND.live:
      return {
        kind: acknowledgement.kind,
        revision: acknowledgement.revision,
        contentSha256: acknowledgement.contentSha256,
      };
    case MIRROR_ACKNOWLEDGEMENT_KIND.tombstone:
      return {
        kind: acknowledgement.kind,
        revision: acknowledgement.revision,
        recoveryId: acknowledgement.recoveryId,
      };
  }
}

/**
 * Emits the exact event generation and action-specific delete/rename evidence needed for restart.
 *
 * @returns The action-specific desired-work DTO.
 */
function projectDesiredState(desired: MirrorDesiredState): DesiredStateDto {
  switch (desired.kind) {
    case MIRROR_DESIRED_STATE_KIND.none:
      return { kind: desired.kind };
    case MIRROR_DESIRED_STATE_KIND.dirtyPresent:
      return {
        kind: desired.kind,
        observationGeneration: desired.observationGeneration,
      };
    case MIRROR_DESIRED_STATE_KIND.runtimeDelete:
      return {
        kind: desired.kind,
        observationGeneration: desired.observationGeneration,
        evidenceId: desired.evidenceId,
        associationId: desired.associationId,
        expectedRevision: desired.expectedRevision,
        graceDeadlineMilliseconds: desired.graceDeadlineMilliseconds,
      };
    case MIRROR_DESIRED_STATE_KIND.renameDeferred:
      return {
        kind: desired.kind,
        observationGeneration: desired.observationGeneration,
        renameId: desired.renameId,
        associationId: desired.associationId,
        sourcePath: desired.sourcePath,
        destinationPath: desired.destinationPath,
        sourceExpectedRevision: desired.sourceExpectedRevision,
        destinationObservationGeneration:
          desired.destinationObservationGeneration,
        destinationAcknowledgedRevision:
          desired.destinationAcknowledgedRevision,
        graceDeadlineMilliseconds: desired.graceDeadlineMilliseconds,
        phase: desired.phase,
      };
  }
}

/**
 * Preserves exact mutation identity, original predicate and consumed budgets in the content-free intent DTO.
 *
 * @returns The exact unresolved-intent DTO.
 */
function projectUnresolvedMutation(
  intent: UnresolvedMutationIntent,
): z.infer<typeof unresolvedMutationIntentSchema> {
  const common = {
    action: intent.action,
    associationId: intent.associationId,
    writerId: intent.writerId,
    operationId: intent.operationId,
    path: intent.path,
    mutationAttempts: intent.mutationAttempts,
    evidenceAttempts: intent.evidenceAttempts,
  };
  switch (intent.action) {
    case MUTATION_ACTION.create:
      return {
        ...common,
        action: intent.action,
        precondition: { kind: "absent" },
        contentSha256: intent.contentSha256,
      };
    case MUTATION_ACTION.update:
    case MUTATION_ACTION.recreate:
      return {
        ...common,
        action: intent.action,
        precondition: {
          kind: "matching-revision",
          revision: intent.precondition.revision,
        },
        contentSha256: intent.contentSha256,
      };
    case MUTATION_ACTION.tombstone:
      return {
        ...common,
        action: intent.action,
        precondition: {
          kind: "matching-revision",
          revision: intent.precondition.revision,
        },
      };
  }
}

/**
 * Emits established baseline metadata for staged handoff without local observation or device identity.
 *
 * @returns The established handoff acknowledgement DTO.
 */
function projectTransferableAcknowledgement(
  acknowledgement: TransferableAcknowledgement,
): TransferableAcknowledgementDto {
  if (acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live) {
    return {
      kind: acknowledgement.kind,
      revision: acknowledgement.revision,
      contentSha256: acknowledgement.contentSha256,
    };
  }
  return {
    kind: acknowledgement.kind,
    revision: acknowledgement.revision,
    recoveryId: acknowledgement.recoveryId,
  };
}

/**
 * Persists review identity/status and its sampled snapshot without refreshing observations or executing the decision.
 *
 * @returns The review DTO with its original sampled evidence.
 */
function projectReview(review: ReconciliationReview): ReconciliationReviewDto {
  return {
    retention: review.retention,
    reviewId: review.reviewId,
    classification: review.classification,
    status: review.status,
    snapshot: projectReconciliationSnapshot(review.snapshot),
    operationId: review.operationId,
  };
}

/**
 * Serializes restart ownership, restore successor linkage and separate local/remote effect certainty for strict validation.
 *
 * @returns The restart-preserving operation DTO.
 */
function projectOperation(
  operation: ReconciliationOperation,
): ReconciliationOperationDto {
  const common = {
    operationId: operation.operationId,
    reviewId: operation.reviewId,
    authority: operation.authority,
    phase: operation.phase,
    snapshot: projectReconciliationSnapshot(operation.snapshot),
    destinationPath: operation.destinationPath,
    reservations: operation.reservations.map((reservation) => ({
      path: reservation.path,
      kind: reservation.kind,
    })),
    preservationReceipts: operation.preservationReceipts.map((receipt) => ({
      ...receipt,
    })),
    successorOperationId: operation.successorOperationId,
  };
  if (isHistoryReconciliationOperation(operation)) {
    if (
      operation.historyProgress.kind === HISTORY_PROGRESS_KIND.legacyV3Unrefined
    ) {
      return {
        ...common,
        operationKind: MIRROR_OPERATION_DTO_KIND.legacyV3History,
        action: { kind: RECONCILIATION_ACTION.resolveHistory },
        historyProgress: { ...operation.historyProgress },
      };
    }
    const historyProgress = projectRefinedHistoryProgress(
      operation.historyProgress,
    );
    return {
      ...common,
      operationKind: MIRROR_OPERATION_DTO_KIND.history,
      action: {
        kind: RECONCILIATION_ACTION.resolveHistory,
        decision: historyProgress.decision,
      },
      historyProgress,
    };
  }
  return {
    ...common,
    operationKind: MIRROR_OPERATION_DTO_KIND.ordinary,
    action: { ...operation.action },
    localEffect: operation.localEffect,
    remoteEffect: operation.remoteEffect,
    localEffectObservation: projectLocalEffectObservation(
      operation.localEffectObservation,
    ),
  };
}

/**
 * Projects refined history progress into the strict mutable adapter DTO shape.
 *
 * @param progress - Durable refined history step ledger.
 * @returns Serialized decision, ordered steps, and cursor.
 */
function projectRefinedHistoryProgress(
  progress: RefinedHistoryProgress,
): z.infer<typeof refinedHistoryProgressSchema> {
  return {
    kind: progress.kind,
    decision:
      progress.decision.kind === HISTORY_DECISION_KIND.executeCleanupPlan
        ? { ...progress.decision }
        : { kind: progress.decision.kind },
    steps: progress.steps.map((step) => ({
      ...step,
      remoteEffect:
        step.remoteEffect.kind ===
        HISTORY_REMOTE_EFFECT_KIND.confirmedExactTombstoneReceipt
          ? {
              ...step.remoteEffect,
              receipt: { ...step.remoteEffect.receipt },
            }
          : { kind: step.remoteEffect.kind },
    })),
    nextStepIndex: progress.nextStepIndex,
  };
}

/**
 * Projects exact local-effect fencing into mutable adapter DTO arrays without weakening event identity.
 *
 * @param observation - Durable synthetic-effect observation.
 * @returns Strict serialized observation.
 */
function projectLocalEffectObservation(
  observation: LocalEffectObservation,
): z.infer<typeof localEffectObservationSchema> {
  switch (observation.kind) {
    case LOCAL_EFFECT_OBSERVATION_KIND.notRequired:
      return {
        ...observation,
        successor:
          observation.successor === null
            ? null
            : {
                ...observation.successor,
                eventKinds: [...observation.successor.eventKinds],
              },
      };
    case LOCAL_EFFECT_OBSERVATION_KIND.notStarted:
    case LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced:
      return { kind: observation.kind };
    case LOCAL_EFFECT_OBSERVATION_KIND.prepared:
    case LOCAL_EFFECT_OBSERVATION_KIND.confirmed:
    case LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3:
      return {
        ...observation,
        successor:
          observation.successor === null
            ? null
            : {
                ...observation.successor,
                eventKinds: [...observation.successor.eventKinds],
              },
      };
  }
}

/**
 * Projects the complete immutable sample without dropping related paths, runtime identity or selected recovery metadata.
 *
 * @returns The complete reconciliation sample DTO.
 */
function projectReconciliationSnapshot(
  snapshot: ReconciliationReviewSnapshot,
): ReconciliationReviewSnapshotDto {
  return {
    runtime: projectReconciliationRuntime(snapshot.runtime),
    targetPath: snapshot.targetPath,
    paths: snapshot.paths.map(projectReconciliationPathEvidence),
    recovery: snapshot.recovery === null ? null : { ...snapshot.recovery },
  };
}

/**
 * Preserves every stale-decision runtime dimension, including full lifecycle rather than merely its kind.
 *
 * @returns The sampled runtime-identity DTO.
 */
function projectReconciliationRuntime(
  runtime: ReconciliationRuntimeIdentity,
): ReconciliationRuntimeIdentityDto {
  return {
    runtimeOwnerVersion: runtime.runtimeOwnerVersion,
    configurationGeneration: runtime.configurationGeneration,
    listenerEpoch: runtime.listenerEpoch,
    deviceId: runtime.deviceId,
    designatedWriterId: runtime.designatedWriterId,
    lifecycle: projectLifecycle(runtime.lifecycle),
  };
}

/**
 * Retains exact local/baseline/remote receipts and M3 blockers in the persisted sample, without synthesizing evidence.
 *
 * @returns The exact path-evidence DTO.
 */
function projectReconciliationPathEvidence(
  evidence: ReconciliationPathEvidence,
): ReconciliationPathEvidenceDto {
  return {
    path: evidence.path,
    local: { ...evidence.local },
    baseline: projectAcknowledgement(evidence.baseline),
    remote:
      evidence.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.live ||
      evidence.remote.kind === RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone
        ? {
            ...evidence.remote,
            receipt: projectOperationReceipt(evidence.remote.receipt),
          }
        : { ...evidence.remote },
    m3: {
      unresolvedMutation:
        evidence.m3.unresolvedMutation === null
          ? null
          : {
              intent: projectUnresolvedMutation(
                evidence.m3.unresolvedMutation.intent,
              ),
              phase: evidence.m3.unresolvedMutation.phase,
            },
      deferredHistory:
        evidence.m3.deferredHistory === null
          ? null
          : { ...evidence.m3.deferredHistory },
    },
  };
}

/**
 * Emits the sampled receipt's original action/predicate/hash relationship; tombstones carry no content hash.
 *
 * @returns The action-specific receipt DTO.
 */
function projectOperationReceipt(
  receipt: OperationReceipt,
): z.infer<typeof operationReceiptSchema> {
  if (receipt.action === MUTATION_ACTION.create) {
    return {
      action: receipt.action,
      associationId: receipt.associationId,
      operationId: receipt.operationId,
      precondition: { kind: receipt.precondition.kind },
      contentSha256: receipt.contentSha256,
    };
  }
  if (receipt.action === MUTATION_ACTION.tombstone) {
    return {
      action: receipt.action,
      associationId: receipt.associationId,
      operationId: receipt.operationId,
      precondition: { ...receipt.precondition },
    };
  }
  return {
    action: receipt.action,
    associationId: receipt.associationId,
    operationId: receipt.operationId,
    precondition: { ...receipt.precondition },
    contentSha256: receipt.contentSha256,
  };
}

/**
 * Rehydrates v4 identifiers while preserving ledger metadata; the caller must still enforce full consistency and handoff integrity.
 *
 * @returns Rehydrated state pending consistency and integrity validation.
 */
function convertDeviceState(dto: DeviceStateDto): MirrorDeviceState {
  return {
    deviceId: requireParsed(dto.deviceId, createMirrorWriterId),
    lifecycle: convertLifecycle(dto.lifecycle),
    globalBlockReason: dto.globalBlockReason,
    paths: dto.paths.map(convertPathState),
    stagedHandoff:
      dto.stagedHandoff === null
        ? null
        : convertStagedHandoff(dto.stagedHandoff),
    reconciliationReviews: dto.reconciliationReviews.map(convertReview),
    reconciliationOperations:
      dto.reconciliationOperations.map(convertOperation),
  };
}

/**
 * Rehydrates canonical binding identity without changing lifecycle authority or pause reason.
 *
 * @returns The lifecycle with validated branded binding identity.
 */
function convertLifecycle(dto: LifecycleDto): MirrorDeviceLifecycle {
  if (dto.kind === MIRROR_DEVICE_LIFECYCLE_KIND.disabled) return dto;
  const associationId = requireParsed(
    dto.associationId,
    createMirrorAssociationId,
  );
  const origin = requireParsed(dto.origin, parsePersistedMirrorOrigin);
  if (dto.kind === MIRROR_DEVICE_LIFECYCLE_KIND.paused) {
    return { kind: dto.kind, associationId, origin, reason: dto.reason };
  }
  return { kind: dto.kind, associationId, origin };
}

/**
 * Rehydrates literal path and exact baseline/pending-work metadata, retaining unresolved phases and blockers.
 *
 * @returns The rehydrated path ledger entry.
 */
function convertPathState(dto: PathStateDto): MirrorPathState {
  const path = requireParsed(dto.path, parsePersistedNotePath);
  return {
    path,
    acknowledgement: convertAcknowledgement(dto.acknowledgement),
    unresolvedMutation:
      dto.unresolvedMutation === null
        ? null
        : {
            intent: convertUnresolvedMutation(dto.unresolvedMutation.intent),
            phase: dto.unresolvedMutation.phase,
          },
    desired: convertDesiredState(dto.desired),
    blockedReason: dto.blockedReason,
  };
}

/**
 * Restores branded baseline revision/hash or recovery ID; equal bytes do not establish a missing ACK.
 *
 * @returns The recorded acknowledgement with validated identifiers.
 */
function convertAcknowledgement(
  dto: AcknowledgementDto,
): MirrorAcknowledgement {
  if (dto.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated) return dto;
  const revision = requireParsed(dto.revision, createApplicationRevision);
  if (dto.kind === MIRROR_ACKNOWLEDGEMENT_KIND.live) {
    return {
      kind: dto.kind,
      revision,
      contentSha256: requireParsed(dto.contentSha256, createContentSha256),
    };
  }
  return {
    kind: dto.kind,
    revision,
    recoveryId: requireParsed(dto.recoveryId, createRecoverySnapshotId),
  };
}

/**
 * Rehydrates pending work without refreshing event generations, grace deadlines or rename destination prerequisites.
 *
 * @returns The original desired-work variant with validated identifiers.
 */
function convertDesiredState(dto: DesiredStateDto): MirrorDesiredState {
  if (
    dto.kind === MIRROR_DESIRED_STATE_KIND.none ||
    dto.kind === MIRROR_DESIRED_STATE_KIND.dirtyPresent
  ) {
    return dto;
  }
  if (dto.kind === MIRROR_DESIRED_STATE_KIND.runtimeDelete) {
    return {
      ...dto,
      evidenceId: requireParsed(dto.evidenceId, createMirrorOperationId),
      associationId: requireParsed(
        dto.associationId,
        createMirrorAssociationId,
      ),
      expectedRevision: requireParsed(
        dto.expectedRevision,
        createApplicationRevision,
      ),
    };
  }
  return {
    ...dto,
    renameId: requireParsed(dto.renameId, createMirrorOperationId),
    associationId: requireParsed(dto.associationId, createMirrorAssociationId),
    sourcePath: requireParsed(dto.sourcePath, parsePersistedNotePath),
    destinationPath:
      dto.destinationPath === null
        ? null
        : requireParsed(dto.destinationPath, parsePersistedNotePath),
    sourceExpectedRevision: requireParsed(
      dto.sourceExpectedRevision,
      createApplicationRevision,
    ),
    destinationAcknowledgedRevision:
      dto.destinationAcknowledgedRevision === null
        ? null
        : requireParsed(
            dto.destinationAcknowledgedRevision,
            createApplicationRevision,
          ),
  };
}

/**
 * Restores sampled deferred history using the desired-state converter and refuses any non-rename result.
 *
 * @returns The rehydrated deferred rename history.
 */
function convertDeferredHistory(
  dto: z.infer<typeof renameDeferredStateSchema>,
): RenameDeferredMirrorState {
  const converted = convertDesiredState(dto);
  /* v8 ignore start -- the caller schema is the rename-deferred discriminant branch. */
  if (converted.kind !== MIRROR_DESIRED_STATE_KIND.renameDeferred) {
    throw new Error("Expected deferred-history evidence.");
  }
  /* v8 ignore stop */
  return converted;
}

/**
 * Restores exact persisted intent identity and retry/evidence budgets without acquiring new mutation authority.
 *
 * @returns The original unresolved mutation with validated identifiers.
 */
function convertUnresolvedMutation(
  dto: z.infer<typeof unresolvedMutationIntentSchema>,
): UnresolvedMutationIntent {
  const associationId = requireParsed(
    dto.associationId,
    createMirrorAssociationId,
  );
  const writerId = requireParsed(dto.writerId, createMirrorWriterId);
  const operationId = requireParsed(dto.operationId, createMirrorOperationId);
  const path = requireParsed(dto.path, parsePersistedNotePath);
  if (dto.action === MUTATION_ACTION.create) {
    return {
      action: dto.action,
      associationId,
      writerId,
      operationId,
      path,
      precondition: { kind: "absent" },
      contentSha256: requireParsed(dto.contentSha256, createContentSha256),
      mutationAttempts: dto.mutationAttempts,
      evidenceAttempts: dto.evidenceAttempts,
    };
  }
  const precondition = convertMatchingPrecondition(dto.precondition);
  if (dto.action === MUTATION_ACTION.tombstone) {
    return {
      action: dto.action,
      associationId,
      writerId,
      operationId,
      path,
      precondition,
      mutationAttempts: dto.mutationAttempts,
      evidenceAttempts: dto.evidenceAttempts,
    };
  }
  return {
    action: dto.action,
    associationId,
    writerId,
    operationId,
    path,
    precondition,
    contentSha256: requireParsed(dto.contentSha256, createContentSha256),
    mutationAttempts: dto.mutationAttempts,
    evidenceAttempts: dto.evidenceAttempts,
  };
}

/**
 * Requires and brands the original revision predicate; absence throws rather than becoming replacement authority.
 *
 * @param dto - Persisted content intent that must contain an original revision predicate.
 * @returns The validated matching-revision precondition.
 */
function convertMatchingPrecondition(
  dto: z.infer<typeof unresolvedMutationIntentSchema>["precondition"],
): Exclude<ConditionalMutationPrecondition, { readonly kind: "absent" }> {
  if (dto.kind === "absent") throw new Error("Expected matching revision.");
  return {
    kind: dto.kind,
    revision: requireParsed(dto.revision, createApplicationRevision),
  };
}

/**
 * Restores staged baselines/checksum/alignment evidence; payload verification remains the decoder's responsibility.
 *
 * @returns The rehydrated staged handoff supplied by the persisted variant.
 */
function convertStagedHandoff(dto: StagedHandoffDto): StagedHandoff {
  return {
    associationId: requireParsed(dto.associationId, createMirrorAssociationId),
    origin: requireParsed(dto.origin, parsePersistedMirrorOrigin),
    checksum: requireParsed(dto.checksum, createContentSha256),
    entries: dto.entries.map((entry) => ({
      path: requireParsed(entry.path, parsePersistedNotePath),
      acknowledgement: convertTransferableAcknowledgement(
        entry.acknowledgement,
      ),
      localAlignment: entry.localAlignment,
      remoteVerification: entry.remoteVerification,
      observationGeneration: entry.observationGeneration,
    })),
  };
}

/**
 * Rehydrates review and operation IDs without treating persisted review status as a fresh UI decision.
 *
 * @returns The rehydrated persisted review.
 */
function convertReview(dto: ReconciliationReviewDto): ReconciliationReview {
  return {
    retention: dto.retention,
    reviewId: requireParsed(dto.reviewId, createMirrorOperationId),
    classification: dto.classification,
    status: dto.status,
    snapshot: convertReconciliationSnapshot(dto.snapshot),
    operationId:
      dto.operationId === null
        ? null
        : requireParsed(dto.operationId, createMirrorOperationId),
  };
}

/**
 * Restores phase, snapshot, reservations, preservation and successor identity without settling or replaying any effects.
 *
 * @returns The rehydrated operation without replay or effect settlement.
 */
function convertOperation(
  dto: ReconciliationOperationDto,
): ReconciliationOperation {
  const common = {
    operationId: requireParsed(dto.operationId, createMirrorOperationId),
    reviewId: requireParsed(dto.reviewId, createMirrorOperationId),
    authority: dto.authority,
    phase: dto.phase,
    snapshot: convertReconciliationSnapshot(dto.snapshot),
    destinationPath:
      dto.destinationPath === null
        ? null
        : requireParsed(dto.destinationPath, parsePersistedNotePath),
    reservations: dto.reservations.map((reservation) => ({
      path: requireParsed(reservation.path, parsePersistedNotePath),
      kind: reservation.kind,
    })),
    preservationReceipts: dto.preservationReceipts.map(
      convertPreservationReceipt,
    ),
    successorOperationId:
      dto.successorOperationId === null
        ? null
        : requireParsed(dto.successorOperationId, createMirrorOperationId),
  };
  if ("historyProgress" in dto) {
    const historyProgress = convertHistoryProgress(dto.historyProgress);
    if (historyProgress.kind === HISTORY_PROGRESS_KIND.legacyV3Unrefined) {
      return {
        ...common,
        action: { kind: RECONCILIATION_ACTION.resolveHistory },
        historyProgress,
      };
    }
    return {
      ...common,
      action: {
        kind: RECONCILIATION_ACTION.resolveHistory,
        decision: historyProgress.decision,
      },
      historyProgress,
    };
  }
  return {
    ...common,
    action: { ...dto.action },
    localEffect: dto.localEffect,
    remoteEffect: dto.remoteEffect,
    localEffectObservation: convertLocalEffectObservation(
      dto.localEffectObservation,
    ),
  };
}

/**
 * @param progress - Structurally validated serialized history progress.
 * @returns Rehydrated history progress with every step identity and predicate branded.
 */
function convertHistoryProgress(
  progress: Extract<
    ReconciliationOperationDto,
    { action: { kind: "bounded-history-decision" } }
  >["historyProgress"],
): RefinedHistoryProgress | LegacyV3HistoryProgress {
  if (progress.kind === HISTORY_PROGRESS_KIND.legacyV3Unrefined) {
    return { ...progress };
  }
  return {
    kind: progress.kind,
    decision:
      progress.decision.kind === HISTORY_DECISION_KIND.executeCleanupPlan
        ? {
            kind: progress.decision.kind,
            canonicalPath:
              progress.decision.canonicalPath === null
                ? null
                : requireParsed(
                    progress.decision.canonicalPath,
                    parsePersistedNotePath,
                  ),
          }
        : { kind: progress.decision.kind },
    steps: progress.steps.map((step): HistoryCleanupStep => {
      return {
        stepId: requireParsed(step.stepId, createMirrorOperationId),
        kind: step.kind,
        sourcePath: requireParsed(step.sourcePath, parsePersistedNotePath),
        prerequisitePath:
          step.prerequisitePath === null
            ? null
            : requireParsed(step.prerequisitePath, parsePersistedNotePath),
        sourceRevision: requireParsed(
          step.sourceRevision,
          createApplicationRevision,
        ),
        sourceContentSha256: requireParsed(
          step.sourceContentSha256,
          createContentSha256,
        ),
        prerequisiteRevision:
          step.prerequisiteRevision === null
            ? null
            : requireParsed(
                step.prerequisiteRevision,
                createApplicationRevision,
              ),
        localAbsenceGeneration: step.localAbsenceGeneration,
        phase: step.phase,
        remoteEffect: convertHistoryRemoteEffect(step.remoteEffect),
      };
    }),
    nextStepIndex: progress.nextStepIndex,
  };
}

/**
 * Rehydrates one history step's remote certainty, retaining only exact tombstone receipts as confirmation.
 *
 * @param effect - Structurally validated serialized remote-effect evidence.
 * @returns Strongly discriminated history remote-effect evidence.
 */
function convertHistoryRemoteEffect(
  effect: z.infer<typeof historyRemoteEffectSchema>,
): HistoryCleanupStep["remoteEffect"] {
  switch (effect.kind) {
    case MUTATION_EFFECT_CERTAINTY.notDispatched:
    case MUTATION_EFFECT_CERTAINTY.definitelyRefused:
    case MUTATION_EFFECT_CERTAINTY.unknown:
      return { kind: effect.kind };
    case HISTORY_REMOTE_EFFECT_KIND.confirmedExactTombstoneReceipt: {
      const receipt = convertOperationReceipt(effect.receipt);
      if (receipt.action !== MUTATION_ACTION.tombstone) {
        throw new Error("Expected history tombstone receipt.");
      }
      return {
        kind: effect.kind,
        revision: requireParsed(effect.revision, createApplicationRevision),
        receipt,
      };
    }
  }
}

/**
 * @param observation - Structurally validated local-effect observation evidence.
 * @returns Rehydrated exact synthetic observation without assigning host-event causality.
 */
function convertLocalEffectObservation(
  observation: Extract<
    ReconciliationOperationDto,
    { localEffect: string }
  >["localEffectObservation"],
): Extract<
  ReconciliationOperation,
  { localEffect: string }
>["localEffectObservation"] {
  if (observation.kind === LOCAL_EFFECT_OBSERVATION_KIND.notRequired) {
    return {
      ...observation,
      path: requireParsed(observation.path, parsePersistedNotePath),
    };
  }
  if (
    observation.kind === LOCAL_EFFECT_OBSERVATION_KIND.notStarted ||
    observation.kind === LOCAL_EFFECT_OBSERVATION_KIND.legacyV3Unfenced
  ) {
    return observation;
  }
  return {
    ...observation,
    effectId: requireParsed(observation.effectId, createMirrorOperationId),
    path: requireParsed(observation.path, parsePersistedNotePath),
    expectedHash: requireParsed(observation.expectedHash, createContentSha256),
    postconditionHash:
      observation.postconditionHash === null
        ? null
        : requireParsed(observation.postconditionHash, createContentSha256),
  };
}

/**
 * Rehydrates all immutable snapshot dimensions; does not normalize, refresh or infer absent evidence.
 *
 * @returns The original snapshot with validated domain identifiers.
 */
function convertReconciliationSnapshot(
  dto: ReconciliationReviewSnapshotDto,
): ReconciliationReviewSnapshot {
  return {
    runtime: convertReconciliationRuntime(dto.runtime),
    targetPath: requireParsed(dto.targetPath, parsePersistedNotePath),
    paths: dto.paths.map(convertReconciliationPathEvidence),
    recovery:
      dto.recovery === null
        ? null
        : convertReconciliationRecoveryEvidence(dto.recovery),
  };
}

/**
 * Brands sampled writer/binding IDs while preserving owner version, configuration generation and listener epoch exactly.
 *
 * @returns The sampled runtime identity with validated identifiers.
 */
function convertReconciliationRuntime(
  dto: ReconciliationRuntimeIdentityDto,
): ReconciliationRuntimeIdentity {
  return {
    runtimeOwnerVersion: dto.runtimeOwnerVersion,
    configurationGeneration: dto.configurationGeneration,
    listenerEpoch: dto.listenerEpoch,
    deviceId: requireParsed(dto.deviceId, createMirrorWriterId),
    designatedWriterId: requireParsed(
      dto.designatedWriterId,
      createMirrorWriterId,
    ),
    lifecycle: convertLifecycle(dto.lifecycle),
  };
}

/**
 * Rehydrates sampled evidence and rejects receipt action/type mismatches; cross-field authority checks remain in core.
 *
 * @returns The sampled path evidence with validated receipt variants.
 */
function convertReconciliationPathEvidence(
  dto: ReconciliationPathEvidenceDto,
): ReconciliationPathEvidence {
  const local =
    dto.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.live
      ? {
          ...dto.local,
          contentSha256: requireParsed(
            dto.local.contentSha256,
            createContentSha256,
          ),
        }
      : dto.local;
  let remote: ReconciliationPathEvidence["remote"];
  switch (dto.remote.kind) {
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.absent:
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable:
      remote = dto.remote;
      break;
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy:
      remote = {
        kind: dto.remote.kind,
        contentSha256: requireParsed(
          dto.remote.contentSha256,
          createContentSha256,
        ),
      };
      break;
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.live: {
      const receipt = convertOperationReceipt(dto.remote.receipt);
      if (receipt.action === MUTATION_ACTION.tombstone) {
        throw new Error("Expected content receipt.");
      }
      remote = {
        kind: dto.remote.kind,
        associationId: requireParsed(
          dto.remote.associationId,
          createMirrorAssociationId,
        ),
        revision: requireParsed(dto.remote.revision, createApplicationRevision),
        contentSha256: requireParsed(
          dto.remote.contentSha256,
          createContentSha256,
        ),
        receipt,
      };
      break;
    }
    case RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone: {
      const receipt = convertOperationReceipt(dto.remote.receipt);
      if (receipt.action !== MUTATION_ACTION.tombstone) {
        throw new Error("Expected tombstone receipt.");
      }
      remote = {
        kind: dto.remote.kind,
        associationId: requireParsed(
          dto.remote.associationId,
          createMirrorAssociationId,
        ),
        revision: requireParsed(dto.remote.revision, createApplicationRevision),
        deletedRevision: requireParsed(
          dto.remote.deletedRevision,
          createApplicationRevision,
        ),
        recoveryId: requireParsed(
          dto.remote.recoveryId,
          createRecoverySnapshotId,
        ),
        receipt,
      };
      break;
    }
  }
  return {
    path: requireParsed(dto.path, parsePersistedNotePath),
    local,
    baseline: convertAcknowledgement(dto.baseline),
    remote,
    m3: {
      unresolvedMutation:
        dto.m3.unresolvedMutation === null
          ? null
          : {
              intent: convertUnresolvedMutation(
                dto.m3.unresolvedMutation.intent,
              ),
              phase: dto.m3.unresolvedMutation.phase,
            },
      deferredHistory:
        dto.m3.deferredHistory === null
          ? null
          : convertDeferredHistory(dto.m3.deferredHistory),
    },
  };
}

/**
 * Brands receipt identity and exact parent predicate, preserving the content-versus-tombstone distinction.
 *
 * @returns The action-specific operation receipt.
 */
function convertOperationReceipt(
  dto: z.infer<typeof operationReceiptSchema>,
): OperationReceipt {
  const associationId = requireParsed(
    dto.associationId,
    createMirrorAssociationId,
  );
  const operationId = requireParsed(dto.operationId, createMirrorOperationId);
  if (dto.action === MUTATION_ACTION.create) {
    return {
      action: dto.action,
      associationId,
      operationId,
      precondition: { kind: dto.precondition.kind },
      contentSha256: requireParsed(dto.contentSha256, createContentSha256),
    };
  }
  const precondition = convertMatchingPrecondition(dto.precondition);
  if (dto.action === MUTATION_ACTION.tombstone) {
    return { action: dto.action, associationId, operationId, precondition };
  }
  const receipt: ContentOperationReceipt = {
    action: dto.action,
    associationId,
    operationId,
    precondition,
    contentSha256: requireParsed(dto.contentSha256, createContentSha256),
  };
  return receipt;
}

/**
 * Rehydrates selected recovery identity and retention metadata without fetching bytes or deciding recoverability now.
 *
 * @returns The rehydrated selected recovery evidence.
 */
function convertReconciliationRecoveryEvidence(
  dto: ReconciliationRecoveryEvidenceDto,
): ReconciliationRecoveryEvidence {
  const common = {
    id: requireParsed(dto.id, createRecoverySnapshotId),
    associationId: requireParsed(dto.associationId, createMirrorAssociationId),
    path: requireParsed(dto.path, parsePersistedNotePath),
    revision: requireParsed(dto.revision, createApplicationRevision),
    sourceRevision: requireParsed(
      dto.sourceRevision,
      createApplicationRevision,
    ),
    contentSha256: requireParsed(dto.contentSha256, createContentSha256),
  };
  return dto.kind === RECOVERY_SNAPSHOT_STATE_KIND.prepared
    ? { kind: dto.kind, ...common }
    : { kind: dto.kind, ...common, recoverUntil: dto.recoverUntil };
}

/**
 * Rehydrates a preservation claim without promoting its proof state; core subsequently checks its evidence-derived identity.
 *
 * @returns The rehydrated preservation claim pending core validation.
 */
function convertPreservationReceipt(
  dto: ReconciliationPreservationReceiptDto,
): ReconciliationPreservationReceipt {
  const common = {
    operationId: requireParsed(dto.operationId, createMirrorOperationId),
    originalPath: requireParsed(dto.originalPath, parsePersistedNotePath),
    side: dto.side,
    sourceRevision:
      dto.sourceRevision === null
        ? null
        : requireParsed(dto.sourceRevision, createApplicationRevision),
    contentSha256: requireParsed(dto.contentSha256, createContentSha256),
    preservationPath: dto.preservationPath,
    proofState: dto.proofState,
  };
  return dto.scope === RECONCILIATION_PRESERVATION_SCOPE.historyStep
    ? {
        scope: dto.scope,
        stepId: requireParsed(dto.stepId, createMirrorOperationId),
        ...common,
      }
    : { scope: dto.scope, ...common };
}

/**
 * Restores an established handoff ACK and throws if conversion yields an unassociated baseline.
 *
 * @returns The established live or tombstone acknowledgement.
 */
function convertTransferableAcknowledgement(
  dto: TransferableAcknowledgementDto,
): TransferableAcknowledgement {
  const acknowledgement = convertAcknowledgement(dto);
  if (acknowledgement.kind === MIRROR_ACKNOWLEDGEMENT_KIND.unassociated) {
    throw new Error("Unassociated acknowledgement is not transferable.");
  }
  return acknowledgement;
}

/**
 * @param value - Persisted literal local path.
 * @returns The path unchanged after validating its literal form.
 */
function parsePersistedNotePath(value: string): NotePath | undefined {
  return isNormalizedNotePath(value) ? value : undefined;
}

/**
 * Applies a boundary parser or throws so invalid persisted identifiers become corrupt-state outcomes.
 *
 * @param value - Persisted identifier text.
 * @param parser - Boundary validator returning undefined for invalid syntax.
 * @returns The validated parser result.
 */
function requireParsed<Value>(
  value: string,
  parser: (candidate: string) => Value | undefined,
): Value {
  const parsed = parser(value);
  if (parsed === undefined) throw new Error("Invalid persisted identifier.");
  return parsed;
}

/**
 * Returns UTF-8 bytes for the persisted v4 snapshot capacity check.
 *
 * @param value - Serialized v4 snapshot text.
 * @returns Encoded v4 snapshot byte count.
 */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
