import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  type ConditionalMutationPrecondition,
  createApplicationEtag,
  createApplicationRevision,
} from "@obsidian-ai-bridge/core";
import { HTTP_HEADER } from "@worker/http/http.constants";

/** Closed parser outcomes for required M3 HTTP preconditions. */
export const CONDITIONAL_REQUEST_RESULT_KIND = {
  valid: "valid",
  missing: "missing",
  invalid: "invalid",
} as const;

/** Conditional header mode for content PUT versus matching-only mutations. */
export type ConditionalRequestMode = "put" | "matching";

/** Strict transport result that never represents replace-any behavior. */
export type ConditionalRequestResult =
  | {
      readonly kind: typeof CONDITIONAL_REQUEST_RESULT_KIND.valid;
      readonly precondition: ConditionalMutationPrecondition;
    }
  | { readonly kind: typeof CONDITIONAL_REQUEST_RESULT_KIND.missing }
  | { readonly kind: typeof CONDITIONAL_REQUEST_RESULT_KIND.invalid };

/**
 * Parses exactly the absence or strong application-generation forms admitted by v2.
 *
 * Weak validators, lists, wildcard matching, date conditions, and mixed condition
 * families are rejected rather than delegated to generic HTTP cache semantics.
 *
 * @param headers - Untrusted request headers.
 * @param mode - Whether absence-only creation is allowed for this route.
 * @returns A strict application precondition or a typed missing/invalid outcome.
 */
export function parseConditionalRequest(
  headers: Headers,
  mode: ConditionalRequestMode,
): ConditionalRequestResult {
  const ifMatch = headers.get(HTTP_HEADER.ifMatch);
  const ifNoneMatch = headers.get(HTTP_HEADER.ifNoneMatch);
  const hasDateCondition =
    headers.has(HTTP_HEADER.ifModifiedSince) ||
    headers.has(HTTP_HEADER.ifUnmodifiedSince);

  if (hasDateCondition || (ifMatch !== null && ifNoneMatch !== null)) {
    return { kind: CONDITIONAL_REQUEST_RESULT_KIND.invalid };
  }
  if (ifMatch === null && ifNoneMatch === null) {
    return { kind: CONDITIONAL_REQUEST_RESULT_KIND.missing };
  }
  if (ifNoneMatch !== null) {
    if (mode !== "put" || ifNoneMatch !== "*") {
      return { kind: CONDITIONAL_REQUEST_RESULT_KIND.invalid };
    }
    return {
      kind: CONDITIONAL_REQUEST_RESULT_KIND.valid,
      precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
    };
  }
  if (ifMatch === null || createApplicationEtag(ifMatch) === undefined) {
    return { kind: CONDITIONAL_REQUEST_RESULT_KIND.invalid };
  }

  const revision = createApplicationRevision(ifMatch.slice(4, -1));
  if (revision === undefined) {
    return { kind: CONDITIONAL_REQUEST_RESULT_KIND.invalid };
  }
  return {
    kind: CONDITIONAL_REQUEST_RESULT_KIND.valid,
    precondition: {
      kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision,
      revision,
    },
  };
}
