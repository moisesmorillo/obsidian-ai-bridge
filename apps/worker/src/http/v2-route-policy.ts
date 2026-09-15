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

/** HTTP methods represented by the public v2 route capability table. */
export type V2RouteMethod = (typeof HTTP_METHOD)[keyof typeof HTTP_METHOD];

/** One public v2 route shape and its named browser-visible operations. */
interface V2RouteDefinition {
  readonly path: string;
  readonly operations: Readonly<Record<string, V2RouteMethod>>;
}

/**
 * Authoritative public v2 route shapes and method capabilities.
 *
 * Hono registration consumes each path, OpenAPI derives its brace-parameter path,
 * and CORS resolves preflight methods from the same definition.
 */
export const V2_ROUTE_POLICY = {
  mirror: {
    path: MIRROR_ROUTE,
    operations: { describe: HTTP_METHOD.get },
  },
  notes: {
    path: V2_NOTES_ROUTE,
    operations: { list: HTTP_METHOD.get },
  },
  note: {
    path: `${V2_NOTES_ROUTE}/:${API_ROUTE_PARAMETER.notePath}`,
    operations: {
      read: HTTP_METHOD.get,
      write: HTTP_METHOD.put,
      remove: HTTP_METHOD.delete,
    },
  },
  noteState: {
    path: `${V2_NOTES_ROUTE}/:${API_ROUTE_PARAMETER.notePath}/${MIRROR_API_V2_SEGMENT.state}`,
    operations: { inspect: HTTP_METHOD.get },
  },
  recovery: {
    path: RECOVERY_ROUTE,
    operations: { list: HTTP_METHOD.get },
  },
  recoveryItem: {
    path: `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}`,
    operations: { inspect: HTTP_METHOD.get },
  },
  recoveryContent: {
    path: `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}/${MIRROR_API_V2_SEGMENT.content}`,
    operations: { read: HTTP_METHOD.get },
  },
  recoverySeal: {
    path: `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}/${MIRROR_API_V2_SEGMENT.seal}`,
    operations: { seal: HTTP_METHOD.post },
  },
  recoveryPurge: {
    path: `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}/${MIRROR_API_V2_SEGMENT.purge}`,
    operations: { purge: HTTP_METHOD.post },
  },
} as const satisfies Record<string, V2RouteDefinition>;

const V2_ROUTE_DEFINITIONS = Object.values(V2_ROUTE_POLICY);

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
