import { createHash } from "node:crypto";
import {
  projectLocalReconciliationResult,
  projectReconciliationPreservation,
  projectRemoteReconciliationResult,
  rejectReconciliationAction,
} from "@core/mirror/reconciliation-action-result";
import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  ConflictPreservationService,
  type ContentSha256,
  CURRENT_NOTE_STATE_KIND,
  type CurrentNoteState,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createReconciliationPreservationPath,
  isNonHistoryReconciliationOperation,
  LEGACY_RECONCILIATION_PRESERVATION_ROOT,
  LiveResolutionService,
  LOCAL_EFFECT_OBSERVATION_KIND,
  LOCAL_RECONCILIATION_WRITE_OUTCOME,
  type LocalReconciliationWriter,
  LocalReconciliationWriteService,
  MIRROR_ACKNOWLEDGEMENT_KIND,
  MIRROR_DEVICE_LIFECYCLE_KIND,
  type MirrorDeviceState,
  MirrorStateOwner,
  type MirrorStateStore,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  type MutationAcknowledgement,
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
  type ReconciliationAction,
  type ReconciliationClassification,
  ReconciliationEffectExecutor,
  type ReconciliationNonHistoryOperation,
  ReconciliationObservationGenerationOwner,
  type ReconciliationOperation,
  type ReconciliationPathEvidence,
  type ReconciliationReviewSnapshot,
  RecoveryRestoreService,
  type RecoverySnapshotState,
  type RemoteBridge,
  type RemoteBridgeMutationResult,
  RemoteTombstoneResolutionService,
  ResolutionCoordinator,
  RevisionedAdoptionService,
} from "@obsidian-ai-bridge/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * @param value - Optional fixture value.
 * @returns Required validated fixture value.
 */
function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid reconciliation fixture.");
  return value;
}

/**
 * @param value - Optional operation fixture.
 * @returns Required aggregate-effect operation fixture.
 */
function requiredNonHistory(
  value: ReconciliationOperation | undefined,
): ReconciliationNonHistoryOperation {
  if (value === undefined || !isNonHistoryReconciliationOperation(value)) {
    throw new Error("Expected non-history operation.");
  }
  return value;
}

const DEVICE = required(
  createMirrorWriterId("11111111-1111-4111-8111-111111111111"),
);
const ASSOCIATION = required(
  createMirrorAssociationId("22222222-2222-4222-8222-222222222222"),
);
const REVIEW = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const OPERATION = required(
  createMirrorOperationId("44444444-4444-4444-8444-444444444444"),
);
const REMOTE_OPERATION = required(
  createMirrorOperationId("55555555-5555-4555-8555-555555555555"),
);
const REVISION_BASE = required(
  createApplicationRevision("66666666-6666-4666-8666-666666666666"),
);
const REVISION_REMOTE = required(
  createApplicationRevision("77777777-7777-4777-8777-777777777777"),
);
const REVISION_RESULT = required(
  createApplicationRevision("88888888-8888-4888-8888-888888888888"),
);
const RECOVERY = required(
  createMirrorOperationId("99999999-9999-4999-8999-999999999999"),
);
const PATH = "notes/conflict.md" as ReconciliationPathEvidence["path"];
const DESTINATION = "notes/copy.md" as ReconciliationPathEvidence["path"];
const LOCAL_TEXT = "local version";
const REMOTE_TEXT = "remote version";
const RECOVERY_TEXT = "recovered version";

/**
 * @param content - Fixture content.
 * @returns Canonical content digest.
 */
function digest(content: string): ContentSha256 {
  return required(
    createContentSha256(createHash("sha256").update(content).digest("hex")),
  );
}

const HASH_BASE = digest("base");
const HASH_LOCAL = digest(LOCAL_TEXT);
const HASH_REMOTE = digest(REMOTE_TEXT);
const HASH_RECOVERY = digest(RECOVERY_TEXT);

/** In-memory state store used by serialized effect tests. */
class Store implements MirrorStateStore {
  readonly saved: MirrorDeviceState[] = [];
  failNextSave = false;
  failOnSave: number | null = null;
  saveAttempts = 0;

  /** @inheritdoc */
  async save(state: MirrorDeviceState) {
    this.saveAttempts += 1;
    if (this.failNextSave || this.failOnSave === this.saveAttempts) {
      this.failNextSave = false;
      return { kind: "failed", reason: "quota-or-storage-error" } as const;
    }
    this.saved.push(state);
    return { kind: "saved" } as const;
  }
}

/** Mutable local read/writer double implementing only the declared narrow capabilities. */
class LocalDouble implements LocalReconciliationWriter {
  readonly files = new Map<string, string>();
  readonly preservation = new Map<string, string>();
  refuseNextCreate = false;
  refuseNextReplace = false;
  loseNextReplaceResponse = false;
  loseNextPreservationResponse = false;

  /** @returns Empty metadata inventory because action tests address admitted paths directly. */
  async list() {
    return {
      kind: "ok",
      entries: [],
      skipped: {
        unsupported_file: 0,
        excluded_location: 0,
        invalid_path: 0,
        oversized: 0,
      },
    } as const;
  }

  /**
   * @param path - Canonical vault path.
   * @returns Current exact local body or a stable missing-file result.
   */
  async read(path: ReconciliationPathEvidence["path"]) {
    const content = this.files.get(path);
    return content === undefined
      ? ({ kind: "failed", reason: "missing_file" } as const)
      : ({
          kind: "ok",
          content,
          sizeBytes: Buffer.byteLength(content),
        } as const);
  }

  /** @inheritdoc */
  async createEligible(
    request: Parameters<LocalReconciliationWriter["createEligible"]>[0],
  ) {
    if (this.refuseNextCreate) {
      this.refuseNextCreate = false;
      return {
        kind: "refused",
        reason: "destination-file-exists",
        effect: "definitely-refused",
      } as const;
    }
    const existing = this.files.get(request.path);
    if (existing !== undefined) {
      if (
        request.mode === "same-operation-recovery" &&
        digest(existing) === request.contentSha256
      ) {
        return {
          kind: "confirmed",
          outcome: LOCAL_RECONCILIATION_WRITE_OUTCOME.adopted,
          path: request.path,
          contentSha256: request.contentSha256,
          sizeBytes: Buffer.byteLength(existing),
        } as const;
      }
      return {
        kind: "refused",
        reason: "destination-file-exists",
        effect: "definitely-refused",
      } as const;
    }
    this.files.set(request.path, request.content);
    return {
      kind: "confirmed",
      outcome: LOCAL_RECONCILIATION_WRITE_OUTCOME.created,
      path: request.path,
      contentSha256: request.contentSha256,
      sizeBytes: Buffer.byteLength(request.content),
    } as const;
  }

  /** @inheritdoc */
  async replaceEligible(
    request: Parameters<LocalReconciliationWriter["replaceEligible"]>[0],
  ) {
    if (this.refuseNextReplace) {
      this.refuseNextReplace = false;
      return {
        kind: "refused",
        reason: "stale-content",
        effect: "definitely-refused",
      } as const;
    }
    const existing = this.files.get(request.path);
    if (existing === request.replacementContent) {
      return {
        kind: "confirmed",
        outcome: LOCAL_RECONCILIATION_WRITE_OUTCOME.adopted,
        path: request.path,
        contentSha256: request.replacementContentSha256,
        sizeBytes: Buffer.byteLength(existing),
      } as const;
    }
    if (existing !== request.expectedContent) {
      return {
        kind: "refused",
        reason: "stale-content",
        effect: "definitely-refused",
      } as const;
    }
    this.files.set(request.path, request.replacementContent);
    if (this.loseNextReplaceResponse) {
      this.loseNextReplaceResponse = false;
      return {
        kind: "failed",
        reason: "host-unavailable",
        effect: "unknown",
      } as const;
    }
    return {
      kind: "confirmed",
      outcome: LOCAL_RECONCILIATION_WRITE_OUTCOME.replaced,
      path: request.path,
      contentSha256: request.replacementContentSha256,
      sizeBytes: Buffer.byteLength(request.replacementContent),
    } as const;
  }

  /** @inheritdoc */
  async createPreservation(
    request: Parameters<LocalReconciliationWriter["createPreservation"]>[0],
  ) {
    const path = required(
      createReconciliationPreservationPath(request.operationId, request.side),
    );
    const existing = this.preservation.get(path);
    if (existing !== undefined && digest(existing) !== request.contentSha256) {
      return {
        kind: "refused",
        reason: "preservation-collision",
        effect: "definitely-refused",
      } as const;
    }
    this.preservation.set(path, request.content);
    if (this.loseNextPreservationResponse) {
      this.loseNextPreservationResponse = false;
      return {
        kind: "failed",
        reason: "postcondition-mismatch",
        effect: "unknown",
      } as const;
    }
    return {
      kind: "confirmed",
      outcome:
        existing === undefined
          ? LOCAL_RECONCILIATION_WRITE_OUTCOME.created
          : LOCAL_RECONCILIATION_WRITE_OUTCOME.adopted,
      path,
      contentSha256: request.contentSha256,
      sizeBytes: Buffer.byteLength(request.content),
    } as const;
  }
}

/** Mutable exact v2 remote double with selectable lost-response behavior. */
class RemoteDouble implements RemoteBridge {
  readonly states = new Map<string, CurrentNoteState>();
  readonly bodies = new Map<string, string>();
  recovery: RecoverySnapshotState = {
    kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
    id: RECOVERY,
    associationId: ASSOCIATION,
    path: PATH,
    revision: REVISION_REMOTE,
    sourceRevision: REVISION_BASE,
    contentSha256: HASH_RECOVERY,
  } as const;
  recoveryBody = RECOVERY_TEXT;
  loseNextMutationResponse = false;
  refuseNextMutation = false;
  failNextInspection = false;
  mismatchNextAcknowledgement = false;
  readLegacyAsLive = false;
  refuseMutationAttempt: number | null = null;
  mutationAttempts = 0;
  recoveryContentAvailable = true;
  onMutation: (() => Promise<void>) | null = null;

  /** @inheritdoc */
  async describe() {
    return {
      kind: "success",
      value: {
        protocol: "obsidian-ai-bridge-mirror-v2",
        associationId: ASSOCIATION,
        writerId: DEVICE,
        maxNoteSizeBytes: 1024 * 1024,
        maxPageSize: 50,
        recoveryRetentionSeconds: 2_592_000,
      },
    } as const;
  }

