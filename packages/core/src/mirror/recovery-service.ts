import type { ConditionalCurrentNoteRepository } from "@core/mirror/conditional-current-note-repository.port";
import {
  CURRENT_NOTE_STATE_KIND,
  MUTATION_EFFECT_CERTAINTY,
  RECOVERY_CONTENT_RESULT_KIND,
  RECOVERY_MAINTENANCE_RESULT_KIND,
  RECOVERY_RETENTION_MILLISECONDS,
  RECOVERY_SNAPSHOT_STATE_KIND,
} from "@core/mirror/mirror.constants";
import type {
  MutationEffectResult,
  RecoveryMutationResult,
  RecoveryPage,
  RecoveryPreparationRequest,
  RecoveryPurgeRequest,
  RecoverySealRequest,
  RecoverySnapshotId,
  RecoverySnapshotState,
} from "@core/mirror/mirror.types";
import type {
  ConfirmedTombstoneSealRequest,
  MirrorClock,
  MirrorGenerationCryptography,
  RecoveryContentResult,
  RecoveryMaintenanceResult,
  RecoveryPreparationProofResult,
} from "@core/mirror/mirror-application.types";
import type {
  ObservedPreparedRecoveryGeneration,
  RecoveryGenerationObservation,
  SealedRecoveryGenerationCandidate,
} from "@core/mirror/mirror-storage.types";
import type { RecoverySnapshotRepository } from "@core/mirror/recovery-snapshot-repository.port";
import { MAX_NOTE_SIZE_BYTES } from "@core/vault/vault.constants";

/**
 * Application policy for recovery preparation, retrieval, sealing, and purge.
 *
 * The service is the only layer that decides retention eligibility. Storage
 * adapters provide create-only writes and exact observed-generation CAS.
 */
export class RecoveryService {
  /**
   * @param repository - Recovery storage capability without unconditional replacement or delete.
   * @param currentRepository - Current-head observations used only to prove explicit sealing.
   * @param cryptography - Digest and fresh-revision dependencies for exact persisted evidence.
   * @param clock - Deterministic time source used only for purge eligibility.
   */
  constructor(
    private readonly repository: RecoverySnapshotRepository,
    private readonly currentRepository: ConditionalCurrentNoteRepository,
    private readonly cryptography: MirrorGenerationCryptography,
    private readonly clock: MirrorClock,
  ) {}

  /** @returns Metadata for one recovery identity, or `null` only for recognized absence. */
  async inspect(id: RecoverySnapshotId): Promise<RecoverySnapshotState | null> {
    return (await this.repository.read(id))?.state ?? null;
  }

  /**
   * Retrieves plaintext only from prepared or unexpired sealed generations.
   *
   * @returns Missing, recoverable, expired, or content-free purged state.
   */
  async retrieve(id: RecoverySnapshotId): Promise<RecoveryContentResult> {
    const observed = await this.repository.read(id);
    if (observed === null) {
      return { kind: RECOVERY_CONTENT_RESULT_KIND.missing };
    }
    if (observed.kind === RECOVERY_SNAPSHOT_STATE_KIND.purged) {
      return {
        kind: RECOVERY_CONTENT_RESULT_KIND.purged,
        state: observed.state,
      };
    }
    if (observed.kind === RECOVERY_SNAPSHOT_STATE_KIND.sealed) {
      const deadline = Date.parse(observed.state.recoverUntil);
      const now = this.clock.now().getTime();
      if (
        !Number.isFinite(deadline) ||
        !Number.isFinite(now) ||
        now >= deadline
      ) {
        return {
          kind: RECOVERY_CONTENT_RESULT_KIND.expired,
          state: observed.state,
        };
      }
    }

    return {
      kind: RECOVERY_CONTENT_RESULT_KIND.recoverable,
      state: observed.state,
      content: observed.content,
    };
  }

  /**
   * Lists one bounded page of recovery metadata without plaintext.
   *
   * @param cursor - Opaque continuation from an earlier page.
   * @returns Validated metadata and storage continuation.
   */
  async list(cursor?: string): Promise<RecoveryPage> {
    const page = await this.repository.list(cursor);
    return { recoveries: page.states, nextCursor: page.nextCursor };
  }

