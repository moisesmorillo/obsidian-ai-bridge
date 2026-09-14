import { OpenAPIHono } from "@hono/zod-openapi";
import { API_ERROR_CODE } from "@obsidian-ai-bridge/protocol";
import { Scalar } from "@scalar/hono-api-reference";
import type { WorkerAppDependencies } from "@worker/app.types";
import { createErrorResponse } from "@worker/http/api-responses";
import { createAuthenticationMiddleware } from "@worker/http/authentication.middleware";
import type {
  WorkerApplication,
  WorkerBasePath,
  WorkerHonoEnvironment,
} from "@worker/http/hono.types";
import {
  API_PREFIX,
  API_REFERENCE_ROUTE,
  API_V2_PREFIX,
  HEALTH_ROUTE,
  NOTES_ROUTE,
  OPENAPI_ROUTE,
} from "@worker/http/http.constants";
import {
  createDeleteNoteHandler,
  createGetNoteHandler,
  createHealthHandler,
  createInvalidPathHandler,
  createListNotesHandler,
  createPutNoteHandler,
  createUnsupportedNoteMethodHandler,
} from "@worker/http/note.handlers";
import {
  deleteNoteRoute,
  deleteV2NoteRoute,
  getMirrorRoute,
  getNoteRoute,
  getRecoveryContentRoute,
  getRecoveryRoute,
  getV2NoteRoute,
  getV2NoteStateRoute,
  healthRoute,
  listNotesRoute,
  listRecoveryRoute,
  listV2NotesRoute,
  openApiConfiguration,
  purgeRecoveryRoute,
  putNoteRoute,
  putV2NoteRoute,
  sealRecoveryRoute,
} from "@worker/http/openapi.routes";
import { createRequestDependenciesMiddleware } from "@worker/http/request-dependencies.middleware";
import {
  createDeleteV2NoteHandler,
  createGetMirrorHandler,
  createGetRecoveryContentHandler,
  createGetRecoveryHandler,
  createGetV2NoteHandler,
  createGetV2NoteStateHandler,
  createListRecoveryHandler,
  createListV2NotesHandler,
  createPurgeRecoveryHandler,
  createPutV2NoteHandler,
  createSealRecoveryHandler,
} from "@worker/http/v2.handlers";
import { createV2CorsMiddleware } from "@worker/http/v2-cors.middleware";
import { V2_ROUTE_POLICY } from "@worker/http/v2-route-policy";
import { createV2RoutePolicyGuardMiddleware } from "@worker/http/v2-route-policy.middleware";
import { createRequestLoggingMiddleware } from "@worker/logging/request-logging.middleware";
import type { BlankSchema } from "hono/types";

/**
 * Builds the complete Hono transport adapter from infrastructure-agnostic ports.
 *
 * @param dependencies - Long-lived ports used to resolve request services and logging.
 * @returns A typed Hono application with retained v1 and conditional v2 routes.
 */
export function createWorkerApp(
  dependencies: WorkerAppDependencies,
): WorkerApplication {
  const app = new OpenAPIHono<
    WorkerHonoEnvironment,
    BlankSchema,
    WorkerBasePath
  >();

  app.use(createRequestLoggingMiddleware(dependencies.logger));
  app.use(API_V2_PREFIX, createV2CorsMiddleware());
  app.use(`${API_V2_PREFIX}/*`, createV2CorsMiddleware());
  app.use(
    API_PREFIX,
    createAuthenticationMiddleware(dependencies.resolveToken),
  );
  app.use(
    `${API_PREFIX}/*`,
    createAuthenticationMiddleware(dependencies.resolveToken),
  );
  app.use(
    API_V2_PREFIX,
    createAuthenticationMiddleware(dependencies.resolveToken),
  );
  app.use(
    `${API_V2_PREFIX}/*`,
    createAuthenticationMiddleware(dependencies.resolveToken),
  );
  app.use(API_V2_PREFIX, createV2RoutePolicyGuardMiddleware());
  app.use(`${API_V2_PREFIX}/*`, createV2RoutePolicyGuardMiddleware());
  app.use(
    createRequestDependenciesMiddleware(dependencies.resolveMirrorServices),
  );

  [
    healthRoute,
    listNotesRoute,
    getNoteRoute,
    putNoteRoute,
    deleteNoteRoute,
    getMirrorRoute,
    listV2NotesRoute,
    getV2NoteStateRoute,
    getV2NoteRoute,
    putV2NoteRoute,
    deleteV2NoteRoute,
    listRecoveryRoute,
    getRecoveryContentRoute,
    getRecoveryRoute,
    sealRecoveryRoute,
    purgeRecoveryRoute,
  ].forEach((route) => {
    app.openAPIRegistry.registerPath(route);
  });

  app.get(HEALTH_ROUTE, createHealthHandler());

  app.get(NOTES_ROUTE, createListNotesHandler());
  app.get(`${NOTES_ROUTE}/:path`, createGetNoteHandler());
  app.put(`${NOTES_ROUTE}/:path`, createPutNoteHandler());
  app.delete(`${NOTES_ROUTE}/:path`, createDeleteNoteHandler());
  app.all(`${NOTES_ROUTE}/:path`, createUnsupportedNoteMethodHandler());
  app.all(`${NOTES_ROUTE}/*`, createInvalidPathHandler());

  app.get(V2_ROUTE_POLICY.mirror.path, createGetMirrorHandler());
  app.get(V2_ROUTE_POLICY.notes.path, createListV2NotesHandler());
  app.get(V2_ROUTE_POLICY.noteState.path, createGetV2NoteStateHandler());
  app.get(V2_ROUTE_POLICY.note.path, createGetV2NoteHandler());
  app.put(V2_ROUTE_POLICY.note.path, createPutV2NoteHandler());
  app.delete(V2_ROUTE_POLICY.note.path, createDeleteV2NoteHandler());
  app.all(V2_ROUTE_POLICY.noteState.path, createUnsupportedNoteMethodHandler());
  app.all(V2_ROUTE_POLICY.note.path, createUnsupportedNoteMethodHandler());
  app.all(`${V2_ROUTE_POLICY.notes.path}/*`, createInvalidPathHandler());
  app.get(V2_ROUTE_POLICY.recovery.path, createListRecoveryHandler());
  app.get(
    V2_ROUTE_POLICY.recoveryContent.path,
    createGetRecoveryContentHandler(),
  );
  app.get(V2_ROUTE_POLICY.recoveryItem.path, createGetRecoveryHandler());
  app.post(V2_ROUTE_POLICY.recoverySeal.path, createSealRecoveryHandler());
  app.post(V2_ROUTE_POLICY.recoveryPurge.path, createPurgeRecoveryHandler());

  app.doc(OPENAPI_ROUTE, openApiConfiguration);
  app.get(API_REFERENCE_ROUTE, Scalar({ url: OPENAPI_ROUTE }));
  app.notFound(() => createErrorResponse(API_ERROR_CODE.notFound));
  app.onError(() => createErrorResponse(API_ERROR_CODE.internalError));

  return app;
}
