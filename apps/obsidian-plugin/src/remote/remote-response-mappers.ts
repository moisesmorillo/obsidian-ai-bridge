import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  type ConditionalMutationRequest,
  CURRENT_NOTE_STATE_KIND,
  type CurrentNoteState,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createRecoverySnapshotId,
  MUTATION_ACTION,
  type MutationAcknowledgement,
  RECOVERY_SNAPSHOT_STATE_KIND,
  type RecoverySnapshotState,
} from "@obsidian-ai-bridge/core";
import type {
  CurrentNoteStateDto,
  MutationAcknowledgementDto,
  OperationReceiptDto,
  RecoverySnapshotStateDto,
} from "@obsidian-ai-bridge/protocol";

/**
 * Converts a validated current-state DTO into branded application values.
 *
 * @param dto - Strict protocol current-state representation.
 * @returns Application state, or `undefined` when branding or receipt coherence fails.
 */
export function mapCurrentStateDto(
  dto: CurrentNoteStateDto,
): CurrentNoteState | undefined {
  const path = dto.path;
  if (
    dto.kind === CURRENT_NOTE_STATE_KIND.absent ||
    dto.kind === CURRENT_NOTE_STATE_KIND.legacy
  ) {
    return { kind: dto.kind, path };
  }
  const revision = createApplicationRevision(dto.revision);
  const receipt = mapReceiptDto(dto.receipt);
  if (revision === undefined || receipt === undefined) return undefined;
  if (dto.kind === CURRENT_NOTE_STATE_KIND.live) {
    const contentSha256 = createContentSha256(dto.contentSha256);
    if (
      contentSha256 === undefined ||
      (receipt.action !== MUTATION_ACTION.create &&
        receipt.action !== MUTATION_ACTION.update &&
        receipt.action !== MUTATION_ACTION.recreate)
    ) {
      return undefined;
    }
    return { kind: dto.kind, path, revision, contentSha256, receipt };
  }
  const deletedRevision = createApplicationRevision(dto.deletedRevision);
  const recoveryId = createRecoverySnapshotId(dto.recoveryId);
  if (
    deletedRevision === undefined ||
    recoveryId === undefined ||
    receipt.action !== MUTATION_ACTION.tombstone
  ) {
    return undefined;
  }
  return {
    kind: dto.kind,
    path,
    revision,
    deletedRevision,
    recoveryId,
    receipt,
  };
}

/**
 * Converts a validated mutation acknowledgement DTO into branded application values.
 *
 * @param dto - Strict protocol acknowledgement representation.
 * @returns Application acknowledgement, or `undefined` for incoherent identifiers.
 */
export function mapMutationAcknowledgementDto(
  dto: MutationAcknowledgementDto,
): MutationAcknowledgement | undefined {
  const path = dto.path;
  const revision = createApplicationRevision(dto.revision);
  const receipt = mapReceiptDto(dto.receipt);
  if (path === undefined || revision === undefined || receipt === undefined) {
    return undefined;
  }
  return { path, revision, receipt };
}

/**
 * Converts a validated recovery DTO into branded application values.
 *
 * @param dto - Strict protocol recovery-state representation.
 * @returns Application recovery state, or `undefined` when branding fails.
 */
export function mapRecoveryStateDto(
  dto: RecoverySnapshotStateDto,
): RecoverySnapshotState | undefined {
  const id = createRecoverySnapshotId(dto.id);
  const associationId = createMirrorAssociationId(dto.associationId);
  const path = dto.path;
  const revision = createApplicationRevision(dto.revision);
  const sourceRevision = createApplicationRevision(dto.sourceRevision);
  const contentSha256 = createContentSha256(dto.contentSha256);
  if (
    id === undefined ||
    associationId === undefined ||
    revision === undefined ||
    sourceRevision === undefined ||
    contentSha256 === undefined
  ) {
    return undefined;
  }
  if (dto.kind === RECOVERY_SNAPSHOT_STATE_KIND.prepared) {
    return {
      kind: dto.kind,
      id,
      associationId,
      path,
      revision,
      sourceRevision,
      contentSha256,
    };
  }
  return {
    kind: dto.kind,
    id,
    associationId,
    path,
    revision,
    sourceRevision,
    contentSha256,
    recoverUntil: dto.recoverUntil,
  };
}

/**
 * Verifies that a decoded acknowledgement proves the exact outgoing mutation.
 *
 * @param acknowledgement - Branded acknowledgement returned by the Worker.
 * @param request - Original conditional mutation request.
 * @param contentHash - Locally computed content digest, empty for tombstones.
 * @returns Whether receipt identity, precondition, action, and digest all match.
 */
export function acknowledgementMatchesRequest(
  acknowledgement: MutationAcknowledgement,
  request: ConditionalMutationRequest,
  contentHash: string,
): boolean {
  const receipt = acknowledgement.receipt;
  if (
    receipt.action !== request.action ||
    receipt.associationId !== request.associationId ||
    receipt.operationId !== request.operationId ||
    receipt.precondition.kind !== request.precondition.kind
  ) {
    return false;
  }
  if (
    receipt.precondition.kind ===
      CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision &&
    request.precondition.kind ===
      CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision &&
    receipt.precondition.revision !== request.precondition.revision
  ) {
    return false;
  }
  return (
    receipt.action === MUTATION_ACTION.tombstone ||
    receipt.contentSha256 === contentHash
  );
}

/**
 * Converts a strict receipt DTO while enforcing action/precondition/content coherence.
 *
 * @param dto - Strict protocol operation receipt.
 * @returns Branded application receipt, or `undefined` for incoherent fields.
 */
function mapReceiptDto(
  dto: OperationReceiptDto,
): MutationAcknowledgement["receipt"] | undefined {
  const associationId = createMirrorAssociationId(dto.associationId);
  const operationId = createMirrorOperationId(dto.operationId);
  if (associationId === undefined || operationId === undefined) {
    return undefined;
  }
  if (dto.precondition.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.absent) {
    const contentSha256 =
      "contentSha256" in dto
        ? createContentSha256(dto.contentSha256)
        : undefined;
    return dto.action === MUTATION_ACTION.create && contentSha256 !== undefined
      ? {
          action: dto.action,
          associationId,
          operationId,
          precondition: {
            kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent,
          },
          contentSha256,
        }
      : undefined;
  }
  const revision = createApplicationRevision(dto.precondition.revision);
  if (revision === undefined) return undefined;
  if (dto.action === MUTATION_ACTION.tombstone) {
    return {
      action: dto.action,
      associationId,
      operationId,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision,
      },
    };
  }
  const contentSha256 =
    "contentSha256" in dto ? createContentSha256(dto.contentSha256) : undefined;
  if (contentSha256 === undefined) return undefined;
  if (
    dto.action === MUTATION_ACTION.update ||
    dto.action === MUTATION_ACTION.recreate
  ) {
    return {
      action: dto.action,
      associationId,
      operationId,
      precondition: {
        kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
        revision,
      },
      contentSha256,
    };
  }
  return undefined;
}
