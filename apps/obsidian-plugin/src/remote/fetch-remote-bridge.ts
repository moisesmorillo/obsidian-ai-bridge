import {
  type ApplicationRevision,
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  type ConditionalMutationRequest,
  CURRENT_NOTE_STATE_KIND,
  type CurrentNoteState,
  createMirrorAssociationId,
  createMirrorWriterId,
  encodeNotePath,
  formatApplicationEtag,
  MAX_NOTE_SIZE_BYTES,
  type MirrorAssociationId,
  type MirrorOperationId,
  type MirrorWriterId,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  type MutationAcknowledgement,
  type NotePage,
  type NotePath,
  parseApplicationEtag,
  RECOVERY_SNAPSHOT_STATE_KIND,
  REMOTE_BRIDGE_FAILURE,
  type RecoveryPage,
  type RecoveryPurgeRequest,
  type RecoverySealRequest,
  type RecoverySnapshotId,
  type RecoverySnapshotState,
  type RemoteBridge,
  type RemoteBridgeDescription,
  type RemoteBridgeMutationResult,
  type RemoteBridgeResult,
  type RemoteNoteContent,
  type RemoteRecoveryContent,
} from "@obsidian-ai-bridge/core";
import {
  BRIDGE_NOTE_FORMAT,
  currentNoteStateSchema,
  MIRROR_API_V2_QUERY_PARAMETER,
  MIRROR_API_V2_ROUTE,
  MIRROR_API_V2_SEGMENT,
  MIRROR_HTTP_HEADER,
  MIRROR_MEDIA_TYPE,
  mirrorDescriptionSchema,
  mutationAcknowledgementSchema,
  notePageSchema,
  recoveryPageSchema,
  recoverySnapshotStateSchema,
  tombstoneMutationResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import {
  MAX_REMOTE_CONTENT_RESPONSE_BYTES,
  MAX_REMOTE_METADATA_RESPONSE_BYTES,
  REMOTE_NOTE_REQUEST_CONTENT_TYPE,
} from "@obsidian-plugin/remote/fetch-remote-bridge.constants";
import type { FetchRemoteBridgeDependencies } from "@obsidian-plugin/remote/fetch-remote-bridge.types";
import { FetchRequestDispatcher } from "@obsidian-plugin/remote/fetch-request-dispatcher";
import {
  acknowledgementMatchesRequest,
  mapCurrentStateDto,
  mapMutationAcknowledgementDto,
  mapRecoveryStateDto,
} from "@obsidian-plugin/remote/remote-response-mappers";
import {
  classifyRemoteResponse,
  createDispatchedMutationFailure,
  REMOTE_BRIDGE_OPERATION,
  REMOTE_RESPONSE_OUTCOME,
  type RemoteMutationOperation,
  type RemoteReadOperation,
  remoteOperationMethod,
} from "@obsidian-plugin/remote/remote-response-policy";
import type { z } from "zod";

/** Sanitized read/decoding refusal without raw transport exceptions or mutation certainty. */
type RemoteBridgeFailureResult = {
  readonly kind: "failure";
  readonly failure: (typeof REMOTE_BRIDGE_FAILURE)[keyof typeof REMOTE_BRIDGE_FAILURE];
};

/** Adapter route actions for conditional recovery maintenance, not content restoration. */
type RecoveryMutationAction =
  | typeof MIRROR_API_V2_SEGMENT.seal
  | typeof MIRROR_API_V2_SEGMENT.purge;

/**
 * Typed, bounded standards-Fetch implementation of the core RemoteBridge port.
 *
 * The adapter performs exactly one attempt per invocation. It owns operation
 * request construction, protocol decoding, and DTO/domain validation. Fetch
 * admission, authentication, deadline, and settlement lifetimes are delegated to
 * the transport dispatcher; status/effect decisions are delegated to one policy.
 */
export class FetchRemoteBridge implements RemoteBridge {
  private readonly dispatcher: FetchRequestDispatcher;
  private readonly crypto: Crypto | null | undefined;

  /** @param dependencies - Validated configuration and explicit platform seams. */
  constructor(dependencies: FetchRemoteBridgeDependencies) {
    this.dispatcher = new FetchRequestDispatcher(dependencies);
    this.crypto =
      dependencies.crypto === undefined
        ? globalThis.crypto
        : dependencies.crypto;
  }

  /**
   * Reads and validates server designation/capabilities; does not activate this device.
   *
   * @returns Validated server information or a sanitized read failure.
   */
  async describe(): Promise<RemoteBridgeResult<RemoteBridgeDescription>> {
    return this.readJson(
      REMOTE_BRIDGE_OPERATION.read.describe,
      MIRROR_API_V2_ROUTE.mirror,
      mirrorDescriptionSchema,
      (dto) => {
        const associationId = createMirrorAssociationId(dto.associationId);
        const writerId = createMirrorWriterId(dto.writerId);
        if (associationId === undefined || writerId === undefined)
          return undefined;
        return {
          protocol: dto.protocol,
          associationId,
          writerId,
          maxNoteSizeBytes: dto.maxNoteSizeBytes,
          maxPageSize: dto.maxPageSize,
          recoveryRetentionSeconds: dto.recoveryRetentionSeconds,
        };
      },
    );
  }

  /**
   * Reads one bounded reporting page with an opaque cursor; absence from a page grants no delete authority.
   *
   * @param cursor - Opaque continuation token, omitted for the first page.
   * @returns One decoded note page or a sanitized failure.
   */
  async listNotes(cursor?: string): Promise<RemoteBridgeResult<NotePage>> {
    return this.readJson(
      REMOTE_BRIDGE_OPERATION.read.listNotes,
      withCursor(MIRROR_API_V2_ROUTE.notes, cursor),
      notePageSchema,
      (dto) => ({ notes: dto.notes, nextCursor: dto.nextCursor }),
    );
  }

  /**
   * Reads bounded strict UTF-8 and distinguishes missing, legacy and revisioned content without adopting a baseline.
   *
   * @returns Decoded content state or a sanitized read failure.
   */
  async readNote(
    path: NotePath,
  ): Promise<RemoteBridgeResult<RemoteNoteContent>> {
    if (!this.isRuntimeSupported()) {
      return failure(REMOTE_BRIDGE_FAILURE.unsupportedRuntime);
    }
    const operation = REMOTE_BRIDGE_OPERATION.read.readNote;
    return this.dispatcher.executeRead<RemoteNoteContent>(
      { method: remoteOperationMethod(operation), path: notePathRoute(path) },
      async (response, signal) => {
        const classification = classifyRemoteResponse(
          operation,
          response.status,
        );
        if (classification.kind === "failure") {
          return failure(classification.failure);
        }
        if (classification.outcome === REMOTE_RESPONSE_OUTCOME.missing) {
          return success({ kind: "missing" });
        }
        if (classification.outcome !== REMOTE_RESPONSE_OUTCOME.primary) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        if (!hasMediaType(response, MIRROR_MEDIA_TYPE.markdown)) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        const content = await this.dispatcher.readText(
          response,
          MAX_REMOTE_CONTENT_RESPONSE_BYTES,
          signal,
        );
        if (content.kind === "failure") return content;
        const format = response.headers.get(MIRROR_HTTP_HEADER.noteFormat);
        if (
          format === BRIDGE_NOTE_FORMAT.legacy &&
          response.headers.get(MIRROR_HTTP_HEADER.etag) === null
        ) {
          return success({ kind: "legacy", content: content.value });
        }
        const revision = responseRevision(response);
        if (format !== BRIDGE_NOTE_FORMAT.current || revision === undefined) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        return success({ kind: "live", revision, content: content.value });
      },
    );
  }

  /**
   * Reads metadata and requires exact path plus application-ETag agreement with the decoded state.
   *
   * @returns Validated metadata or a sanitized read failure.
   */
  async inspectNote(
    path: NotePath,
  ): Promise<RemoteBridgeResult<CurrentNoteState>> {
    if (!this.isRuntimeSupported()) {
      return failure(REMOTE_BRIDGE_FAILURE.unsupportedRuntime);
    }
    return this.readJson(
      REMOTE_BRIDGE_OPERATION.read.inspectNote,
      `${notePathRoute(path)}/${MIRROR_API_V2_SEGMENT.state}`,
      currentNoteStateSchema,
      (dto, response) => {
        const state = mapCurrentStateDto(dto);
        if (
          state === undefined ||
          state.path !== path ||
          !stateEtagMatches(
            state,
            response.headers.get(MIRROR_HTTP_HEADER.etag),
          )
        ) {
          return undefined;
        }
        return state;
      },
    );
  }

  /**
   * Sends one conditional mutation and confirms only a path/receipt/hash/ETag match; malformed ACKs retain unknown effect.
   *
   * @returns Confirmed mutation evidence, definite refusal, or unknown effect.
   */
  async mutateNote(
    request: ConditionalMutationRequest,
  ): Promise<RemoteBridgeMutationResult<MutationAcknowledgement>> {
    if (!this.isRuntimeSupported()) {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.unsupportedRuntime,
        effect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      };
    }
    const operation = noteMutationOperation(request.action);
    const contentHash = await this.requestContentHash(request);
    if (contentHash.kind === "failure") return contentHash;
    const condition =
      request.precondition.kind ===
      CONDITIONAL_MUTATION_PRECONDITION_KIND.absent
        ? { [MIRROR_HTTP_HEADER.ifNoneMatch]: "*" }
        : {
            [MIRROR_HTTP_HEADER.ifMatch]: formatApplicationEtag(
              request.precondition.revision,
            ),
          };
    const headers = {
      ...identityHeaders(
        request.associationId,
        request.writerId,
        request.operationId,
      ),
      ...condition,
      ...(request.action === MUTATION_ACTION.tombstone
        ? {}
        : {
            [MIRROR_HTTP_HEADER.contentType]: REMOTE_NOTE_REQUEST_CONTENT_TYPE,
          }),
    };
    return this.dispatcher.executeMutation<MutationAcknowledgement>(
      {
        method: remoteOperationMethod(operation),
        path: notePathRoute(request.path),
        headers,
        effectOperationId: request.operationId,
        ...(request.action === MUTATION_ACTION.tombstone
          ? {}
          : { body: request.content }),
      },
      async (response, signal) => {
        const classification = classifyRemoteResponse(
          operation,
          response.status,
        );
        if (classification.kind === "failure") return classification;
        if (classification.outcome !== REMOTE_RESPONSE_OUTCOME.primary) {
          return createDispatchedMutationFailure(
            REMOTE_BRIDGE_FAILURE.malformedResponse,
          );
        }
        if (!hasMediaType(response, MIRROR_MEDIA_TYPE.json)) {
          return createDispatchedMutationFailure(
            REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
          );
        }
        let acknowledgement: MutationAcknowledgement | undefined;
        if (request.action === MUTATION_ACTION.tombstone) {
          const decoded = await this.readJsonBody(
            response,
            tombstoneMutationResponseSchema,
            signal,
          );
          if (decoded.kind === "failure") {
            return createDispatchedMutationFailure(decoded.failure);
          }
          acknowledgement = mapMutationAcknowledgementDto(
            decoded.value.acknowledgement,
          );
        } else {
          const decoded = await this.readJsonBody(
            response,
            mutationAcknowledgementSchema,
            signal,
          );
          if (decoded.kind === "failure") {
            return createDispatchedMutationFailure(decoded.failure);
          }
          acknowledgement = mapMutationAcknowledgementDto(decoded.value);
        }
        if (
          acknowledgement === undefined ||
          acknowledgement.path !== request.path ||
          !acknowledgementMatchesRequest(
            acknowledgement,
            request,
            contentHash.value,
          ) ||
          formatApplicationEtag(acknowledgement.revision) !==
            response.headers.get(MIRROR_HTTP_HEADER.etag)
        ) {
          return createDispatchedMutationFailure(
            REMOTE_BRIDGE_FAILURE.malformedResponse,
          );
        }
        return { kind: "confirmed", confirmed: acknowledgement };
      },
    );
  }

  /**
   * Decodes one bounded recovery metadata page, refusing the whole response if any entry fails domain conversion.
   *
   * @param cursor - Opaque continuation token, omitted for the first page.
   * @returns One validated recovery page or a sanitized failure.
   */
  async listRecovery(
    cursor?: string,
  ): Promise<RemoteBridgeResult<RecoveryPage>> {
    return this.readJson(
      REMOTE_BRIDGE_OPERATION.read.listRecovery,
      withCursor(MIRROR_API_V2_ROUTE.recovery, cursor),
      recoveryPageSchema,
      (dto) => {
        const recoveries: RecoverySnapshotState[] = [];
        for (const recovery of dto.recoveries) {
          const mapped = mapRecoveryStateDto(recovery);
          if (mapped === undefined) return undefined;
          recoveries.push(mapped);
        }
        return { recoveries, nextCursor: dto.nextCursor };
      },
    );
  }

  /**
   * Reads exact recovery metadata with ID/ETag validation; a missing snapshot is successful null, not a transport failure.
   *
   * @returns Validated snapshot metadata, null for missing, or a sanitized failure.
   */
  async inspectRecovery(
    id: RecoverySnapshotId,
  ): Promise<RemoteBridgeResult<RecoverySnapshotState | null>> {
    const operation = REMOTE_BRIDGE_OPERATION.read.inspectRecovery;
    return this.dispatcher.executeRead(
      { method: remoteOperationMethod(operation), path: recoveryRoute(id) },
      async (response, signal) => {
        const classification = classifyRemoteResponse(
          operation,
          response.status,
        );
        if (classification.kind === "failure") {
          return failure(classification.failure);
        }
        if (classification.outcome === REMOTE_RESPONSE_OUTCOME.missing) {
          return success(null);
        }
        if (
          classification.outcome !== REMOTE_RESPONSE_OUTCOME.primary ||
          !hasMediaType(response, MIRROR_MEDIA_TYPE.json)
        ) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        const decoded = await this.readJsonBody(
          response,
          recoverySnapshotStateSchema,
          signal,
        );
        if (decoded.kind === "failure") return decoded;
        const state = mapRecoveryStateDto(decoded.value);
        if (
          state === undefined ||
          state.id !== id ||
          formatApplicationEtag(state.revision) !==
            response.headers.get(MIRROR_HTTP_HEADER.etag)
        ) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        return success(state);
      },
    );
  }

  /**
   * Reads bounded recoverable bytes or missing/unavailable status; never restores locally or changes retention.
   *
   * @returns Recoverable content, an explicit non-content state, or a sanitized failure.
   */
  async readRecoveryContent(
    id: RecoverySnapshotId,
  ): Promise<RemoteBridgeResult<RemoteRecoveryContent>> {
    const operation = REMOTE_BRIDGE_OPERATION.read.readRecoveryContent;
    return this.dispatcher.executeRead<RemoteRecoveryContent>(
      {
        method: remoteOperationMethod(operation),
        path: `${recoveryRoute(id)}/${MIRROR_API_V2_SEGMENT.content}`,
      },
      async (response, signal) => {
        const classification = classifyRemoteResponse(
          operation,
          response.status,
        );
        if (classification.kind === "failure") {
          return failure(classification.failure);
        }
        if (classification.outcome === REMOTE_RESPONSE_OUTCOME.missing) {
          return success({ kind: "missing" });
        }
        if (classification.outcome === REMOTE_RESPONSE_OUTCOME.unavailable) {
          return success({ kind: "unavailable" });
        }
        if (
          classification.outcome !== REMOTE_RESPONSE_OUTCOME.primary ||
          !hasMediaType(response, MIRROR_MEDIA_TYPE.markdown)
        ) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        const content = await this.dispatcher.readText(
          response,
          MAX_REMOTE_CONTENT_RESPONSE_BYTES,
          signal,
        );
        if (content.kind === "failure") return content;
        if (
          response.headers.get(MIRROR_HTTP_HEADER.noteFormat) !==
            BRIDGE_NOTE_FORMAT.current ||
          responseRevision(response) === undefined
        ) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        return success({ kind: "recoverable", content: content.value });
      },
    );
  }

  /**
   * Makes one exact-revision recovery seal request through the shared maintenance decoder.
   *
   * @returns Confirmed seal evidence, definite refusal, or unknown effect.
   */
  async sealRecovery(
    request: RecoverySealRequest,
  ): Promise<RemoteBridgeMutationResult<RecoverySnapshotState>> {
    return this.mutateRecovery(MIRROR_API_V2_SEGMENT.seal, request);
  }

  /**
   * Makes one exact-revision purge request; server policy owns expiry and retained-marker creation.
   *
   * @returns Confirmed purge evidence, definite refusal, or unknown effect.
   */
  async purgeRecovery(
    request: RecoveryPurgeRequest,
  ): Promise<RemoteBridgeMutationResult<RecoverySnapshotState>> {
    return this.mutateRecovery(MIRROR_API_V2_SEGMENT.purge, request);
  }

  /**
   * Confirms maintenance only from the expected terminal kind, identity and fresh revision with matching ETag.
   *
   * @returns Confirmed terminal metadata, definite refusal, or unknown effect.
   */
  private async mutateRecovery(
    action: RecoveryMutationAction,
    request: RecoverySealRequest | RecoveryPurgeRequest,
  ): Promise<RemoteBridgeMutationResult<RecoverySnapshotState>> {
    const operation = recoveryMutationOperation(action);
    return this.dispatcher.executeMutation<RecoverySnapshotState>(
      {
        method: remoteOperationMethod(operation),
        path: `${recoveryRoute(request.id)}/${action}`,
        effectOperationId: request.operationId,
        headers: {
          ...identityHeaders(
            request.associationId,
            request.writerId,
            request.operationId,
          ),
          [MIRROR_HTTP_HEADER.ifMatch]: formatApplicationEtag(
            request.expectedRevision,
          ),
        },
      },
      async (response, signal) => {
        const classification = classifyRemoteResponse(
          operation,
          response.status,
        );
        if (classification.kind === "failure") return classification;
        if (classification.outcome !== REMOTE_RESPONSE_OUTCOME.primary) {
          return createDispatchedMutationFailure(
            REMOTE_BRIDGE_FAILURE.malformedResponse,
          );
        }
        if (!hasMediaType(response, MIRROR_MEDIA_TYPE.json)) {
          return createDispatchedMutationFailure(
            REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
          );
        }
        const decoded = await this.readJsonBody(
          response,
          recoverySnapshotStateSchema,
          signal,
        );
        if (decoded.kind === "failure") {
          return createDispatchedMutationFailure(decoded.failure);
        }
        const state = mapRecoveryStateDto(decoded.value);
        const expectedKind =
          action === MIRROR_API_V2_SEGMENT.seal
            ? RECOVERY_SNAPSHOT_STATE_KIND.sealed
            : RECOVERY_SNAPSHOT_STATE_KIND.purged;
        if (
          state === undefined ||
          state.kind !== expectedKind ||
          state.id !== request.id ||
          state.associationId !== request.associationId ||
          state.revision === request.expectedRevision ||
          formatApplicationEtag(state.revision) !==
            response.headers.get(MIRROR_HTTP_HEADER.etag)
        ) {
          return createDispatchedMutationFailure(
            REMOTE_BRIDGE_FAILURE.malformedResponse,
          );
        }
        return { kind: "confirmed", confirmed: state };
      },
    );
  }

  /**
   * Composes read status/media validation, bounded JSON decoding and domain mapping; no retry or effect authority.
   *
   * @returns The mapped domain value or a sanitized read failure.
   */
  private async readJson<Dto, Value>(
    operation: RemoteReadOperation,
    path: string,
    schema: z.ZodType<Dto>,
    map: (dto: Dto, response: Response) => Value | undefined,
  ): Promise<RemoteBridgeResult<Value>> {
    return this.dispatcher.executeRead(
      { method: remoteOperationMethod(operation), path },
      async (response, signal) => {
        const classification = classifyRemoteResponse(
          operation,
          response.status,
        );
        if (classification.kind === "failure") {
          return failure(classification.failure);
        }
        if (
          classification.outcome !== REMOTE_RESPONSE_OUTCOME.primary ||
          !hasMediaType(response, MIRROR_MEDIA_TYPE.json)
        ) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        const decoded = await this.readJsonBody(response, schema, signal);
        if (decoded.kind === "failure") return decoded;
        const value = map(decoded.value, response);
        return value === undefined
          ? failure(REMOTE_BRIDGE_FAILURE.malformedResponse)
          : success(value);
      },
    );
  }

  /**
   * Bounds metadata bytes and validates untrusted JSON with the supplied contract before any DTO escapes.
   *
   * @returns A schema-validated DTO or a bounded decoding failure.
   */
  private async readJsonBody<Dto>(
    response: Response,
    schema: z.ZodType<Dto>,
    signal: AbortSignal,
  ): Promise<RemoteBridgeResult<Dto>> {
    const text = await this.dispatcher.readText(
      response,
      MAX_REMOTE_METADATA_RESPONSE_BYTES,
      signal,
    );
    if (text.kind === "failure") return text;
    let value: unknown;
    try {
      value = JSON.parse(text.value);
    } catch {
      return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
    }
    const parsed = schema.safeParse(value);
    return parsed.success
      ? success(parsed.data)
      : failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
  }

  /** @returns Whether every capability required by the complete adapter exists. */
  private isRuntimeSupported(): boolean {
    return this.dispatcher.isRuntimeSupported();
  }

  /**
   * Size-checks and hashes outgoing UTF-8 before dispatch; tombstones have no body, and provider failures are undispatched.
   *
   * @returns A successful hash (empty string for bodyless tombstones), or an undispatched refusal.
   */
  private async requestContentHash(
    request: ConditionalMutationRequest,
  ): Promise<
    | { readonly kind: "success"; readonly value: string }
    | {
        readonly kind: "failure";
        readonly failure: (typeof REMOTE_BRIDGE_FAILURE)[keyof typeof REMOTE_BRIDGE_FAILURE];
        readonly effect: typeof MUTATION_EFFECT_CERTAINTY.notDispatched;
      }
  > {
    if (request.action === MUTATION_ACTION.tombstone)
      return { kind: "success", value: "" };
    if (this.crypto === undefined || this.crypto === null) {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.unsupportedRuntime,
        effect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      };
    }
    const bytes = new TextEncoder().encode(request.content);
    if (bytes.byteLength > MAX_NOTE_SIZE_BYTES) {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
        effect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      };
    }
    try {
      const digest = await this.crypto.subtle.digest("SHA-256", bytes);
      return { kind: "success", value: toHex(new Uint8Array(digest)) };
    } catch {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.unsupportedRuntime,
        effect: MUTATION_EFFECT_CERTAINTY.notDispatched,
      };
    }
  }
}

