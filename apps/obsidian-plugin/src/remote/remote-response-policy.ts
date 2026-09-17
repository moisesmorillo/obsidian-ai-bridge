import {
  MUTATION_EFFECT_CERTAINTY,
  REMOTE_BRIDGE_FAILURE,
  type RemoteBridgeFailure,
  type RemoteBridgeMutationResult,
} from "@obsidian-ai-bridge/core";
import { HTTP_METHOD, HTTP_STATUS_CODE } from "@obsidian-ai-bridge/protocol";

/** Stable adapter operation identities grouped by read or mutation effect semantics. */
export const REMOTE_BRIDGE_OPERATION = {
  read: {
    describe: "describe",
    inspectNote: "inspect-note",
    inspectRecovery: "inspect-recovery",
    listNotes: "list-notes",
    listRecovery: "list-recovery",
    readNote: "read-note",
    readRecoveryContent: "read-recovery-content",
  },
  mutation: {
    createNote: "create-note",
    purgeRecovery: "purge-recovery",
    recreateNote: "recreate-note",
    sealRecovery: "seal-recovery",
    tombstoneNote: "tombstone-note",
    updateNote: "update-note",
  },
} as const;

/** Accepted non-error response meanings consumed by operation-specific decoders. */
export const REMOTE_RESPONSE_OUTCOME = {
  missing: "missing",
  primary: "primary",
  unavailable: "unavailable",
} as const;

/** Derives closed adapter vocabularies from their authoritative constant objects. */
type ValueOf<Value> = Value[keyof Value];

/** Read-only operation identities accepted by the response classifier. */
export type RemoteReadOperation = ValueOf<typeof REMOTE_BRIDGE_OPERATION.read>;

/** Mutation operation identities accepted by the response classifier. */
export type RemoteMutationOperation = ValueOf<
  typeof REMOTE_BRIDGE_OPERATION.mutation
>;

/** Every operation represented by the remote HTTP policy. */
export type RemoteBridgeOperation =
  | RemoteReadOperation
  | RemoteMutationOperation;

/** HTTP methods that can be dispatched by the remote bridge adapter. */
export type RemoteHttpMethod = ValueOf<typeof HTTP_METHOD>;

/** Accepted response meanings before body/DTO validation establishes a domain result. */
type RemoteResponseOutcome = ValueOf<typeof REMOTE_RESPONSE_OUTCOME>;
/** Failure certainty vocabulary inherited from the core mutation contract. */
type RemoteMutationEffect = Extract<
  RemoteBridgeMutationResult<never>,
  { readonly kind: "failure" }
>["effect"];

/** Accepted response requiring operation-specific body or domain handling. */
export interface AcceptedRemoteResponse {
  readonly kind: "accepted";
  readonly outcome: RemoteResponseOutcome;
}

/** Sanitized failure returned by a read-only operation. */
export interface RemoteReadResponseFailure {
  readonly kind: "failure";
  readonly failure: RemoteBridgeFailure;
}

/** Sanitized failure and effect certainty returned by a dispatched mutation. */
export interface RemoteMutationResponseFailure {
  readonly kind: "failure";
  readonly failure: RemoteBridgeFailure;
  readonly effect: Exclude<
    RemoteMutationEffect,
    typeof MUTATION_EFFECT_CERTAINTY.notDispatched
  >;
}

/** Complete response classification returned for a read or mutation operation. */
export type RemoteResponseClassification =
  | AcceptedRemoteResponse
  | RemoteReadResponseFailure
  | RemoteMutationResponseFailure;

/** One operation's method/status semantics, with exact accepted rows taking precedence over failure fallbacks. */
interface RemoteOperationPolicy {
  readonly kind: "read" | "mutation";
  readonly method: RemoteHttpMethod;
  readonly acceptedStatuses: Readonly<
    Partial<Record<number, RemoteResponseOutcome>>
  >;
  readonly failureStatuses: Readonly<
    Partial<Record<number, RemoteBridgeFailure>>
  >;
  readonly unexpectedFailure: RemoteBridgeFailure;
}

