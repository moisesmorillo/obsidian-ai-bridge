import { SYNC_R2_WRITE_COOLDOWN_MS } from "@worker/infrastructure/sync/sync-r2.constants";
import {
  PROFILE_IDS,
  PROFILE_SEED_BATCH,
  type ProfileReply,
  type ProfileRequest,
  type ProfileState,
  profileStateSchema,
} from "@worker-tests/runtime/fixtures/inventory-profile.contract";
import { profileHead } from "@worker-tests/runtime/fixtures/inventory-profile.worker";
import { profileWait } from "@worker-tests/runtime/fixtures/inventory-profile-policy";

/** Selects exactly one request from the validated host checkpoint; done never dispatches.
 * @param state Exact rehydrated checkpoint for this emulator and fixture.
 * @returns One seed/store request; completion or missing handle throws without dispatch.
 */
export function nextProfileRequest(state: ProfileState): ProfileRequest {
  switch (state.phase) {
    case "seed":
      return {
        action: "seed",
        headCount: state.headCount,
        offset: state.offset,
      };
    case "start":
      return { action: "start" };
    case "scan":
      return { action: "continue" };
    case "page": {
      if (state.handle === null)
        throw new RangeError("Missing complete handle.");
      return { action: "page", handle: state.handle, cursor: state.cursor };
    }
    case "done":
      throw new RangeError("Completed profile cannot dispatch.");
  }
}

/** Advances only evidence-bound profile checkpoints, never changing scan authority.
 * @param state Prior immutable host checkpoint.
 * @param request Exact operation selected from that checkpoint.
 * @param reply Parsed observed reply whose identity/count/evidence must match.
 * @returns Validated successor, or throws leaving the previous checkpoint authoritative.
 */
export function advanceProfileState(
  state: ProfileState,
  request: ProfileRequest,
  reply: ProfileReply,
): ProfileState {
  if (
    JSON.stringify(request) !== JSON.stringify(nextProfileRequest(state)) ||
    reply.action === "failed"
  )
    throw new RangeError("Profile reply cannot advance this checkpoint.");
  if (request.action === "seed" && reply.action === "seed") {
    const expected = Math.min(
      state.headCount,
      state.offset + PROFILE_SEED_BATCH,
    );
    if (reply.nextOffset !== expected)
      throw new RangeError("Fixture batch did not confirm its exact range.");
    return profileStateSchema.parse({
      ...state,
      phase: expected === state.headCount ? "start" : "seed",
      offset: expected,
      maxHeadBytes: Math.max(state.maxHeadBytes, reply.maxHeadBytes),
    });
  }
  if (
    (request.action === "start" || request.action === "continue") &&
    reply.action === "inventory"
  ) {
    const result = reply.result;
    if (
      result.vaultId !== PROFILE_IDS.vaultId ||
      result.inventoryId !== PROFILE_IDS.inventoryId
    )
      throw new RangeError("Foreign scan identity.");
    if (result.kind === "inventory_in_progress")
      return profileStateSchema.parse({
        ...state,
        phase: request.action === "start" ? "scan" : "start",
        notBeforeMs: Math.max(state.notBeforeMs, result.retryAfterEpochMs ?? 0),
      });
    if (result.entryCount !== state.headCount)
      throw new RangeError("Complete handle has wrong fixture count.");
    return profileStateSchema.parse({
      ...state,
      phase: "page",
      handle: result,
      cursor: "",
    });
  }
  if (request.action === "page" && reply.action === "page") {
    const seen = new Set(state.seen);
    for (const summary of reply.result.summaries) {
      const indexText = summary.path.split("/").at(-1)?.slice(0, 6);
      const index = Number(indexText);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= state.headCount ||
        seen.has(index)
      )
        throw new RangeError("Duplicated or unexpected evidence summary.");
      const expected = profileHead(index);
      if (
        summary.path !== expected.path ||
        summary.kind !== expected.kind ||
        summary.revision !== expected.revision
      )
        throw new RangeError("Evidence differs from canonical seeded head.");
      seen.add(index);
    }
    if (reply.result.final && seen.size !== state.headCount)
      throw new RangeError("Incomplete evidence traversal.");
    return profileStateSchema.parse({
      ...state,
      phase: reply.result.final ? "done" : "page",
      cursor: reply.result.nextCursor ?? "",
      seen: [...seen],
    });
  }
  throw new RangeError("Mismatched profile action and reply.");
}

/** Retains uncertainty scheduling evidence without advancing the checkpoint.
 * @param state Prior checkpoint whose work remains unresolved.
 * @param reply Parsed failure with optional independently known safe floor.
 * @param now Host observation epoch, conservatively bounding the just-ended request.
 * @returns Same work phase with maximum old, supplied and observation-time cooldown floor.
 */
export function observeProfileFailure(
  state: ProfileState,
  reply: ProfileReply,
  now: number,
): ProfileState {
  if (reply.action !== "failed")
    throw new RangeError("Expected observed failure.");
  profileWait(now, reply.retryAfterEpochMs ?? 0);
  return profileStateSchema.parse({
    ...state,
    notBeforeMs: Math.max(
      state.notBeforeMs,
      reply.retryAfterEpochMs ?? 0,
      now + SYNC_R2_WRITE_COOLDOWN_MS,
    ),
  });
}