/**
 * Resolves one note mutation action to its authoritative transport operation row.
 *
 * @param action - Core mutation action selected before transport dispatch.
 * @returns Canonical note operation used for method/status/effect classification.
 */
function noteMutationOperation(
  action: ConditionalMutationRequest["action"],
): RemoteMutationOperation {
  switch (action) {
    case MUTATION_ACTION.create:
      return REMOTE_BRIDGE_OPERATION.mutation.createNote;
    case MUTATION_ACTION.update:
      return REMOTE_BRIDGE_OPERATION.mutation.updateNote;
    case MUTATION_ACTION.recreate:
      return REMOTE_BRIDGE_OPERATION.mutation.recreateNote;
    case MUTATION_ACTION.tombstone:
      return REMOTE_BRIDGE_OPERATION.mutation.tombstoneNote;
  }
}

/**
 * Resolves one recovery route action to its authoritative transport operation row.
 *
 * @param action - Public recovery child-route segment.
 * @returns Canonical recovery operation used for method/status/effect classification.
 */
function recoveryMutationOperation(
  action: RecoveryMutationAction,
): RemoteMutationOperation {
  switch (action) {
    case MIRROR_API_V2_SEGMENT.seal:
      return REMOTE_BRIDGE_OPERATION.mutation.sealRecovery;
    case MIRROR_API_V2_SEGMENT.purge:
      return REMOTE_BRIDGE_OPERATION.mutation.purgeRecovery;
  }
}

