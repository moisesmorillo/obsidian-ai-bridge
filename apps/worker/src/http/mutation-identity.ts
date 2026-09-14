import {
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  type MirrorAssociationId,
  type MirrorOperationId,
  type MirrorWriterId,
} from "@obsidian-ai-bridge/core";
import type { MirrorDesignation } from "@worker/app.types";
import { HTTP_HEADER } from "@worker/http/http.constants";

/** Closed mutation-identity validation outcomes. */
export const MUTATION_IDENTITY_RESULT_KIND = {
  valid: "valid",
  malformed: "malformed",
  forbidden: "forbidden",
} as const;

/** Validated cooperating-writer metadata accepted by the static designation guard. */
export interface ValidMutationIdentity {
  readonly associationId: MirrorAssociationId;
  readonly writerId: MirrorWriterId;
  readonly operationId: MirrorOperationId;
}

/** Closed identity result used before any mutation service is called. */
export type MutationIdentityResult =
  | {
      readonly kind: typeof MUTATION_IDENTITY_RESULT_KIND.valid;
      readonly identity: ValidMutationIdentity;
    }
  | { readonly kind: typeof MUTATION_IDENTITY_RESULT_KIND.malformed }
  | { readonly kind: typeof MUTATION_IDENTITY_RESULT_KIND.forbidden };

/**
 * Validates mutation IDs and checks the configured association/writer designation.
 *
 * @param headers - Untrusted request headers.
 * @param designation - Composition-validated static Worker configuration.
 * @returns Validated identities, malformed input, or designation refusal.
 */
export function validateMutationIdentity(
  headers: Headers,
  designation: MirrorDesignation | null,
): MutationIdentityResult {
  const associationId = createMirrorAssociationId(
    headers.get(HTTP_HEADER.associationId) ?? "",
  );
  const writerId = createMirrorWriterId(
    headers.get(HTTP_HEADER.writerId) ?? "",
  );
  const operationId = createMirrorOperationId(
    headers.get(HTTP_HEADER.operationId) ?? "",
  );
  if (
    associationId === undefined ||
    writerId === undefined ||
    operationId === undefined
  ) {
    return { kind: MUTATION_IDENTITY_RESULT_KIND.malformed };
  }
  if (
    designation === null ||
    designation.associationId !== associationId ||
    designation.writerId !== writerId
  ) {
    return { kind: MUTATION_IDENTITY_RESULT_KIND.forbidden };
  }

  return {
    kind: MUTATION_IDENTITY_RESULT_KIND.valid,
    identity: { associationId, writerId, operationId },
  };
}
