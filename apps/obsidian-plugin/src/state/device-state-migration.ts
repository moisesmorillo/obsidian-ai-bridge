import {
  isMirrorDeviceStateConsistent,
  type MirrorDeviceState,
  type MirrorDeviceStateV2,
  type MirrorDeviceStateV3,
  projectMirrorDeviceStateV3ToV4,
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
): MirrorDeviceStateV3 {
  const migrated: MirrorDeviceStateV3 = {
    deviceId: state.deviceId,
    lifecycle: state.lifecycle,
    globalBlockReason: state.globalBlockReason,
    paths: state.paths,
    stagedHandoff: state.stagedHandoff,
    reconciliationReviews: [],
    reconciliationOperations: [],
  };
  if (
    !isMirrorDeviceStateConsistent(projectMirrorDeviceStateV3ToV4(migrated))
  ) {
    throw new Error(
      "Migrated mirror device state violates version-3 invariants.",
    );
  }
  return migrated;
}

/**
 * Projects one strict non-empty version-3 state into the version-4 compatibility surface.
 *
 * History and started local effects become explicit attention states; no decision,
 * cleanup step, event origin, or newer evidence is inferred.
 *
 * @param state - Strictly decoded frozen version-3 state.
 * @returns Fully validated version-4 state.
 * @throws When the projection violates the current v4 invariant contract.
 */
export function migrateMirrorDeviceStateV3ToV4(
  state: MirrorDeviceStateV3,
): MirrorDeviceState {
  const migrated = projectMirrorDeviceStateV3ToV4(state);
  if (!isMirrorDeviceStateConsistent(migrated)) {
    throw new Error(
      "Migrated mirror device state violates version-4 invariants.",
    );
  }
  return migrated;
}