  /** @inheritdoc */
  async listNotes() {
    return { kind: "success", value: { notes: [], nextCursor: null } } as const;
  }

  /** @inheritdoc */
  async readNote(path: ReconciliationPathEvidence["path"]) {
    const state = this.states.get(path);
    const content = this.bodies.get(path);
    if (this.readLegacyAsLive && content !== undefined) {
      return {
        kind: "success",
        value: { kind: "live", revision: REVISION_REMOTE, content },
      } as const;
    }
    if (
      state?.kind === CURRENT_NOTE_STATE_KIND.legacy &&
      content !== undefined
    ) {
      return { kind: "success", value: { kind: "legacy", content } } as const;
    }
    if (state?.kind === CURRENT_NOTE_STATE_KIND.live && content !== undefined) {
      return {
        kind: "success",
        value: { kind: "live", revision: state.revision, content },
      } as const;
    }
    return { kind: "success", value: { kind: "missing" } } as const;
  }

  /** @inheritdoc */
  async inspectNote(path: ReconciliationPathEvidence["path"]) {
    if (this.failNextInspection) {
      this.failNextInspection = false;
      return { kind: "failure", failure: "network-unavailable" } as const;
    }
    return {
      kind: "success",
      value:
        this.states.get(path) ??
        ({ kind: CURRENT_NOTE_STATE_KIND.absent, path } as const),
    } as const;
  }

  /** @inheritdoc */
  async mutateNote(
    request: Parameters<RemoteBridge["mutateNote"]>[0],
  ): Promise<RemoteBridgeMutationResult<MutationAcknowledgement>> {
    this.mutationAttempts += 1;
    await this.onMutation?.();
    if (
      this.refuseNextMutation ||
      this.refuseMutationAttempt === this.mutationAttempts
    ) {
      this.refuseNextMutation = false;
      return {
        kind: "failure",
        failure: "precondition-failed",
        effect: "definitely-refused",
      };
    }
    let state: CurrentNoteState;
    let acknowledgement: MutationAcknowledgement;
    if (request.action === MUTATION_ACTION.tombstone) {
      const receipt = {
        action: request.action,
        associationId: request.associationId,
        operationId: request.operationId,
        precondition: request.precondition,
      };
      state = {
        kind: CURRENT_NOTE_STATE_KIND.tombstone,
        path: request.path,
        revision: REVISION_RESULT,
        deletedRevision: request.precondition.revision,
        recoveryId: request.operationId,
        receipt,
      };
      acknowledgement = {
        path: request.path,
        revision: REVISION_RESULT,
        receipt,
      };
    } else if (request.action === MUTATION_ACTION.create) {
      const contentSha256 = digest(request.content);
      const receipt = {
        action: request.action,
        associationId: request.associationId,
        operationId: request.operationId,
        precondition: request.precondition,
        contentSha256,
      };
      state = {
        kind: CURRENT_NOTE_STATE_KIND.live,
        path: request.path,
        revision: REVISION_RESULT,
        contentSha256,
        receipt,
      };
      this.bodies.set(request.path, request.content);
      acknowledgement = {
        path: request.path,
        revision: REVISION_RESULT,
        receipt,
      };
    } else {
      const contentSha256 = digest(request.content);
      const receipt = {
        action: request.action,
        associationId: request.associationId,
        operationId: request.operationId,
        precondition: request.precondition,
        contentSha256,
      };
      state = {
        kind: CURRENT_NOTE_STATE_KIND.live,
        path: request.path,
        revision: REVISION_RESULT,
        contentSha256,
        receipt,
      };
      this.bodies.set(request.path, request.content);
      acknowledgement = {
        path: request.path,
        revision: REVISION_RESULT,
        receipt,
      };
    }
    this.states.set(request.path, state);
    if (this.loseNextMutationResponse) {
      this.loseNextMutationResponse = false;
      return { kind: "failure", failure: "timed-out", effect: "unknown" };
    }
    if (this.mismatchNextAcknowledgement) {
      this.mismatchNextAcknowledgement = false;
      return {
        kind: MUTATION_EFFECT_CERTAINTY.confirmed,
        confirmed: {
          ...acknowledgement,
          receipt: {
            ...acknowledgement.receipt,
            operationId: REMOTE_OPERATION,
          },
        },
      };
    }
    return {
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: acknowledgement,
    };
  }

  /** @inheritdoc */
  async listRecovery() {
    return {
      kind: "success",
      value: { recoveries: [this.recovery], nextCursor: null },
    } as const;
  }

  /** @inheritdoc */
  async inspectRecovery(id: typeof RECOVERY) {
    return {
      kind: "success",
      value: id === RECOVERY ? this.recovery : null,
    } as const;
  }

  /** @inheritdoc */
  async readRecoveryContent(id: typeof RECOVERY) {
    if (id === RECOVERY && this.recoveryContentAvailable) {
      return {
        kind: "success",
        value: { kind: "recoverable", content: this.recoveryBody },
      } as const;
    }
    return { kind: "success", value: { kind: "missing" } } as const;
  }

  /** @inheritdoc */
  async sealRecovery() {
    return {
      kind: "failure",
      failure: "precondition-failed",
      effect: "definitely-refused",
    } as const;
  }

  /** @inheritdoc */
  async purgeRecovery() {
    return {
      kind: "failure",
      failure: "precondition-failed",
      effect: "definitely-refused",
    } as const;
  }
}

/** @returns Exact live remote state and body fixture. */
function remoteLive(): Extract<CurrentNoteState, { readonly kind: "live" }> {
  return {
    kind: CURRENT_NOTE_STATE_KIND.live,
    path: PATH,
    revision: REVISION_REMOTE,
    contentSha256: HASH_REMOTE,
    receipt: {
      action: MUTATION_ACTION.update,
      associationId: ASSOCIATION,
      operationId: REMOTE_OPERATION,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: REVISION_BASE,
      },
      contentSha256: HASH_REMOTE,
    },
  };
}

/** @returns Exact remote tombstone fixture. */
function remoteTombstone(): Extract<
  CurrentNoteState,
  { readonly kind: "tombstone" }
> {
  return {
    kind: CURRENT_NOTE_STATE_KIND.tombstone,
    path: PATH,
    revision: REVISION_REMOTE,
    deletedRevision: REVISION_BASE,
    recoveryId: RECOVERY,
    receipt: {
      action: MUTATION_ACTION.tombstone,
      associationId: ASSOCIATION,
      operationId: RECOVERY,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: REVISION_BASE,
      },
    },
  };
}

/**
 * @param path - Canonical fixture path.
 * @param local - Sampled local evidence.
 * @param remote - Sampled remote evidence.
 * @param baseline - Prior acknowledgement evidence.
 * @returns Exact content-free path evidence.
 */
function pathEvidence(
  path: ReconciliationPathEvidence["path"],
  local: ReconciliationPathEvidence["local"],
  remote: ReconciliationPathEvidence["remote"],
  baseline: ReconciliationPathEvidence["baseline"] = {
    kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
    revision: REVISION_BASE,
    contentSha256: HASH_BASE,
  },
): ReconciliationPathEvidence {
  return {
    path,
    local,
    baseline,
    remote,
    m3: { unresolvedMutation: null, deferredHistory: null },
  };
}

/**
 * @param content - Local fixture body.
 * @param generation - Observation generation.
 * @returns Stable live local evidence.
 */
function localLive(
  content: string,
  generation = 7,
): ReconciliationPathEvidence["local"] {
  return {
    kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.live,
    stability: RECONCILIATION_LOCAL_STABILITY.stable,
    observationGeneration: generation,
    byteSize: Buffer.byteLength(content),
    contentSha256: digest(content),
  };
}

/**
 * @param generation - Observation generation.
 * @returns Stable absent local evidence.
 */
function localAbsent(generation = 7): ReconciliationPathEvidence["local"] {
  return {
    kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.absent,
    stability: RECONCILIATION_LOCAL_STABILITY.stable,
    observationGeneration: generation,
  };
}

/**
 * @param paths - Exact review path evidence.
 * @param recovery - Optional recovery evidence.
 * @returns Active immutable review snapshot.
 */
function snapshot(
  paths: readonly ReconciliationPathEvidence[],
  recovery: ReconciliationReviewSnapshot["recovery"] = null,
): ReconciliationReviewSnapshot {
  return {
    runtime: {
      runtimeOwnerVersion: 3,
      configurationGeneration: 1,
      listenerEpoch: 1,
      deviceId: DEVICE,
      designatedWriterId: DEVICE,
      lifecycle: {
        kind: MIRROR_DEVICE_LIFECYCLE_KIND.active,
        associationId: ASSOCIATION,
        origin: "https://bridge.example",
      },
    },
    targetPath: PATH,
    paths,
    recovery,
  };
}

/** @returns Classification compatible with the fixture action. */
function classification(
  action: ReconciliationAction,
): ReconciliationClassification {
  switch (action.kind) {
    case RECONCILIATION_ACTION.adoptRevision:
      return RECONCILIATION_CLASSIFICATION.localMissing;
    case RECONCILIATION_ACTION.forkLegacy:
      return RECONCILIATION_CLASSIFICATION.legacyRemote;
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
    case RECONCILIATION_ACTION.restoreRecovery:
      return RECONCILIATION_CLASSIFICATION.remoteTombstoned;
    case RECONCILIATION_ACTION.keepBoth:
      return RECONCILIATION_CLASSIFICATION.bothChanged;
    case RECONCILIATION_ACTION.keepLocal:
    case RECONCILIATION_ACTION.useRemote:
      return RECONCILIATION_CLASSIFICATION.bothChanged;
    case RECONCILIATION_ACTION.resolveHistory:
      return RECONCILIATION_CLASSIFICATION.deferredHistory;
    case RECONCILIATION_ACTION.defer:
      return RECONCILIATION_CLASSIFICATION.remoteAhead;
  }
}

/** @returns Explicit authority required by the fixture action. */
function authority(
  action: ReconciliationAction,
): ReconciliationOperation["authority"] {
  switch (action.kind) {
    case RECONCILIATION_ACTION.adoptRevision:
    case RECONCILIATION_ACTION.forkLegacy:
      return RECONCILIATION_AUTHORITY_SOURCE.adoptionDecision;
    case RECONCILIATION_ACTION.acceptTombstone:
    case RECONCILIATION_ACTION.recreateRemote:
      return RECONCILIATION_AUTHORITY_SOURCE.tombstoneDecision;
    case RECONCILIATION_ACTION.restoreRecovery:
      return RECONCILIATION_AUTHORITY_SOURCE.recoveryRestoreDecision;
    case RECONCILIATION_ACTION.resolveHistory:
      return RECONCILIATION_AUTHORITY_SOURCE.historyDecision;
    default:
      return RECONCILIATION_AUTHORITY_SOURCE.reconciliationDecision;
  }
}

