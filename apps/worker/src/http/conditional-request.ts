import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  type ConditionalMutationPrecondition,
  parseApplicationEtag,
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

/** Closed raw conditional-header shapes before application policy is applied. */
const CONDITIONAL_HEADER_SHAPE = {
  missing: "missing",
  dateCondition: "date-condition",
  conflicting: "conflicting",
  ifNoneMatch: "if-none-match",
  ifMatch: "if-match",
} as const;

/** Raw conditional-header classification with values retained for variant parsing. */
type ConditionalHeaderClassification =
  | { readonly kind: typeof CONDITIONAL_HEADER_SHAPE.missing }
  | { readonly kind: typeof CONDITIONAL_HEADER_SHAPE.dateCondition }
  | { readonly kind: typeof CONDITIONAL_HEADER_SHAPE.conflicting }
  | {
      readonly kind: typeof CONDITIONAL_HEADER_SHAPE.ifNoneMatch;
      readonly value: string;
    }
  | {
      readonly kind: typeof CONDITIONAL_HEADER_SHAPE.ifMatch;
      readonly value: string;
    };

/**
 * Classifies the supplied conditional-header family without applying route policy.
 *
 * @param headers - Untrusted request headers.
 * @returns One closed raw-header shape for exhaustive policy dispatch.
 */
function classifyConditionalHeaders(
  headers: Headers,
): ConditionalHeaderClassification {
  const ifMatch = headers.get(HTTP_HEADER.ifMatch);
  const ifNoneMatch = headers.get(HTTP_HEADER.ifNoneMatch);
  if (
    headers.has(HTTP_HEADER.ifModifiedSince) ||
    headers.has(HTTP_HEADER.ifUnmodifiedSince)
  ) {
    return { kind: CONDITIONAL_HEADER_SHAPE.dateCondition };
  }
  if (ifMatch !== null && ifNoneMatch !== null) {
    return { kind: CONDITIONAL_HEADER_SHAPE.conflicting };
  }
  if (ifNoneMatch !== null) {
    return { kind: CONDITIONAL_HEADER_SHAPE.ifNoneMatch, value: ifNoneMatch };
  }
  if (ifMatch !== null) {
    return { kind: CONDITIONAL_HEADER_SHAPE.ifMatch, value: ifMatch };
  }
  return { kind: CONDITIONAL_HEADER_SHAPE.missing };
}

/**
 * Parses the absence-only conditional variant under route-specific policy.
 *
 * @param value - Raw If-None-Match header value.
 * @param mode - Whether the route admits absence-only creation.
 * @returns An absent precondition only for exact `If-None-Match: *` on PUT.
 */
function parseIfNoneMatch(
  value: string,
  mode: ConditionalRequestMode,
): ConditionalRequestResult {
  if (mode !== "put" || value !== "*") {
    return { kind: CONDITIONAL_REQUEST_RESULT_KIND.invalid };
  }
  return {
    kind: CONDITIONAL_REQUEST_RESULT_KIND.valid,
    precondition: { kind: CONDITIONAL_MUTATION_PRECONDITION_KIND.absent },
  };
}

/**
 * Parses one exact strong application-generation condition.
 *
 * @param value - Raw If-Match header value.
 * @returns A matching-revision precondition, or invalid for all other syntax.
 */
function parseIfMatch(value: string): ConditionalRequestResult {
  const revision = parseApplicationEtag(value);
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
  const classification = classifyConditionalHeaders(headers);
  switch (classification.kind) {
    case CONDITIONAL_HEADER_SHAPE.missing:
      return { kind: CONDITIONAL_REQUEST_RESULT_KIND.missing };
    case CONDITIONAL_HEADER_SHAPE.dateCondition:
    case CONDITIONAL_HEADER_SHAPE.conflicting:
      return { kind: CONDITIONAL_REQUEST_RESULT_KIND.invalid };
    case CONDITIONAL_HEADER_SHAPE.ifNoneMatch:
      return parseIfNoneMatch(classification.value, mode);
    case CONDITIONAL_HEADER_SHAPE.ifMatch:
      return parseIfMatch(classification.value);
  }
}
