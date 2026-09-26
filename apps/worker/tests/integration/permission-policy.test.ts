import { encodeNotePath, normalizeNotePath } from "@obsidian-ai-bridge/core";
import {
  API_ERROR_CODE,
  apiErrorResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import { createWorkerApp } from "@worker/app";
import { CLIENT_PERMISSION } from "@worker/auth/auth.constants";
import type { ClientPermission } from "@worker/auth/auth.types";
import {
  digestCredentialToken,
  serializeCredentialRegistry,
} from "@worker/auth/credential-registry";
import {
  resolveRouteOperation,
  toOpenApiV2RoutePath,
  V2_ROUTE_POLICY,
} from "@worker/http/v2-route-policy";
import type { Logger } from "@worker/logging/logger.types";
import {
  createTestMirrorServices,
  MemoryMirrorBucket,
  TEST_ASSOCIATION_ID,
  TEST_WRITER_ID,
} from "@worker-tests/support/mirror-test-kit";
import { describe, expect, it } from "vitest";

const CLIENT_ID = "55555555-5555-4555-8555-555555555555";
const RECOVERY_ID = "66666666-6666-4666-8666-666666666666";
const REVISION = "77777777-7777-4777-8777-777777777777";
const OPERATION_ID = "88888888-8888-4888-8888-888888888888";
const logger: Logger = { info: () => undefined };

function encodedPath(path: string): string {
  const normalized = normalizeNotePath(path);
  if (normalized === undefined) throw new Error("Invalid fixture path");
  return encodeNotePath(normalized);
}

function concretePath(path: string): string {
  return toOpenApiV2RoutePath(path)
    .replace("{path}", encodedPath("Permission.md"))
    .replace("{id}", RECOVERY_ID);
}

function operationRequest(
  method: string,
  path: string,
  token?: string,
  invalidDesignation = false,
): Request {
  const headers = new Headers();
  if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
  if (["PUT", "DELETE", "POST"].includes(method)) {
    headers.set(
      "Bridge-Association-Id",
      invalidDesignation
        ? "99999999-9999-4999-8999-999999999999"
        : TEST_ASSOCIATION_ID,
    );
    headers.set("Bridge-Writer-Id", TEST_WRITER_ID);
    headers.set("Bridge-Operation-Id", OPERATION_ID);
  }
  if (method === "PUT") {
    headers.set("Content-Type", "text/plain");
    headers.set("If-None-Match", "*");
  }
  if (method === "DELETE" || method === "POST") {
    headers.set("If-Match", `"m3-${REVISION}"`);
  }
  return new Request(`https://example.test${path}`, {
    method,
    headers,
    ...(method === "PUT" ? { body: "permission body" } : {}),
  });
}

async function application(permissions: readonly ClientPermission[]) {
  const token = `token-${permissions.join("-")}`;
  const bucket = new MemoryMirrorBucket();
  const mirrorServices = createTestMirrorServices(bucket);
  const tokenDigest = await digestCredentialToken(token);
  let serviceResolutions = 0;
  const app = createWorkerApp({
    logger,
    resolveMirrorServices: () => {
      serviceResolutions += 1;
      return mirrorServices;
    },
    resolveAuthentication: () => ({
      serializedRegistry: serializeCredentialRegistry({
        version: 1,
        credentials: [
          {
            clientId: CLIENT_ID,
            name: "Permission client",
            permissions,
            tokenDigest,
          },
        ],
      }),
    }),
  });
  return { app, bucket, serviceResolutions: () => serviceResolutions, token };
}

const operationCases = [
  {
    name: "mirror description",
    method: V2_ROUTE_POLICY.mirror.operations.describe,
    path: concretePath(V2_ROUTE_POLICY.mirror.path),
    permission: CLIENT_PERMISSION.read,
  },
  {
    name: "current list",
    method: V2_ROUTE_POLICY.notes.operations.list,
    path: concretePath(V2_ROUTE_POLICY.notes.path),
    permission: CLIENT_PERMISSION.read,
  },
  {
    name: "current content",
    method: V2_ROUTE_POLICY.note.operations.read,
    path: concretePath(V2_ROUTE_POLICY.note.path),
    permission: CLIENT_PERMISSION.read,
  },
  {
    name: "current state",
    method: V2_ROUTE_POLICY.noteState.operations.inspect,
    path: concretePath(V2_ROUTE_POLICY.noteState.path),
    permission: CLIENT_PERMISSION.read,
  },
  {
    name: "recovery list",
    method: V2_ROUTE_POLICY.recovery.operations.list,
    path: concretePath(V2_ROUTE_POLICY.recovery.path),
    permission: CLIENT_PERMISSION.read,
  },
  {
    name: "recovery metadata",
    method: V2_ROUTE_POLICY.recoveryItem.operations.inspect,
    path: concretePath(V2_ROUTE_POLICY.recoveryItem.path),
    permission: CLIENT_PERMISSION.read,
  },
  {
    name: "recovery content",
    method: V2_ROUTE_POLICY.recoveryContent.operations.read,
    path: concretePath(V2_ROUTE_POLICY.recoveryContent.path),
    permission: CLIENT_PERMISSION.read,
  },
  {
    name: "current create or update",
    method: V2_ROUTE_POLICY.note.operations.write,
    path: concretePath(V2_ROUTE_POLICY.note.path),
    permission: CLIENT_PERMISSION.write,
  },
  {
    name: "recovery seal",
    method: V2_ROUTE_POLICY.recoverySeal.operations.seal,
    path: concretePath(V2_ROUTE_POLICY.recoverySeal.path),
    permission: CLIENT_PERMISSION.write,
  },
  {
    name: "current tombstone",
    method: V2_ROUTE_POLICY.note.operations.remove,
    path: concretePath(V2_ROUTE_POLICY.note.path),
    permission: CLIENT_PERMISSION.delete,
  },
  {
    name: "recovery purge",
    method: V2_ROUTE_POLICY.recoveryPurge.operations.purge,
    path: concretePath(V2_ROUTE_POLICY.recoveryPurge.path),
    permission: CLIENT_PERMISSION.delete,
  },
] as const;

function insufficientPermission(
  requiredPermission: ClientPermission,
): ClientPermission {
  return requiredPermission === CLIENT_PERMISSION.read
    ? CLIENT_PERMISSION.delete
    : CLIENT_PERMISSION.read;
}

describe("Worker route-operation permission policy", () => {
  it("covers every registered v2 operation exactly once", () => {
    const policyOperations = Object.values(V2_ROUTE_POLICY)
      .flatMap((definition) =>
        Object.values(definition.operations).map((method) => {
          const path = concretePath(definition.path);
          const operation = resolveRouteOperation(path, method);
          if (operation.kind !== "permission") {
            throw new Error("Registered operation lacks a permission");
          }
          return { method, path, permission: operation.permission };
        }),
      )
      .sort((left, right) =>
        `${left.method} ${left.path}`.localeCompare(
          `${right.method} ${right.path}`,
        ),
      );
    const testedOperations = operationCases
      .map(({ method, path, permission }) => ({ method, path, permission }))
      .sort((left, right) =>
        `${left.method} ${left.path}`.localeCompare(
          `${right.method} ${right.path}`,
        ),
      );

    expect(testedOperations).toEqual(policyOperations);
    expect(
      new Set(testedOperations.map(({ method, path }) => `${method} ${path}`))
        .size,
    ).toBe(testedOperations.length);
  });

  it.each(operationCases)(
    "admits full and exact principals for $name",
    async ({ method, path, permission }) => {
      for (const permissions of [
        [
          CLIENT_PERMISSION.read,
          CLIENT_PERMISSION.write,
          CLIENT_PERMISSION.delete,
        ],
        [permission],
      ]) {
        const testApp = await application(permissions);
        const response = await testApp.app.fetch(
          operationRequest(method, path, testApp.token),
        );
        expect(response.status, `${method} ${path}`).not.toBe(401);
        expect(response.status, `${method} ${path}`).not.toBe(403);
        expect(testApp.serviceResolutions()).toBe(1);
      }
    },
  );

  it.each(operationCases)(
    "returns 403 before service or storage dispatch for insufficient $name permission",
    async ({ method, path, permission }) => {
      const testApp = await application([insufficientPermission(permission)]);
      const response = await testApp.app.fetch(
        operationRequest(method, path, testApp.token),
      );

      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe(API_ERROR_CODE.forbiddenWriter);
      expect(testApp.serviceResolutions()).toBe(0);
      expect(testApp.bucket.getCount).toBe(0);
      expect(testApp.bucket.putKeys).toHaveLength(0);
    },
  );

  it.each(operationCases)(
    "returns 401 before service or storage dispatch for unauthenticated $name",
    async ({ method, path, permission }) => {
      const testApp = await application([permission]);
      const response = await testApp.app.fetch(operationRequest(method, path));

      expect(response.status).toBe(401);
      expect(await errorCode(response)).toBe(API_ERROR_CODE.unauthorized);
      expect(testApp.serviceResolutions()).toBe(0);
      expect(testApp.bucket.getCount).toBe(0);
      expect(testApp.bucket.putKeys).toHaveLength(0);
    },
  );

  it("keeps permissions independent and writer designation separate", async () => {
    const writeOnly = await application([CLIENT_PERMISSION.write]);
    const tombstone = await writeOnly.app.fetch(
      operationRequest(
        V2_ROUTE_POLICY.note.operations.remove,
        concretePath(V2_ROUTE_POLICY.note.path),
        writeOnly.token,
      ),
    );
    const purge = await writeOnly.app.fetch(
      operationRequest(
        V2_ROUTE_POLICY.recoveryPurge.operations.purge,
        concretePath(V2_ROUTE_POLICY.recoveryPurge.path),
        writeOnly.token,
      ),
    );
    expect([tombstone.status, purge.status]).toEqual([403, 403]);
    expect(writeOnly.serviceResolutions()).toBe(0);

    const deleteOnly = await application([CLIENT_PERMISSION.delete]);
    const read = await deleteOnly.app.fetch(
      operationRequest(
        V2_ROUTE_POLICY.note.operations.read,
        concretePath(V2_ROUTE_POLICY.note.path),
        deleteOnly.token,
      ),
    );
    const write = await deleteOnly.app.fetch(
      operationRequest(
        V2_ROUTE_POLICY.note.operations.write,
        concretePath(V2_ROUTE_POLICY.note.path),
        deleteOnly.token,
      ),
    );
    expect([read.status, write.status]).toEqual([403, 403]);
    expect(deleteOnly.serviceResolutions()).toBe(0);

    const authorizedWriter = await application([CLIENT_PERMISSION.write]);
    const invalidWriter = await authorizedWriter.app.fetch(
      operationRequest(
        V2_ROUTE_POLICY.note.operations.write,
        concretePath(V2_ROUTE_POLICY.note.path),
        authorizedWriter.token,
        true,
      ),
    );
    expect(invalidWriter.status).toBe(403);
    expect(authorizedWriter.serviceResolutions()).toBe(1);
    expect(authorizedWriter.bucket.getCount).toBe(0);
    expect(authorizedWriter.bucket.putKeys).toHaveLength(0);
  });

  it("keeps documentation hidden and preflight storage-free while unknown API operations fail closed", async () => {
    const testApp = await application([CLIENT_PERMISSION.read]);
    for (const path of ["/health", "/openapi.json", "/docs"]) {
      expect(
        (await testApp.app.fetch(operationRequest("GET", path))).status,
      ).toBe(404);
    }
    expect(testApp.serviceResolutions()).toBe(0);
    for (const path of ["/openapi.json", "/docs"]) {
      expect(
        (
          await testApp.app.fetch(operationRequest("GET", path), {
            LOCAL_API_DOCS: "true",
            VAULT_BUCKET: testApp.bucket,
          })
        ).status,
      ).toBe(200);
    }
    expect(testApp.serviceResolutions()).toBe(0);

    const preflight = await testApp.app.fetch(
      new Request("https://example.test/api/v2/notes", {
        method: "OPTIONS",
        headers: {
          Origin: "https://client.example",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(testApp.serviceResolutions()).toBe(0);

    for (const [method, path] of [
      ["GET", "/api/v1/notes"],
      ["PUT", `/api/v1/notes/${encodedPath("Permission.md")}`],
      ["DELETE", `/api/v1/notes/${encodedPath("Permission.md")}`],
      ["PATCH", concretePath(V2_ROUTE_POLICY.note.path)],
      ["GET", "/api/v2/unknown/descendant"],
    ] as const) {
      const response = await testApp.app.fetch(
        operationRequest(method, path, testApp.token),
      );
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(testApp.serviceResolutions()).toBe(0);
    expect(testApp.bucket.getCount).toBe(0);
    expect(testApp.bucket.putKeys).toHaveLength(0);

    const unauthenticatedUnknown = await testApp.app.fetch(
      operationRequest("GET", "/api/v1/notes"),
    );
    expect(unauthenticatedUnknown.status).toBe(401);
  });
});

async function errorCode(response: Response): Promise<string> {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}
