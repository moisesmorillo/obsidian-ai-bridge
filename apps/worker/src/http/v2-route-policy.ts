import {
  API_ROUTE_PARAMETER,
  HTTP_METHOD,
  MIRROR_API_V2_SEGMENT,
} from "@obsidian-ai-bridge/protocol";
import { CLIENT_PERMISSION } from "@worker/auth/auth.constants";
import type { ClientPermission } from "@worker/auth/auth.types";
import {
  API_REFERENCE_ROUTE,
  MIRROR_ROUTE,
  OPENAPI_ROUTE,
  RECOVERY_ROUTE,
  V2_NOTES_ROUTE,
} from "@worker/http/http.constants";
import type { LogOperationCategory } from "@worker/logging/logger.types";
import { LOG_OPERATION_CATEGORY } from "@worker/logging/logging.constants";

/** Root whose descendants require registry authentication even when unregistered. */
export const AUTHENTICATED_API_ROOT = "/api";

/** Public CORS preflight method derived for every registered v2 route shape. */
export const CORS_PREFLIGHT_METHOD = "OPTIONS";

/** Closed admission outcomes produced by the authoritative operation policy. */
export const ROUTE_OPERATION_KIND = {
  authenticatedUnknown: "authenticated_unknown",
  permission: "permission",
  public: "public",
  publicUnknown: "public_unknown",
} as const;

/** HTTP methods represented by the public v2 route capability table. */
export type V2RouteMethod = (typeof HTTP_METHOD)[keyof typeof HTTP_METHOD];

/** One authenticated v2 route shape and its named operations. */
interface V2RouteDefinition {
  readonly path: string;
  readonly operations: Readonly<Record<string, V2RouteMethod>>;
  readonly permissions: Readonly<Record<string, ClientPermission>>;
  readonly operationCategories: Readonly<Record<string, LogOperationCategory>>;
}

/** One public operation that never resolves a credential principal. */
interface PublicRouteDefinition {
  readonly path: string;
  readonly method: V2RouteMethod;
  readonly operationCategory: typeof LOG_OPERATION_CATEGORY.public;
}

/** Exhaustive policy result for one concrete HTTP operation. */
export type RouteOperationResolution =
  | {
      readonly kind: typeof ROUTE_OPERATION_KIND.public;
      readonly operationCategory: typeof LOG_OPERATION_CATEGORY.public;
    }
  | {
      readonly kind: typeof ROUTE_OPERATION_KIND.permission;
      readonly operationCategory: LogOperationCategory;
      readonly permission: ClientPermission;
    }
  | {
      readonly kind: typeof ROUTE_OPERATION_KIND.authenticatedUnknown;
      readonly operationCategory: typeof LOG_OPERATION_CATEGORY.unknown;
    }
  | {
      readonly kind: typeof ROUTE_OPERATION_KIND.publicUnknown;
      readonly operationCategory: typeof LOG_OPERATION_CATEGORY.unknown;
    };

/**
 * Defines one v2 route while requiring permission and diagnostics for every operation.
 *
 * @param path - Canonical Hono route shape.
 * @param operations - Named HTTP methods consumed by routing, CORS, and OpenAPI.
 * @param permissions - Exact independent permission required by each operation.
 * @param operationCategories - Closed diagnostic category for each operation.
 * @returns One definition checked across all policy projections.
 */
function defineV2Route<
  const Path extends string,
  const Operations extends Readonly<Record<string, V2RouteMethod>>,
>(
  path: Path,
  operations: Operations,
  permissions: {
    readonly [Name in keyof Operations]: ClientPermission;
  },
  operationCategories: {
    readonly [Name in keyof Operations]: LogOperationCategory;
  },
) {
  return { path, operations, permissions, operationCategories };
}

/**
 * Defines one exact public route operation.
 *
 * @param path - Canonical public route path.
 * @param method - Sole supported method for the route.
 * @returns Public operation definition used by diagnostics and admission policy.
 */
function definePublicRoute(
  path: string,
  method: V2RouteMethod,
): PublicRouteDefinition {
  return {
    path,
    method,
    operationCategory: LOG_OPERATION_CATEGORY.public,
  };
}

/**
 * Authoritative operation surface for public, v2, preflight, and unknown requests.
 *
 * Each registered v2 operation owns exactly one independent permission here. Public
 * preflight is derived only for these v2 shapes. Unknown `/api` descendants remain
 * authenticated but unmapped and therefore cannot dispatch storage or effects.
 */