/** Device state fixture whose operations are all aggregate-effect actions. */
type NonHistoryOperationState = Omit<
  MirrorDeviceState,
  "reconciliationOperations"
> & {
  readonly reconciliationOperations: readonly ReconciliationNonHistoryOperation[];
};

/**
 * @param action - Closed aggregate-effect action.
 * @param target - Exact target evidence.
 * @param destination - Optional exact destination evidence.
 * @param recovery - Optional selected recovery evidence.
 * @returns Valid state containing one admitted operation.
 */
function stateFor(
  action: ReconciliationNonHistoryOperation["action"],
  target: ReconciliationPathEvidence,
  destination?: ReconciliationPathEvidence,
  recovery: ReconciliationReviewSnapshot["recovery"] = null,
): NonHistoryOperationState {
  const reviewSnapshot = snapshot(
    destination === undefined ? [target] : [target, destination],
    recovery,
  );
  const operation: ReconciliationNonHistoryOperation = {
    operationId: OPERATION,
    reviewId: REVIEW,
    authority: authority(action),
    action,
    phase: RECONCILIATION_OPERATION_PHASE.admitted,
    snapshot: reviewSnapshot,
    destinationPath: destination?.path ?? null,
    reservations: [
      { path: PATH, kind: RECONCILIATION_PATH_REFERENCE_KIND.reviewTarget },
      ...(destination === undefined
        ? []
        : [
            {
              path: destination.path,
              kind: RECONCILIATION_PATH_REFERENCE_KIND.newDestination,
            } as const,
          ]),
    ],
    preservationReceipts: [],
    successorOperationId: null,
    localEffectObservation:
      action.kind === RECONCILIATION_ACTION.useRemote ||
      action.kind === RECONCILIATION_ACTION.keepBoth ||
      action.kind === RECONCILIATION_ACTION.adoptRevision ||
      action.kind === RECONCILIATION_ACTION.restoreRecovery ||
      action.kind === RECONCILIATION_ACTION.forkLegacy
        ? { kind: LOCAL_EFFECT_OBSERVATION_KIND.notStarted }
        : {
            kind: LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
            path: target.path,
            listenerEpoch: reviewSnapshot.runtime.listenerEpoch,
            beforeGeneration:
              target.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown
                ? 0
                : target.local.observationGeneration,
            successor: null,
          },
    localEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
    remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
  };
  return {
    deviceId: DEVICE,
    lifecycle: reviewSnapshot.runtime.lifecycle,
    globalBlockReason: null,
    paths: [
      {
        path: PATH,
        acknowledgement: target.baseline,
        unresolvedMutation: null,
        desired: { kind: "none" },
        blockedReason: "diverged",
      },
    ],
    stagedHandoff: null,
    reconciliationReviews: [
      {
        retention: RECONCILIATION_REVIEW_RETENTION.durable,
        reviewId: REVIEW,
        classification: classification(action),
        status: RECONCILIATION_REVIEW_STATUS.staged,
        snapshot: reviewSnapshot,
        operationId: OPERATION,
      },
    ],
    reconciliationOperations: [operation],
  };
}

/** Complete action test harness using real core services and in-memory ports. */
interface Harness {
  readonly store: Store;
  readonly local: LocalDouble;
  readonly remote: RemoteDouble;
  readonly observations: ReconciliationObservationGenerationOwner;
  readonly effects: ReconciliationEffectExecutor;
  readonly live: LiveResolutionService;
  readonly adoption: RevisionedAdoptionService;
  readonly tombstones: RemoteTombstoneResolutionService;
  readonly restore: RecoveryRestoreService;
}

/** @returns Fully composed core-only action harness. */
function harness(state: MirrorDeviceState): Harness {
  const local = new LocalDouble();
  const remote = new RemoteDouble();
  const store = new Store();
  const owner = new MirrorStateOwner(state, store);
  const observations = new ReconciliationObservationGenerationOwner();
  for (const evidence of state.reconciliationOperations[0]?.snapshot.paths ??
    []) {
    const generation =
      evidence.local.kind === RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown
        ? 1
        : evidence.local.observationGeneration;
    while (observations.current(evidence.path) < generation) {
      observations.observe(evidence.path);
    }
  }
  const cryptography = {
    hashContent: async (content: string) => digest(content),
  };
  const writer = new LocalReconciliationWriteService(
    local,
    owner,
    cryptography,
  );
  const preservation = new ConflictPreservationService(
    local,
    owner,
    cryptography,
  );
  const effects = new ReconciliationEffectExecutor(
    local,
    remote,
    owner,
    preservation,
    writer,
    {
      observations,
      ...cryptography,
      nowMilliseconds: () => Date.parse("2030-01-01T00:00:00.000Z"),
    },
  );
  return {
    store,
    local,
    remote,
    observations,
    effects,
    live: new LiveResolutionService(effects),
    adoption: new RevisionedAdoptionService(effects),
    tombstones: new RemoteTombstoneResolutionService(effects),
    restore: new RecoveryRestoreService(effects),
  };
}

