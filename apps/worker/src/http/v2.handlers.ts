import {
  CONDITIONAL_MUTATION_PRECONDITION_KIND,
  CURRENT_CONTENT_RESULT_KIND,
  CURRENT_NOTE_STATE_KIND,
  type CurrentContentMutationResult,
  createRecoverySnapshotId,
  formatApplicationEtag,
  MAX_MIRROR_PAGE_SIZE,
  MAX_NOTE_SIZE_BYTES,
  MUTATION_ACTION,
  MUTATION_EFFECT_CERTAINTY,
  RECOVERY_CONTENT_RESULT_KIND,
  RECOVERY_MAINTENANCE_RESULT_KIND,
  RECOVERY_RETENTION_MILLISECONDS,
  RECOVERY_SNAPSHOT_STATE_KIND,
} from "@obsidian-ai-bridge/core";
import {
  API_ERROR_CODE,
  API_ROUTE_PARAMETER,
  BRIDGE_NOTE_FORMAT,
  MIRROR_API_V2_QUERY_PARAMETER,
  MIRROR_API_V2_SEGMENT,
  MIRROR_PROTOCOL_ID,
  type MirrorDescriptionDto,
  mirrorCursorSchema,
  notePageSchema,
  recoveryPageSchema,
  type TombstoneMutationResponseDto,
} from "@obsidian-ai-bridge/protocol";
import {
  createErrorResponse,
  createJsonResponse,
  createNoteContentResponse,
  createNotFoundResponse,
  createPayloadTooLargeResponse,
  createUnsupportedMediaTypeResponse,
} from "@worker/http/api-responses";
import {
  CONDITIONAL_REQUEST_RESULT_KIND,
  parseConditionalRequest,
} from "@worker/http/conditional-request";
import type { WorkerContext } from "@worker/http/hono.types";
import { HTTP_HEADER, HTTP_STATUS } from "@worker/http/http.constants";
import {
  MUTATION_IDENTITY_RESULT_KIND,
  validateMutationIdentity,
} from "@worker/http/mutation-identity";
import {
  decodeRequestNotePath,
  literalRequestRouteParameter,
} from "@worker/http/note.handlers";
import { readNoteBody } from "@worker/http/note-body";
import { NOTE_BODY_RESULT_KIND } from "@worker/http/note-body.constants";
import { isSupportedNoteContentType } from "@worker/http/note-content-type";

/** @returns A handler describing protocol limits and validated designation. */
export function createGetMirrorHandler() {
  return (context: WorkerContext) => {
    const designation = context.var.mirrorServices.designation;
    if (designation === null) {
      return createErrorResponse(API_ERROR_CODE.internalError);
    }
    const response: MirrorDescriptionDto = {
      protocol: MIRROR_PROTOCOL_ID,
      associationId: designation.associationId,
      writerId: designation.writerId,
      maxNoteSizeBytes: MAX_NOTE_SIZE_BYTES,
      maxPageSize: MAX_MIRROR_PAGE_SIZE,
      recoveryRetentionSeconds: RECOVERY_RETENTION_MILLISECONDS / 1000,
    };
    return createJsonResponse(context, response, HTTP_STATUS.ok);
  };
}

/**
 * Parses one optional, unique, bounded opaque cursor.
 *
 * @param context - Request containing the untrusted query string.
 * @returns Valid cursor, `undefined` when absent, or `null` when malformed.
 */
