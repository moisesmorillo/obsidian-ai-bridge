import {
  isMirrorDeviceStateConsistent,
  type MirrorDeviceState,
  type MirrorDeviceStateV2,
} from "@obsidian-ai-bridge/core";

/**
 * Projects one fully validated M3 version-2 state into the M4 version-3 contract.
 *
 * Every M3 field and array order is retained exactly. No review, operation, authority,
 * resolution, or inferred baseline is created from historical state.
 *
 * @param state - Strictly decoded and semantically valid frozen version-2 state.
 * @returns A valid body-free version-3 state with empty sparse M4 collections.
 * @throws When the projected state violates the current core invariant contract.
 */
export function migrateMirrorDeviceStateV2ToV3(
  state: MirrorDeviceStateV2,
): MirrorDeviceState {
  const migrated: MirrorDeviceState = {
    deviceId: state.deviceId,
    lifecycle: state.lifecycle,
    globalBlockReason: state.globalBlockReason,
    paths: state.paths,
    stagedHandoff: state.stagedHandoff,
    reconciliationReviews: [],
    reconciliationOperations: [],
  };
  if (!isMirrorDeviceStateConsistent(migrated)) {
    throw new Error(
      "Migrated mirror device state violates version-3 invariants.",
    );
  }
  return migrated;
}