/** @returns Absent unassociated destination evidence. */
function absentDestination(): ReconciliationPathEvidence {
  return pathEvidence(
    DESTINATION,
    localAbsent(8),
    { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
    { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("M4 revisioned adoption and live resolution", () => {
  it("stops Keep local at evidence-required when host indexing cannot prove preservation", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);
    subject.local.loseNextPreservationResponse = true;

    const result = await subject.live.execute({ operationId: OPERATION });
    expect(result).toMatchObject({ kind: "evidence-required" });

    expect(subject.remote.mutationAttempts).toBe(0);
    expect(result.snapshot.state.reconciliationOperations[0]).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
      preservationReceipts: [
        {
          proofState: RECONCILIATION_PRESERVATION_PROOF_STATE.evidenceRequired,
        },
      ],
    });
  });

  it("does not reinterpret or redispatch an unknown legacy preservation receipt", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const admitted = stateFor(
      { kind: RECONCILIATION_ACTION.keepLocal },
      target,
    );
    const operation = requiredNonHistory(admitted.reconciliationOperations[0]);
    const legacyPath = `${LEGACY_RECONCILIATION_PRESERVATION_ROOT}/${OPERATION}/remote.md`;
    const state: NonHistoryOperationState = {
      ...admitted,
      reconciliationOperations: [
        {
          ...operation,
          phase: RECONCILIATION_OPERATION_PHASE.evidenceRequired,
          preservationReceipts: [
            {
              operationId: OPERATION,
              scope: RECONCILIATION_PRESERVATION_SCOPE.operation,
              originalPath: PATH,
              side: RECONCILIATION_PRESERVATION_SIDE.remote,
              sourceRevision: REVISION_REMOTE,
              contentSha256: HASH_REMOTE,
              preservationPath: legacyPath,
              proofState:
                RECONCILIATION_PRESERVATION_PROOF_STATE.evidenceRequired,
            },
          ],
        },
      ],
    };
    const subject = harness(state);
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);

    const result = await subject.live.execute({ operationId: OPERATION });
    expect(result).toMatchObject({ kind: "rejected" });

    expect(subject.local.preservation.size).toBe(0);
    expect(subject.remote.mutationAttempts).toBe(0);
    expect(
      requiredNonHistory(result.snapshot.state.reconciliationOperations[0])
        .preservationReceipts[0]?.preservationPath,
    ).toBe(legacyPath);
  });

  it("preserves remote bytes before Keep local and records the exact update baseline", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);

    const result = await subject.live.execute({ operationId: OPERATION });

    expect(result.kind).toBe("completed");
    expect(subject.local.preservation.values().next().value).toBe(REMOTE_TEXT);
    expect(subject.remote.bodies.get(PATH)).toBe(LOCAL_TEXT);
    expect(result.snapshot.state.paths[0]?.acknowledgement).toMatchObject({
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
      revision: REVISION_RESULT,
      contentSha256: HASH_LOCAL,
    });
  });

  it("retains a local successor event while Keep local remote PUT is pending", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);
    subject.remote.onMutation = async () => {
      const generation = subject.observations.observe(PATH);
      await subject.effects.localWrites.observeReservedEvent(
        PATH,
        RECONCILIATION_EVENT_KIND.modify,
        generation,
      );
    };

    const result = await subject.live.execute({ operationId: OPERATION });

    expect(result.snapshot.state.reconciliationOperations[0]).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.successorReviewRequired,
      remoteEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      localEffectObservation: {
        kind: LOCAL_EFFECT_OBSERVATION_KIND.notRequired,
        successor: {
          eventKinds: [RECONCILIATION_EVENT_KIND.modify],
        },
      },
    });
  });

  it("preserves local bytes before Use remote and retains a lost ACK for exact evidence recovery", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.useRemote }, target),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);

    const result = await subject.live.execute({ operationId: OPERATION });

    expect(result.kind).toBe("completed");
    expect(subject.local.files.get(PATH)).toBe(REMOTE_TEXT);
    expect(subject.local.preservation.values().next().value).toBe(LOCAL_TEXT);
  });

  it("requires an explicit operation to import an absent exact live revision", async () => {
    const target = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.adoptRevision }, target),
    );
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);

    const result = await subject.adoption.execute({ operationId: OPERATION });

    expect(result.kind).toBe("completed");
    expect(subject.local.files.get(PATH)).toBe(REMOTE_TEXT);
    expect(result.snapshot.state.paths[0]?.acknowledgement).toMatchObject({
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
    });
  });

  it("resumes recovered-v3 adoption without redispatching a local create", async () => {
    const target = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const initial = stateFor(
      { kind: RECONCILIATION_ACTION.adoptRevision },
      target,
    );
    const current = requiredNonHistory(initial.reconciliationOperations[0]);
    const recovered: ReconciliationNonHistoryOperation = {
      ...current,
      phase: RECONCILIATION_OPERATION_PHASE.partial,
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      localEffectObservation: {
        kind: LOCAL_EFFECT_OBSERVATION_KIND.recoveredV3,
        effectId: RECOVERY,
        path: PATH,
        expectedHash: HASH_REMOTE,
        listenerEpoch: 1,
        beforeGeneration: 7,
        postconditionHash: HASH_REMOTE,
        successor: null,
      },
    };
    const subject = harness({
      ...initial,
      reconciliationOperations: [recovered],
    });
    subject.local.files.set(PATH, REMOTE_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);
    const create = vi.spyOn(subject.local, "createEligible");
    const replace = vi.spyOn(subject.local, "replaceEligible");

    await expect(
      subject.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(create).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each([
    RECONCILIATION_PRESERVATION_SIDE.local,
    RECONCILIATION_PRESERVATION_SIDE.remote,
  ] as const)(
    "materializes Keep both with %s as primary",
    async (primarySide) => {
      const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
        kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
        associationId: ASSOCIATION,
        revision: REVISION_REMOTE,
        contentSha256: HASH_REMOTE,
        receipt: remoteLive().receipt,
      });
      const subject = harness(
        stateFor(
          { kind: RECONCILIATION_ACTION.keepBoth, primarySide },
          target,
          absentDestination(),
        ),
      );
      subject.local.files.set(PATH, LOCAL_TEXT);
      subject.remote.states.set(PATH, remoteLive());
      subject.remote.bodies.set(PATH, REMOTE_TEXT);

      const result = await subject.live.execute({ operationId: OPERATION });

      expect(result.kind).toBe("completed");
      expect(subject.local.files.get(DESTINATION)).toBe(
        primarySide === RECONCILIATION_PRESERVATION_SIDE.local
          ? REMOTE_TEXT
          : LOCAL_TEXT,
      );
      expect(
        result.snapshot.state.paths.some((entry) => entry.path === DESTINATION),
      ).toBe(true);
    },
  );

  it("resumes Keep both after the durable local destination checkpoint", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
        },
        target,
        absentDestination(),
      ),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);

    await expect(subject.effects.preserveRequired(OPERATION)).resolves.toBe(
      "verified",
    );
    await expect(
      subject.effects.localWrites.createEligible({
        operationId: OPERATION,
        path: DESTINATION,
        content: REMOTE_TEXT,
      }),
    ).resolves.toMatchObject({ kind: "confirmed" });

    await expect(
      subject.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(subject.remote.bodies.get(PATH)).toBe(LOCAL_TEXT);
    expect(subject.remote.bodies.get(DESTINATION)).toBe(REMOTE_TEXT);
  });

  it("rejects stale Keep both evidence at each restart checkpoint", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const prepare = async (
      primarySide:
        | typeof RECONCILIATION_PRESERVATION_SIDE.local
        | typeof RECONCILIATION_PRESERVATION_SIDE.remote,
    ) => {
      const subject = harness(
        stateFor(
          { kind: RECONCILIATION_ACTION.keepBoth, primarySide },
          target,
          absentDestination(),
        ),
      );
      subject.local.files.set(PATH, LOCAL_TEXT);
      subject.remote.states.set(PATH, remoteLive());
      subject.remote.bodies.set(PATH, REMOTE_TEXT);
      await expect(subject.effects.preserveRequired(OPERATION)).resolves.toBe(
        "verified",
      );
      return subject;
    };
    const changeRemote = (subject: ReturnType<typeof harness>) => {
      subject.remote.states.set(PATH, {
        ...remoteLive(),
        revision: REVISION_RESULT,
      });
    };
    const checkpointCopy = async (
      subject: ReturnType<typeof harness>,
      content: string,
    ) => {
      await expect(
        subject.effects.localWrites.createEligible({
          operationId: OPERATION,
          path: DESTINATION,
          content,
        }),
      ).resolves.toMatchObject({ kind: "confirmed" });
    };

    const staleInitialRemote = await prepare(
      RECONCILIATION_PRESERVATION_SIDE.local,
    );
    changeRemote(staleInitialRemote);
    await expect(
      staleInitialRemote.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const staleInitialLocal = await prepare(
      RECONCILIATION_PRESERVATION_SIDE.remote,
    );
    staleInitialLocal.local.files.set(PATH, "changed");
    await expect(
      staleInitialLocal.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const staleCopy = await prepare(RECONCILIATION_PRESERVATION_SIDE.local);
    await checkpointCopy(staleCopy, REMOTE_TEXT);
    staleCopy.local.files.set(DESTINATION, "changed");
    await expect(
      staleCopy.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const staleCheckpointRemote = await prepare(
      RECONCILIATION_PRESERVATION_SIDE.local,
    );
    await checkpointCopy(staleCheckpointRemote, REMOTE_TEXT);
    changeRemote(staleCheckpointRemote);
    await expect(
      staleCheckpointRemote.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const staleRemotePrimary = await prepare(
      RECONCILIATION_PRESERVATION_SIDE.remote,
    );
    changeRemote(staleRemotePrimary);
    await expect(
      staleRemotePrimary.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const stalePendingReplacement = await prepare(
      RECONCILIATION_PRESERVATION_SIDE.remote,
    );
    await checkpointCopy(stalePendingReplacement, LOCAL_TEXT);
    stalePendingReplacement.local.files.set(PATH, "changed");
    await expect(
      stalePendingReplacement.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const staleConfirmedReplacement = await prepare(
      RECONCILIATION_PRESERVATION_SIDE.remote,
    );
    await checkpointCopy(staleConfirmedReplacement, LOCAL_TEXT);
    await expect(
      staleConfirmedReplacement.effects.mutateRemote(
        OPERATION,
        {
          action: MUTATION_ACTION.create,
          associationId: ASSOCIATION,
          writerId: DEVICE,
          operationId: OPERATION,
          path: DESTINATION,
          precondition: {
            kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
          },
          content: LOCAL_TEXT,
        },
        { aggregateEffect: true, recordAcknowledgement: false },
      ),
    ).resolves.toMatchObject({ kind: "confirmed" });
    staleConfirmedReplacement.local.files.set(PATH, "changed");
    await expect(
      staleConfirmedReplacement.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });
  });

  it("recovers a lost Keep both target replacement from its exact postcondition", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
        },
        target,
        absentDestination(),
      ),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);
    subject.local.loseNextReplaceResponse = true;

    await expect(
      subject.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    await expect(
      subject.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(subject.local.files.get(PATH)).toBe(REMOTE_TEXT);
    expect(subject.local.files.get(DESTINATION)).toBe(LOCAL_TEXT);
  });

  it("recovers both lost Keep both remote responses from exact receipts", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
        },
        target,
        absentDestination(),
      ),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);
    subject.remote.loseNextMutationResponse = true;

    await expect(
      subject.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "evidence-required" });

    subject.remote.loseNextMutationResponse = true;
    await expect(
      subject.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "evidence-required" });

    await expect(
      subject.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(subject.remote.bodies.get(PATH)).toBe(LOCAL_TEXT);
    expect(subject.remote.bodies.get(DESTINATION)).toBe(REMOTE_TEXT);
  });

  it("forks legacy bytes only to a distinct absent path and leaves the legacy object untouched", async () => {
    const target = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
      contentSha256: HASH_REMOTE,
    });
    const subject = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.forkLegacy },
        target,
        absentDestination(),
      ),
    );
    subject.remote.states.set(PATH, {
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      path: PATH,
    });
    subject.remote.bodies.set(PATH, REMOTE_TEXT);

    const result = await subject.adoption.execute({ operationId: OPERATION });

    expect(result.kind).toBe("completed");
    expect(subject.remote.states.get(PATH)?.kind).toBe(
      CURRENT_NOTE_STATE_KIND.legacy,
    );
    expect(subject.local.files.get(DESTINATION)).toBe(REMOTE_TEXT);
  });

  it("recovers a lost legacy-fork response from the destination receipt", async () => {
    const target = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
      contentSha256: HASH_REMOTE,
    });
    const subject = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.forkLegacy },
        target,
        absentDestination(),
      ),
    );
    subject.remote.states.set(PATH, {
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      path: PATH,
    });
    subject.remote.bodies.set(PATH, REMOTE_TEXT);
    subject.remote.loseNextMutationResponse = true;

    await expect(
      subject.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    await expect(
      subject.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "completed" });
  });
});

describe("M4 tombstone and recovery actions", () => {
  it("adopts an exact tombstone only while local absence remains stable", async () => {
    const tombstone = remoteTombstone();
    const target = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.acceptTombstone }, target),
    );
    subject.remote.states.set(PATH, tombstone);

    const result = await subject.tombstones.execute({ operationId: OPERATION });

    expect(result.kind).toBe("completed");
    expect(result.snapshot.state.paths[0]?.acknowledgement).toMatchObject({
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
      revision: REVISION_REMOTE,
      recoveryId: RECOVERY,
    });
  });

  it("preserves local bytes before exact tombstone recreation and recovers a lost response by receipt", async () => {
    const tombstone = remoteTombstone();
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.recreateRemote }, target),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, tombstone);
    subject.remote.loseNextMutationResponse = true;

    const first = await subject.tombstones.execute({ operationId: OPERATION });
    expect(first.kind).toBe("evidence-required");

    const second = await subject.tombstones.execute({ operationId: OPERATION });
    expect(second.kind).toBe("completed");
    expect(subject.remote.bodies.get(PATH)).toBe(LOCAL_TEXT);
  });

  it("copies a local tombstone conflict to an absent path without changing the tombstone", async () => {
    const tombstone = remoteTombstone();
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const subject = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
        },
        target,
        absentDestination(),
      ),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, tombstone);

    const result = await subject.tombstones.execute({ operationId: OPERATION });

    expect(result.kind).toBe("completed");
    expect(subject.remote.states.get(PATH)?.kind).toBe(
      CURRENT_NOTE_STATE_KIND.tombstone,
    );
    expect(subject.local.files.get(DESTINATION)).toBe(LOCAL_TEXT);
  });

  it("recovers a lost tombstone-copy response from the destination receipt", async () => {
    const tombstone = remoteTombstone();
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const subject = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
        },
        target,
        absentDestination(),
      ),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, tombstone);
    subject.remote.loseNextMutationResponse = true;

    await expect(
      subject.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    await expect(
      subject.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "completed" });
  });

  it("restores exact recovery bytes locally and retains restored-pending-review ownership", async () => {
    const tombstone = remoteTombstone();
    const target = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const subject = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.restoreRecovery },
        target,
        undefined,
        new RemoteDouble().recovery,
      ),
    );
    subject.remote.states.set(PATH, tombstone);

    const result = await subject.restore.execute({ operationId: OPERATION });

    expect(result.kind).toBe("restored-pending-review");
    expect(subject.local.files.get(PATH)).toBe(RECOVERY_TEXT);
    expect(result.snapshot.state.reconciliationOperations[0]).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.restoredPendingReview,
      localEffect: MUTATION_EFFECT_CERTAINTY.confirmed,
      remoteEffect: MUTATION_EFFECT_CERTAINTY.notDispatched,
    });
  });

  it("refuses expired sealed recovery without any local effect", async () => {
    const tombstone = remoteTombstone();
    const recovery = {
      ...new RemoteDouble().recovery,
      kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
      recoverUntil: "2020-01-01T00:00:00.000Z",
    } as const;
    const target = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const subject = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.restoreRecovery },
        target,
        undefined,
        recovery,
      ),
    );
    subject.remote.recovery = recovery;
    subject.remote.states.set(PATH, tombstone);

    const result = await subject.restore.execute({ operationId: OPERATION });

    expect(result).toMatchObject({
      kind: "rejected",
      reason: "recovery-expired",
    });
    expect(subject.local.files.size).toBe(0);
  });
});

