import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CURRENT_NOTE_STATE_KIND,
  MUTATION_ACTION,
} from "@core/mirror/mirror.constants";
import type {
  ConditionalMutationPrecondition,
  CurrentNoteState,
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
    (intent.precondition.kind ===
      CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision &&
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

/**
 * Checks whether a remote current state is the exact receipt for one durable intent.
 *
 * @param state - Validated remote current-state evidence.
 * @param intent - Original persisted mutation identity and condition.
 * @returns Whether the state proves that exact operation committed.
 */
export function currentStateHasExactIntentReceipt(
  state: CurrentNoteState,
  intent: UnresolvedMutationIntent,
): boolean {
  return (
    (state.kind === CURRENT_NOTE_STATE_KIND.live ||
      state.kind === CURRENT_NOTE_STATE_KIND.tombstone) &&
    receiptMatchesIntent(state.receipt, intent)
  );
}

/**
 * Converts proven current-state evidence into acknowledgement input.
 *
 * @returns Acknowledgement for live/tombstone evidence, or none for absence/legacy.
 */
export function currentStateAcknowledgement(
  state: CurrentNoteState,
): MutationAcknowledgement | undefined {
  if (
    state.kind !== CURRENT_NOTE_STATE_KIND.live &&
    state.kind !== CURRENT_NOTE_STATE_KIND.tombstone
  ) {
    return undefined;
  }
  return { path: state.path, revision: state.revision, receipt: state.receipt };
}

/**
 * Checks current remote evidence against the path's last durable acknowledgement.
 *
 * @returns Whether bootstrap/reconciliation may safely retain the local baseline.
 */
export function currentStateMatchesPathAcknowledgement(
  path: MirrorPathState,
  observed: CurrentNoteState,
): boolean {
  switch (path.acknowledgement.kind) {
    case MIRROR_ACKNOWLEDGEMENT_KIND.unassociated:
      return observed.kind === CURRENT_NOTE_STATE_KIND.absent;
    case MIRROR_ACKNOWLEDGEMENT_KIND.live:
      return (
        observed.kind === CURRENT_NOTE_STATE_KIND.live &&
        observed.revision === path.acknowledgement.revision &&
        observed.contentSha256 === path.acknowledgement.contentSha256
      );
    case MIRROR_ACKNOWLEDGEMENT_KIND.tombstone:
      return (
        observed.kind === CURRENT_NOTE_STATE_KIND.tombstone &&
        observed.revision === path.acknowledgement.revision &&
        observed.recoveryId === path.acknowledgement.recoveryId
      );
  }
}

/**
 * Checks exact operation, action, precondition, and content identity.
 *
 * @returns Whether the receipt proves the exact durable intent.
 */
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
  if (left.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.absent) return true;
  return (
    right.kind === CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision &&
    left.revision === right.revision
  );
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