/** Exhaustive operation table preserving read-versus-mutation certainty at each key. */
type RemoteOperationPolicyMap = Readonly<
  {
    readonly [Operation in RemoteReadOperation]: RemoteOperationPolicy & {
      readonly kind: "read";
    };
  } & {
    readonly [Operation in RemoteMutationOperation]: RemoteOperationPolicy & {
      readonly kind: "mutation";
    };
  }
>;

/** A missing required metadata/list route signals protocol incompatibility rather than absent note content. */
const READ_ROUTE_MISSING_FAILURE = {
  [HTTP_STATUS_CODE.notFound]: REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
} as const;

/** Exact conditional-write refusals shared by note and recovery mutation routes. */
const NOTE_MUTATION_FAILURES = {
  [HTTP_STATUS_CODE.preconditionFailed]:
    REMOTE_BRIDGE_FAILURE.preconditionFailed,
  [HTTP_STATUS_CODE.preconditionRequired]:
    REMOTE_BRIDGE_FAILURE.preconditionRequired,
} as const;

/** Recovery maintenance additionally treats missing snapshots and state conflicts as definite refusals. */
const RECOVERY_MUTATION_FAILURES = {
  [HTTP_STATUS_CODE.notFound]: REMOTE_BRIDGE_FAILURE.missing,
  [HTTP_STATUS_CODE.conflict]: REMOTE_BRIDGE_FAILURE.conflict,
  ...NOTE_MUTATION_FAILURES,
} as const;

/**
 * Authoritative method, accepted-status, and route-specific failure policy.
 *
 * Common authentication, throttling, and server failures are applied by the
 * classifier after these exact operation rows.
 */
const REMOTE_OPERATION_POLICY: RemoteOperationPolicyMap = {
  [REMOTE_BRIDGE_OPERATION.read.describe]: {
    kind: "read",
    method: HTTP_METHOD.get,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
    },
    failureStatuses: READ_ROUTE_MISSING_FAILURE,
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.malformedResponse,
  },
  [REMOTE_BRIDGE_OPERATION.read.inspectNote]: {
    kind: "read",
    method: HTTP_METHOD.get,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
    },
    failureStatuses: READ_ROUTE_MISSING_FAILURE,
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.malformedResponse,
  },
  [REMOTE_BRIDGE_OPERATION.read.inspectRecovery]: {
    kind: "read",
    method: HTTP_METHOD.get,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
      [HTTP_STATUS_CODE.notFound]: REMOTE_RESPONSE_OUTCOME.missing,
    },
    failureStatuses: {},
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.malformedResponse,
  },
  [REMOTE_BRIDGE_OPERATION.read.listNotes]: {
    kind: "read",
    method: HTTP_METHOD.get,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
    },
    failureStatuses: READ_ROUTE_MISSING_FAILURE,
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.malformedResponse,
  },
  [REMOTE_BRIDGE_OPERATION.read.listRecovery]: {
    kind: "read",
    method: HTTP_METHOD.get,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
    },
    failureStatuses: READ_ROUTE_MISSING_FAILURE,
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.malformedResponse,
  },
  [REMOTE_BRIDGE_OPERATION.read.readNote]: {
    kind: "read",
    method: HTTP_METHOD.get,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
      [HTTP_STATUS_CODE.notFound]: REMOTE_RESPONSE_OUTCOME.missing,
    },
    failureStatuses: {},
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.malformedResponse,
  },
  [REMOTE_BRIDGE_OPERATION.read.readRecoveryContent]: {
    kind: "read",
    method: HTTP_METHOD.get,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
      [HTTP_STATUS_CODE.notFound]: REMOTE_RESPONSE_OUTCOME.missing,
      [HTTP_STATUS_CODE.gone]: REMOTE_RESPONSE_OUTCOME.unavailable,
    },
    failureStatuses: {},
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.malformedResponse,
  },
  [REMOTE_BRIDGE_OPERATION.mutation.createNote]: {
    kind: "mutation",
    method: HTTP_METHOD.put,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.created]: REMOTE_RESPONSE_OUTCOME.primary,
    },
    failureStatuses: NOTE_MUTATION_FAILURES,
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
  },
  [REMOTE_BRIDGE_OPERATION.mutation.recreateNote]: {
    kind: "mutation",
    method: HTTP_METHOD.put,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
    },
    failureStatuses: NOTE_MUTATION_FAILURES,
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
  },
  [REMOTE_BRIDGE_OPERATION.mutation.purgeRecovery]: {
    kind: "mutation",
    method: HTTP_METHOD.post,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
    },
    failureStatuses: RECOVERY_MUTATION_FAILURES,
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
  },
  [REMOTE_BRIDGE_OPERATION.mutation.sealRecovery]: {
    kind: "mutation",
    method: HTTP_METHOD.post,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
    },
    failureStatuses: RECOVERY_MUTATION_FAILURES,
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
  },
  [REMOTE_BRIDGE_OPERATION.mutation.tombstoneNote]: {
    kind: "mutation",
    method: HTTP_METHOD.delete,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
    },
    failureStatuses: NOTE_MUTATION_FAILURES,
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
  },
  [REMOTE_BRIDGE_OPERATION.mutation.updateNote]: {
    kind: "mutation",
    method: HTTP_METHOD.put,
    acceptedStatuses: {
      [HTTP_STATUS_CODE.ok]: REMOTE_RESPONSE_OUTCOME.primary,
    },
    failureStatuses: NOTE_MUTATION_FAILURES,
    unexpectedFailure: REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
  },
};