describe("resolution routing and stale barriers", () => {
  it("routes only implemented Slice 4-5 actions and leaves history/defer unexecuted", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    const live = vi.spyOn(subject.live, "execute").mockResolvedValue({
      kind: "blocked",
      snapshot: subject.effects.snapshot(),
    });
    const coordinator = new ResolutionCoordinator(
      subject.effects,
      subject.live,
      subject.adoption,
      subject.tombstones,
      subject.restore,
    );

    await coordinator.execute({ operationId: OPERATION });

    expect(live).toHaveBeenCalledOnce();
    await expect(
      coordinator.execute({ operationId: REMOTE_OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-found",
    });
  });

  it("blocks a remote effect when the sampled revision changed before dispatch", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, {
      ...remoteLive(),
      revision: REVISION_RESULT,
    });
    subject.remote.bodies.set(PATH, REMOTE_TEXT);

    const result = await subject.live.execute({ operationId: OPERATION });

    expect(result).toMatchObject({
      kind: "rejected",
      reason: "evidence-changed",
    });
    expect(subject.remote.bodies.get(PATH)).toBe(REMOTE_TEXT);
  });
});

describe("shared reconciliation action result projection", () => {
  it("projects every finite preservation and primitive settlement", () => {
    const subject = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.keepLocal },
        pathEvidence(PATH, localLive(LOCAL_TEXT), {
          kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
          associationId: ASSOCIATION,
          revision: REVISION_REMOTE,
          contentSha256: HASH_REMOTE,
          receipt: remoteLive().receipt,
        }),
      ),
    );
    const snapshot = subject.effects.snapshot();

    expect(
      projectReconciliationPreservation(subject.effects, "verified"),
    ).toBeUndefined();
    expect(
      projectReconciliationPreservation(subject.effects, "blocked"),
    ).toMatchObject({ kind: "blocked" });
    expect(
      projectReconciliationPreservation(subject.effects, "evidence-required"),
    ).toMatchObject({ kind: "evidence-required" });
    expect(
      projectReconciliationPreservation(subject.effects, "changed"),
    ).toMatchObject({ kind: "rejected", reason: "evidence-changed" });
    expect(
      projectReconciliationPreservation(subject.effects, "persistence-failure"),
    ).toMatchObject({ kind: "rejected", reason: "persistence-failure" });
    expect(
      rejectReconciliationAction(subject.effects, "wrong-action"),
    ).toMatchObject({ kind: "rejected", reason: "wrong-action" });

    expect(
      projectLocalReconciliationResult({ kind: "confirmed", snapshot }),
    ).toMatchObject({ kind: "completed" });
    expect(
      projectLocalReconciliationResult({ kind: "blocked", snapshot }),
    ).toMatchObject({ kind: "blocked" });
    expect(
      projectLocalReconciliationResult({ kind: "evidence-required", snapshot }),
    ).toMatchObject({ kind: "evidence-required" });
    expect(
      projectLocalReconciliationResult({
        kind: "rejected",
        reason: "persistence-failure",
        snapshot,
      }),
    ).toMatchObject({ kind: "rejected", reason: "persistence-failure" });
    expect(
      projectLocalReconciliationResult({
        kind: "rejected",
        reason: "wrong-action",
        snapshot,
      }),
    ).toMatchObject({ kind: "rejected", reason: "local-effect-failed" });

    expect(
      projectRemoteReconciliationResult({ kind: "blocked", snapshot }),
    ).toMatchObject({ kind: "blocked" });
    expect(
      projectRemoteReconciliationResult({
        kind: "evidence-required",
        snapshot,
      }),
    ).toMatchObject({ kind: "evidence-required" });
    expect(
      projectRemoteReconciliationResult({
        kind: "rejected",
        reason: "persistence-failure",
        snapshot,
      }),
    ).toMatchObject({ kind: "rejected", reason: "persistence-failure" });
    expect(
      projectRemoteReconciliationResult({
        kind: "rejected",
        reason: "evidence-changed",
        snapshot,
      }),
    ).toMatchObject({ kind: "rejected", reason: "remote-effect-failed" });
  });
});

