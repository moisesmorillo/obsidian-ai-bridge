import { MUTATION_ACTION } from "@core/mirror/mirror.constants";
import type {
  ConditionalMutationPrecondition,
  MutationAcknowledgement,
  OperationReceipt,
  UnresolvedMutationIntent,
} from "@core/mirror/mirror.types";
import { MIRROR_ACKNOWLEDGEMENT_KIND } from "@core/mirror/mirror-state.constants";
import type {
  MirrorDeviceState,
  MirrorPathState,
} from "@core/mirror/mirror-state.types";

/**
 * Applies an exact remote acknowledgement to its persisted unresolved intent.
 *
 * The acknowledgement must match the complete operation identity and original
 * precondition. Content operations additionally require the exact attempted hash;
 * tombstones bind their recovery ID to the persisted operation UUID. The returned
 * snapshot records ACK metadata before removing unresolved evidence, allowing the
 * serialized state owner to persist both changes together before path release.
 *
 * @param state - Current authoritative device-local state.
 * @param acknowledgement - Validated acknowledgement for one stored remote generation.
 * @returns Next state, or `undefined` when any receipt/intent field mismatches.
 */
export function applyMutationAcknowledgement(
  state: MirrorDeviceState,
  acknowledgement: MutationAcknowledgement,
): MirrorDeviceState | undefined {
  const index = state.paths.findIndex(
    (entry) => entry.path === acknowledgement.path,
  );
  if (index < 0) return undefined;
  const current = state.paths[index];
  if (current === undefined || current.unresolvedMutation === null) {
    return undefined;
  }
  const intent = current.unresolvedMutation.intent;
  if (
    !receiptMatchesIntent(acknowledgement.receipt, intent) ||
    (intent.precondition.kind === "matching-revision" &&
      acknowledgement.revision === intent.precondition.revision)
  ) {
    return undefined;
  }
  const updated = acknowledgedPathState(current, acknowledgement);
  const paths = state.paths.map((entry, entryIndex) =>
    entryIndex === index ? updated : entry,
  );
  return { ...state, paths };
}

function receiptMatchesIntent(
  receipt: OperationReceipt,
  intent: UnresolvedMutationIntent,
): boolean {
  if (
    receipt.associationId !== intent.associationId ||
    receipt.operationId !== intent.operationId ||
    receipt.action !== intent.action ||
    !preconditionsEqual(receipt.precondition, intent.precondition)
  ) {
    return false;
  }
  if (receipt.action === MUTATION_ACTION.tombstone) {
    return intent.action === MUTATION_ACTION.tombstone;
  }
  return (
    intent.action !== MUTATION_ACTION.tombstone &&
    receipt.contentSha256 === intent.contentSha256
  );
}

function preconditionsEqual(
  left: ConditionalMutationPrecondition,
  right: ConditionalMutationPrecondition,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "absent") return true;
  return right.kind === "matching-revision" && left.revision === right.revision;
}

function acknowledgedPathState(
  current: MirrorPathState,
  acknowledgement: MutationAcknowledgement,
): MirrorPathState {
  if (acknowledgement.receipt.action === MUTATION_ACTION.tombstone) {
    return {
      ...current,
      acknowledgement: {
        kind: MIRROR_ACKNOWLEDGEMENT_KIND.tombstone,
        revision: acknowledgement.revision,
        recoveryId: acknowledgement.receipt.operationId,
      },
      unresolvedMutation: null,
      blockedReason: null,
    };
  }
  return {
    ...current,
    acknowledgement: {
      kind: MIRROR_ACKNOWLEDGEMENT_KIND.live,
      revision: acknowledgement.revision,
      contentSha256: acknowledgement.receipt.contentSha256,
    },
    unresolvedMutation: null,
    blockedReason: null,
  };
}