function parseCursor(context: WorkerContext): string | undefined | null {
  const values = new URL(context.req.url).searchParams.getAll(
    MIRROR_API_V2_QUERY_PARAMETER.cursor,
  );
  if (values.length === 0) return undefined;
  if (values.length !== 1) return null;
  const parsed = mirrorCursorSchema.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

/** @returns A handler listing one validated page of visible v2 notes. */
export function createListV2NotesHandler() {
  return async (context: WorkerContext) => {
    const cursor = parseCursor(context);
    if (cursor === null)
      return createErrorResponse(API_ERROR_CODE.invalidRequest);
    const page = await context.var.mirrorServices.current.list(cursor);
    const response = notePageSchema.safeParse(page);
    if (!response.success) {
      return createErrorResponse(API_ERROR_CODE.internalError);
    }
    return createJsonResponse(context, response.data, HTTP_STATUS.ok);
  };
}

/** @returns A handler reading legacy/live text without leaking storage envelopes. */
export function createGetV2NoteHandler() {
  return async (context: WorkerContext) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined)
      return createErrorResponse(API_ERROR_CODE.invalidPath);
    const result = await context.var.mirrorServices.current.readContent(path);
    switch (result.kind) {
      case CURRENT_CONTENT_RESULT_KIND.absent:
      case CURRENT_CONTENT_RESULT_KIND.tombstone:
        return createNotFoundResponse(context);
      case CURRENT_CONTENT_RESULT_KIND.legacy:
        return createNoteContentResponse(context, result.content, {
          noteFormat: BRIDGE_NOTE_FORMAT.legacy,
        });
      case CURRENT_CONTENT_RESULT_KIND.live:
        return createNoteContentResponse(context, result.content, {
          etag: formatApplicationEtag(result.state.revision),
          noteFormat: BRIDGE_NOTE_FORMAT.current,
        });
    }
  };
}

/** @returns A handler returning metadata-only current state. */
export function createGetV2NoteStateHandler() {
  return async (context: WorkerContext) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined)
      return createErrorResponse(API_ERROR_CODE.invalidPath);
    const state = await context.var.mirrorServices.current.inspect(path);
    const etag =
      state.kind === CURRENT_NOTE_STATE_KIND.live ||
      state.kind === CURRENT_NOTE_STATE_KIND.tombstone
        ? formatApplicationEtag(state.revision)
        : undefined;
    return createJsonResponse(context, state, HTTP_STATUS.ok, etag);
  };
}

/**
 * Maps required mutation identities before storage-backed policy is invoked.
 *
 * @param context - Request and composition-validated designation.
 * @returns Validated identities or a sanitized HTTP refusal.
 */
function mutationIdentity(context: WorkerContext) {
  const result = validateMutationIdentity(
    context.req.raw.headers,
    context.var.mirrorServices.designation,
  );
  if (result.kind === MUTATION_IDENTITY_RESULT_KIND.malformed) {
    return {
      error: createErrorResponse(API_ERROR_CODE.invalidRequest),
    } as const;
  }
  if (result.kind === MUTATION_IDENTITY_RESULT_KIND.forbidden) {
    return {
      error: createErrorResponse(API_ERROR_CODE.forbiddenWriter),
    } as const;
  }
  return { identity: result.identity } as const;
}

/**
 * Maps a required conditional header to a sanitized transport error.
 *
 * @param result - Missing or malformed conditional parser outcome.
 * @returns Corresponding 428 or 400 response.
 */
function conditionalError(
  result: Exclude<
    ReturnType<typeof parseConditionalRequest>,
    { readonly kind: "valid" }
  >,
): Response {
  return createErrorResponse(
    result.kind === CONDITIONAL_REQUEST_RESULT_KIND.missing
      ? API_ERROR_CODE.preconditionRequired
      : API_ERROR_CODE.invalidRequest,
  );
}

/**
 * Reads an explicitly typed bounded note body.
 *
 * @param context - Request carrying raw note bytes.
 * @returns Valid text or a sanitized media/encoding/size response.
 */
async function noteBody(context: WorkerContext) {
  if (
    !isSupportedNoteContentType(context.req.header(HTTP_HEADER.contentType))
  ) {
    return { error: createUnsupportedMediaTypeResponse(context) } as const;
  }
  const result = await readNoteBody(context.req.raw);
  switch (result.kind) {
    case NOTE_BODY_RESULT_KIND.tooLarge:
      return { error: createPayloadTooLargeResponse(context) } as const;
    case NOTE_BODY_RESULT_KIND.invalidEncoding:
      return {
        error: createErrorResponse(API_ERROR_CODE.invalidBody),
      } as const;
    case NOTE_BODY_RESULT_KIND.ok:
      return { content: result.content } as const;
  }
}