/** Post-dispatch certainty policy: only explicit contract refusals prove no effect; transport/protocol uncertainty stays unknown. */
const DISPATCHED_FAILURE_EFFECT: Readonly<
  Record<
    RemoteBridgeFailure,
    Exclude<
      RemoteMutationEffect,
      typeof MUTATION_EFFECT_CERTAINTY.notDispatched
    >
  >
> = {
  [REMOTE_BRIDGE_FAILURE.unauthenticated]:
    MUTATION_EFFECT_CERTAINTY.definitelyRefused,
  [REMOTE_BRIDGE_FAILURE.forbidden]:
    MUTATION_EFFECT_CERTAINTY.definitelyRefused,
  [REMOTE_BRIDGE_FAILURE.preconditionFailed]:
    MUTATION_EFFECT_CERTAINTY.definitelyRefused,
  [REMOTE_BRIDGE_FAILURE.preconditionRequired]:
    MUTATION_EFFECT_CERTAINTY.definitelyRefused,
  [REMOTE_BRIDGE_FAILURE.missing]: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
  [REMOTE_BRIDGE_FAILURE.conflict]: MUTATION_EFFECT_CERTAINTY.definitelyRefused,
  [REMOTE_BRIDGE_FAILURE.rateLimited]: MUTATION_EFFECT_CERTAINTY.unknown,
  [REMOTE_BRIDGE_FAILURE.serverFailed]: MUTATION_EFFECT_CERTAINTY.unknown,
  [REMOTE_BRIDGE_FAILURE.incompatibleProtocol]:
    MUTATION_EFFECT_CERTAINTY.unknown,
  [REMOTE_BRIDGE_FAILURE.malformedResponse]: MUTATION_EFFECT_CERTAINTY.unknown,
  [REMOTE_BRIDGE_FAILURE.unsupportedRuntime]: MUTATION_EFFECT_CERTAINTY.unknown,
  [REMOTE_BRIDGE_FAILURE.networkUnavailable]: MUTATION_EFFECT_CERTAINTY.unknown,
  [REMOTE_BRIDGE_FAILURE.timedOut]: MUTATION_EFFECT_CERTAINTY.unknown,
  [REMOTE_BRIDGE_FAILURE.cancelled]: MUTATION_EFFECT_CERTAINTY.unknown,
  [REMOTE_BRIDGE_FAILURE.admissionDenied]: MUTATION_EFFECT_CERTAINTY.unknown,
  [REMOTE_BRIDGE_FAILURE.missingSecret]: MUTATION_EFFECT_CERTAINTY.unknown,
  [REMOTE_BRIDGE_FAILURE.invalidConfiguration]:
    MUTATION_EFFECT_CERTAINTY.unknown,
};

