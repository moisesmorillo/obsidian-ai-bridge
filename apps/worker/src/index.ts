/// <reference types="@cloudflare/workers-types" />

import {
  decodeNotePath,
  deleteNote,
  listNotes,
  NotePayloadTooLargeError,
  readNote,
  writeNote,
} from "@obsidian-ai-bridge/core";
import type { NotePath, VaultRepository } from "@obsidian-ai-bridge/core";
import type {
  ApiErrorCode,
  ApiErrorResponse,
  HealthResponse,
  NoteListResponse,
  NoteWriteResponse,
} from "@obsidian-ai-bridge/protocol";
import { hasValidBearerToken } from "./auth";
import { readNoteBody } from "./body";
import { R2VaultRepository } from "./r2-repository";

const apiPrefix = "/api/v1";
const notesPath = `${apiPrefix}/notes`;

export interface Env {
  readonly VAULT_BUCKET: R2Bucket;
  readonly OBSIDIAN_BRIDGE_TOKEN: string;
}

export interface RequestLog {
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
}

export interface RequestHandlerDependencies {
  readonly repository: VaultRepository;
  readonly token?: string;
  readonly logger?: (entry: RequestLog) => void;
}

const defaultLogger = (entry: RequestLog): void => {
  console.log(JSON.stringify(entry));
};

function jsonResponse(
  body: unknown,
  status: number,
  additionalHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...additionalHeaders,
    },
  });
}

function errorResponse(
  code: ApiErrorCode,
  message: string,
  status: number,
  additionalHeaders: Record<string, string> = {},
): Response {
  const body: ApiErrorResponse = {
    error: { code, message },
  };
  return jsonResponse(body, status, additionalHeaders);
}

function pathname(request: Request): string {
  // Base64url identifiers contain no path separators or dot segments to normalize.
  return new URL(request.url).pathname;
}

function routeLabel(request: Request): string {
  const requestPathname = pathname(request);
  if (requestPathname === "/health") {
    return "/health";
  }
  if (requestPathname === notesPath) {
    return notesPath;
  }
  if (requestPathname.startsWith(`${notesPath}/`)) {
    return `${notesPath}/:path`;
  }
  return "unknown";
}

function isApiPath(pathname: string): boolean {
  return pathname === apiPrefix || pathname.startsWith(`${apiPrefix}/`);
}

function isSupportedContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return true;
  }

  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/markdown" || mediaType === "text/plain";
}

function pathFromRequest(pathname: string): NotePath | undefined {
  const encodedPath = pathname.slice(`${notesPath}/`.length);
  if (encodedPath.includes("/")) {
    return undefined;
  }

  return decodeNotePath(encodedPath);
}

async function dispatchRequest(
  request: Request,
  dependencies: RequestHandlerDependencies,
): Promise<Response> {
  const requestPathname = pathname(request);

  if (requestPathname === "/health" && request.method === "GET") {
    const body: HealthResponse = { status: "ok" };
    return jsonResponse(body, 200);
  }

  if (!isApiPath(requestPathname)) {
    return errorResponse(
      "not_found",
      "The requested resource was not found.",
      404,
    );
  }

  if (!hasValidBearerToken(request, dependencies.token)) {
    return errorResponse("unauthorized", "Authentication is required.", 401, {
      "WWW-Authenticate": "Bearer",
    });
  }

  if (requestPathname === notesPath && request.method === "GET") {
    const body: NoteListResponse = {
      notes: await listNotes(dependencies.repository),
    };
    return jsonResponse(body, 200);
  }

  if (!requestPathname.startsWith(`${notesPath}/`)) {
    return errorResponse(
      "not_found",
      "The requested resource was not found.",
      404,
    );
  }

  const path = pathFromRequest(requestPathname);
  if (path === undefined) {
    return errorResponse("invalid_path", "The note path is invalid.", 400);
  }

  if (request.method === "GET") {
    return getNoteResponse(dependencies.repository, path);
  }

  if (request.method === "PUT") {
    return putNoteResponse(request, dependencies.repository, path);
  }

  if (request.method === "DELETE") {
    await deleteNote(dependencies.repository, path);
    return new Response(null, { status: 204 });
  }

  return errorResponse(
    "not_found",
    "The requested resource was not found.",
    404,
  );
}

async function getNoteResponse(
  repository: VaultRepository,
  path: NotePath,
): Promise<Response> {
  const content = await readNote(repository, path);
  if (content === null) {
    return errorResponse("not_found", "The requested note was not found.", 404);
  }

  return new Response(content, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

async function putNoteResponse(
  request: Request,
  repository: VaultRepository,
  path: NotePath,
): Promise<Response> {
  if (!isSupportedContentType(request.headers.get("Content-Type"))) {
    return errorResponse(
      "unsupported_media_type",
      "The request body must use Markdown or plain text content.",
      415,
    );
  }

  const body = await readNoteBody(request);
  if (body.kind === "too_large") {
    return errorResponse(
      "payload_too_large",
      "The note exceeds the 1 MiB size limit.",
      413,
    );
  }
  if (body.kind === "invalid_encoding") {
    return errorResponse(
      "invalid_body",
      "The request body must be valid UTF-8 text.",
      400,
    );
  }

  try {
    const result = await writeNote(repository, path, body.content);
    const response: NoteWriteResponse = {
      path,
      stored: true,
    };
    return jsonResponse(response, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof NotePayloadTooLargeError) {
      return errorResponse(
        "payload_too_large",
        "The note exceeds the 1 MiB size limit.",
        413,
      );
    }
    throw error;
  }
}

export async function handleRequest(
  request: Request,
  dependencies: RequestHandlerDependencies,
): Promise<Response> {
  const startedAt = performance.now();
  const logger = dependencies.logger ?? defaultLogger;
  const route = routeLabel(request);
  let status = 500;

  try {
    const response = await dispatchRequest(request, dependencies);
    status = response.status;
    return response;
  } catch {
    return errorResponse("internal_error", "An internal error occurred.", 500);
  } finally {
    logger({
      method: request.method,
      route,
      status,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    });
  }
}

const worker = {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      repository: new R2VaultRepository(env.VAULT_BUCKET),
      token: env.OBSIDIAN_BRIDGE_TOKEN,
    });
  },
};

export default worker;