/**
 * Ensures bodyless mutation routes do not silently accept plaintext.
 *
 * @param context - Request whose body must decode to zero bytes.
 * @returns An error response, or `null` for an empty body.
 */
async function validateEmptyBody(
  context: WorkerContext,
): Promise<Response | null> {
  const result = await readNoteBody(context.req.raw);
  switch (result.kind) {
    case NOTE_BODY_RESULT_KIND.tooLarge:
      return createPayloadTooLargeResponse(context);
    case NOTE_BODY_RESULT_KIND.invalidEncoding:
      return createErrorResponse(API_ERROR_CODE.invalidBody);
    case NOTE_BODY_RESULT_KIND.ok:
      return result.content === ""
        ? null
        : createErrorResponse(API_ERROR_CODE.invalidRequest);
  }
}

/** @returns A handler for conditional create, update, or tombstone recreation. */
export function createPutV2NoteHandler() {
  return async (context: WorkerContext) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined)
      return createErrorResponse(API_ERROR_CODE.invalidPath);
    const identity = mutationIdentity(context);
    if ("error" in identity) return identity.error;
    const condition = parseConditionalRequest(context.req.raw.headers, "put");
    if (condition.kind !== CONDITIONAL_REQUEST_RESULT_KIND.valid) {
      return conditionalError(condition);
    }
    const body = await noteBody(context);
    if ("error" in body) return body.error;

    if (
      condition.precondition.kind ===
      CONDITIONAL_MUTATION_PRECONDITION_KIND.absent
    ) {
      const result = await context.var.mirrorServices.current.create({
        action: MUTATION_ACTION.create,
        ...identity.identity,
        path,
        precondition: condition.precondition,
        content: body.content,
      });
      return contentMutationResponse(context, result, HTTP_STATUS.created);
    }

    const observed = await context.var.mirrorServices.current.inspect(path);
    if (observed.kind === CURRENT_NOTE_STATE_KIND.live) {
      const result = await context.var.mirrorServices.current.update({
        action: MUTATION_ACTION.update,
        ...identity.identity,
        path,
        precondition: condition.precondition,
        content: body.content,
      });
      return contentMutationResponse(context, result, HTTP_STATUS.ok);
    }
    if (observed.kind === CURRENT_NOTE_STATE_KIND.tombstone) {
      const result = await context.var.mirrorServices.current.recreate({
        action: MUTATION_ACTION.recreate,
        ...identity.identity,
        path,
        precondition: condition.precondition,
        content: body.content,
      });
      return contentMutationResponse(context, result, HTTP_STATUS.ok);
    }
    return createErrorResponse(API_ERROR_CODE.preconditionFailed);
  };
}

/**
 * Serializes only exact confirmed current-generation acknowledgements.
 *
 * @param context - Active request context.
 * @param result - Application mutation certainty.
 * @param successStatus - Create or matching-mutation success status.
 * @returns Exact acknowledgement, stale refusal, or sanitized server failure.
 */
function contentMutationResponse(
  context: WorkerContext,
  result: CurrentContentMutationResult,
  successStatus: typeof HTTP_STATUS.created | typeof HTTP_STATUS.ok,
): Response {
  switch (result.kind) {
    case MUTATION_EFFECT_CERTAINTY.confirmed:
      return createJsonResponse(
        context,
        result.confirmed,
        successStatus,
        formatApplicationEtag(result.confirmed.revision),
      );
    case MUTATION_EFFECT_CERTAINTY.definitelyRefused:
      return createErrorResponse(API_ERROR_CODE.preconditionFailed);
    case MUTATION_EFFECT_CERTAINTY.notDispatched:
    case MUTATION_EFFECT_CERTAINTY.unknown:
      return createErrorResponse(API_ERROR_CODE.internalError);
  }
}

