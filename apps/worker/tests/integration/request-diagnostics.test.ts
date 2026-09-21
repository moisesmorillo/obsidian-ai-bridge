import { encodeNotePath, normalizeNotePath } from "@obsidian-ai-bridge/core";
import { API_ERROR_CODE } from "@obsidian-ai-bridge/protocol";
import { createWorkerApp } from "@worker/app";
import { CLIENT_PERMISSION } from "@worker/auth/auth.constants";
import {
  digestCredentialToken,
  serializeCredentialRegistry,
} from "@worker/auth/credential-registry";
import type { Logger, RequestLogEntry } from "@worker/logging/logger.types";
import {
  LOG_AUTHENTICATION_RESULT,
  LOG_OPERATION_CATEGORY,
} from "@worker/logging/logging.constants";
import {
  createTestMirrorServices,
  MemoryMirrorBucket,
  TEST_ASSOCIATION_ID,
  TEST_WRITER_ID,
} from "@worker-tests/support/mirror-test-kit";
import { describe, expect, it } from "vitest";

const FIRST_CLIENT = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Primary writer",
  token: "primary-registry-token",
} as const;
const SECOND_CLIENT = {
  id: "66666666-6666-4666-8666-666666666666",
  name: "Secondary reader",
  token: "secondary-registry-token",
} as const;
const REVOKED_TOKEN = "revoked-registry-token";
const PRIVATE_PATH = "Private/Diagnostic.md";
const RECOVERY_ID = "77777777-7777-4777-8777-777777777777";
const OPERATION_ID = "88888888-8888-4888-8888-888888888888";
const PRIVATE_REVISION = "m3-99999999-9999-4999-8999-999999999999";
const PRIVATE_BODY = "private note body with hash abcdef0123456789";

/** In-memory structured event sink used to inspect exact diagnostic projections. */
class CapturingLogger implements Logger {
  readonly entries: RequestLogEntry[] = [];

  /**
   * Retains one already-sanitized event for assertions.
   *
   * @param entry - Content-free structured request event.
   * @returns Nothing after retaining the event.
   */
  info(entry: RequestLogEntry): void {
    this.entries.push(entry);
  }
}

/**
 * Creates a canonical encoded note identifier for diagnostic leakage tests.
 *
 * @param path - Valid literal note path fixture.
 * @returns Canonical base64url route identifier.
 */
function encodedPath(path: string): string {
  const normalized = normalizeNotePath(path);
  if (normalized === undefined) throw new Error("Invalid test path");
  return encodeNotePath(normalized);
}

/**
 * Builds the complete mutation header family without exposing it to log assertions.
 *
 * @param token - Registry token supplied only to the request boundary.
 * @returns Complete conditional mutation headers.
 */
function mutationHeaders(token: string): Headers {
  return new Headers({
    Authorization: `Bearer ${token}`,
    "Bridge-Association-Id": TEST_ASSOCIATION_ID,
    "Bridge-Writer-Id": TEST_WRITER_ID,
    "Bridge-Operation-Id": OPERATION_ID,
    "Content-Type": "text/plain",
    "If-Match": `"${PRIVATE_REVISION}"`,
  });
}

/**
 * Creates the registry-authenticated Worker and its observable test seams.
 *
 * @returns Composed Worker, storage, logger, services, and confidential digest fixtures.
 */
async function application() {
  const firstDigest = await digestCredentialToken(FIRST_CLIENT.token);
  const secondDigest = await digestCredentialToken(SECOND_CLIENT.token);
  const bucket = new MemoryMirrorBucket();
  const logger = new CapturingLogger();
  const mirrorServices = createTestMirrorServices(bucket);
  const app = createWorkerApp({
    logger,
    resolveMirrorServices: () => mirrorServices,
    resolveAuthentication: () => ({
      serializedRegistry: serializeCredentialRegistry({
        version: 1,
        credentials: [
          {
            clientId: FIRST_CLIENT.id,
            name: FIRST_CLIENT.name,
            permissions: [
              CLIENT_PERMISSION.read,
              CLIENT_PERMISSION.write,
              CLIENT_PERMISSION.delete,
            ],
            tokenDigest: firstDigest,
          },
          {
            clientId: SECOND_CLIENT.id,
            name: SECOND_CLIENT.name,
            permissions: [CLIENT_PERMISSION.read],
            tokenDigest: secondDigest,
          },
        ],
      }),
    }),
  });

  return { app, bucket, firstDigest, logger, mirrorServices, secondDigest };
}

