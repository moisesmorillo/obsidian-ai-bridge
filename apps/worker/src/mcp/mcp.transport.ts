import { createMcpHandler } from "@modelcontextprotocol/server";
import type { WorkerAppDependencies } from "@worker/app.types";
import type { WorkerContext, WorkerMiddleware } from "@worker/http/hono.types";
import {
  CACHE_CONTROL_HEADER,
  CACHE_CONTROL_NO_STORE,
  HTTP_HEADER,
  HTTP_STATUS,
  JSON_CONTENT_TYPE,
} from "@worker/http/http.constants";
import {
  MCP_ENDPOINT_PATH,
  MCP_HTTP_HEADER,
  MCP_HTTP_METHOD,
  MCP_MAX_REQUEST_BODY_BYTES,
  MCP_MAX_RESPONSE_BODY_BYTES,
  MCP_MAX_STREAM_CHUNKS,
  MCP_METHOD_NOT_ALLOWED_STATUS,
} from "@worker/mcp/mcp.constants";
import { createMcpServer } from "@worker/mcp/mcp.server";

/** Request bytes either become a bounded sanitized Request or a static transport refusal. */
type McpRequestValidation =
  | { readonly kind: "accepted"; readonly request: Request }
  | { readonly kind: "refused"; readonly response: Response };

/** A bounded stream read distinguishes a valid body from size and I/O failures. */
type McpBoundedBodyResult =
  | {
      readonly kind: "withinLimit";
      readonly bytes: Uint8Array<ArrayBuffer>;
    }
  | { readonly kind: "overLimit" }
  | { readonly kind: "readFailure" };

/** Creates the modern-only stateless MCP handler for the authenticated Worker request.
 *
 * @param dependencies - Long-lived Worker factories used to resolve authenticated request services.
 * @returns A request handler that bounds input/output and closes the SDK transport after dispatch.
 */
export function createMcpRequestHandler(dependencies: WorkerAppDependencies) {
  return async (context: WorkerContext): Promise<Response> => {
    const principal = context.var.clientPrincipal;
    if (principal === undefined) {
      return new Response(null, { status: HTTP_STATUS.unauthorized });
    }

    const handler = createMcpHandler(
      () =>
        createMcpServer({
          principal,
          resolveMirrorServices: () =>
            dependencies.resolveMirrorServices(context.env),
        }),
      {
        legacy: "reject",
        responseMode: "auto",
        maxSubscriptions: 0,
        onerror: () => undefined,
      },
    );

    try {
      const requestValidation = await validateRequestBody(context.req.raw);
      if (requestValidation.kind === "refused") {
        return requestValidation.response;
      }
      const response = await handler.fetch(requestValidation.request);
      const boundedResponse = await boundMcpResponse(response);
      return boundedResponse === undefined
        ? createMcpTransportRefusal(HTTP_STATUS.badGateway)
        : withNoStore(boundedResponse);
    } catch {
      return createMcpTransportRefusal(HTTP_STATUS.internalServerError);
    } finally {
      await handler.close().catch(() => undefined);
    }
  };
}

/** Checks media type, declared size, and actual bytes before reconstructing an SDK-only request.
 *
 * @param request - Authenticated original MCP POST with an untrusted streamed body.
 * @returns Sanitized SDK request or static HTTP refusal without exposing parser details.
 */
async function validateRequestBody(
  request: Request,
): Promise<McpRequestValidation> {
  const contentType = request.headers
    .get(HTTP_HEADER.contentType)
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    request.method !== MCP_HTTP_METHOD.post ||
    contentType !== JSON_CONTENT_TYPE
  ) {
    return {
      kind: "refused",
      response: createMcpTransportRefusal(HTTP_STATUS.unsupportedMediaType),
    };
  }

  const declaredLength = request.headers.get(HTTP_HEADER.contentLength);
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      return {
        kind: "refused",
        response: createMcpTransportRefusal(HTTP_STATUS.badRequest),
      };
    }
    if (Number(declaredLength) > MCP_MAX_REQUEST_BODY_BYTES) {
      return {
        kind: "refused",
        response: createMcpTransportRefusal(HTTP_STATUS.payloadTooLarge),
      };
    }
  }

  const body = await readBoundedStream(
    request.body,
    MCP_MAX_REQUEST_BODY_BYTES,
  );
  if (body.kind !== "withinLimit") {
    return {
      kind: "refused",
      response: createMcpTransportRefusal(
        body.kind === "overLimit"
          ? HTTP_STATUS.payloadTooLarge
          : HTTP_STATUS.badRequest,
      ),
    };
  }

  const headers = new Headers(request.headers);
  headers.delete(HTTP_HEADER.authorization);
  headers.delete(HTTP_HEADER.contentLength);
  headers.delete(MCP_HTTP_HEADER.cookie);
  return {
    kind: "accepted",
    request: new Request(request.url, {
      method: request.method,
      headers,
      body: body.bytes.byteLength === 0 ? null : body.bytes,
      signal: request.signal,
    }),
  };
}

