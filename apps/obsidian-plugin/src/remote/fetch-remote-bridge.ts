import {
  type ApplicationRevision,
  type ConditionalMutationRequest,
  type CurrentNoteState,
  createApplicationRevision,
  createContentSha256,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  formatApplicationEtag,
  MAX_NOTE_SIZE_BYTES,
  type MirrorAssociationId,
  type MirrorOperationId,
  type MirrorWriterId,
  MUTATION_ACTION,
  type MutationAcknowledgement,
  type NotePage,
  type NotePath,
  normalizeNotePath,
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
  type RemoteRequestAdmission,
} from "@obsidian-ai-bridge/core";
import {
  BRIDGE_NOTE_FORMAT,
  currentNoteStateSchema,
  mirrorDescriptionSchema,
  mutationAcknowledgementSchema,
  notePageSchema,
  recoveryPageSchema,
  recoverySnapshotStateSchema,
  tombstoneMutationResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import type { ObsidianSecretStorageHost } from "@obsidian-plugin/configuration/obsidian-secret-store";
import {
  decodeStrictUtf8,
  readBoundedResponseBytes,
} from "@obsidian-plugin/remote/bounded-response-reader";
import {
  MAX_REMOTE_CONTENT_RESPONSE_BYTES,
  MAX_REMOTE_METADATA_RESPONSE_BYTES,
  REMOTE_API_V2_PATH,
  REMOTE_FETCH_OPTIONS,
  REMOTE_NOTE_REQUEST_CONTENT_TYPE,
  REMOTE_REQUEST_DEADLINE_MILLISECONDS,
  REMOTE_RESPONSE_MEDIA_TYPE,
} from "@obsidian-plugin/remote/fetch-remote-bridge.constants";
import type { z } from "zod";

/** Standards Fetch seam retained only at the plugin transport boundary. */
export type RemoteFetch = (input: URL, init: RequestInit) => Promise<Response>;

/** Construction dependencies for the v2 Fetch RemoteBridge adapter. */
export interface FetchRemoteBridgeDependencies {
  /** Slice 3 validated canonical origin; this adapter never reparses endpoint policy. */
  readonly origin: string;
  /** Native SecretStorage host; bearer text is read immediately before Fetch. */
  readonly secretStorage: ObsidianSecretStorageHost;
  /** Validated native-secret reference, never a plaintext bearer. */
  readonly secretReference: string;
  /** Coordinator-owned global request admission capability. */
  readonly admission: RemoteRequestAdmission;
  /** Injectable standards Fetch seam for deterministic transport tests. */
  readonly fetch?: RemoteFetch | null;
  /** Injectable Web Crypto implementation for exact content-receipt validation. */
  readonly crypto?: Crypto | null;
  /** Inclusive full-operation deadline, including response-body streaming. */
  readonly deadlineMilliseconds?: number;
}

type RemoteBridgeFailureResult = {
  readonly kind: "failure";
  readonly failure: (typeof REMOTE_BRIDGE_FAILURE)[keyof typeof REMOTE_BRIDGE_FAILURE];
};

type DispatchResult =
  | {
      readonly kind: "response";
      readonly response: Response;
      readonly signal: AbortSignal;
      readonly release: () => void;
    }
  | {
      readonly kind: "failure";
      readonly failure: (typeof REMOTE_BRIDGE_FAILURE)[keyof typeof REMOTE_BRIDGE_FAILURE];
      readonly dispatched: boolean;
    };

/**
 * Typed, bounded standards-Fetch implementation of the core RemoteBridge port.
 *
 * The adapter performs exactly one attempt per invocation. It contains URLs,
 * headers, secrets, status codes, streams, schema DTOs, and browser APIs so none
 * cross into core application policy.
 */
export class FetchRemoteBridge implements RemoteBridge {
  private readonly fetch: RemoteFetch | null | undefined;
  private readonly crypto: Crypto | null | undefined;
  private readonly deadlineMilliseconds: number;

  /** @param dependencies - Validated configuration and explicit platform seams. */
  constructor(private readonly dependencies: FetchRemoteBridgeDependencies) {
    this.fetch =
      dependencies.fetch === undefined ? globalThis.fetch : dependencies.fetch;
    this.crypto =
      dependencies.crypto === undefined
        ? globalThis.crypto
        : dependencies.crypto;
    this.deadlineMilliseconds =
      dependencies.deadlineMilliseconds ?? REMOTE_REQUEST_DEADLINE_MILLISECONDS;
  }

  async describe(): Promise<RemoteBridgeResult<RemoteBridgeDescription>> {
    return this.readJson("GET", "/mirror", mirrorDescriptionSchema, (dto) => {
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
    });
  }

  async listNotes(cursor?: string): Promise<RemoteBridgeResult<NotePage>> {
    return this.readJson(
      "GET",
      withCursor("/notes", cursor),
      notePageSchema,
      (dto) => {
        const notes: NotePath[] = [];
        for (const path of dto.notes) {
          const normalized = toNotePath(path);
          if (normalized === undefined) return undefined;
          notes.push(normalized);
        }
        return { notes, nextCursor: dto.nextCursor };
      },
    );
  }

  async readNote(
    path: NotePath,
  ): Promise<RemoteBridgeResult<RemoteNoteContent>> {
    return this.withResponse<RemoteNoteContent>(
      { method: "GET", path: notePathRoute(path) },
      async (response, signal) => {
        if (response.status === 404) return success({ kind: "missing" });
        if (response.status !== 200) return responseFailure(response, false);
        if (!hasMediaType(response, REMOTE_RESPONSE_MEDIA_TYPE.markdown)) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        const content = await this.readText(
          response,
          MAX_REMOTE_CONTENT_RESPONSE_BYTES,
          signal,
        );
        if (content.kind === "failure") return content;
        const format = response.headers.get("Bridge-Note-Format");
        if (
          format === BRIDGE_NOTE_FORMAT.legacy &&
          response.headers.get("ETag") === null
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

  async inspectNote(
    path: NotePath,
  ): Promise<RemoteBridgeResult<CurrentNoteState>> {
    return this.readJson(
      "GET",
      `${notePathRoute(path)}/state`,
      currentNoteStateSchema,
      (dto, response) => {
        const state = mapCurrentState(dto);
        if (
          state === undefined ||
          state.path !== path ||
          !stateEtagMatches(state, response.headers.get("ETag"))
        ) {
          return undefined;
        }
        return state;
      },
    );
  }

  async mutateNote(
    request: ConditionalMutationRequest,
  ): Promise<RemoteBridgeMutationResult<MutationAcknowledgement>> {
    const contentHash = await this.requestContentHash(request);
    if (contentHash.kind === "failure") return contentHash;
    const condition =
      request.precondition.kind === "absent"
        ? { "If-None-Match": "*" }
        : { "If-Match": formatApplicationEtag(request.precondition.revision) };
    const headers = {
      ...identityHeaders(
        request.associationId,
        request.writerId,
        request.operationId,
      ),
      ...condition,
      ...(request.action === MUTATION_ACTION.tombstone
        ? {}
        : { "Content-Type": REMOTE_NOTE_REQUEST_CONTENT_TYPE }),
    };
    return this.withMutationResponse<MutationAcknowledgement>(
      {
        method: request.action === MUTATION_ACTION.tombstone ? "DELETE" : "PUT",
        path: notePathRoute(request.path),
        headers,
        ...(request.action === MUTATION_ACTION.tombstone
          ? {}
          : { body: request.content }),
      },
      async (response, signal) => {
        if (
          response.status === 412 ||
          response.status === 428 ||
          response.status === 401 ||
          response.status === 403
        ) {
          return mutationFailure(responseFailure(response, true));
        }
        const expectedStatus =
          request.action === MUTATION_ACTION.create ? 201 : 200;
        if (
          response.status !== expectedStatus ||
          !hasMediaType(response, REMOTE_RESPONSE_MEDIA_TYPE.json)
        ) {
          return mutationFailure(
            failure(REMOTE_BRIDGE_FAILURE.incompatibleProtocol),
          );
        }
        let acknowledgement: MutationAcknowledgement | undefined;
        if (request.action === MUTATION_ACTION.tombstone) {
          const decoded = await this.readJsonBody(
            response,
            tombstoneMutationResponseSchema,
            signal,
          );
          if (decoded.kind === "failure") return mutationFailure(decoded);
          acknowledgement = mapAcknowledgement(decoded.value.acknowledgement);
        } else {
          const decoded = await this.readJsonBody(
            response,
            mutationAcknowledgementSchema,
            signal,
          );
          if (decoded.kind === "failure") return mutationFailure(decoded);
          acknowledgement = mapAcknowledgement(decoded.value);
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
            response.headers.get("ETag")
        ) {
          return mutationFailure(
            failure(REMOTE_BRIDGE_FAILURE.malformedResponse),
          );
        }
        return { kind: "confirmed", confirmed: acknowledgement };
      },
    );
  }

  async listRecovery(
    cursor?: string,
  ): Promise<RemoteBridgeResult<RecoveryPage>> {
    return this.readJson(
      "GET",
      withCursor("/recovery", cursor),
      recoveryPageSchema,
      (dto) => {
        const recoveries: RecoverySnapshotState[] = [];
        for (const recovery of dto.recoveries) {
          const mapped = mapRecoveryState(recovery);
          if (mapped === undefined) return undefined;
          recoveries.push(mapped);
        }
        return { recoveries, nextCursor: dto.nextCursor };
      },
    );
  }

  async inspectRecovery(
    id: RecoverySnapshotId,
  ): Promise<RemoteBridgeResult<RecoverySnapshotState | null>> {
    return this.withResponse(
      { method: "GET", path: recoveryRoute(id) },
      async (response, signal) => {
        if (response.status === 404) return success(null);
        if (
          response.status !== 200 ||
          !hasMediaType(response, REMOTE_RESPONSE_MEDIA_TYPE.json)
        ) {
          return responseFailure(response, false);
        }
        const decoded = await this.readJsonBody(
          response,
          recoverySnapshotStateSchema,
          signal,
        );
        if (decoded.kind === "failure") return decoded;
        const state = mapRecoveryState(decoded.value);
        if (
          state === undefined ||
          state.id !== id ||
          formatApplicationEtag(state.revision) !== response.headers.get("ETag")
        ) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        return success(state);
      },
    );
  }

  async readRecoveryContent(
    id: RecoverySnapshotId,
  ): Promise<RemoteBridgeResult<RemoteRecoveryContent>> {
    return this.withResponse<RemoteRecoveryContent>(
      { method: "GET", path: `${recoveryRoute(id)}/content` },
      async (response, signal) => {
        if (response.status === 404) return success({ kind: "missing" });
        if (response.status === 410) return success({ kind: "unavailable" });
        if (
          response.status !== 200 ||
          !hasMediaType(response, REMOTE_RESPONSE_MEDIA_TYPE.markdown)
        ) {
          return responseFailure(response, false);
        }
        const content = await this.readText(
          response,
          MAX_REMOTE_CONTENT_RESPONSE_BYTES,
          signal,
        );
        if (content.kind === "failure") return content;
        if (
          response.headers.get("Bridge-Note-Format") !==
            BRIDGE_NOTE_FORMAT.current ||
          responseRevision(response) === undefined
        ) {
          return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
        }
        return success({ kind: "recoverable", content: content.value });
      },
    );
  }

  async sealRecovery(
    request: RecoverySealRequest,
  ): Promise<RemoteBridgeMutationResult<RecoverySnapshotState>> {
    return this.mutateRecovery("seal", request);
  }

  async purgeRecovery(
    request: RecoveryPurgeRequest,
  ): Promise<RemoteBridgeMutationResult<RecoverySnapshotState>> {
    return this.mutateRecovery("purge", request);
  }

  private async mutateRecovery(
    action: "seal" | "purge",
    request: RecoverySealRequest | RecoveryPurgeRequest,
  ): Promise<RemoteBridgeMutationResult<RecoverySnapshotState>> {
    return this.withMutationResponse<RecoverySnapshotState>(
      {
        method: "POST",
        path: `${recoveryRoute(request.id)}/${action}`,
        headers: {
          ...identityHeaders(
            request.associationId,
            request.writerId,
            request.operationId,
          ),
          "If-Match": formatApplicationEtag(request.expectedRevision),
        },
      },
      async (response, signal) => {
        if (
          response.status === 412 ||
          response.status === 401 ||
          response.status === 403 ||
          response.status === 409 ||
          response.status === 404
        ) {
          return mutationFailure(responseFailure(response, true));
        }
        if (
          response.status !== 200 ||
          !hasMediaType(response, REMOTE_RESPONSE_MEDIA_TYPE.json)
        ) {
          return mutationFailure(
            failure(REMOTE_BRIDGE_FAILURE.incompatibleProtocol),
          );
        }
        const decoded = await this.readJsonBody(
          response,
          recoverySnapshotStateSchema,
          signal,
        );
        if (decoded.kind === "failure") return mutationFailure(decoded);
        const state = mapRecoveryState(decoded.value);
        if (
          state === undefined ||
          state.id !== request.id ||
          state.associationId !== request.associationId ||
          formatApplicationEtag(state.revision) !== response.headers.get("ETag")
        ) {
          return mutationFailure(
            failure(REMOTE_BRIDGE_FAILURE.malformedResponse),
          );
        }
        return { kind: "confirmed", confirmed: state };
      },
    );
  }

  private async readJson<Dto, Value>(
    method: "GET",
    path: string,
    schema: z.ZodType<Dto>,
    map: (dto: Dto, response: Response) => Value | undefined,
  ): Promise<RemoteBridgeResult<Value>> {
    return this.withResponse({ method, path }, async (response, signal) => {
      if (
        response.status !== 200 ||
        !hasMediaType(response, REMOTE_RESPONSE_MEDIA_TYPE.json)
      ) {
        return responseFailure(response, false);
      }
      const decoded = await this.readJsonBody(response, schema, signal);
      if (decoded.kind === "failure") return decoded;
      const value = map(decoded.value, response);
      return value === undefined
        ? failure(REMOTE_BRIDGE_FAILURE.malformedResponse)
        : success(value);
    });
  }

  private async readJsonBody<Dto>(
    response: Response,
    schema: z.ZodType<Dto>,
    signal: AbortSignal,
  ): Promise<RemoteBridgeResult<Dto>> {
    const text = await this.readText(
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

  private async readText(
    response: Response,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<RemoteBridgeResult<string>> {
    const result = await readBoundedResponseBytes(
      response,
      maximumBytes,
      signal,
    );
    if (result.kind === "ok") {
      const text = decodeStrictUtf8(result.bytes);
      return text === undefined
        ? failure(REMOTE_BRIDGE_FAILURE.malformedResponse)
        : success(text);
    }
    if (result.kind === "aborted")
      return failure(REMOTE_BRIDGE_FAILURE.timedOut);
    return failure(REMOTE_BRIDGE_FAILURE.malformedResponse);
  }

  private async withResponse<Value>(
    request: {
      readonly method: string;
      readonly path: string;
      readonly headers?: HeadersInit;
      readonly body?: BodyInit | null;
    },
    consume: (
      response: Response,
      signal: AbortSignal,
    ) => Promise<RemoteBridgeResult<Value>>,
  ): Promise<RemoteBridgeResult<Value>> {
    const dispatched = await this.dispatch(request);
    if (dispatched.kind === "failure") return failure(dispatched.failure);
    try {
      return await consume(dispatched.response, dispatched.signal);
    } finally {
      cancelResponse(dispatched.response);
      dispatched.release();
    }
  }

  private async withMutationResponse<Value>(
    request: {
      readonly method: string;
      readonly path: string;
      readonly headers?: HeadersInit;
      readonly body?: BodyInit | null;
    },
    consume: (
      response: Response,
      signal: AbortSignal,
    ) => Promise<RemoteBridgeMutationResult<Value>>,
  ): Promise<RemoteBridgeMutationResult<Value>> {
    const dispatched = await this.dispatch(request);
    if (dispatched.kind === "failure") {
      return {
        kind: "failure",
        failure: dispatched.failure,
        effect: dispatched.dispatched ? "unknown" : "not-dispatched",
      };
    }
    try {
      return await consume(dispatched.response, dispatched.signal);
    } finally {
      cancelResponse(dispatched.response);
      dispatched.release();
    }
  }

  private async dispatch(request: {
    readonly method: string;
    readonly path: string;
    readonly headers?: HeadersInit;
    readonly body?: BodyInit | null;
  }): Promise<DispatchResult> {
    let permit: Awaited<ReturnType<RemoteRequestAdmission["admit"]>>;
    try {
      permit = await this.dependencies.admission.admit();
    } catch {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.admissionDenied,
        dispatched: false,
      };
    }
    if (permit === undefined) {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.admissionDenied,
        dispatched: false,
      };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (timer !== undefined) clearTimeout(timer);
      permit.release();
    };
    const fetch = this.fetch;
    if (
      fetch === undefined ||
      fetch === null ||
      typeof AbortController === "undefined"
    ) {
      release();
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.unsupportedRuntime,
        dispatched: false,
      };
    }
    let bearer: string | null;
    try {
      bearer =
        this.dependencies.secretStorage.getSecret?.(
          this.dependencies.secretReference,
        ) ?? null;
    } catch {
      release();
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.missingSecret,
        dispatched: false,
      };
    }
    if (bearer === null || bearer.length === 0) {
      release();
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.missingSecret,
        dispatched: false,
      };
    }
    let url: URL;
    try {
      url = new URL(
        `${REMOTE_API_V2_PATH}${request.path}`,
        this.dependencies.origin,
      );
    } catch {
      release();
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.invalidConfiguration,
        dispatched: false,
      };
    }
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), this.deadlineMilliseconds);
    let fetchResult: Response | undefined;
    try {
      const headers = new Headers(request.headers);
      headers.set("Authorization", `Bearer ${bearer}`);
      const promise = fetch(url, {
        ...REMOTE_FETCH_OPTIONS,
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: controller.signal,
      });
      const raced = await raceFetchWithAbort(promise, controller.signal);
      if (raced.kind === "aborted") {
        return {
          kind: "failure",
          failure: REMOTE_BRIDGE_FAILURE.timedOut,
          dispatched: true,
        };
      }
      fetchResult = raced.response;
      return {
        kind: "response",
        response: fetchResult,
        signal: controller.signal,
        release,
      };
    } catch {
      return {
        kind: "failure",
        failure: controller.signal.aborted
          ? REMOTE_BRIDGE_FAILURE.timedOut
          : REMOTE_BRIDGE_FAILURE.networkUnavailable,
        dispatched: true,
      };
    } finally {
      if (fetchResult === undefined) release();
    }
  }

  private async requestContentHash(
    request: ConditionalMutationRequest,
  ): Promise<
    | { readonly kind: "success"; readonly value: string }
    | {
        readonly kind: "failure";
        readonly failure: (typeof REMOTE_BRIDGE_FAILURE)[keyof typeof REMOTE_BRIDGE_FAILURE];
        readonly effect: "not-dispatched";
      }
  > {
    if (request.action === MUTATION_ACTION.tombstone)
      return { kind: "success", value: "" };
    if (this.crypto === undefined || this.crypto === null) {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.unsupportedRuntime,
        effect: "not-dispatched",
      };
    }
    const bytes = new TextEncoder().encode(request.content);
    if (bytes.byteLength > MAX_NOTE_SIZE_BYTES) {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.incompatibleProtocol,
        effect: "not-dispatched",
      };
    }
    try {
      const digest = await this.crypto.subtle.digest("SHA-256", bytes);
      return { kind: "success", value: toHex(new Uint8Array(digest)) };
    } catch {
      return {
        kind: "failure",
        failure: REMOTE_BRIDGE_FAILURE.unsupportedRuntime,
        effect: "not-dispatched",
      };
    }
  }
}