  /**
   * Creates recovery content before deletion and proves exact duplicate preparation.
   *
   * A refused create is promoted to proven preparation only after a second read
   * matches every immutable source field and exact plaintext. Unknown effects and
   * all read/storage failures remain non-confirmed, so callers cannot tombstone.
   *
   * @param request - Exact live-source snapshot labeled by the deletion operation.
   * @returns Proven prepared generation or conservative effect certainty.
   */
  async prepareForDeletion(
    request: RecoveryPreparationRequest,
  ): Promise<RecoveryPreparationProofResult> {
    let created: RecoveryPreparationProofResult;
    try {
      if (
        request.id !== request.operationId ||
        new TextEncoder().encode(request.content).byteLength >
          MAX_NOTE_SIZE_BYTES
      ) {
        return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
      }
      if (
        (await this.cryptography.digest(request.content)) !==
        request.contentSha256
      ) {
        return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
      }

      const candidate = {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.prepared,
        id: request.id,
        associationId: request.associationId,
        path: request.path,
        revision: this.cryptography.generateRevision(),
        sourceRevision: request.sourceRevision,
        contentSha256: request.contentSha256,
        operationId: request.operationId,
        content: request.content,
      } as const;
      created = await this.repository.create(candidate);
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    if (created.kind !== MUTATION_EFFECT_CERTAINTY.definitelyRefused) {
      return created;
    }

    try {
      const existing = await this.repository.read(request.id);
      if (!this.isExactPreparation(existing, request)) {
        return { kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused };
      }
      return {
        kind: MUTATION_EFFECT_CERTAINTY.confirmed,
        confirmed: existing,
      };
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Seals proven recovery material from the exact confirmed tombstone PUT timestamp.
   *
   * @param request - Prepared CAS proof and exact tombstone generation metadata.
   * @returns Sealing certainty independent of the already committed deletion.
   */
  async sealConfirmedTombstone(
    request: ConfirmedTombstoneSealRequest,
  ): Promise<RecoveryMutationResult> {
    const prepared = request.preparation;
    const tombstone = request.tombstone;
    if (
      prepared.state.id !== request.operationId ||
      prepared.state.id !== tombstone.state.recoveryId ||
      prepared.state.path !== tombstone.state.path ||
      prepared.state.sourceRevision !== tombstone.state.deletedRevision ||
      prepared.state.associationId !== tombstone.state.receipt.associationId ||
      tombstone.state.receipt.operationId !== request.operationId ||
      tombstone.state.receipt.precondition.revision !==
        tombstone.state.deletedRevision
    ) {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    return this.sealObserved(
      prepared,
      tombstone.state.revision,
      tombstone.uploaded,
      request.operationId,
    );
  }

  /**
   * Explicitly seals prepared content only after proving its still-current tombstone.
   * An exact replay of an already confirmed seal returns its read-only acknowledgement.
   *
   * @param request - Exact prepared application revision and mutation identity.
   * @returns Confirmed sealed metadata or conservative refusal/certainty.
   */
  async seal(request: RecoverySealRequest): Promise<RecoveryMutationResult> {
    return this.toMutationResult(await this.sealDetailed(request));
  }

  /**
   * Seals recovery while preserving missing, stale, and proof-conflict outcomes.
   *
   * @param request - Exact prepared generation and mutation identity.
   * @returns A transport-ready semantic outcome without exposing storage details.
   */
  async sealDetailed(
    request: RecoverySealRequest,
  ): Promise<RecoveryMaintenanceResult> {
    try {
      const recovery = await this.repository.read(request.id);
      if (recovery === null) {
        return { kind: RECOVERY_MAINTENANCE_RESULT_KIND.missing };
      }
      if (recovery.kind === RECOVERY_SNAPSHOT_STATE_KIND.sealed) {
        if (
          recovery.state.associationId === request.associationId &&
          recovery.previousRevision === request.expectedRevision &&
          recovery.operationId === request.operationId
        ) {
          return {
            kind: RECOVERY_MAINTENANCE_RESULT_KIND.confirmed,
            confirmed: recovery.state,
          };
        }
        return {
          kind: RECOVERY_MAINTENANCE_RESULT_KIND.preconditionFailed,
        };
      }
      if (
        recovery.state.revision !== request.expectedRevision ||
        recovery.state.associationId !== request.associationId
      ) {
        return {
          kind: RECOVERY_MAINTENANCE_RESULT_KIND.preconditionFailed,
        };
      }
      if (recovery.kind !== RECOVERY_SNAPSHOT_STATE_KIND.prepared) {
        return { kind: RECOVERY_MAINTENANCE_RESULT_KIND.conflict };
      }

      const current = await this.currentRepository.read(recovery.state.path);
      if (
        current.kind !== CURRENT_NOTE_STATE_KIND.tombstone ||
        current.state.path !== recovery.state.path ||
        current.state.recoveryId !== recovery.state.id ||
        current.state.receipt.operationId !== recovery.state.id ||
        current.state.deletedRevision !== recovery.state.sourceRevision ||
        current.state.receipt.precondition.revision !==
          recovery.state.sourceRevision ||
        current.state.receipt.associationId !== recovery.state.associationId
      ) {
        return { kind: RECOVERY_MAINTENANCE_RESULT_KIND.conflict };
      }

      return this.toMaintenanceResult(
        await this.sealObserved(
          recovery,
          current.state.revision,
          current.uploaded,
          request.operationId,
        ),
      );
    } catch {
      return { kind: RECOVERY_MAINTENANCE_RESULT_KIND.notDispatched };
    }
  }

  /**
   * Purges only an exact sealed generation at or after its immutable deadline.
   * An exact replay against its purged receipt returns the retained marker unchanged.
   *
   * @param request - Expected sealed revision and purge operation identity.
   * @returns Confirmed content-free marker or conservative refusal/certainty.
   */
  async purge(request: RecoveryPurgeRequest): Promise<RecoveryMutationResult> {
    return this.toMutationResult(await this.purgeDetailed(request));
  }

  /**
   * Purges recovery while distinguishing missing, stale, and retention conflicts.
   *
   * @param request - Exact sealed generation and purge mutation identity.
   * @returns A transport-ready semantic outcome without exposing storage details.
   */
  async purgeDetailed(
    request: RecoveryPurgeRequest,
  ): Promise<RecoveryMaintenanceResult> {
    try {
      const recovery = await this.repository.read(request.id);
      if (recovery === null) {
        return { kind: RECOVERY_MAINTENANCE_RESULT_KIND.missing };
      }
      if (recovery.kind === RECOVERY_SNAPSHOT_STATE_KIND.purged) {
        if (
          recovery.state.associationId === request.associationId &&
          recovery.previousRevision === request.expectedRevision &&
          recovery.operationId === request.operationId
        ) {
          return {
            kind: RECOVERY_MAINTENANCE_RESULT_KIND.confirmed,
            confirmed: recovery.state,
          };
        }
        return {
          kind: RECOVERY_MAINTENANCE_RESULT_KIND.preconditionFailed,
        };
      }
      if (
        recovery.state.revision !== request.expectedRevision ||
        recovery.state.associationId !== request.associationId
      ) {
        return {
          kind: RECOVERY_MAINTENANCE_RESULT_KIND.preconditionFailed,
        };
      }
      if (recovery.kind !== RECOVERY_SNAPSHOT_STATE_KIND.sealed) {
        return { kind: RECOVERY_MAINTENANCE_RESULT_KIND.conflict };
      }

      const deadline = Date.parse(recovery.state.recoverUntil);
      const now = this.clock.now().getTime();
      if (
        !Number.isFinite(deadline) ||
        !Number.isFinite(now) ||
        now < deadline
      ) {
        return { kind: RECOVERY_MAINTENANCE_RESULT_KIND.conflict };
      }

      const candidate = {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.purged,
        id: recovery.state.id,
        associationId: recovery.state.associationId,
        path: recovery.state.path,
        revision: this.cryptography.generateRevision(),
        sourceRevision: recovery.state.sourceRevision,
        contentSha256: recovery.state.contentSha256,
        operationId: request.operationId,
        previousRevision: recovery.state.revision,
        tombstoneRevision: recovery.tombstoneRevision,
        recoverUntil: recovery.state.recoverUntil,
      } as const;
      return this.toMaintenanceResult(
        this.toApplicationResult(await recovery.replacement.purge(candidate)),
      );
    } catch {
      return { kind: RECOVERY_MAINTENANCE_RESULT_KIND.notDispatched };
    }
  }

  /**
   * Builds and conditionally stores one sealed generation from proven timestamp evidence.
   *
   * @param prepared - Exact prepared generation and its retained CAS capability.
   * @param tombstoneRevision - Confirmed current tombstone application revision.
   * @param tombstoneUploaded - Storage timestamp from that exact successful PUT.
   * @param operationId - Identity of the seal maintenance mutation.
   * @returns Sealed metadata or conservative transition certainty.
   */
  private async sealObserved(
    prepared: ObservedPreparedRecoveryGeneration,
    tombstoneRevision: SealedRecoveryGenerationCandidate["tombstoneRevision"],
    tombstoneUploaded: Date,
    operationId: SealedRecoveryGenerationCandidate["operationId"],
  ): Promise<RecoveryMutationResult> {
    const uploadedMilliseconds = tombstoneUploaded.getTime();
    if (!Number.isFinite(uploadedMilliseconds)) {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }

    try {
      const candidate: SealedRecoveryGenerationCandidate = {
        kind: RECOVERY_SNAPSHOT_STATE_KIND.sealed,
        id: prepared.state.id,
        associationId: prepared.state.associationId,
        path: prepared.state.path,
        revision: this.cryptography.generateRevision(),
        sourceRevision: prepared.state.sourceRevision,
        contentSha256: prepared.state.contentSha256,
        operationId,
        previousRevision: prepared.state.revision,
        tombstoneRevision,
        recoverUntil: new Date(
          uploadedMilliseconds + RECOVERY_RETENTION_MILLISECONDS,
        ).toISOString(),
        content: prepared.content,
      };
      const result = await prepared.replacement.seal(candidate);
      return this.toApplicationResult(result);
    } catch {
      return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
    }
  }

  /**
   * Checks all immutable source and plaintext fields for duplicate preparation evidence.
   *
   * @param observed - Existing validated recovery object, if present.
   * @param request - Original intended prepared snapshot.
   * @returns Whether the existing generation proves the exact same preparation.
   */
  private isExactPreparation(
    observed: RecoveryGenerationObservation | null,
    request: RecoveryPreparationRequest,
  ): observed is ObservedPreparedRecoveryGeneration {
    return (
      observed?.kind === RECOVERY_SNAPSHOT_STATE_KIND.prepared &&
      observed.state.id === request.id &&
      observed.state.associationId === request.associationId &&
      observed.state.path === request.path &&
      observed.state.sourceRevision === request.sourceRevision &&
      observed.state.contentSha256 === request.contentSha256 &&
      observed.content === request.content
    );
  }

  /**
   * Converts a semantic maintenance result to the legacy certainty-only result.
   *
   * @param result - Detailed maintenance result.
   * @returns Backward-compatible effect certainty and confirmed metadata.
   */
  private toMutationResult(
    result: RecoveryMaintenanceResult,
  ): RecoveryMutationResult {
    switch (result.kind) {
      case RECOVERY_MAINTENANCE_RESULT_KIND.missing:
      case RECOVERY_MAINTENANCE_RESULT_KIND.preconditionFailed:
      case RECOVERY_MAINTENANCE_RESULT_KIND.conflict:
        return { kind: MUTATION_EFFECT_CERTAINTY.definitelyRefused };
      case RECOVERY_MAINTENANCE_RESULT_KIND.notDispatched:
        return { kind: MUTATION_EFFECT_CERTAINTY.notDispatched };
      case RECOVERY_MAINTENANCE_RESULT_KIND.confirmed:
        return {
          kind: MUTATION_EFFECT_CERTAINTY.confirmed,
          confirmed: result.confirmed,
        };
      case RECOVERY_MAINTENANCE_RESULT_KIND.unknown:
        return { kind: MUTATION_EFFECT_CERTAINTY.unknown };
    }
  }

  /**
   * Converts storage certainty into detailed recovery-maintenance semantics.
   *
   * @param result - Storage-backed recovery transition result.
   * @returns Detailed result preserving CAS refusal as a stale predicate.
   */
  private toMaintenanceResult(
    result: RecoveryMutationResult,
  ): RecoveryMaintenanceResult {
    switch (result.kind) {
      case MUTATION_EFFECT_CERTAINTY.definitelyRefused:
        return {
          kind: RECOVERY_MAINTENANCE_RESULT_KIND.preconditionFailed,
        };
      case MUTATION_EFFECT_CERTAINTY.notDispatched:
        return { kind: RECOVERY_MAINTENANCE_RESULT_KIND.notDispatched };
      case MUTATION_EFFECT_CERTAINTY.confirmed:
        return {
          kind: RECOVERY_MAINTENANCE_RESULT_KIND.confirmed,
          confirmed: result.confirmed,
        };
      case MUTATION_EFFECT_CERTAINTY.unknown:
        return { kind: RECOVERY_MAINTENANCE_RESULT_KIND.unknown };
    }
  }

  /**
   * Removes storage-only observation capabilities from confirmed recovery results.
   *
   * @param result - Recovery storage transition result.
   * @returns Metadata-only application result with unchanged certainty.
   */
  private toApplicationResult(
    result: MutationEffectResult<RecoveryGenerationObservation>,
  ): RecoveryMutationResult {
    if (result.kind !== MUTATION_EFFECT_CERTAINTY.confirmed) {
      return result;
    }
    return {
      kind: MUTATION_EFFECT_CERTAINTY.confirmed,
      confirmed: result.confirmed.state,
    };
  }
}
