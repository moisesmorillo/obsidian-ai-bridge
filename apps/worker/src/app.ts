import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { WorkerAppDependencies } from "@worker/app.types";
import { createErrorResponse } from "@worker/http/api-responses";
import { createAuthenticationMiddleware } from "@worker/http/authentication.middleware";
import type {
  WorkerApplication,
  WorkerHonoEnvironment,
} from "@worker/http/hono.types";
import {
  API_PREFIX,
  API_REFERENCE_ROUTE,
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
  getNoteRoute,
  healthRoute,
  listNotesRoute,
  openApiConfiguration,
  putNoteRoute,
} from "@worker/http/openapi.routes";
import { createRequestDependenciesMiddleware } from "@worker/http/request-dependencies.middleware";
import { createRequestLoggingMiddleware } from "@worker/logging/request-logging.middleware";

/** Builds the complete Hono transport adapter from infrastructure-agnostic ports. */
export function createWorkerApp(
  dependencies: WorkerAppDependencies,
): WorkerApplication {
  const app = new OpenAPIHono<WorkerHonoEnvironment>();

  app.use(createRequestLoggingMiddleware(dependencies.logger));
  app.use(createRequestDependenciesMiddleware(dependencies.resolveNoteService));
  app.use(
    API_PREFIX,
    createAuthenticationMiddleware(dependencies.resolveToken),
  );
  app.use(
    `${API_PREFIX}/*`,
    createAuthenticationMiddleware(dependencies.resolveToken),
  );

  app.openapi(healthRoute, createHealthHandler());
  app.openapi(listNotesRoute, createListNotesHandler());
  app.openapi(getNoteRoute, createGetNoteHandler());
  app.openapi(putNoteRoute, createPutNoteHandler());
  app.openapi(deleteNoteRoute, createDeleteNoteHandler());
  app.all(`${NOTES_ROUTE}/:path`, createUnsupportedNoteMethodHandler());
  app.all(`${NOTES_ROUTE}/*`, createInvalidPathHandler());

  app.doc(OPENAPI_ROUTE, openApiConfiguration);
  app.get(API_REFERENCE_ROUTE, Scalar({ url: OPENAPI_ROUTE }));
  app.notFound(() => createErrorResponse("not_found"));
  app.onError(() => createErrorResponse("internal_error"));

  return app;
}