/**
 * Escapes an opaque page cursor without interpreting or normalizing its server-owned value.
 *
 * @param path - Protocol route before query parameters.
 * @param cursor - Opaque server continuation token, or undefined for the first page.
 * @returns The route with an encoded cursor when supplied.
 */
function withCursor(path: string, cursor: string | undefined): string {
  if (cursor === undefined) return path;
  return `${path}?${MIRROR_API_V2_QUERY_PARAMETER.cursor}=${encodeURIComponent(cursor)}`;
}

/**
 * Addresses a literal note through canonical base64url, never hierarchical URL path interpretation.
 *
 * @returns The canonical encoded note route.
 */
function notePathRoute(path: NotePath): string {
  return `${MIRROR_API_V2_ROUTE.notes}/${encodeNotePath(path)}`;
}

/**
 * Addresses recovery metadata by its already-validated operation UUID.
 *
 * @returns The recovery metadata route for the validated ID.
 */
function recoveryRoute(id: RecoverySnapshotId): string {
  return `${MIRROR_API_V2_ROUTE.recovery}/${id}`;
}

/**
 * Maps non-secret cooperating-writer and operation IDs to protocol headers; bearer authentication is dispatcher-owned.
 *
 * @returns Protocol identity headers, without bearer credentials.
 */