/** @returns A handler that recoverably tombstones without physical deletion. */
export function createDeleteV2NoteHandler() {
  return async (context: WorkerContext) => {
    const path = decodeRequestNotePath(context);
    if (path === undefined)
      return createErrorResponse(API_ERROR_CODE.invalidPath);
    const identity = mutationIdentity(context);
    if ("error" in identity) return identity.error;
    const condition = parseConditionalRequest(
      context.req.raw.headers,
      "matching",
    );
    if (condition.kind !== CONDITIONAL_REQUEST_RESULT_KIND.valid) {
      return conditionalError(condition);
    }
    const emptyBodyError = await validateEmptyBody(context);
    if (emptyBodyError !== null) return emptyBodyError;
    if (
      condition.precondition.kind !==
      CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision
    ) {
      return createErrorResponse(API_ERROR_CODE.invalidRequest);
    }

    const result = await context.var.mirrorServices.current.tombstone({
      action: MUTATION_ACTION.tombstone,
      ...identity.identity,
      path,
      precondition: condition.precondition,
    });
    switch (result.kind) {
      case MUTATION_EFFECT_CERTAINTY.confirmed: {
        if (
          result.confirmed.recovery.kind !==
          RECOVERY_SNAPSHOT_STATE_KIND.prepared
        ) {
          return createErrorResponse(API_ERROR_CODE.internalError);
        }
        const sealingResult = result.confirmed.sealing;
        let sealing: TombstoneMutationResponseDto["sealing"];
        if (sealingResult.kind === MUTATION_EFFECT_CERTAINTY.confirmed) {
          if (
            sealingResult.confirmed.kind !== RECOVERY_SNAPSHOT_STATE_KIND.sealed
          ) {
            return createErrorResponse(API_ERROR_CODE.internalError);
          }
          sealing = {
            kind: MUTATION_EFFECT_CERTAINTY.confirmed,
            recovery: sealingResult.confirmed,
          };
        } else {
          sealing = { kind: sealingResult.kind };
        }
        const acknowledgement = result.confirmed.acknowledgement;
        if (acknowledgement.receipt.action !== MUTATION_ACTION.tombstone) {
          return createErrorResponse(API_ERROR_CODE.internalError);
        }
        const response: TombstoneMutationResponseDto = {
          acknowledgement: {
            path: acknowledgement.path,
            revision: acknowledgement.revision,
            receipt: acknowledgement.receipt,
          },
          recovery: result.confirmed.recovery,
          sealing,
        };
        return createJsonResponse(
          context,
          response,
          HTTP_STATUS.ok,
          formatApplicationEtag(result.confirmed.acknowledgement.revision),
        );
      }
      case MUTATION_EFFECT_CERTAINTY.definitelyRefused:
        return createErrorResponse(API_ERROR_CODE.preconditionFailed);
      case MUTATION_EFFECT_CERTAINTY.notDispatched:
      case MUTATION_EFFECT_CERTAINTY.unknown:
        return createErrorResponse(API_ERROR_CODE.internalError);
    }
  };
}

/** @returns A handler listing bounded recovery metadata without plaintext. */
export function createListRecoveryHandler() {
  return async (context: WorkerContext) => {
    const cursor = parseCursor(context);
    if (cursor === null)
      return createErrorResponse(API_ERROR_CODE.invalidRequest);
    const page = await context.var.mirrorServices.recovery.list(cursor);
    const response = recoveryPageSchema.safeParse(page);
    if (!response.success) {
      return createErrorResponse(API_ERROR_CODE.internalError);
    }
    return createJsonResponse(context, response.data, HTTP_STATUS.ok);
  };
}

/** @returns A handler returning metadata only for one recovery generation. */
export function createGetRecoveryHandler() {
  return async (context: WorkerContext) => {
    const id = createRecoverySnapshotId(
      literalRequestRouteParameter(context, API_ROUTE_PARAMETER.recoveryId) ??
        "",
    );
    if (id === undefined)
      return createErrorResponse(API_ERROR_CODE.invalidRequest);
    const state = await context.var.mirrorServices.recovery.inspect(id);
    if (state === null) return createNotFoundResponse(context);
    return createJsonResponse(
      context,
      state,
      HTTP_STATUS.ok,
      formatApplicationEtag(state.revision),
    );
  };
}

