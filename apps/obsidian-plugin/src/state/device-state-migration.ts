import {
  isMirrorDeviceStateConsistent,
  isMirrorDeviceStateV4Consistent,
  type MirrorDeviceState,
  type MirrorDeviceStateV2,
  type MirrorDeviceStateV3,
  type MirrorDeviceStateV4,
  projectMirrorDeviceStateV3ToV4,
  projectMirrorDeviceStateV4ToV5,
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
    !isMirrorDeviceStateV4Consistent(projectMirrorDeviceStateV3ToV4(migrated))
  ) {
    throw new Error(
      "Migrated mirror device state violates version-3 invariants.",
    );
  }
  return migrated;
}

/**
 * Projects one strict non-empty version-3 state into the frozen version-4 compatibility surface.
 *
 * History and started local effects become explicit attention states; no decision,
 * cleanup step, event origin, or newer evidence is inferred.
 *
 * @param state - Strictly decoded frozen version-3 state.
 * @returns Fully validated version-4 state.
 * @throws When the projection violates the frozen v4 invariant contract.
 */
export function migrateMirrorDeviceStateV3ToV4(
  state: MirrorDeviceStateV3,
): MirrorDeviceStateV4 {
  const migrated = projectMirrorDeviceStateV3ToV4(state);
  if (!isMirrorDeviceStateV4Consistent(migrated)) {
    throw new Error(
      "Migrated mirror device state violates version-4 invariants.",
    );
  }
  return migrated;
}

/**
 * Fences every still-active v4 operation because persisted state cannot prove coverage across cold start.
 *
 * Terminal operations remain unchanged. No live review, effect, recovery result or
 * observation range is inferred from numeric epochs or historical operation phase.
 *
 * @param state - Strictly decoded and semantically valid frozen v4 state.
 * @returns Fully validated v5 state with explicit cold-gap authority.
 * @throws When the projection violates the current v5 invariant contract.
 */
export function migrateMirrorDeviceStateV4ToV5(
  state: MirrorDeviceStateV4,
): MirrorDeviceState {
  const migrated = projectMirrorDeviceStateV4ToV5(state);
  if (!isMirrorDeviceStateConsistent(migrated)) {
    throw new Error(
      "Migrated mirror device state violates version-5 invariants.",
    );
  }
  return migrated;
}