function identityHeaders(
  associationId: MirrorAssociationId,
  writerId: MirrorWriterId,
  operationId: MirrorOperationId,
): Record<string, string> {
  return {
    [MIRROR_HTTP_HEADER.associationId]: associationId,
    [MIRROR_HTTP_HEADER.writerId]: writerId,
    [MIRROR_HTTP_HEADER.operationId]: operationId,
  };
}

/**
 * Compares the response's base media type case-insensitively while ignoring optional parameters.
 *
 * @returns Whether the base media type matches the required type.
 */
function hasMediaType(response: Response, expected: string): boolean {
  const value = response.headers.get(MIRROR_HTTP_HEADER.contentType);
  if (value === null) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

/**
 * Accepts only a canonical application ETag as revision evidence, never a raw storage validator.
 *
 * @returns The validated application revision, or undefined.
 */
function responseRevision(response: Response): ApplicationRevision | undefined {
  const etag = response.headers.get(MIRROR_HTTP_HEADER.etag);
  return etag === null ? undefined : parseApplicationEtag(etag);
}

/**
 * Requires exact ETags for revisioned states and no ETag for absent/legacy observations.
 *
 * @returns Whether the validator agrees with the remote state variant.
 */
function stateEtagMatches(
  state: CurrentNoteState,
  etag: string | null,
): boolean {
  if (
    state.kind === CURRENT_NOTE_STATE_KIND.live ||
    state.kind === CURRENT_NOTE_STATE_KIND.tombstone
  ) {
    return formatApplicationEtag(state.revision) === etag;
  }
  return etag === null;
}

/**
 * Wraps a decoded read value without implying any mutation was confirmed.
 *
 * @returns A successful read result carrying the decoded value.
 */
function success<Value>(value: Value): RemoteBridgeResult<Value> {
  return { kind: "success", value };
}

/**
 * Creates a content-free read refusal from the closed remote failure vocabulary.
 *
 * @param failureKind - Sanitized remote failure category.
 * @returns A typed read failure.
 */
function failure(
  failureKind: (typeof REMOTE_BRIDGE_FAILURE)[keyof typeof REMOTE_BRIDGE_FAILURE],
): RemoteBridgeFailureResult {
  return { kind: "failure", failure: failureKind };
}

/**
 * Encodes digest bytes as lowercase, zero-padded hexadecimal for request/ACK hash comparison.
 *
 * @returns Canonical lowercase hexadecimal text.
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