describe("M4 action negative and recovery matrices", () => {
  it("rejects local primitives outside exact action and path authority", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const keepLocal = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    await expect(
      keepLocal.effects.localWrites.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: LOCAL_TEXT,
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-action" });
    await expect(
      keepLocal.effects.localWrites.replaceEligible({
        operationId: OPERATION,
        path: PATH,
        expectedContent: LOCAL_TEXT,
        replacementContent: REMOTE_TEXT,
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-action" });

    const useRemote = harness(
      stateFor({ kind: RECONCILIATION_ACTION.useRemote }, target),
    );
    await expect(
      useRemote.effects.localWrites.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: REMOTE_TEXT,
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "path-evidence-mismatch",
    });
    await expect(
      useRemote.effects.localWrites.replaceEligible({
        operationId: OPERATION,
        path: DESTINATION,
        expectedContent: LOCAL_TEXT,
        replacementContent: REMOTE_TEXT,
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "path-evidence-mismatch",
    });

    const absent = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.useRemote },
        pathEvidence(PATH, localAbsent(), target.remote),
      ),
    );
    await expect(
      absent.effects.localWrites.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: LOCAL_TEXT,
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "source-evidence-mismatch",
    });

    absent.local.refuseNextCreate = true;
    await absent.effects.localWrites.createEligible({
      operationId: OPERATION,
      path: PATH,
      content: REMOTE_TEXT,
    });
    await expect(
      absent.effects.localWrites.createEligible({
        operationId: OPERATION,
        path: PATH,
        content: REMOTE_TEXT,
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-phase" });

    const unavailable = harness(
      stateFor({ kind: RECONCILIATION_ACTION.useRemote }, target),
    );
    unavailable.store.failNextSave = true;
    await unavailable.effects.stateOwner.transition((state) => state);
    await expect(
      unavailable.effects.localWrites.replaceEligible({
        operationId: OPERATION,
        path: PATH,
        expectedContent: LOCAL_TEXT,
        replacementContent: REMOTE_TEXT,
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
  });

  it("rejects inconsistent admitted evidence at every action family boundary", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    const original = requiredNonHistory(subject.effects.operation(OPERATION));
    const operationSpy = vi.spyOn(subject.effects, "operation");
    const execute = async (
      service: {
        execute(request: {
          operationId: typeof OPERATION;
        }): Promise<{ kind: string; reason?: string }>;
      },
      operation: ReconciliationOperation,
    ) => {
      operationSpy.mockReturnValue(operation);
      await expect(
        service.execute({ operationId: OPERATION }),
      ).resolves.toMatchObject({
        kind: "rejected",
        reason: expect.any(String),
      });
    };
    const noPaths = {
      ...original,
      snapshot: { ...original.snapshot, paths: [] },
    };

    await execute(subject.live, noPaths);
    await execute(subject.live, {
      ...noPaths,
      action: { kind: RECONCILIATION_ACTION.useRemote },
    });
    await execute(subject.live, {
      ...original,
      action: {
        kind: RECONCILIATION_ACTION.keepBoth,
        primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
      },
      destinationPath: null,
    });
    await execute(subject.adoption, {
      ...noPaths,
      action: { kind: RECONCILIATION_ACTION.adoptRevision },
    });
    await execute(subject.adoption, {
      ...original,
      action: { kind: RECONCILIATION_ACTION.forkLegacy },
      destinationPath: null,
    });
    await execute(subject.tombstones, {
      ...noPaths,
      action: { kind: RECONCILIATION_ACTION.acceptTombstone },
    });
    await execute(subject.tombstones, {
      ...noPaths,
      action: { kind: RECONCILIATION_ACTION.recreateRemote },
    });
    await execute(subject.tombstones, {
      ...original,
      action: {
        kind: RECONCILIATION_ACTION.keepBoth,
        primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
      },
      destinationPath: null,
    });
    await execute(subject.restore, {
      ...original,
      action: { kind: RECONCILIATION_ACTION.restoreRecovery },
    });
  });

  it("projects action-specific local, remote, and persistence failures", async () => {
    const liveTarget = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });

    const keepBoth = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
        },
        liveTarget,
        absentDestination(),
      ),
    );
    keepBoth.local.files.set(PATH, LOCAL_TEXT);
    keepBoth.local.files.set(DESTINATION, "occupied");
    keepBoth.remote.states.set(PATH, remoteLive());
    keepBoth.remote.bodies.set(PATH, REMOTE_TEXT);
    await expect(
      keepBoth.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const legacyTarget = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
      contentSha256: HASH_REMOTE,
    });
    const legacy = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.forkLegacy },
        legacyTarget,
        absentDestination(),
      ),
    );
    legacy.local.files.set(DESTINATION, "occupied");
    legacy.remote.states.set(PATH, {
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      path: PATH,
    });
    legacy.remote.bodies.set(PATH, REMOTE_TEXT);
    await expect(
      legacy.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const tombstoneState = remoteTombstone();
    const tombstoneTarget = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstoneState.revision,
      deletedRevision: tombstoneState.deletedRevision,
      recoveryId: tombstoneState.recoveryId,
      receipt: tombstoneState.receipt,
    });
    const copy = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
        },
        tombstoneTarget,
        absentDestination(),
      ),
    );
    copy.local.files.set(PATH, LOCAL_TEXT);
    copy.local.files.set(DESTINATION, "occupied");
    copy.remote.states.set(PATH, tombstoneState);
    await expect(
      copy.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const adoptionTarget = pathEvidence(PATH, localLive(REMOTE_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const adoption = harness(
      stateFor({ kind: RECONCILIATION_ACTION.adoptRevision }, adoptionTarget),
    );
    adoption.local.files.set(PATH, REMOTE_TEXT);
    adoption.remote.states.set(PATH, remoteLive());
    adoption.remote.bodies.set(PATH, REMOTE_TEXT);
    adoption.store.failNextSave = true;
    await expect(
      adoption.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });

    const remoteFailure = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, liveTarget),
    );
    remoteFailure.local.files.set(PATH, LOCAL_TEXT);
    remoteFailure.remote.states.set(PATH, remoteLive());
    remoteFailure.remote.bodies.set(PATH, REMOTE_TEXT);
    await remoteFailure.effects.preserveRequired(OPERATION);
    remoteFailure.store.failNextSave = true;
    await expect(
      remoteFailure.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });
  });

  it("stops every action-specific phase when exact effect evidence changes or refuses", async () => {
    const liveTarget = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });

    const staleLocal = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, liveTarget),
    );
    staleLocal.local.files.set(PATH, LOCAL_TEXT);
    staleLocal.remote.states.set(PATH, remoteLive());
    staleLocal.remote.bodies.set(PATH, REMOTE_TEXT);
    await staleLocal.effects.preserveRequired(OPERATION);
    staleLocal.local.files.set(PATH, "changed");
    await expect(
      staleLocal.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "evidence-changed" });

    const staleRemote = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, liveTarget),
    );
    staleRemote.local.files.set(PATH, LOCAL_TEXT);
    staleRemote.remote.states.set(PATH, remoteLive());
    staleRemote.remote.bodies.set(PATH, REMOTE_TEXT);
    await staleRemote.effects.preserveRequired(OPERATION);
    staleRemote.remote.states.set(PATH, {
      ...remoteLive(),
      revision: REVISION_RESULT,
    });
    await expect(
      staleRemote.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "evidence-changed" });

    const remoteAhead = harness(
      stateFor({ kind: RECONCILIATION_ACTION.useRemote }, liveTarget),
    );
    remoteAhead.local.files.set(PATH, LOCAL_TEXT);
    remoteAhead.remote.states.set(PATH, {
      ...remoteLive(),
      revision: REVISION_RESULT,
    });
    await expect(
      remoteAhead.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const absentTarget = pathEvidence(PATH, localAbsent(), liveTarget.remote);
    const refusedCreate = harness(
      stateFor({ kind: RECONCILIATION_ACTION.useRemote }, absentTarget),
    );
    refusedCreate.remote.states.set(PATH, remoteLive());
    refusedCreate.remote.bodies.set(PATH, REMOTE_TEXT);
    refusedCreate.local.refuseNextCreate = true;
    await expect(
      refusedCreate.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const refusedReplace = harness(
      stateFor({ kind: RECONCILIATION_ACTION.useRemote }, liveTarget),
    );
    refusedReplace.local.files.set(PATH, LOCAL_TEXT);
    refusedReplace.remote.states.set(PATH, remoteLive());
    refusedReplace.remote.bodies.set(PATH, REMOTE_TEXT);
    refusedReplace.local.refuseNextReplace = true;
    await expect(
      refusedReplace.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const keepBothRemote = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
        },
        liveTarget,
        absentDestination(),
      ),
    );
    keepBothRemote.local.files.set(PATH, LOCAL_TEXT);
    keepBothRemote.remote.states.set(PATH, remoteLive());
    keepBothRemote.remote.bodies.set(PATH, REMOTE_TEXT);
    keepBothRemote.local.refuseNextReplace = true;
    await expect(
      keepBothRemote.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const keepBothLocal = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
        },
        liveTarget,
        absentDestination(),
      ),
    );
    keepBothLocal.local.files.set(PATH, LOCAL_TEXT);
    keepBothLocal.remote.states.set(PATH, remoteLive());
    keepBothLocal.remote.bodies.set(PATH, REMOTE_TEXT);
    keepBothLocal.remote.refuseMutationAttempt = 2;
    await expect(
      keepBothLocal.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const adoptAbsent = harness(
      stateFor({ kind: RECONCILIATION_ACTION.adoptRevision }, absentTarget),
    );
    adoptAbsent.remote.states.set(PATH, remoteLive());
    adoptAbsent.remote.bodies.set(PATH, REMOTE_TEXT);
    adoptAbsent.local.files.set(PATH, "unexpected");
    await expect(
      adoptAbsent.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const adoptRefused = harness(
      stateFor({ kind: RECONCILIATION_ACTION.adoptRevision }, absentTarget),
    );
    adoptRefused.remote.states.set(PATH, remoteLive());
    adoptRefused.remote.bodies.set(PATH, REMOTE_TEXT);
    adoptRefused.local.refuseNextCreate = true;
    await expect(
      adoptRefused.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const tombstone = remoteTombstone();
    const tombTarget = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const tombCopy = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
        },
        tombTarget,
        absentDestination(),
      ),
    );
    tombCopy.local.files.set(PATH, LOCAL_TEXT);
    tombCopy.remote.states.set(PATH, tombstone);
    tombCopy.remote.refuseNextMutation = true;
    await expect(
      tombCopy.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const restoreTarget = pathEvidence(PATH, localAbsent(), tombTarget.remote);
    const restoreRefused = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.restoreRecovery },
        restoreTarget,
        undefined,
        new RemoteDouble().recovery,
      ),
    );
    restoreRefused.remote.states.set(PATH, tombstone);
    restoreRefused.local.refuseNextCreate = true;
    await expect(
      restoreRefused.restore.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });
  });

  it("rejects late stale evidence and preservation failures across action families", async () => {
    const liveTarget = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const wrong = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, liveTarget),
    );
    vi.spyOn(wrong.effects, "operation").mockReturnValue({
      ...requiredNonHistory(wrong.effects.operation(OPERATION)),
      action: { kind: RECONCILIATION_ACTION.adoptRevision },
    });
    await expect(
      wrong.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-action" });

    const staleUseRemote = harness(
      stateFor({ kind: RECONCILIATION_ACTION.useRemote }, liveTarget),
    );
    staleUseRemote.local.files.set(PATH, LOCAL_TEXT);
    staleUseRemote.remote.states.set(PATH, remoteLive());
    staleUseRemote.remote.bodies.set(PATH, REMOTE_TEXT);
    await staleUseRemote.effects.preserveRequired(OPERATION);
    staleUseRemote.local.files.set(PATH, "late change");
    await expect(
      staleUseRemote.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const keepBoth = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
        },
        liveTarget,
        absentDestination(),
      ),
    );
    keepBoth.local.files.set(PATH, LOCAL_TEXT);
    keepBoth.remote.states.set(PATH, remoteLive());
    keepBoth.remote.bodies.set(PATH, REMOTE_TEXT);
    keepBoth.remote.refuseNextMutation = true;
    await expect(
      keepBoth.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const adoptionTarget = pathEvidence(
      PATH,
      localLive(REMOTE_TEXT),
      liveTarget.remote,
    );
    const staleAdoption = harness(
      stateFor({ kind: RECONCILIATION_ACTION.adoptRevision }, adoptionTarget),
    );
    staleAdoption.local.files.set(PATH, REMOTE_TEXT);
    staleAdoption.remote.states.set(PATH, {
      ...remoteLive(),
      revision: REVISION_RESULT,
    });
    await expect(
      staleAdoption.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const changedAdoption = harness(
      stateFor({ kind: RECONCILIATION_ACTION.adoptRevision }, adoptionTarget),
    );
    changedAdoption.local.files.set(PATH, LOCAL_TEXT);
    changedAdoption.remote.states.set(PATH, remoteLive());
    changedAdoption.remote.bodies.set(PATH, REMOTE_TEXT);
    await expect(
      changedAdoption.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const legacyTarget = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
      contentSha256: HASH_REMOTE,
    });
    const legacyCollision = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.forkLegacy },
        legacyTarget,
        absentDestination(),
      ),
    );
    legacyCollision.remote.states.set(PATH, {
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      path: PATH,
    });
    legacyCollision.remote.bodies.set(PATH, REMOTE_TEXT);
    legacyCollision.local.preservation.set(
      required(
        createReconciliationPreservationPath(
          OPERATION,
          RECONCILIATION_PRESERVATION_SIDE.remote,
        ),
      ),
      "collision",
    );
    await expect(
      legacyCollision.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const legacyRemoteFailure = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.forkLegacy },
        legacyTarget,
        absentDestination(),
      ),
    );
    legacyRemoteFailure.remote.states.set(PATH, {
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      path: PATH,
    });
    legacyRemoteFailure.remote.bodies.set(PATH, REMOTE_TEXT);
    legacyRemoteFailure.remote.refuseNextMutation = true;
    await expect(
      legacyRemoteFailure.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const tombstone = remoteTombstone();
    const tombTarget = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const recreateCollision = harness(
      stateFor({ kind: RECONCILIATION_ACTION.recreateRemote }, tombTarget),
    );
    recreateCollision.local.files.set(PATH, LOCAL_TEXT);
    recreateCollision.remote.states.set(PATH, tombstone);
    recreateCollision.local.preservation.set(
      required(
        createReconciliationPreservationPath(
          OPERATION,
          RECONCILIATION_PRESERVATION_SIDE.local,
        ),
      ),
      "collision",
    );
    await expect(
      recreateCollision.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const recreateStale = harness(
      stateFor({ kind: RECONCILIATION_ACTION.recreateRemote }, tombTarget),
    );
    recreateStale.local.files.set(PATH, LOCAL_TEXT);
    recreateStale.remote.states.set(PATH, tombstone);
    await recreateStale.effects.preserveRequired(OPERATION);
    recreateStale.local.files.set(PATH, "late change");
    await expect(
      recreateStale.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const acceptTarget = pathEvidence(PATH, localAbsent(), tombTarget.remote);
    const staleAccept = harness(
      stateFor({ kind: RECONCILIATION_ACTION.acceptTombstone }, acceptTarget),
    );
    staleAccept.local.files.set(PATH, "appeared");
    staleAccept.remote.states.set(PATH, tombstone);
    await expect(
      staleAccept.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const restoreTarget = pathEvidence(PATH, localAbsent(), tombTarget.remote);
    const staleRestore = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.restoreRecovery },
        restoreTarget,
        undefined,
        new RemoteDouble().recovery,
      ),
    );
    staleRestore.local.files.set(PATH, "appeared");
    staleRestore.remote.states.set(PATH, tombstone);
    await expect(
      staleRestore.restore.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });
  });

  it("settles remaining preserved, phased, and persistence-fenced branches", async () => {
    const liveTarget = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const staleKeepBoth = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.local,
        },
        liveTarget,
        absentDestination(),
      ),
    );
    staleKeepBoth.local.files.set(PATH, LOCAL_TEXT);
    staleKeepBoth.remote.states.set(PATH, remoteLive());
    staleKeepBoth.remote.bodies.set(PATH, REMOTE_TEXT);
    await staleKeepBoth.effects.preserveRequired(OPERATION);
    staleKeepBoth.local.files.set(PATH, "late change");
    await expect(
      staleKeepBoth.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const legacyTarget = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
      contentSha256: HASH_REMOTE,
    });
    const legacyChanged = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.forkLegacy },
        legacyTarget,
        absentDestination(),
      ),
    );
    legacyChanged.remote.states.set(PATH, {
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      path: PATH,
    });
    legacyChanged.remote.bodies.set(PATH, REMOTE_TEXT);
    await legacyChanged.effects.preserveRequired(OPERATION);
    legacyChanged.remote.bodies.set(PATH, LOCAL_TEXT);
    await expect(
      legacyChanged.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const legacyWrongKind = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.forkLegacy },
        legacyTarget,
        absentDestination(),
      ),
    );
    legacyWrongKind.remote.states.set(PATH, {
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      path: PATH,
    });
    legacyWrongKind.remote.bodies.set(PATH, REMOTE_TEXT);
    legacyWrongKind.remote.readLegacyAsLive = true;
    await expect(
      legacyWrongKind.effects.readExactRemote(legacyTarget),
    ).resolves.toBe("changed");

    const tombstone = remoteTombstone();
    const tombTarget = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const staleRecreate = harness(
      stateFor({ kind: RECONCILIATION_ACTION.recreateRemote }, tombTarget),
    );
    staleRecreate.local.files.set(PATH, LOCAL_TEXT);
    staleRecreate.remote.states.set(PATH, tombstone);
    await staleRecreate.effects.preserveRequired(OPERATION);
    staleRecreate.remote.states.set(PATH, {
      ...tombstone,
      revision: REVISION_RESULT,
    });
    await expect(
      staleRecreate.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const copyCollision = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
        },
        tombTarget,
        absentDestination(),
      ),
    );
    copyCollision.local.files.set(PATH, LOCAL_TEXT);
    copyCollision.remote.states.set(PATH, tombstone);
    copyCollision.local.preservation.set(
      required(
        createReconciliationPreservationPath(
          OPERATION,
          RECONCILIATION_PRESERVATION_SIDE.local,
        ),
      ),
      "collision",
    );
    await expect(
      copyCollision.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const copyStale = harness(
      stateFor(
        {
          kind: RECONCILIATION_ACTION.keepBoth,
          primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
        },
        tombTarget,
        absentDestination(),
      ),
    );
    copyStale.local.files.set(PATH, LOCAL_TEXT);
    copyStale.remote.states.set(PATH, tombstone);
    await copyStale.effects.preserveRequired(OPERATION);
    copyStale.local.files.set(PATH, "late change");
    await expect(
      copyStale.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected" });

    const restoreTarget = pathEvidence(
      PATH,
      localLive(LOCAL_TEXT),
      tombTarget.remote,
    );
    const restoreCollision = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.restoreRecovery },
        restoreTarget,
        undefined,
        new RemoteDouble().recovery,
      ),
    );
    restoreCollision.local.files.set(PATH, LOCAL_TEXT);
    restoreCollision.remote.states.set(PATH, tombstone);
    restoreCollision.local.preservation.set(
      required(
        createReconciliationPreservationPath(
          OPERATION,
          RECONCILIATION_PRESERVATION_SIDE.local,
        ),
      ),
      "collision",
    );
    await expect(
      restoreCollision.restore.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const preservationPersistence = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, liveTarget),
    );
    preservationPersistence.local.files.set(PATH, LOCAL_TEXT);
    preservationPersistence.remote.states.set(PATH, remoteLive());
    preservationPersistence.remote.bodies.set(PATH, REMOTE_TEXT);
    preservationPersistence.store.failNextSave = true;
    await expect(
      preservationPersistence.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });

    const confirmationPersistence = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, liveTarget),
    );
    confirmationPersistence.local.files.set(PATH, LOCAL_TEXT);
    confirmationPersistence.remote.states.set(PATH, remoteLive());
    confirmationPersistence.remote.bodies.set(PATH, REMOTE_TEXT);
    await confirmationPersistence.effects.preserveRequired(OPERATION);
    confirmationPersistence.store.saveAttempts = 0;
    confirmationPersistence.store.failOnSave = 2;
    await expect(
      confirmationPersistence.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "persistence-failure",
    });

    const recoveryChanged = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, liveTarget),
    );
    const operation = requiredNonHistory(
      recoveryChanged.effects.operation(OPERATION),
    );
    const selected = {
      ...operation,
      snapshot: {
        ...operation.snapshot,
        recovery: new RemoteDouble().recovery,
      },
    };
    recoveryChanged.remote.recovery = {
      ...recoveryChanged.remote.recovery,
      revision: REVISION_RESULT,
    };
    await expect(
      recoveryChanged.effects.readExactRecovery(selected),
    ).resolves.toBe("changed");

    const phased = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, liveTarget),
    );
    phased.remote.states.set(PATH, remoteLive());
    vi.spyOn(phased.effects, "operation").mockReturnValue({
      ...requiredNonHistory(phased.effects.operation(OPERATION)),
      phase: RECONCILIATION_OPERATION_PHASE.mutatingRemote,
    });
    await expect(
      phased.effects.mutateRemote(
        OPERATION,
        {
          action: MUTATION_ACTION.update,
          associationId: ASSOCIATION,
          writerId: DEVICE,
          operationId: OPERATION,
          path: PATH,
          precondition: {
            kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
            revision: REVISION_REMOTE,
          },
          content: LOCAL_TEXT,
        },
        { aggregateEffect: true, recordAcknowledgement: false },
      ),
    ).resolves.toMatchObject({ kind: "evidence-required" });
  });

  it("publishes an alternate restored successor with an absence-only create", async () => {
    const originalTarget = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, originalTarget),
    );
    const operation = requiredNonHistory(subject.effects.operation(OPERATION));
    const restoredTarget = pathEvidence(
      PATH,
      localLive(LOCAL_TEXT),
      { kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent },
      { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
    );
    vi.spyOn(subject.effects, "operation").mockReturnValue({
      ...operation,
      snapshot: { ...operation.snapshot, paths: [restoredTarget] },
    });
    vi.spyOn(subject.effects, "preserveRequired").mockResolvedValue("verified");
    vi.spyOn(subject.effects, "readExactLocal").mockResolvedValue({
      content: LOCAL_TEXT,
      contentSha256: HASH_LOCAL,
    });
    vi.spyOn(subject.effects, "readExactRemote").mockResolvedValue(
      "non-content",
    );
    const acknowledgement: MutationAcknowledgement = {
      path: PATH,
      revision: REVISION_RESULT,
      receipt: {
        action: MUTATION_ACTION.create,
        associationId: ASSOCIATION,
        operationId: OPERATION,
        precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
        contentSha256: HASH_LOCAL,
      },
    };
    const mutate = vi.spyOn(subject.effects, "mutateRemote").mockResolvedValue({
      kind: "confirmed",
      acknowledgement,
      snapshot: subject.effects.snapshot(),
    });
    vi.spyOn(subject.effects, "complete").mockResolvedValue(
      subject.effects.snapshot(),
    );

    await expect(
      subject.live.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "completed" });
    expect(mutate).toHaveBeenCalledWith(
      OPERATION,
      expect.objectContaining({
        action: MUTATION_ACTION.create,
        precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
      }),
      expect.any(Object),
    );
  });

  it("associates equal local bytes without dispatching a local write", async () => {
    const target = pathEvidence(PATH, localLive(REMOTE_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.adoptRevision }, target),
    );
    subject.local.files.set(PATH, REMOTE_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);

    const result = await subject.adoption.execute({ operationId: OPERATION });

    expect(result.kind).toBe("completed");
    expect(
      requiredNonHistory(result.snapshot.state.reconciliationOperations[0])
        .localEffect,
    ).toBe(MUTATION_EFFECT_CERTAINTY.notDispatched);
  });

  it("imports an absent local path through Use remote with archive-free ordering", async () => {
    const target = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.useRemote }, target),
    );
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);

    const result = await subject.live.execute({ operationId: OPERATION });

    expect(result.kind).toBe("completed");
    expect(subject.local.files.get(PATH)).toBe(REMOTE_TEXT);
    expect(subject.local.preservation.size).toBe(0);
  });

  it("restores over occupied bytes only after verified preservation and resumes without rewriting", async () => {
    const tombstone = remoteTombstone();
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const subject = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.restoreRecovery },
        target,
        undefined,
        new RemoteDouble().recovery,
      ),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, tombstone);

    const first = await subject.restore.execute({ operationId: OPERATION });
    const second = await subject.restore.execute({ operationId: OPERATION });

    expect(first.kind).toBe("restored-pending-review");
    expect(second.kind).toBe("restored-pending-review");
    expect(subject.local.preservation.values().next().value).toBe(LOCAL_TEXT);
    expect(subject.local.files.get(PATH)).toBe(RECOVERY_TEXT);
  });

  it("refuses unavailable or changed recovery evidence before local mutation", async () => {
    const tombstone = remoteTombstone();
    const target = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    const unavailable = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.restoreRecovery },
        target,
        undefined,
        new RemoteDouble().recovery,
      ),
    );
    unavailable.remote.states.set(PATH, tombstone);
    unavailable.remote.recoveryContentAvailable = false;
    await expect(
      unavailable.restore.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "recovery-unavailable",
    });

    const changed = harness(
      stateFor(
        { kind: RECONCILIATION_ACTION.restoreRecovery },
        target,
        undefined,
        new RemoteDouble().recovery,
      ),
    );
    changed.remote.states.set(PATH, tombstone);
    changed.remote.recoveryBody = "wrong recovery";
    await expect(
      changed.restore.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "evidence-changed" });
  });

  it("projects wrong-action and unknown-operation requests without effects", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );

    await expect(
      subject.live.execute({ operationId: REMOTE_OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-found",
    });
    await expect(
      subject.adoption.execute({ operationId: REMOTE_OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-found",
    });
    await expect(
      subject.tombstones.execute({ operationId: REMOTE_OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-found",
    });
    await expect(
      subject.restore.execute({ operationId: REMOTE_OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-found",
    });
    await expect(
      subject.live.execute({ operationId: OPERATION }),
    ).resolves.not.toMatchObject({ kind: "rejected", reason: "wrong-action" });
    await expect(
      subject.adoption.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-action" });
    await expect(
      subject.tombstones.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-action" });
    await expect(
      subject.restore.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-action" });
    await expect(
      subject.live.execute({ operationId: REMOTE_OPERATION }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-found",
    });
  });

  it("rejects unknown, unstable, missing, mismatched, and unavailable exact reads", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );

    const unknownLocal = {
      ...target,
      local: {
        kind: RECONCILIATION_LOCAL_EVIDENCE_KIND.unknown,
        stability: RECONCILIATION_LOCAL_STABILITY.unknown,
      } as const,
    };
    await expect(subject.effects.readExactLocal(unknownLocal)).resolves.toBe(
      "changed",
    );
    subject.observations.observe(PATH);
    await expect(subject.effects.readExactLocal(target)).resolves.toBe(
      "changed",
    );

    const fresh = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    await expect(fresh.effects.readExactLocal(target)).resolves.toBe("changed");
    fresh.remote.states.set(PATH, remoteLive());
    await expect(fresh.effects.readExactRemote(target)).resolves.toBe(
      "changed",
    );
    fresh.remote.bodies.set(PATH, LOCAL_TEXT);
    await expect(fresh.effects.readExactRemote(target)).resolves.toBe(
      "changed",
    );

    const legacy = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
      contentSha256: HASH_REMOTE,
    });
    fresh.remote.states.set(PATH, {
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      path: PATH,
    });
    fresh.remote.bodies.delete(PATH);
    await expect(fresh.effects.readExactRemote(legacy)).resolves.toBe(
      "changed",
    );

    const unavailable = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.unavailable,
    });
    await expect(fresh.effects.readExactRemote(unavailable)).resolves.toBe(
      "changed",
    );
    const operation = requiredNonHistory(fresh.effects.operation(OPERATION));
    await expect(fresh.effects.readExactRecovery(operation)).resolves.toBe(
      "unavailable",
    );
  });

  it("settles invalid, unavailable, unhashable, mismatched, and tombstone remote effects", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const request = {
      action: MUTATION_ACTION.update,
      associationId: ASSOCIATION,
      writerId: DEVICE,
      operationId: OPERATION,
      path: PATH,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision: REVISION_REMOTE,
      },
      content: LOCAL_TEXT,
    } as const;

    const inactive = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    await expect(
      inactive.effects.mutateRemote(REMOTE_OPERATION, request, {
        aggregateEffect: true,
        recordAcknowledgement: false,
      }),
    ).resolves.toMatchObject({
      kind: "rejected",
      reason: "operation-not-active",
    });

    const unhashable = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    vi.spyOn(unhashable.effects.runtime, "hashContent").mockRejectedValueOnce(
      new Error("unavailable"),
    );
    await expect(
      unhashable.effects.mutateRemote(OPERATION, request, {
        aggregateEffect: true,
        recordAcknowledgement: false,
      }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "evidence-changed" });

    const unavailable = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    unavailable.local.files.set(PATH, LOCAL_TEXT);
    unavailable.remote.states.set(PATH, remoteLive());
    unavailable.remote.bodies.set(PATH, REMOTE_TEXT);
    await unavailable.effects.preserveRequired(OPERATION);
    unavailable.remote.failNextInspection = true;
    await expect(
      unavailable.effects.mutateRemote(OPERATION, request, {
        aggregateEffect: true,
        recordAcknowledgement: false,
      }),
    ).resolves.toMatchObject({ kind: "blocked" });

    const mismatched = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    mismatched.local.files.set(PATH, LOCAL_TEXT);
    mismatched.remote.states.set(PATH, remoteLive());
    mismatched.remote.bodies.set(PATH, REMOTE_TEXT);
    await mismatched.effects.preserveRequired(OPERATION);
    mismatched.remote.mismatchNextAcknowledgement = true;
    await expect(
      mismatched.effects.mutateRemote(OPERATION, request, {
        aggregateEffect: true,
        recordAcknowledgement: false,
      }),
    ).resolves.toMatchObject({ kind: "evidence-required" });
    await expect(
      mismatched.effects.mutateRemote(OPERATION, request, {
        aggregateEffect: true,
        recordAcknowledgement: false,
      }),
    ).resolves.toMatchObject({ kind: "confirmed" });

    const tombstone = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    tombstone.local.files.set(PATH, LOCAL_TEXT);
    tombstone.remote.states.set(PATH, remoteLive());
    tombstone.remote.bodies.set(PATH, REMOTE_TEXT);
    await tombstone.effects.preserveRequired(OPERATION);
    await expect(
      tombstone.effects.mutateRemote(
        OPERATION,
        { ...request, action: MUTATION_ACTION.tombstone },
        { aggregateEffect: true, recordAcknowledgement: true },
      ),
    ).resolves.toMatchObject({ kind: "confirmed" });
  });

  it("persists a finite blocked result after a proven remote refusal", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    subject.remote.states.set(PATH, remoteLive());
    subject.remote.bodies.set(PATH, REMOTE_TEXT);
    subject.remote.refuseNextMutation = true;

    const result = await subject.live.execute({ operationId: OPERATION });

    expect(result.kind).toBe("blocked");
    expect(result.snapshot.state.reconciliationOperations[0]).toMatchObject({
      phase: RECONCILIATION_OPERATION_PHASE.blocked,
      remoteEffect: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
    });
  });

  it("exercises exact evidence readers for absence, tombstones, legacy, and changed local state", async () => {
    const target = pathEvidence(
      PATH,
      localAbsent(),
      {
        kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.absent,
      },
      { kind: MIRROR_ACKNOWLEDGEMENT_KIND.unassociated },
    );
    const admittedTarget = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, admittedTarget),
    );

    await expect(subject.effects.readExactLocal(target)).resolves.toBe(
      "absent",
    );
    await expect(subject.effects.readExactRemote(target)).resolves.toBe(
      "non-content",
    );
    subject.local.files.set(PATH, LOCAL_TEXT);
    await expect(subject.effects.readExactLocal(target)).resolves.toBe(
      "changed",
    );

    const legacy = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.legacy,
      contentSha256: HASH_REMOTE,
    });
    subject.remote.states.set(PATH, {
      kind: CURRENT_NOTE_STATE_KIND.legacy,
      path: PATH,
    });
    subject.remote.bodies.set(PATH, REMOTE_TEXT);
    await expect(
      subject.effects.readExactRemote(legacy),
    ).resolves.toMatchObject({
      contentSha256: HASH_REMOTE,
    });

    const tombstone = remoteTombstone();
    const tombstoneEvidence = pathEvidence(PATH, localAbsent(), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
      associationId: ASSOCIATION,
      revision: tombstone.revision,
      deletedRevision: tombstone.deletedRevision,
      recoveryId: tombstone.recoveryId,
      receipt: tombstone.receipt,
    });
    subject.remote.states.set(PATH, tombstone);
    await expect(
      subject.effects.readExactRemote(tombstoneEvidence),
    ).resolves.toBe("non-content");
  });

  it("routes adoption, tombstone, restore, and tombstone Keep both discriminants", async () => {
    const target = pathEvidence(PATH, localLive(LOCAL_TEXT), {
      kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.live,
      associationId: ASSOCIATION,
      revision: REVISION_REMOTE,
      contentSha256: HASH_REMOTE,
      receipt: remoteLive().receipt,
    });
    const subject = harness(
      stateFor({ kind: RECONCILIATION_ACTION.keepLocal }, target),
    );
    const adoption = vi.spyOn(subject.adoption, "execute").mockResolvedValue({
      kind: "blocked",
      snapshot: subject.effects.snapshot(),
    });
    const tombstones = vi
      .spyOn(subject.tombstones, "execute")
      .mockResolvedValue({
        kind: "blocked",
        snapshot: subject.effects.snapshot(),
      });
    const restore = vi.spyOn(subject.restore, "execute").mockResolvedValue({
      kind: "blocked",
      snapshot: subject.effects.snapshot(),
    });
    const coordinator = new ResolutionCoordinator(
      subject.effects,
      subject.live,
      subject.adoption,
      subject.tombstones,
      subject.restore,
    );
    const original = requiredNonHistory(subject.effects.operation(OPERATION));

    const operationSpy = vi
      .spyOn(subject.effects, "operation")
      .mockReturnValue({
        ...original,
        action: { kind: RECONCILIATION_ACTION.adoptRevision },
      });
    await coordinator.execute({ operationId: OPERATION });
    expect(adoption).toHaveBeenCalled();

    operationSpy.mockReturnValue({
      ...original,
      action: { kind: RECONCILIATION_ACTION.acceptTombstone },
    });
    await coordinator.execute({ operationId: OPERATION });
    expect(tombstones).toHaveBeenCalled();

    operationSpy.mockReturnValue({
      ...original,
      action: { kind: RECONCILIATION_ACTION.restoreRecovery },
    });
    await coordinator.execute({ operationId: OPERATION });
    expect(restore).toHaveBeenCalled();

    operationSpy.mockReturnValue({
      ...original,
      action: {
        kind: RECONCILIATION_ACTION.keepBoth,
        primarySide: RECONCILIATION_PRESERVATION_SIDE.remote,
      },
      snapshot: {
        ...original.snapshot,
        paths: original.snapshot.paths.map((evidence) => ({
          ...evidence,
          remote: {
            kind: RECONCILIATION_REMOTE_EVIDENCE_KIND.tombstone,
            associationId: ASSOCIATION,
            revision: REVISION_REMOTE,
            deletedRevision: REVISION_BASE,
            recoveryId: RECOVERY,
            receipt: remoteTombstone().receipt,
          },
        })),
      },
    });
    await coordinator.execute({ operationId: OPERATION });
    expect(tombstones).toHaveBeenCalledTimes(2);

    operationSpy.mockReturnValue({
      ...original,
      action: { kind: RECONCILIATION_ACTION.defer },
    });
    await expect(
      coordinator.execute({ operationId: OPERATION }),
    ).resolves.toMatchObject({ kind: "rejected", reason: "wrong-action" });
  });
});