/** @returns A handler exposing text only for currently recoverable material. */
export function createGetRecoveryContentHandler() {
  return async (context: WorkerContext) => {
    const id = createRecoverySnapshotId(
      literalRequestRouteParameter(context, API_ROUTE_PARAMETER.recoveryId) ??
        "",
    );
    if (id === undefined)
      return createErrorResponse(API_ERROR_CODE.invalidRequest);
    const result = await context.var.mirrorServices.recovery.retrieve(id);
    switch (result.kind) {
      case RECOVERY_CONTENT_RESULT_KIND.missing:
        return createNotFoundResponse(context);
      case RECOVERY_CONTENT_RESULT_KIND.expired:
      case RECOVERY_CONTENT_RESULT_KIND.purged:
        return createErrorResponse(API_ERROR_CODE.recoveryUnavailable);
      case RECOVERY_CONTENT_RESULT_KIND.recoverable:
        return createNoteContentResponse(context, result.content, {
          etag: formatApplicationEtag(result.state.revision),
          noteFormat: BRIDGE_NOTE_FORMAT.current,
        });
    }
  };
}

/**
 * Creates one explicit designated recovery maintenance handler.
 *
 * @param action - Seal or purge application transition to invoke.
 * @returns A handler preserving 404, 409, 412, and effect-certainty semantics.
 */
function createRecoveryMutationHandler(
  action:
    | typeof MIRROR_API_V2_SEGMENT.seal
    | typeof MIRROR_API_V2_SEGMENT.purge,
) {
  return async (context: WorkerContext) => {
    const id = createRecoverySnapshotId(
      literalRequestRouteParameter(context, API_ROUTE_PARAMETER.recoveryId) ??
        "",
    );
    if (id === undefined)
      return createErrorResponse(API_ERROR_CODE.invalidRequest);
    const identity = mutationIdentity(context);
    if ("error" in identity) return identity.error;
    const condition = parseConditionalRequest(
      context.req.raw.headers,
      "matching",
    );
    if (condition.kind !== CONDITIONAL_REQUEST_RESULT_KIND.valid) {
      return conditionalError(condition);
    }
    const emptyBodyError = await validateEmptyBody(context);
    if (emptyBodyError !== null) return emptyBodyError;
    if (
      condition.precondition.kind !==
      CONDITIONAL_MUTATION_PRECONDITION_KIND.matchingRevision
    ) {
      return createErrorResponse(API_ERROR_CODE.invalidRequest);
    }

    const request = {
      id,
      ...identity.identity,
      expectedRevision: condition.precondition.revision,
    };
    const result =
      action === MIRROR_API_V2_SEGMENT.seal
        ? await context.var.mirrorServices.recovery.sealDetailed(request)
        : await context.var.mirrorServices.recovery.purgeDetailed(request);
    switch (result.kind) {
      case RECOVERY_MAINTENANCE_RESULT_KIND.missing:
        return createNotFoundResponse(context);
      case RECOVERY_MAINTENANCE_RESULT_KIND.preconditionFailed:
        return createErrorResponse(API_ERROR_CODE.preconditionFailed);
      case RECOVERY_MAINTENANCE_RESULT_KIND.conflict:
        return createErrorResponse(API_ERROR_CODE.conflict);
      case RECOVERY_MAINTENANCE_RESULT_KIND.confirmed:
        return createJsonResponse(
          context,
          result.confirmed,
          HTTP_STATUS.ok,
          formatApplicationEtag(result.confirmed.revision),
        );
      case RECOVERY_MAINTENANCE_RESULT_KIND.notDispatched:
      case RECOVERY_MAINTENANCE_RESULT_KIND.unknown:
        return createErrorResponse(API_ERROR_CODE.internalError);
    }
  };
}

/** @returns The explicit recovery-seal handler. */
export function createSealRecoveryHandler() {
  return createRecoveryMutationHandler(MIRROR_API_V2_SEGMENT.seal);
}

/** @returns The explicit recovery-purge handler. */
export function createPurgeRecoveryHandler() {
  return createRecoveryMutationHandler(MIRROR_API_V2_SEGMENT.purge);
}
