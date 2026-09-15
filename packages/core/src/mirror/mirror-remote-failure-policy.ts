import { MIRROR_GLOBAL_BLOCK_REASON } from "@core/mirror/mirror-state.constants";
import type { MirrorDeviceState } from "@core/mirror/mirror-state.types";
import type { MirrorStateOwner } from "@core/mirror/mirror-state-owner";
import { REMOTE_BRIDGE_FAILURE } from "@core/mirror/remote-bridge.constants";
import type { RemoteBridgeFailure } from "@core/mirror/remote-bridge.types";

/**
 * Classifies sanitized remote failures that close global mutation admission.
 *
 * @param failure - Transport-independent remote failure.
 * @returns Durable global blocker, or `null` for path-local/transient failures.
 */
export function globalBlockForRemoteFailure(
  failure: RemoteBridgeFailure,
): MirrorDeviceState["globalBlockReason"] {
  switch (failure) {
    case REMOTE_BRIDGE_FAILURE.unauthenticated:
    case REMOTE_BRIDGE_FAILURE.missingSecret:
      return MIRROR_GLOBAL_BLOCK_REASON.missingSecret;
    case REMOTE_BRIDGE_FAILURE.forbidden:
      return MIRROR_GLOBAL_BLOCK_REASON.designationMismatch;
    case REMOTE_BRIDGE_FAILURE.incompatibleProtocol:
    case REMOTE_BRIDGE_FAILURE.unsupportedRuntime:
    case REMOTE_BRIDGE_FAILURE.invalidConfiguration:
      return MIRROR_GLOBAL_BLOCK_REASON.configurationUnavailable;
    case REMOTE_BRIDGE_FAILURE.preconditionFailed:
    case REMOTE_BRIDGE_FAILURE.preconditionRequired:
    case REMOTE_BRIDGE_FAILURE.missing:
    case REMOTE_BRIDGE_FAILURE.conflict:
    case REMOTE_BRIDGE_FAILURE.rateLimited:
    case REMOTE_BRIDGE_FAILURE.serverFailed:
    case REMOTE_BRIDGE_FAILURE.malformedResponse:
    case REMOTE_BRIDGE_FAILURE.networkUnavailable:
    case REMOTE_BRIDGE_FAILURE.timedOut:
    case REMOTE_BRIDGE_FAILURE.cancelled:
    case REMOTE_BRIDGE_FAILURE.admissionDenied:
      return null;
  }
}

/** Persists a global blocker when the classified remote failure requires one. */
export async function applyGlobalRemoteFailure(
  stateOwner: MirrorStateOwner,
  failure: RemoteBridgeFailure,
): Promise<void> {
  const reason = globalBlockForRemoteFailure(failure);
  if (reason === null) return;
  await stateOwner.transition((state) => ({
    ...state,
    globalBlockReason: reason,
  }));
}