/**
 * Returns the HTTP method owned by one operation row.
 *
 * @param operation - Canonical remote operation identity.
 * @returns Exact method that the adapter must dispatch.
 */
export function remoteOperationMethod(
  operation: RemoteBridgeOperation,
): RemoteHttpMethod {
  return REMOTE_OPERATION_POLICY[operation].method;
}

/**
 * Classifies one response through the operation's complete status/effect policy.
 *
 * @param operation - Canonical remote operation identity.
 * @param status - HTTP response status returned after dispatch.
 * @returns Accepted domain outcome or sanitized read/mutation failure.
 */
export function classifyRemoteResponse(
  operation: RemoteReadOperation,
  status: number,
): AcceptedRemoteResponse | RemoteReadResponseFailure;
/** Classifies a dispatched mutation response with conservative effect certainty on failure. */
export function classifyRemoteResponse(
  operation: RemoteMutationOperation,
  status: number,
): AcceptedRemoteResponse | RemoteMutationResponseFailure;
/** Classifies a dynamically selected operation while retaining its read/mutation result union. */
export function classifyRemoteResponse(
  operation: RemoteBridgeOperation,
  status: number,
): RemoteResponseClassification;
/**
 * Applies exact accepted rows before failure classification; accepted status still requires operation-specific body validation.
 *
 * @returns The accepted row or sanitized response failure.
 */
export function classifyRemoteResponse(
  operation: RemoteBridgeOperation,
  status: number,
): RemoteResponseClassification {
  const policy = REMOTE_OPERATION_POLICY[operation];
  const acceptedOutcome = policy.acceptedStatuses[status];
  if (acceptedOutcome !== undefined) {
    return { kind: "accepted", outcome: acceptedOutcome };
  }

  const failure = responseFailure(policy, status);
  if (policy.kind === "read") {
    return { kind: "failure", failure };
  }
  return createDispatchedMutationFailure(failure);
}

/**
 * Applies the exhaustive failure-to-effect policy after a mutation was dispatched.
 *
 * @param failure - Sanitized response, body, or settlement failure.
 * @returns Mutation failure with conservative post-dispatch effect certainty.
 */
export function createDispatchedMutationFailure(
  failure: RemoteBridgeFailure,
): RemoteMutationResponseFailure {
  return {
    kind: "failure",
    failure,
    effect: DISPATCHED_FAILURE_EFFECT[failure],
  };
}

/**
 * Resolves route-specific, common, range, and fallback response failures in order.
 *
 * @param policy - Exact operation policy row.
 * @param status - Non-accepted response status.
 * @returns Sanitized failure for the response.
 */
function responseFailure(
  policy: RemoteOperationPolicy,
  status: number,
): RemoteBridgeFailure {
  const routeFailure = policy.failureStatuses[status];
  if (routeFailure !== undefined) return routeFailure;
  if (status === HTTP_STATUS_CODE.unauthorized) {
    return REMOTE_BRIDGE_FAILURE.unauthenticated;
  }
  if (status === HTTP_STATUS_CODE.forbidden) {
    return REMOTE_BRIDGE_FAILURE.forbidden;
  }
  if (status === HTTP_STATUS_CODE.rateLimited) {
    return REMOTE_BRIDGE_FAILURE.rateLimited;
  }
  if (status >= HTTP_STATUS_CODE.internalServerError) {
    return REMOTE_BRIDGE_FAILURE.serverFailed;
  }
  return policy.unexpectedFailure;
}
