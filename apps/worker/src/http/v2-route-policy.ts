import {
  API_ROUTE_PARAMETER,
  HTTP_METHOD,
  MIRROR_API_V2_SEGMENT,
} from "@obsidian-ai-bridge/protocol";
import {
  MIRROR_ROUTE,
  RECOVERY_ROUTE,
  V2_NOTES_ROUTE,
} from "@worker/http/http.constants";
import type { LogOperationCategory } from "@worker/logging/logger.types";
import { LOG_OPERATION_CATEGORY } from "@worker/logging/logging.constants";

/** HTTP methods represented by the public v2 route capability table. */
export type V2RouteMethod = (typeof HTTP_METHOD)[keyof typeof HTTP_METHOD];

/** One public v2 route shape and its named browser-visible operations. */
interface V2RouteDefinition {
  readonly path: string;
  readonly operations: Readonly<Record<string, V2RouteMethod>>;
  readonly operationCategories: Readonly<Record<string, LogOperationCategory>>;
}

/**
 * Defines one route while requiring diagnostic attribution for every named operation.
 *
 * @param path - Canonical Hono route shape.
 * @param operations - Named HTTP methods consumed by routing, CORS, and OpenAPI.
 * @param operationCategories - Closed diagnostic category for each named operation.
 * @returns One route definition with operation names checked across both projections.
 */
function defineV2Route<
  const Path extends string,
  const Operations extends Readonly<Record<string, V2RouteMethod>>,
>(
  path: Path,
  operations: Operations,
  operationCategories: {
    readonly [Name in keyof Operations]: LogOperationCategory;
  },
) {
  return { path, operations, operationCategories };
}

/**
 * Authoritative public v2 route shapes and method capabilities.
 *
 * Hono registration consumes each path, OpenAPI derives its brace-parameter path,
 * and CORS resolves preflight methods from the same definition.
 */
export const V2_ROUTE_POLICY = {
  mirror: defineV2Route(
    MIRROR_ROUTE,
    { describe: HTTP_METHOD.get },
    { describe: LOG_OPERATION_CATEGORY.mirrorRead },
  ),
  notes: defineV2Route(
    V2_NOTES_ROUTE,
    { list: HTTP_METHOD.get },
    { list: LOG_OPERATION_CATEGORY.currentRead },
  ),
  note: defineV2Route(
    `${V2_NOTES_ROUTE}/:${API_ROUTE_PARAMETER.notePath}`,
    {
      read: HTTP_METHOD.get,
      write: HTTP_METHOD.put,
      remove: HTTP_METHOD.delete,
    },
    {
      read: LOG_OPERATION_CATEGORY.currentRead,
      write: LOG_OPERATION_CATEGORY.currentMutation,
      remove: LOG_OPERATION_CATEGORY.destructiveMutation,
    },
  ),
  noteState: defineV2Route(
    `${V2_NOTES_ROUTE}/:${API_ROUTE_PARAMETER.notePath}/${MIRROR_API_V2_SEGMENT.state}`,
    { inspect: HTTP_METHOD.get },
    { inspect: LOG_OPERATION_CATEGORY.currentRead },
  ),
  recovery: defineV2Route(
    RECOVERY_ROUTE,
    { list: HTTP_METHOD.get },
    { list: LOG_OPERATION_CATEGORY.recoveryRead },
  ),
  recoveryItem: defineV2Route(
    `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}`,
    { inspect: HTTP_METHOD.get },
    { inspect: LOG_OPERATION_CATEGORY.recoveryRead },
  ),
  recoveryContent: defineV2Route(
    `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}/${MIRROR_API_V2_SEGMENT.content}`,
    { read: HTTP_METHOD.get },
    { read: LOG_OPERATION_CATEGORY.recoveryRead },
  ),
  recoverySeal: defineV2Route(
    `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}/${MIRROR_API_V2_SEGMENT.seal}`,
    { seal: HTTP_METHOD.post },
    { seal: LOG_OPERATION_CATEGORY.recoveryMaintenance },
  ),
  recoveryPurge: defineV2Route(
    `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}/${MIRROR_API_V2_SEGMENT.purge}`,
    { purge: HTTP_METHOD.post },
    { purge: LOG_OPERATION_CATEGORY.destructiveMutation },
  ),
} as const satisfies Record<string, V2RouteDefinition>;

/** Derived route lookup view; V2_ROUTE_POLICY remains the sole method/path capability authority. */
const V2_ROUTE_DEFINITIONS: readonly V2RouteDefinition[] =
  Object.values(V2_ROUTE_POLICY);

/**
 * Resolves exact methods for one concrete pathname against public route shapes.
 *
 * @param pathname - URL pathname without query data.
 * @returns Exact allowed methods, or `undefined` for an unknown route shape.
 */
export function resolveV2RouteMethods(
  pathname: string,
): readonly V2RouteMethod[] | undefined {
  const route = V2_ROUTE_DEFINITIONS.find((definition) =>
    matchesRouteShape(definition.path, pathname),
  );
  return route === undefined ? undefined : Object.values(route.operations);
}

/**
 * Resolves the closed diagnostic category for one exact v2 route operation.
 *
 * This projection observes route semantics only; it grants no permission and does
 * not alter route admission or dispatch.
 *
 * @param pathname - URL pathname without query data.
 * @param method - Request method to match against the registered operation.
 * @returns Closed category, or `undefined` for an unknown route or method.
 */
export function resolveV2LogOperationCategory(
  pathname: string,
  method: string,
): LogOperationCategory | undefined {
  const route = V2_ROUTE_DEFINITIONS.find((definition) =>
    matchesRouteShape(definition.path, pathname),
  );
  if (route === undefined) return undefined;

  const operationName = Object.entries(route.operations).find(
    ([, operationMethod]) => operationMethod === method,
  )?.[0];
  return operationName === undefined
    ? undefined
    : route.operationCategories[operationName];
}

/**
 * Converts the Hono parameter syntax owned by the route table to OpenAPI syntax.
 *
 * @param routePath - Authoritative Hono route shape.
 * @returns Equivalent OpenAPI path with brace-delimited parameters.
 */
export function toOpenApiV2RoutePath(routePath: string): string {
  return routePath
    .split("/")
    .map((segment) =>
      segment.startsWith(":") ? `{${segment.slice(1)}}` : segment,
    )
    .join("/");
}

/**
 * Matches one concrete pathname without decoding or validating parameter values.
 *
 * Literal identifier validation remains the route handler's responsibility; CORS
 * needs only the same non-empty single-segment shape accepted by Hono routing.
 *
 * @param routePath - Hono route shape containing whole-segment parameters.
 * @param pathname - Concrete undecorated URL pathname.
 * @returns Whether the concrete pathname has the same literal/parameter segments.
 */
function matchesRouteShape(routePath: string, pathname: string): boolean {
  const routeSegments = routePath.split("/");
  const pathnameSegments = pathname.split("/");
  if (routeSegments.length !== pathnameSegments.length) return false;

  return routeSegments.every((routeSegment, index) => {
    const pathnameSegment = pathnameSegments[index];
    if (routeSegment.startsWith(":")) {
      return pathnameSegment !== undefined && pathnameSegment !== "";
    }
    return routeSegment === pathnameSegment;
  });
}