/** Reads a stream into bounded memory and cancels when byte or chunk limits are crossed.
 *
 * @param stream - Untrusted request or SDK response body stream.
 * @param limit - Maximum accepted body bytes.
 * @returns Typed byte result distinguishing over-limit data from read failures.
 */
async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<McpBoundedBodyResult> {
  if (stream === null) {
    return {
      kind: "withinLimit",
      bytes: new Uint8Array(new ArrayBuffer(0)),
    };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let chunkCount = 0;
  let ended = false;
  try {
    while (!ended && totalBytes <= limit) {
      const next = await reader.read();
      ended = next.done;
      if (next.done) continue;
      chunkCount += 1;
      totalBytes += next.value.byteLength;
      if (totalBytes > limit || chunkCount > MCP_MAX_STREAM_CHUNKS) {
        await reader.cancel().catch(() => undefined);
        return { kind: "overLimit" };
      }
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { kind: "readFailure" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(new ArrayBuffer(totalBytes));
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return { kind: "withinLimit", bytes };
}

/** Rebuilds one bounded MCP response or returns `undefined` when its serialized result is oversized.
 *
 * @param response - SDK response whose serialized body must fit Worker limits.
 * @returns Buffered response preserving status/headers, or `undefined` when it cannot be bounded.
 */
async function boundMcpResponse(
  response: Response,
): Promise<Response | undefined> {
  const body = await readBoundedStream(
    response.body,
    MCP_MAX_RESPONSE_BODY_BYTES,
  );
  if (body.kind !== "withinLimit") return undefined;
  return new Response(body.bytes.byteLength === 0 ? null : body.bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Reconstructs a response with private, uncached semantics for all MCP outcomes.
 *
 * @param response - SDK or transport response to protect from shared caching.
 * @returns Equivalent response carrying the authoritative `no-store` directive.
 */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(CACHE_CONTROL_HEADER, CACHE_CONTROL_NO_STORE);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Wraps a standalone transport refusal in the same uncached response policy.
 *
 * @param status - Static HTTP status selected by the transport boundary.
 * @param allowPost - Whether a method refusal should advertise the sole accepted verb.
 * @returns Empty no-store response with an optional `Allow: POST` header.
 */
function createMcpTransportRefusal(
  status: number,
  allowPost = false,
): Response {
  const headers = new Headers({
    [CACHE_CONTROL_HEADER]: CACHE_CONTROL_NO_STORE,
  });
  if (allowPost) headers.set(MCP_HTTP_HEADER.allow, MCP_HTTP_METHOD.post);
  return new Response(null, { status, headers });
}

/** Applies same-origin POST-only policy before authentication and parsing on the MCP route.
 *
 * @returns Hono middleware rejecting unsupported methods and cross-origin browser requests.
 */
export function createMcpEndpointPolicyMiddleware(): WorkerMiddleware {
  return async (context, next) => {
    const requestUrl = new URL(context.req.url);
    if (requestUrl.pathname !== MCP_ENDPOINT_PATH) {
      await next();
      return;
    }

    if (context.req.method !== MCP_HTTP_METHOD.post) {
      return createMcpTransportRefusal(MCP_METHOD_NOT_ALLOWED_STATUS, true);
    }
    const origin = context.req.header(HTTP_HEADER.origin);
    if (origin !== undefined && !isSameOrigin(origin, requestUrl)) {
      return createMcpTransportRefusal(HTTP_STATUS.forbidden);
    }

    await next();
    context.header(CACHE_CONTROL_HEADER, CACHE_CONTROL_NO_STORE);
  };
}

/** Accepts only an HTTP(S) Origin serialized without credentials or extra URL components.
 *
 * @param origin - Untrusted Origin header value.
 * @param requestUrl - Canonical request URL whose origin is the comparison target.
 * @returns Whether the header is a valid exact same-origin serialization.
 */
function isSameOrigin(origin: string, requestUrl: URL): boolean {
  if (origin === "null") return false;
  try {
    const originUrl = new URL(origin);
    return (
      (originUrl.protocol === "http:" || originUrl.protocol === "https:") &&
      originUrl.username === "" &&
      originUrl.password === "" &&
      originUrl.pathname === "/" &&
      originUrl.search === "" &&
      originUrl.hash === "" &&
      originUrl.origin === requestUrl.origin
    );
  } catch {
    return false;
  }
}
