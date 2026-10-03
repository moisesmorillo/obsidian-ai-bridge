import type { ContentSha256 } from "@core/mirror/mirror.types";
import { isContentSha256 } from "@core/mirror/mirror-identifiers";
import type {
  SyncCommittedPosition,
  SyncCurrentState,
  SyncMutationRequest,
  SyncOperationRecord,
} from "@core/sync/sync-store.types";
import { MAX_NOTE_SIZE_BYTES } from "@core/vault/vault.constants";

/** Failures that the pure mutation precondition and replay policy can select. */
export type SyncMutationPolicyErrorCode =
  | "invalid_input"
  | "stale_revision"
  | "operation_id_reused"
  | "operation_pending"
  | "effect_unknown";

/** Exact policy outcome; only `proceed` authorizes an adapter to attempt publication. */
export type SyncMutationDecision =
  | { readonly kind: "proceed" }
  | {
      readonly kind: "already_committed";
      /** Revision of the exact request previously verified as committed. */
      readonly revision: SyncMutationRequest["revision"];
      /** Stable identity of the exact replayed request. */
      readonly operationId: SyncMutationRequest["operationId"];
      /** Previously verified committed feed position. */
      readonly position: SyncCommittedPosition;
    }
  | {
      readonly kind: "reject";
      /** Typed reason publication must not proceed. */
      readonly code: SyncMutationPolicyErrorCode;
    };

/**
 * Evaluates one exact-parent mutation without persisting or repairing evidence.
 * Its `proceed` decision does not claim an atomic multi-key commit.
 *
 * @param request Complete immutable mutation intent, including exact UTF-8 live bytes.
 * @param observed Successful current-head observation; failures are not absence evidence.
 * @param priorOperation Journal evidence for this operation ID, if available.
 * @param hashContent Computes SHA-256 over the supplied text's exact UTF-8 bytes.
 * @returns Whether publication may proceed, was already committed, or must be rejected.
 * @throws Propagates a digest capability failure; without a digest, publication is not authorized.
 */
export async function evaluateSyncMutation(
  request: SyncMutationRequest,
  observed: SyncCurrentState,
  priorOperation: SyncOperationRecord | undefined,
  hashContent: (content: string) => Promise<ContentSha256>,
): Promise<SyncMutationDecision> {
  if (
    priorOperation !== undefined &&
    !sameMutationRequest(request, priorOperation.request)
  ) {
    return reject("operation_id_reused");
  }

  if (!(await isSyncMutationInputValid(request, hashContent))) {
    return reject("invalid_input");
  }

  if (priorOperation !== undefined) {
    switch (priorOperation.kind) {
      case "pending":
        return reject("operation_pending");
      case "unknown":
        return reject("effect_unknown");
      case "committed":
        return {
          kind: "already_committed",
          revision: priorOperation.request.revision,
          operationId: priorOperation.request.operationId,
          position: priorOperation.position,
        };
    }
  }

  if (!matchesMutationParent(request, observed)) {
    return reject("stale_revision");
  }

  return { kind: "proceed" };
}

/** Rejects a revision that would repeat the exact parent generation.
 * @param request Candidate mutation whose proposed revision is checked.
 * @returns Whether this operation publishes a distinct revision.
 */
function hasFreshRevision(request: SyncMutationRequest): boolean {
  switch (request.kind) {
    case "create":
      return isNeverSeenParent(request.parent);
    case "update":
      return (
        isRevisionParent(request.parent) &&
        request.revision !== request.parent.revision
      );
    case "tombstone":
      return (
        isRevisionParent(request.parent) &&
        request.revision !== request.parent.revision
      );
    default:
      return false;
  }
}

/** Validates caller-controlled parent and payload invariants without consulting observed state.
 * @param request Complete mutation intent checked before any storage observation.
 * @param hashContent Hashes exact UTF-8 text; the capability failure propagates to the caller.
 * @returns Whether the request has a valid exact parent shape, fresh revision, and supported digest/size.
 */
