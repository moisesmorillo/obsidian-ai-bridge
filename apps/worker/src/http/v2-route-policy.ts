import {
  MIRROR_ROUTE,
  RECOVERY_ROUTE,
  V2_NOTES_ROUTE,
} from "@worker/http/http.constants";

/** HTTP methods represented by the public v2 route capability table. */
export type V2RouteMethod = "GET" | "PUT" | "DELETE" | "POST";

/** One public v2 route shape and its exact browser-visible method capability. */
interface V2RouteDefinition {
  readonly path: string;
  readonly methods: readonly V2RouteMethod[];
}

/**
 * Authoritative public v2 route shapes and method capabilities.
 *
 * Hono registration consumes each path, OpenAPI derives its brace-parameter path,
 * and CORS resolves preflight methods from the same definition.
 */
export const V2_ROUTE_POLICY = {
  mirror: { path: MIRROR_ROUTE, methods: ["GET"] },
  notes: { path: V2_NOTES_ROUTE, methods: ["GET"] },
  note: {
    path: `${V2_NOTES_ROUTE}/:path`,
    methods: ["GET", "PUT", "DELETE"],
  },
  noteState: { path: `${V2_NOTES_ROUTE}/:path/state`, methods: ["GET"] },
  recovery: { path: RECOVERY_ROUTE, methods: ["GET"] },
  recoveryItem: { path: `${RECOVERY_ROUTE}/:id`, methods: ["GET"] },
  recoveryContent: {
    path: `${RECOVERY_ROUTE}/:id/content`,
    methods: ["GET"],
  },
  recoverySeal: { path: `${RECOVERY_ROUTE}/:id/seal`, methods: ["POST"] },
  recoveryPurge: { path: `${RECOVERY_ROUTE}/:id/purge`, methods: ["POST"] },
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
  return V2_ROUTE_DEFINITIONS.find((route) =>
    matchesRouteShape(route.path, pathname),
  )?.methods;
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