export const ROUTE_OPERATION_POLICY = {
  public: {
    openApi: definePublicRoute(OPENAPI_ROUTE, HTTP_METHOD.get),
    reference: definePublicRoute(API_REFERENCE_ROUTE, HTTP_METHOD.get),
  },
  v2: {
    mirror: defineV2Route(
      MIRROR_ROUTE,
      { describe: HTTP_METHOD.get },
      { describe: CLIENT_PERMISSION.read },
      { describe: LOG_OPERATION_CATEGORY.mirrorRead },
    ),
    notes: defineV2Route(
      V2_NOTES_ROUTE,
      { list: HTTP_METHOD.get },
      { list: CLIENT_PERMISSION.read },
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
        read: CLIENT_PERMISSION.read,
        write: CLIENT_PERMISSION.write,
        remove: CLIENT_PERMISSION.delete,
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
      { inspect: CLIENT_PERMISSION.read },
      { inspect: LOG_OPERATION_CATEGORY.currentRead },
    ),
    recovery: defineV2Route(
      RECOVERY_ROUTE,
      { list: HTTP_METHOD.get },
      { list: CLIENT_PERMISSION.read },
      { list: LOG_OPERATION_CATEGORY.recoveryRead },
    ),
    recoveryItem: defineV2Route(
      `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}`,
      { inspect: HTTP_METHOD.get },
      { inspect: CLIENT_PERMISSION.read },
      { inspect: LOG_OPERATION_CATEGORY.recoveryRead },
    ),
    recoveryContent: defineV2Route(
      `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}/${MIRROR_API_V2_SEGMENT.content}`,
      { read: HTTP_METHOD.get },
      { read: CLIENT_PERMISSION.read },
      { read: LOG_OPERATION_CATEGORY.recoveryRead },
    ),
    recoverySeal: defineV2Route(
      `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}/${MIRROR_API_V2_SEGMENT.seal}`,
      { seal: HTTP_METHOD.post },
      { seal: CLIENT_PERMISSION.write },
      { seal: LOG_OPERATION_CATEGORY.recoveryMaintenance },
    ),
    recoveryPurge: defineV2Route(
      `${RECOVERY_ROUTE}/:${API_ROUTE_PARAMETER.recoveryId}/${MIRROR_API_V2_SEGMENT.purge}`,
      { purge: HTTP_METHOD.post },
      { purge: CLIENT_PERMISSION.delete },
      { purge: LOG_OPERATION_CATEGORY.destructiveMutation },
    ),
  },
} as const satisfies {
  readonly public: Readonly<Record<string, PublicRouteDefinition>>;
  readonly v2: Readonly<Record<string, V2RouteDefinition>>;
};

/** V2 route registration view derived from the exhaustive operation policy. */
export const V2_ROUTE_POLICY = ROUTE_OPERATION_POLICY.v2;

/** Derived public definitions; the exported policy remains authoritative. */
const PUBLIC_ROUTE_DEFINITIONS: readonly PublicRouteDefinition[] =
  Object.values(ROUTE_OPERATION_POLICY.public);

/** Derived v2 definitions; the exported policy remains authoritative. */
const V2_ROUTE_DEFINITIONS: readonly V2RouteDefinition[] = Object.values(
  ROUTE_OPERATION_POLICY.v2,
);

/**
 * Resolves the complete admission, permission, and diagnostic policy for a request.
 *
 * @param pathname - Literal URL pathname without query data.
 * @param method - Request method at the transport boundary.
 * @returns Exhaustive public, permission, or fail-closed unknown classification.
 */
export function resolveRouteOperation(
  pathname: string,
  method: string,
): RouteOperationResolution {
  const publicRoute = PUBLIC_ROUTE_DEFINITIONS.find(
    (definition) =>
      definition.path === pathname && definition.method === method,
  );
  if (publicRoute !== undefined) {
    return {
      kind: ROUTE_OPERATION_KIND.public,
      operationCategory: publicRoute.operationCategory,
    };
  }

  const v2Route = V2_ROUTE_DEFINITIONS.find((definition) =>
    matchesRouteShape(definition.path, pathname),
  );
  if (v2Route !== undefined && method === CORS_PREFLIGHT_METHOD) {
    return {
      kind: ROUTE_OPERATION_KIND.public,
      operationCategory: LOG_OPERATION_CATEGORY.public,
    };
  }
  if (v2Route !== undefined) {
    const operationName = Object.entries(v2Route.operations).find(
      ([, operationMethod]) => operationMethod === method,
    )?.[0];
    if (operationName !== undefined) {
      const operationCategory = v2Route.operationCategories[operationName];
      const permission = v2Route.permissions[operationName];
      if (operationCategory !== undefined && permission !== undefined) {
        return {
          kind: ROUTE_OPERATION_KIND.permission,
          operationCategory,
          permission,
        };
      }
    }
  }

  if (
    pathname === AUTHENTICATED_API_ROOT ||
    pathname.startsWith(`${AUTHENTICATED_API_ROOT}/`)
  ) {
    return {
      kind: ROUTE_OPERATION_KIND.authenticatedUnknown,
      operationCategory: LOG_OPERATION_CATEGORY.unknown,
    };
  }

  return {
    kind: ROUTE_OPERATION_KIND.publicUnknown,
    operationCategory: LOG_OPERATION_CATEGORY.unknown,
  };
}

/**
 * Resolves exact non-preflight methods for one concrete v2 pathname.
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
