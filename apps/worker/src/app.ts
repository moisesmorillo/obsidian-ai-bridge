import { OpenAPIHono } from "@hono/zod-openapi";
import { API_ERROR_CODE } from "@obsidian-ai-bridge/protocol";
import { Scalar } from "@scalar/hono-api-reference";
import type { WorkerAppDependencies } from "@worker/app.types";
import {
  createErrorResponse,
  createUnauthorizedResponse,
} from "@worker/http/api-responses";
import { createAuthenticationMiddleware } from "@worker/http/authentication.middleware";
import type {
  WorkerApplication,
  WorkerBasePath,
  WorkerHonoEnvironment,
  WorkerMiddleware,
} from "@worker/http/hono.types";
import { API_V2_PREFIX } from "@worker/http/http.constants";
import { createHealthHandler } from "@worker/http/note.handlers";
import {
  deleteV2NoteRoute,
  getMirrorRoute,
  getRecoveryContentRoute,
  getRecoveryRoute,
  getV2NoteRoute,
  getV2NoteStateRoute,
  healthRoute,
  listRecoveryRoute,
  listV2NotesRoute,
  openApiConfiguration,
  purgeRecoveryRoute,
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
import {
  AUTHENTICATED_API_ROOT,
  ROUTE_OPERATION_KIND,
  ROUTE_OPERATION_POLICY,
  resolveRouteOperation,
  V2_ROUTE_POLICY,
} from "@worker/http/v2-route-policy";
import { createV2RoutePolicyGuardMiddleware } from "@worker/http/v2-route-policy.middleware";
import { createRequestLoggingMiddleware } from "@worker/logging/request-logging.middleware";
import type { BlankSchema } from "hono/types";

/**
 * Enforces the permission selected by the authoritative operation policy.
 *
 * Authentication publishes the principal first. Unknown API operations and exact
 * permission refusals terminate here before service construction or effect dispatch.
 *
 * @returns Middleware enforcing independent principal permissions without writer bypass.
 */
function createOperationAuthorizationMiddleware(): WorkerMiddleware {
  return async (context, next) => {
    const operation = resolveRouteOperation(
      new URL(context.req.url).pathname,
      context.req.method,
    );
    if (operation.kind === ROUTE_OPERATION_KIND.authenticatedUnknown) {
      return createErrorResponse(API_ERROR_CODE.notFound);
    }
    if (operation.kind !== ROUTE_OPERATION_KIND.permission) {
      await next();
      return;
    }

    const principal = context.var.clientPrincipal;
    if (principal === undefined) {
      return createUnauthorizedResponse(context);
    }
    if (!principal.permissions.includes(operation.permission)) {
      return createErrorResponse(API_ERROR_CODE.forbiddenWriter);
    }

    await next();
  };
}

/**
 * Builds the complete Hono transport adapter from infrastructure-agnostic ports.
 *
 * @param dependencies - Long-lived ports used to resolve request services and logging.
 * @returns A typed Hono application with public routes and authenticated v2 operations.
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
    AUTHENTICATED_API_ROOT,
    createAuthenticationMiddleware(dependencies.resolveAuthentication),
  );
  app.use(
    `${AUTHENTICATED_API_ROOT}/*`,
    createAuthenticationMiddleware(dependencies.resolveAuthentication),
  );
  app.use(AUTHENTICATED_API_ROOT, createOperationAuthorizationMiddleware());
  app.use(
    `${AUTHENTICATED_API_ROOT}/*`,
    createOperationAuthorizationMiddleware(),
  );
  app.use(AUTHENTICATED_API_ROOT, createV2RoutePolicyGuardMiddleware());
  app.use(`${AUTHENTICATED_API_ROOT}/*`, createV2RoutePolicyGuardMiddleware());
  app.use(
    AUTHENTICATED_API_ROOT,
    createRequestDependenciesMiddleware(dependencies.resolveMirrorServices),
  );
  app.use(
    `${AUTHENTICATED_API_ROOT}/*`,
    createRequestDependenciesMiddleware(dependencies.resolveMirrorServices),
  );

  [
    healthRoute,
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

  app.on(
    ROUTE_OPERATION_POLICY.public.health.method,
    ROUTE_OPERATION_POLICY.public.health.path,
    createHealthHandler(),
  );

  app.on(
    V2_ROUTE_POLICY.mirror.operations.describe,
    V2_ROUTE_POLICY.mirror.path,
    createGetMirrorHandler(),
  );
  app.on(
    V2_ROUTE_POLICY.notes.operations.list,
    V2_ROUTE_POLICY.notes.path,
    createListV2NotesHandler(),
  );
  app.on(
    V2_ROUTE_POLICY.noteState.operations.inspect,
    V2_ROUTE_POLICY.noteState.path,
    createGetV2NoteStateHandler(),
  );
  app.on(
    V2_ROUTE_POLICY.note.operations.read,
    V2_ROUTE_POLICY.note.path,
    createGetV2NoteHandler(),
  );
  app.on(
    V2_ROUTE_POLICY.note.operations.write,
    V2_ROUTE_POLICY.note.path,
    createPutV2NoteHandler(),
  );
  app.on(
    V2_ROUTE_POLICY.note.operations.remove,
    V2_ROUTE_POLICY.note.path,
    createDeleteV2NoteHandler(),
  );
  app.on(
    V2_ROUTE_POLICY.recovery.operations.list,
    V2_ROUTE_POLICY.recovery.path,
    createListRecoveryHandler(),
  );
  app.on(
    V2_ROUTE_POLICY.recoveryContent.operations.read,
    V2_ROUTE_POLICY.recoveryContent.path,
    createGetRecoveryContentHandler(),
  );
  app.on(
    V2_ROUTE_POLICY.recoveryItem.operations.inspect,
    V2_ROUTE_POLICY.recoveryItem.path,
    createGetRecoveryHandler(),
  );
  app.on(
    V2_ROUTE_POLICY.recoverySeal.operations.seal,
    V2_ROUTE_POLICY.recoverySeal.path,
    createSealRecoveryHandler(),
  );
  app.on(
    V2_ROUTE_POLICY.recoveryPurge.operations.purge,
    V2_ROUTE_POLICY.recoveryPurge.path,
    createPurgeRecoveryHandler(),
  );

  app.doc(ROUTE_OPERATION_POLICY.public.openApi.path, openApiConfiguration);
  app.on(
    ROUTE_OPERATION_POLICY.public.reference.method,
    ROUTE_OPERATION_POLICY.public.reference.path,
    Scalar({ url: ROUTE_OPERATION_POLICY.public.openApi.path }),
  );
  app.notFound(() => createErrorResponse(API_ERROR_CODE.notFound));
  app.onError(() => createErrorResponse(API_ERROR_CODE.internalError));

  return app;
}