export async function isSyncMutationInputValid(
  request: SyncMutationRequest,
  hashContent: (content: string) => Promise<ContentSha256>,
): Promise<boolean> {
  if (
    !hasFreshRevision(request) ||
    typeof request.contentSha256 !== "string" ||
    !isContentSha256(request.contentSha256)
  ) {
    return false;
  }
  if (request.kind === "tombstone") return true;

  const contentBytes = new TextEncoder().encode(request.content);
  if (contentBytes.byteLength > MAX_NOTE_SIZE_BYTES) return false;

  return (await hashContent(request.content)) === request.contentSha256;
}

/** Checks the create-only parent alternative without dereferencing malformed runtime input.
 * @param parent Parent value received through the typed core contract.
 * @returns Whether it is the explicit never-seen state.
 */
function isNeverSeenParent(parent: SyncMutationRequest["parent"]): boolean {
  return (
    typeof parent === "object" &&
    parent !== null &&
    parent.kind === "never_seen"
  );
}

/** Checks the exact-revision parent alternative without dereferencing malformed runtime input.
 * @param parent Parent value received through the typed core contract.
 * @returns Whether it carries a string revision under the exact revision discriminator.
 */
function isRevisionParent(
  parent: SyncMutationRequest["parent"],
): parent is Extract<
  SyncMutationRequest["parent"],
  { readonly kind: "revision" }
> {
  return (
    typeof parent === "object" &&
    parent !== null &&
    parent.kind === "revision" &&
    typeof parent.revision === "string"
  );
}

/** Checks the action-specific observed-head condition without refreshing it.
 * @param request Mutation carrying the exact expected parent.
 * @param observed Last successfully observed current path state.
 * @returns Whether the action is valid against this exact observation.
 */
function matchesMutationParent(
  request: SyncMutationRequest,
  observed: SyncCurrentState,
): boolean {
  switch (request.kind) {
    case "create":
      return observed.kind === "never_seen";
    case "update":
      return (
        observed.kind !== "never_seen" &&
        observed.revision === request.parent.revision
      );
    case "tombstone":
      return (
        observed.kind === "live" &&
        observed.revision === request.parent.revision &&
        observed.contentSha256 === request.contentSha256
      );
  }
}

/** Compares every immutable mutation field, including exact encoded live bytes.
 * @param left Request submitted for evaluation.
 * @param right Request bound by the existing operation identity.
 * @returns Whether both requests describe the same complete operation.
 */
function sameMutationRequest(
  left: SyncMutationRequest,
  right: SyncMutationRequest,
): boolean {
  if (
    left.vaultId !== right.vaultId ||
    left.path !== right.path ||
    left.operationId !== right.operationId ||
    left.revision !== right.revision ||
    left.origin !== right.origin ||
    left.contentSha256 !== right.contentSha256
  ) {
    return false;
  }

  switch (left.kind) {
    case "create":
      return (
        right.kind === "create" &&
        left.mediaType === right.mediaType &&
        sameUtf8Bytes(left.content, right.content)
      );
    case "update":
      return (
        right.kind === "update" &&
        left.parent.revision === right.parent.revision &&
        left.mediaType === right.mediaType &&
        sameUtf8Bytes(left.content, right.content)
      );
    case "tombstone":
      return (
        right.kind === "tombstone" &&
        left.parent.revision === right.parent.revision
      );
  }
}

/** Compares UTF-8 payload bytes without normalizing Unicode or Markdown text.
 * @param left First exact payload string.
 * @param right Second exact payload string.
 * @returns Whether both strings encode to identical UTF-8 bytes.
 */
function sameUtf8Bytes(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    leftBytes.every((byte, index) => byte === rightBytes[index])
  );
}

/** Produces a typed non-success outcome without mutating observed inputs.
 * @param code Closed policy failure preventing publication.
 * @returns A rejection decision with the selected failure code.
 */
function reject(code: SyncMutationPolicyErrorCode): SyncMutationDecision {
  return { kind: "reject", code };
}
