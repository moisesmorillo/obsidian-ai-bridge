import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ContentSha256, SyncDemoService } from "@obsidian-ai-bridge/core";
import {
  HTTP_METHOD,
  MAX_SYNC_DEMO_REQUEST_BYTES,
  SYNC_DEMO_CORS_ORIGIN,
  SYNC_DEMO_LOOPBACK_HOSTS,
  SYNC_DEMO_OPERATION,
  SYNC_DEMO_ROUTE,
  SYNC_DEMO_TRANSPORT_ERROR,
  SYNC_DEMO_URL_PROTOCOL,
  syncDemoRequestSchema,
  syncDemoResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import { Scalar } from "@scalar/hono-api-reference";
import {
  AUTHENTICATION_RESULT_KIND,
  AUTHENTICATION_SCHEME,
  CLIENT_PERMISSION,
  WWW_AUTHENTICATE_HEADER,
} from "@worker/auth/auth.constants";
import { authenticateRequest } from "@worker/auth/authenticate-request";
import {
  decodeSyncDemoConfiguration,
  type SyncDemoConfiguration,
} from "@worker/demo/demo-configuration";
import {
  API_REFERENCE_ROUTE,
  CACHE_CONTROL_HEADER,
  CACHE_CONTROL_NO_STORE,
  HTTP_HEADER,
  HTTP_STATUS,
  JSON_CONTENT_TYPE,
  MARKDOWN_MEDIA_TYPE,
  OPENAPI_ROUTE,
} from "@worker/http/http.constants";
import { parseMediaType } from "@worker/http/media-type";
import { cors } from "hono/cors";

/** Experimental app dependencies; construction grants no storage authority until request admission. */
export interface SyncDemoAppDependencies {
  /** Explicit lab configuration, separate from existing Worker environment settings. */
  readonly configuration: string | undefined;
  /** Disposable digest registry only; raw tokens are never retained here. */
  readonly registry: string | undefined;
  /** Resolves one scope-bound core service after authentication and exact permission checks. */
  readonly resolveService: (
    configuration: SyncDemoConfiguration,
  ) => SyncDemoService;
  /** Adapter-owned SHA-256 implementation over the exact submitted UTF-8 bytes. */
  readonly digest: (content: string) => Promise<ContentSha256>;
}

/** No runtime bindings or contextual weak types cross this constructor-injected HTTP app. */
type DemoHonoEnvironment = { Bindings: never; Variables: never };
/** Authoritative permission map for the closed demo operation set; write never implies read. */
const permissions = {
  [SYNC_DEMO_OPERATION.current]: CLIENT_PERMISSION.read,
  [SYNC_DEMO_OPERATION.version]: CLIENT_PERMISSION.read,
  [SYNC_DEMO_OPERATION.changes]: CLIENT_PERMISSION.read,
  [SYNC_DEMO_OPERATION.mutate]: CLIENT_PERMISSION.write,
} as const;
/** Fail-closed lab availability status, not a successful domain acknowledgement. */
const DEMO_UNAVAILABLE_STATUS = 503;
/** Local OpenAPI security component identity, not a token scheme or an authorization capability. */
const DEMO_BEARER_SECURITY_SCHEME = "bearerAuth";
/** Sanitized transport envelope; domain certainty remains in the separate response schema. */
const transportFailureSchema = z
  .object({
    kind: z.literal("error"),
    code: z.enum(Object.values(SYNC_DEMO_TRANSPORT_ERROR)),
  })
  .strict();
/** Shared documented JSON failure representation; each status retains its separate admission meaning. */
const transportFailureContent = {
  [JSON_CONTENT_TYPE]: { schema: transportFailureSchema },
};
/** One schema-derived operation document, registered without an unbounded automatic JSON parser. */
const requestRoute = createRoute({
  method: "post",
  path: SYNC_DEMO_ROUTE,
  security: [{ [DEMO_BEARER_SECURITY_SCHEME]: [] }],
  request: {
    body: {
      required: true,
      content: { [JSON_CONTENT_TYPE]: { schema: syncDemoRequestSchema } },
    },
  },
  responses: {
    [HTTP_STATUS.ok]: {
      description:
        "Typed store outcome; only kind=committed is a mutation acknowledgement.",
      content: { [JSON_CONTENT_TYPE]: { schema: syncDemoResponseSchema } },
    },
    [HTTP_STATUS.badRequest]: {
      description: "Invalid bounded request",
      content: transportFailureContent,
    },
    [HTTP_STATUS.unauthorized]: {
      description: "Registry authentication required",
      content: transportFailureContent,
    },
    [HTTP_STATUS.forbidden]: {
      description: "Participant or independent permission denied",
      content: transportFailureContent,
    },
    [HTTP_STATUS.payloadTooLarge]: {
      description: "Encoded request byte limit exceeded",
      content: transportFailureContent,
    },
    [DEMO_UNAVAILABLE_STATUS]: {
      description: "Lab unavailable or unarmed",
      content: transportFailureContent,
    },
  },
});

/** Reads at most the encoded JSON ceiling regardless of Content-Length; exceptions never supply payloads.
 * @param request Incoming raw stream, consumed once after authentication.
 * @returns Strict UTF-8 text or a closed body failure; over-limit streams are canceled.
 */
async function readDemoBody(
  request: Request,
): Promise<
  { kind: "text"; text: string } | { kind: "invalid" } | { kind: "too_large" }
> {
  if (!request.body) return { kind: "invalid" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      size += chunk.value.byteLength;
      if (size > MAX_SYNC_DEMO_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(chunk.value);
      chunk = await reader.read();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of chunks) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }
}

/** Composes only lab routes; even armed requests must have a loopback URL and an admitted registry principal.
 * @param dependencies Explicit local authority and adapter capabilities; no ambient registry fallback.
 * @returns Separate HTTP app with no existing v2/MCP route composition.
 */
export function createSyncDemoApp(dependencies: SyncDemoAppDependencies) {
  const app = new OpenAPIHono<DemoHonoEnvironment>();
  const configuration = decodeSyncDemoConfiguration(dependencies.configuration);
  app.use("*", async (context, next) => {
    context.header(CACHE_CONTROL_HEADER, CACHE_CONTROL_NO_STORE);
    const url = new URL(context.req.url);
    if (
      configuration === null ||
      url.protocol !== SYNC_DEMO_URL_PROTOCOL ||
      !SYNC_DEMO_LOOPBACK_HOSTS.some((host) => host === url.hostname)
    ) {
      return context.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.unavailable },
        DEMO_UNAVAILABLE_STATUS,
      );
    }
    await next();
  });
  app.use(
    SYNC_DEMO_ROUTE,
    cors({
      origin: SYNC_DEMO_CORS_ORIGIN,
      allowMethods: [HTTP_METHOD.post],
      allowHeaders: [HTTP_HEADER.authorization, HTTP_HEADER.contentType],
      maxAge: 0,
    }),
  );
  app.onError(() =>
    Response.json(
      { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.unavailable },
      {
        status: DEMO_UNAVAILABLE_STATUS,
        headers: { [CACHE_CONTROL_HEADER]: CACHE_CONTROL_NO_STORE },
      },
    ),
  );
  app.openAPIRegistry.registerComponent(
    "securitySchemes",
    DEMO_BEARER_SECURITY_SCHEME,
    {
      type: "http",
      scheme: "bearer",
    },
  );
  app.openAPIRegistry.registerPath(requestRoute);
  app.doc(OPENAPI_ROUTE, {
    openapi: "3.0.0",
    info: {
      title: "Synthetic local sync demo — not a production API",
      version: "1",
    },
  });
  app.get(API_REFERENCE_ROUTE, Scalar({ url: OPENAPI_ROUTE }));
  app.post(SYNC_DEMO_ROUTE, async (context) => {
    if (!configuration)
      return context.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.unavailable },
        DEMO_UNAVAILABLE_STATUS,
      );
    const auth = await authenticateRequest(context.req.raw.headers, {
      serializedRegistry: dependencies.registry,
    });
    if (auth.kind !== AUTHENTICATION_RESULT_KIND.authenticated) {
      context.header(WWW_AUTHENTICATE_HEADER, AUTHENTICATION_SCHEME.bearer);
      return context.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.unauthorized },
        HTTP_STATUS.unauthorized,
      );
    }
    const participant = configuration.participants.find(
      (candidate) => candidate.clientId === auth.principal.clientId,
    );
    if (!participant)
      return context.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.forbidden },
        HTTP_STATUS.forbidden,
      );
    if (
      parseMediaType(context.req.header(HTTP_HEADER.contentType)) !==
      JSON_CONTENT_TYPE
    ) {
      return context.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.invalidRequest },
        HTTP_STATUS.badRequest,
      );
    }
    const body = await readDemoBody(context.req.raw);
    if (body.kind === "too_large")
      return context.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.tooLarge },
        HTTP_STATUS.payloadTooLarge,
      );
    if (body.kind !== "text")
      return context.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.invalidRequest },
        HTTP_STATUS.badRequest,
      );
    let parsed: ReturnType<typeof syncDemoRequestSchema.safeParse>;
    try {
      parsed = syncDemoRequestSchema.safeParse(JSON.parse(body.text));
    } catch {
      return context.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.invalidRequest },
        HTTP_STATUS.badRequest,
      );
    }
    if (!parsed.success)
      return context.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.invalidRequest },
        HTTP_STATUS.badRequest,
      );
    const request = parsed.data;
    if (!auth.principal.permissions.includes(permissions[request.operation]))
      return context.json(
        { kind: "error", code: SYNC_DEMO_TRANSPORT_ERROR.forbidden },
        HTTP_STATUS.forbidden,
      );
    const service = dependencies.resolveService(configuration);
    switch (request.operation) {
      case SYNC_DEMO_OPERATION.current:
        return context.json(
          await service.readCurrent(request.path),
          HTTP_STATUS.ok,
        );
      case SYNC_DEMO_OPERATION.version:
        return context.json(
          await service.readVersion(request.revision),
          HTTP_STATUS.ok,
        );
      case SYNC_DEMO_OPERATION.changes:
        return context.json(
          await service.readChanges(request.cursor),
          HTTP_STATUS.ok,
        );
      case SYNC_DEMO_OPERATION.mutate:
        return context.json(
          await service.mutate({
            ...request.mutation,
            vaultId: configuration.vaultId,
            origin: participant.origin,
            contentSha256: await dependencies.digest(request.mutation.content),
            mediaType: MARKDOWN_MEDIA_TYPE,
          }),
          HTTP_STATUS.ok,
        );
    }
  });
  return app;
}