function withCursor(path: string, cursor: string | undefined): string {
  if (cursor === undefined) return path;
  return `${path}?cursor=${encodeURIComponent(cursor)}`;
}

function notePathRoute(path: NotePath): string {
  return `/notes/${encodeNotePath(path)}`;
}

function recoveryRoute(id: RecoverySnapshotId): string {
  return `/recovery/${id}`;
}

function encodeNotePath(path: NotePath): string {
  const bytes = new TextEncoder().encode(path);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function identityHeaders(
  associationId: MirrorAssociationId,
  writerId: MirrorWriterId,
  operationId: MirrorOperationId,
): Record<string, string> {
  return {
    "Bridge-Association-Id": associationId,
    "Bridge-Writer-Id": writerId,
    "Bridge-Operation-Id": operationId,
  };
}

function hasMediaType(response: Response, expected: string): boolean {
  const value = response.headers.get("Content-Type");
  if (value === null) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

function responseRevision(response: Response): ApplicationRevision | undefined {
  const etag = response.headers.get("ETag");
  if (etag === null || !etag.startsWith('"m3-') || !etag.endsWith('"'))
    return undefined;
  return createApplicationRevision(etag.slice(4, -1));
}

function stateEtagMatches(
  state: CurrentNoteState,
  etag: string | null,
): boolean {
  if (state.kind === "live" || state.kind === "tombstone") {
    return formatApplicationEtag(state.revision) === etag;
  }
  return etag === null;
}

function mapCurrentState(
  dto: ReturnType<typeof currentNoteStateSchema.parse>,
): CurrentNoteState | undefined {
  const path = toNotePath(dto.path);
  if (path === undefined) return undefined;
  if (dto.kind === "absent" || dto.kind === "legacy")
    return { kind: dto.kind, path };
  const revision = createApplicationRevision(dto.revision);
  const receipt = mapReceipt(dto.receipt);
  if (revision === undefined || receipt === undefined) return undefined;
  if (dto.kind === "live") {
    const contentSha256 = createContentSha256(dto.contentSha256);
    if (
      contentSha256 === undefined ||
      (receipt.action !== "create" &&
        receipt.action !== "update" &&
        receipt.action !== "recreate")
    )
      return undefined;
    return { kind: dto.kind, path, revision, contentSha256, receipt };
  }
  const deletedRevision = createApplicationRevision(dto.deletedRevision);
  const recoveryId = createRecoverySnapshotId(dto.recoveryId);
  if (
    deletedRevision === undefined ||
    recoveryId === undefined ||
    receipt.action !== "tombstone"
  )
    return undefined;
  return {
    kind: dto.kind,
    path,
    revision,
    deletedRevision,
    recoveryId,
    receipt,
  };
}

function mapAcknowledgement(
  dto: ReturnType<typeof mutationAcknowledgementSchema.parse>,
): MutationAcknowledgement | undefined {
  const path = toNotePath(dto.path);
  const revision = createApplicationRevision(dto.revision);
  const receipt = mapReceipt(dto.receipt);
  if (path === undefined || revision === undefined || receipt === undefined)
    return undefined;
  return { path, revision, receipt };
}

function mapReceipt(
  dto: ReturnType<typeof mutationAcknowledgementSchema.parse>["receipt"],
): MutationAcknowledgement["receipt"] | undefined {
  const associationId = createMirrorAssociationId(dto.associationId);
  const operationId = createMirrorOperationId(dto.operationId);
  if (associationId === undefined || operationId === undefined)
    return undefined;
  if (dto.precondition.kind === "absent") {
    const contentSha256 =
      "contentSha256" in dto
        ? createContentSha256(dto.contentSha256)
        : undefined;
    return dto.action === "create" && contentSha256 !== undefined
      ? {
          action: dto.action,
          associationId,
          operationId,
          precondition: { kind: "absent" },
          contentSha256,
        }
      : undefined;
  }
  const revision = createApplicationRevision(dto.precondition.revision);
  if (revision === undefined) return undefined;
  if (dto.action === "tombstone")
    return {
      action: dto.action,
      associationId,
      operationId,
      precondition: { kind: "matching-revision", revision },
    };
  const contentSha256 =
    "contentSha256" in dto ? createContentSha256(dto.contentSha256) : undefined;
  if (contentSha256 === undefined) return undefined;
  if (dto.action === "update" || dto.action === "recreate") {
    return {
      action: dto.action,
      associationId,
      operationId,
      precondition: { kind: "matching-revision", revision },
      contentSha256,
    };
  }
  return undefined;
}

function mapRecoveryState(
  dto: ReturnType<typeof recoverySnapshotStateSchema.parse>,
): RecoverySnapshotState | undefined {
  const id = createRecoverySnapshotId(dto.id);
  const associationId = createMirrorAssociationId(dto.associationId);
  const path = toNotePath(dto.path);
  const revision = createApplicationRevision(dto.revision);
  const sourceRevision = createApplicationRevision(dto.sourceRevision);
  const contentSha256 = createContentSha256(dto.contentSha256);
  if (
    id === undefined ||
    associationId === undefined ||
    path === undefined ||
    revision === undefined ||
    sourceRevision === undefined ||
    contentSha256 === undefined
  )
    return undefined;
  if (dto.kind === "prepared")
    return {
      kind: dto.kind,
      id,
      associationId,
      path,
      revision,
      sourceRevision,
      contentSha256,
    };
  return {
    kind: dto.kind,
    id,
    associationId,
    path,
    revision,
    sourceRevision,
    contentSha256,
    recoverUntil: dto.recoverUntil,
  };
}

function toNotePath(value: string): NotePath | undefined {
  return normalizeNotePath(value);
}

function acknowledgementMatchesRequest(
  acknowledgement: MutationAcknowledgement,
  request: ConditionalMutationRequest,
  contentHash: string,
): boolean {
  const receipt = acknowledgement.receipt;
  if (
    receipt.action !== request.action ||
    receipt.associationId !== request.associationId ||
    receipt.operationId !== request.operationId ||
    receipt.precondition.kind !== request.precondition.kind
  )
    return false;
  if (
    receipt.precondition.kind === "matching-revision" &&
    request.precondition.kind === "matching-revision" &&
    receipt.precondition.revision !== request.precondition.revision
  )
    return false;
  return (
    receipt.action === "tombstone" || receipt.contentSha256 === contentHash
  );
}

function responseFailure(
  response: Response,
  mutation: boolean,
): RemoteBridgeFailureResult {
  if (response.status === 401)
    return failure(REMOTE_BRIDGE_FAILURE.unauthenticated);
  if (response.status === 403) return failure(REMOTE_BRIDGE_FAILURE.forbidden);
  if (response.status === 404) return failure(REMOTE_BRIDGE_FAILURE.missing);
  if (response.status === 409) return failure(REMOTE_BRIDGE_FAILURE.conflict);
  if (response.status === 412)
    return failure(REMOTE_BRIDGE_FAILURE.preconditionFailed);
  if (response.status === 428)
    return failure(REMOTE_BRIDGE_FAILURE.preconditionRequired);
  if (response.status === 429)
    return failure(REMOTE_BRIDGE_FAILURE.rateLimited);
  if (response.status >= 500)
    return failure(REMOTE_BRIDGE_FAILURE.serverFailed);
  return failure(
    mutation
      ? REMOTE_BRIDGE_FAILURE.incompatibleProtocol
      : REMOTE_BRIDGE_FAILURE.malformedResponse,
  );
}

function mutationFailure<Value>(
  result: RemoteBridgeFailureResult,
): RemoteBridgeMutationResult<Value> {
  const definitelyRefused =
    result.failure === REMOTE_BRIDGE_FAILURE.unauthenticated ||
    result.failure === REMOTE_BRIDGE_FAILURE.forbidden ||
    result.failure === REMOTE_BRIDGE_FAILURE.preconditionFailed ||
    result.failure === REMOTE_BRIDGE_FAILURE.preconditionRequired ||
    result.failure === REMOTE_BRIDGE_FAILURE.conflict ||
    result.failure === REMOTE_BRIDGE_FAILURE.missing;
  return {
    kind: "failure",
    failure: result.failure,
    effect: definitelyRefused ? "definitely-refused" : "unknown",
  };
}

function success<Value>(value: Value): RemoteBridgeResult<Value> {
  return { kind: "success", value };
}

function failure(
  failureKind: (typeof REMOTE_BRIDGE_FAILURE)[keyof typeof REMOTE_BRIDGE_FAILURE],
): RemoteBridgeFailureResult {
  return { kind: "failure", failure: failureKind };
}

async function raceFetchWithAbort(
  promise: Promise<Response>,
  signal: AbortSignal,
): Promise<
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "aborted" }
> {
  if (signal.aborted) return { kind: "aborted" };
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
    void promise
      .then((response) => resolve({ kind: "response", response }), reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function cancelResponse(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