/**
 * Creates an HTTPS request against the in-memory Worker.
 *
 * @param path - Concrete request pathname.
 * @param init - Optional Fetch request configuration.
 * @returns Request targeting the test Worker origin.
 */
function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://example.test${path}`, init);
}

describe("Worker live request diagnostics", () => {
  it("attributes repeated reads to exact client IDs without changing responses", async () => {
    const { app, logger } = await application();

    const firstRead = await app.fetch(
      request("/api/v2/notes", {
        headers: { Authorization: `Bearer ${FIRST_CLIENT.token}` },
      }),
    );
    const repeatedRead = await app.fetch(
      request("/api/v2/notes", {
        headers: { Authorization: `Bearer ${FIRST_CLIENT.token}` },
      }),
    );
    const secondRead = await app.fetch(
      request("/api/v2/notes", {
        headers: { Authorization: `Bearer ${SECOND_CLIENT.token}` },
      }),
    );

    expect([firstRead.status, repeatedRead.status, secondRead.status]).toEqual([
      200, 200, 200,
    ]);
    expect(logger.entries).toMatchObject([
      {
        authentication: LOG_AUTHENTICATION_RESULT.authenticated,
        clientId: FIRST_CLIENT.id,
        operationCategory: LOG_OPERATION_CATEGORY.currentRead,
        route: "/api/v2/notes",
        status: 200,
      },
      {
        authentication: LOG_AUTHENTICATION_RESULT.authenticated,
        clientId: FIRST_CLIENT.id,
        operationCategory: LOG_OPERATION_CATEGORY.currentRead,
        route: "/api/v2/notes",
        status: 200,
      },
      {
        authentication: LOG_AUTHENTICATION_RESULT.authenticated,
        clientId: SECOND_CLIENT.id,
        operationCategory: LOG_OPERATION_CATEGORY.currentRead,
        route: "/api/v2/notes",
        status: 200,
      },
    ]);
  });

  it("keeps permission refusals free of permission, registry, and content detail", async () => {
    const { app, firstDigest, logger, secondDigest } = await application();
    const headers = mutationHeaders(SECOND_CLIENT.token);
    headers.set("If-None-Match", "*");
    headers.delete("If-Match");

    const response = await app.fetch(
      request(`/api/v2/notes/${encodedPath(PRIVATE_PATH)}`, {
        method: "PUT",
        headers,
        body: PRIVATE_BODY,
      }),
    );

    expect(response.status).toBe(403);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]).toMatchObject({
      authentication: LOG_AUTHENTICATION_RESULT.authenticated,
      clientId: SECOND_CLIENT.id,
      errorCode: API_ERROR_CODE.forbiddenWriter,
      operationCategory: LOG_OPERATION_CATEGORY.currentMutation,
      status: 403,
    });
    const observable = `${await response.text()}${JSON.stringify(logger.entries)}`;
    for (const forbidden of [
      FIRST_CLIENT.name,
      FIRST_CLIENT.token,
      SECOND_CLIENT.name,
      SECOND_CLIENT.token,
      firstDigest,
      secondDigest,
      PRIVATE_PATH,
      encodedPath(PRIVATE_PATH),
      PRIVATE_BODY,
      "permissions",
    ]) {
      expect(observable).not.toContain(forbidden);
    }
  });

  it("keeps public, rejected, destructive, bounded, failure, recovery, and unknown outcomes sanitized", async () => {
    const { app, bucket, firstDigest, logger, mirrorServices, secondDigest } =
      await application();
    const encodedPrivatePath = encodedPath(PRIVATE_PATH);

    expect((await app.fetch(request("/health"))).status).toBe(200);

    const destructive = await app.fetch(
      request(`/api/v2/notes/${encodedPrivatePath}`, {
        method: "DELETE",
        headers: mutationHeaders(FIRST_CLIENT.token),
      }),
    );
    expect(destructive.status).toBe(412);

    const revoked = await app.fetch(
      request("/api/v2/mirror", {
        headers: { Authorization: `Bearer ${REVOKED_TOKEN}` },
      }),
    );
    expect(revoked.status).toBe(401);

    const malformed = await app.fetch(
      request("/api/v2/mirror", {
        headers: { Authorization: "Bearer" },
      }),
    );
    expect(malformed.status).toBe(401);

    const oversized = await app.fetch(
      request(`/api/v2/notes/${encodedPrivatePath}`, {
        method: "PUT",
        headers: mutationHeaders(FIRST_CLIENT.token),
        body: `${PRIVATE_BODY}${"x".repeat(1024 * 1024 + 1)}`,
      }),
    );
    expect(oversized.status).toBe(413);

    bucket.throwOnGet = true;
    const applicationFailure = await app.fetch(
      request(`/api/v2/notes/${encodedPrivatePath}/state`, {
        headers: { Authorization: `Bearer ${FIRST_CLIENT.token}` },
      }),
    );
    expect(applicationFailure.status).toBe(500);
    bucket.throwOnGet = false;

    const recoveryRead = await app.fetch(
      request(`/api/v2/recovery/${RECOVERY_ID}`, {
        headers: { Authorization: `Bearer ${FIRST_CLIENT.token}` },
      }),
    );
    expect(recoveryRead.status).toBe(404);

    const unknown = await app.fetch(
      request(`/api/v2/unknown/${encodedPrivatePath}`, {
        headers: { Authorization: `Bearer ${FIRST_CLIENT.token}` },
      }),
    );
    expect(unknown.status).toBe(404);

    expect(logger.entries[0]).toMatchObject({
      authentication: LOG_AUTHENTICATION_RESULT.public,
      operationCategory: LOG_OPERATION_CATEGORY.public,
      route: "/health",
      status: 200,
    });
    expect(logger.entries[0]).not.toHaveProperty("clientId");
    expect(logger.entries[1]).toMatchObject({
      authentication: LOG_AUTHENTICATION_RESULT.authenticated,
      clientId: FIRST_CLIENT.id,
      errorCode: API_ERROR_CODE.preconditionFailed,
      operationCategory: LOG_OPERATION_CATEGORY.destructiveMutation,
      status: 412,
    });
    expect(logger.entries[2]).toMatchObject({
      authentication: LOG_AUTHENTICATION_RESULT.rejected,
      errorCode: API_ERROR_CODE.unauthorized,
      operationCategory: LOG_OPERATION_CATEGORY.mirrorRead,
      status: 401,
    });
    expect(logger.entries[2]).not.toHaveProperty("clientId");
    expect(logger.entries[3]).toMatchObject({
      authentication: LOG_AUTHENTICATION_RESULT.rejected,
      errorCode: API_ERROR_CODE.unauthorized,
      operationCategory: LOG_OPERATION_CATEGORY.mirrorRead,
      status: 401,
    });
    expect(logger.entries[3]).not.toHaveProperty("clientId");
    expect(logger.entries[4]).toMatchObject({
      authentication: LOG_AUTHENTICATION_RESULT.authenticated,
      clientId: FIRST_CLIENT.id,
      errorCode: API_ERROR_CODE.payloadTooLarge,
      operationCategory: LOG_OPERATION_CATEGORY.currentMutation,
      status: 413,
    });
    expect(logger.entries[5]).toMatchObject({
      authentication: LOG_AUTHENTICATION_RESULT.authenticated,
      clientId: FIRST_CLIENT.id,
      errorCode: API_ERROR_CODE.internalError,
      operationCategory: LOG_OPERATION_CATEGORY.currentRead,
      status: 500,
    });
    expect(logger.entries[6]).toMatchObject({
      authentication: LOG_AUTHENTICATION_RESULT.authenticated,
      clientId: FIRST_CLIENT.id,
      errorCode: API_ERROR_CODE.notFound,
      operationCategory: LOG_OPERATION_CATEGORY.recoveryRead,
      status: 404,
    });
    expect(logger.entries[7]).toMatchObject({
      authentication: LOG_AUTHENTICATION_RESULT.authenticated,
      clientId: FIRST_CLIENT.id,
      errorCode: API_ERROR_CODE.notFound,
      operationCategory: LOG_OPERATION_CATEGORY.unknown,
      route: "unknown",
      status: 404,
    });

    const observable = JSON.stringify(logger.entries);
    for (const forbidden of [
      FIRST_CLIENT.token,
      SECOND_CLIENT.token,
      REVOKED_TOKEN,
      firstDigest,
      secondDigest,
      FIRST_CLIENT.name,
      SECOND_CLIENT.name,
      PRIVATE_PATH,
      encodedPrivatePath,
      RECOVERY_ID,
      OPERATION_ID,
      PRIVATE_REVISION,
      PRIVATE_BODY,
      "Authorization",
      "private storage detail",
      "Bridge-Association-Id",
      "Bridge-Writer-Id",
      "If-Match",
    ]) {
      expect(observable).not.toContain(forbidden);
    }
    expect(bucket.putKeys).toHaveLength(0);
    expect(mirrorServices.designation).toEqual({
      associationId: TEST_ASSOCIATION_ID,
      writerId: TEST_WRITER_ID,
    });
  });
});
