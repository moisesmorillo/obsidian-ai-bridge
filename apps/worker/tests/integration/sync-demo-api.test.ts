import {
  createContentSha256,
  SyncDemoService,
  type SyncStore,
} from "@obsidian-ai-bridge/core";
import {
  SYNC_DEMO_BINDING_HEADER,
  SYNC_DEMO_ROUTE,
  syncOperationIdSchema,
} from "@obsidian-ai-bridge/protocol";
import {
  digestCredentialToken,
  serializeCredentialRegistry,
} from "@worker/auth/credential-registry";
import { createSyncDemoApp } from "@worker/demo/demo-app";
import type { SyncDemoConfiguration } from "@worker/demo/demo-configuration";
import { describe, expect, it, vi } from "vitest";

const clientId = "11111111-1111-4111-8111-111111111111";
const config = {
  mode: "synthetic-local-only",
  vaultId: "22222222-2222-4222-8222-222222222222",
  paths: ["demo.md"],
  participants: [
    { clientId, origin: "33333333-3333-4333-8333-333333333333" },
    {
      clientId: "44444444-4444-4444-8444-444444444444",
      origin: "55555555-5555-4555-8555-555555555555",
    },
    {
      clientId: "66666666-6666-4666-8666-666666666666",
      origin: "77777777-7777-4777-8777-777777777777",
    },
  ],
};
const token = "synthetic-demo-test-token";
const mutation = {
  operation: "mutate",
  mutation: {
    kind: "create",
    path: "demo.md",
    content: "# Synthetic\r\n",
    parent: { kind: "never_seen" },
    operationId: "88888888-8888-4888-8888-888888888888",
    revision: "99999999-9999-4999-8999-999999999999",
  },
};

async function fixture(
  permissions: readonly ("read" | "write")[] = ["read", "write"],
  configuration = JSON.stringify(config),
) {
  const registry = serializeCredentialRegistry({
    version: 1,
    credentials: [
      {
        clientId,
        name: "synthetic",
        permissions,
        tokenDigest: await digestCredentialToken(token),
      },
    ],
  });
  const store = {
    readCurrent: vi.fn<SyncStore["readCurrent"]>(async () => ({
      kind: "never_seen",
    })),
    readVersion: vi.fn<SyncStore["readVersion"]>(async () => ({
      kind: "absent",
    })),
    mutate: vi.fn<SyncStore["mutate"]>(async () => ({
      kind: "error",
      code: "operation_pending",
      operationId: syncOperationIdSchema.parse(mutation.mutation.operationId),
    })),
    readChanges: vi.fn<SyncStore["readChanges"]>(async () => ({
      kind: "error",
      code: "invalid_cursor",
    })),
    readRecovery: async () =>
      ({ kind: "error", code: "storage_unavailable" }) as const,
    startInventory: async () =>
      ({ kind: "error", code: "storage_unavailable" }) as const,
    continueInventory: async () =>
      ({ kind: "error", code: "storage_unavailable" }) as const,
    readInventoryPage: async () =>
      ({ kind: "error", code: "storage_unavailable" }) as const,
    resumeOperation: async () =>
      ({ kind: "error", code: "storage_unavailable" }) as const,
  } satisfies SyncStore;
  const hash = createContentSha256("a".repeat(64));
  if (!hash) throw new Error("Bad test hash");
  const resolveService = vi.fn(
    (bound: SyncDemoConfiguration) =>
      new SyncDemoService(
        store,
        bound.vaultId,
        bound.paths,
        16384,
        async () => null,
      ),
  );
  const app = createSyncDemoApp({
    configuration,
    registry,
    resolveService,
    digest: async () => hash,
  });
  const request = (
    body: object,
    credential: string | null = token,
    host = "127.0.0.1",
    expected: { vaultId?: string; origin?: string } = {},
  ) =>
    app.request(`http://${host}${SYNC_DEMO_ROUTE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(expected.vaultId === undefined
          ? {}
          : { [SYNC_DEMO_BINDING_HEADER.vaultId]: expected.vaultId }),
        ...(expected.origin === undefined
          ? {}
          : { [SYNC_DEMO_BINDING_HEADER.origin]: expected.origin }),
        ...(credential === null
          ? {}
          : { Authorization: `Bearer ${credential}` }),
      },
      body: JSON.stringify(body),
    });
  return { app, request, store, resolveService };
}

describe("isolated synthetic REST admission", () => {
  it.each([
    {
      vaultId: "88888888-8888-4888-8888-888888888888",
      origin: "33333333-3333-4333-8333-333333333333",
    },
    { vaultId: config.vaultId, origin: "55555555-5555-4555-8555-555555555555" },
  ])(
    "denies mismatched identity expectations before service resolution",
    async (expected) => {
      const f = await fixture();
      const response = await f.request(mutation, token, "127.0.0.1", expected);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        kind: "error",
        code: "binding_mismatch",
      });
      expect(f.resolveService).not.toHaveBeenCalled();
      expect(f.store.mutate).not.toHaveBeenCalled();
    },
  );
  it.each([
    { vaultId: config.vaultId },
    { origin: "33333333-3333-4333-8333-333333333333" },
    { vaultId: "malformed", origin: "33333333-3333-4333-8333-333333333333" },
  ])(
    "rejects partial or malformed expectation pairs before service resolution",
    async (expected) => {
      const f = await fixture();
      const response = await f.request(mutation, token, "127.0.0.1", expected);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        kind: "error",
        code: "invalid_request",
      });
      expect(f.resolveService).not.toHaveBeenCalled();
    },
  );
  it("accepts matching expectations without changing server identity or granting write", async () => {
    const expected = {
      vaultId: config.vaultId,
      origin: "33333333-3333-4333-8333-333333333333",
    };
    const f = await fixture();
    expect(
      (await f.request(mutation, token, "127.0.0.1", expected)).status,
    ).toBe(200);
    expect(f.store.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultId: config.vaultId,
        origin: expected.origin,
      }),
    );
    const readOnly = await fixture(["read"]);
    expect(
      (await readOnly.request(mutation, token, "127.0.0.1", expected)).status,
    ).toBe(403);
    expect(readOnly.resolveService).not.toHaveBeenCalled();
  });
  it("documents both optional expectations and allows them through lab CORS preflight", async () => {
    const f = await fixture();
    const document = await f.app.request("http://127.0.0.1/openapi.json");
    expect(await document.json()).toMatchObject({
      paths: {
        [SYNC_DEMO_ROUTE]: {
          post: {
            parameters: expect.arrayContaining([
              expect.objectContaining({
                in: "header",
                name: SYNC_DEMO_BINDING_HEADER.vaultId,
                required: false,
              }),
              expect.objectContaining({
                in: "header",
                name: SYNC_DEMO_BINDING_HEADER.origin,
                required: false,
              }),
            ]),
          },
        },
      },
    });
    const preflight = await f.app.request(
      `http://127.0.0.1${SYNC_DEMO_ROUTE}`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "app://obsidian.md",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": Object.values(
            SYNC_DEMO_BINDING_HEADER,
          ).join(","),
        },
      },
    );
    for (const name of Object.values(SYNC_DEMO_BINDING_HEADER))
      expect(
        preflight.headers.get("Access-Control-Allow-Headers")?.toLowerCase(),
      ).toContain(name.toLowerCase());
    expect(f.resolveService).not.toHaveBeenCalled();
  });
  it("denies missing/wrong credentials and non-loopback requests before service resolution", async () => {
    const f = await fixture();
    expect(
      (await f.request({ operation: "current", path: "demo.md" }, null)).status,
    ).toBe(401);
    expect(
      (await f.request({ operation: "current", path: "demo.md" }, "wrong"))
        .status,
    ).toBe(401);
    expect(
      (
        await f.request(
          { operation: "current", path: "demo.md" },
          token,
          "example.com",
        )
      ).status,
    ).toBe(503);
    expect(f.resolveService).not.toHaveBeenCalled();
  });
  it("keeps read and write independent and assigns only configured server provenance", async () => {
    const reader = await fixture(["read"]);
    expect((await reader.request(mutation)).status).toBe(403);
    expect(reader.resolveService).not.toHaveBeenCalled();
    const writer = await fixture(["write"]);
    expect(
      (await writer.request({ operation: "current", path: "demo.md" })).status,
    ).toBe(403);
    const response = await writer.request(mutation);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: "error",
      code: "operation_pending",
    });
    expect(writer.store.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        vaultId: config.vaultId,
        origin: config.participants[0]?.origin,
        content: mutation.mutation.content,
        parent: { kind: "never_seen" },
      }),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps immutable reads and original feed checkpoints behind independent read permission", async () => {
    const f = await fixture(["read"]);
    const version = await f.request({
      operation: "version",
      revision: mutation.mutation.revision,
    });
    expect(version.status).toBe(200);
    expect(await version.json()).toEqual({ kind: "absent" });
    const changes = await f.request({
      operation: "changes",
      cursor: "original-opaque",
    });
    expect(changes.status).toBe(200);
    expect(await changes.json()).toEqual({
      kind: "error",
      code: "invalid_cursor",
    });
    expect(f.store.readChanges).toHaveBeenCalledWith({
      vaultId: config.vaultId,
      cursor: "original-opaque",
    });
    const writer = await fixture(["write"]);
    expect(
      (
        await writer.request({
          operation: "version",
          revision: mutation.mutation.revision,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await writer.request({
          operation: "changes",
          cursor: "original-opaque",
        })
      ).status,
    ).toBe(403);
    expect(writer.resolveService).not.toHaveBeenCalled();
  });

  it("rejects origin/vault injection, foreign paths and deletion without a mutation effect", async () => {
    const f = await fixture();
    for (const extra of [
      { origin: config.participants[1]?.origin },
      { vaultId: config.vaultId },
      { kind: "tombstone" },
    ]) {
      expect(
        (
          await f.request({
            ...mutation,
            mutation: { ...mutation.mutation, ...extra },
          })
        ).status,
      ).toBe(400);
    }
    const response = await f.request({
      ...mutation,
      mutation: { ...mutation.mutation, path: "foreign.md" },
    });
    expect(await response.json()).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(f.store.mutate).not.toHaveBeenCalled();
  });
  it("fails closed for missing/duplicate lab configuration and binds no legacy API/MCP route", async () => {
    for (const cfg of [
      "",
      JSON.stringify({ ...config, paths: ["Demo.md", "demo.md"] }),
      JSON.stringify({
        ...config,
        participants: [
          config.participants[0],
          config.participants[0],
          config.participants[2],
        ],
      }),
    ]) {
      const f = await fixture(["read"], cfg);
      expect(
        (await f.request({ operation: "current", path: "demo.md" })).status,
      ).toBe(503);
      expect(f.resolveService).not.toHaveBeenCalled();
    }
    const f = await fixture();
    expect(
      (await f.app.request("http://127.0.0.1/mcp", { method: "POST" })).status,
    ).toBe(404);
    expect((await f.app.request("http://127.0.0.1/api/v2/notes")).status).toBe(
      404,
    );
  });
  it("rejects malformed JSON, invalid UTF-8 and oversized streams without a service", async () => {
    const f = await fixture();
    for (const body of ["{", new Uint8Array([255])]) {
      const response = await f.app.request(
        `http://127.0.0.1${SYNC_DEMO_ROUTE}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
        },
      );
      expect(response.status).toBe(400);
    }
    const response = await f.app.request(`http://127.0.0.1${SYNC_DEMO_ROUTE}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": "1",
      },
      body: "x".repeat(110_000),
    });
    expect(response.status).toBe(413);
    expect(f.resolveService).not.toHaveBeenCalled();
  });
  it("rejects non-JSON media and sanitizes adapter failures without exposing exception text", async () => {
    const f = await fixture();
    const response = await f.app.request(`http://127.0.0.1${SYNC_DEMO_ROUTE}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(mutation),
    });
    expect(response.status).toBe(400);
    expect(f.resolveService).not.toHaveBeenCalled();
    f.resolveService.mockImplementation(() => {
      throw new Error("private-adapter-secret");
    });
    const failed = await f.request({ operation: "current", path: "demo.md" });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({
      kind: "error",
      code: "demo_unavailable",
    });
  });
  it("serves schema-derived local OpenAPI and only the official Obsidian CORS origin", async () => {
    const f = await fixture();
    const docs = await f.app.request("http://127.0.0.1/openapi.json");
    expect(docs.status).toBe(200);
    expect(await docs.json()).toMatchObject({
      paths: {
        [SYNC_DEMO_ROUTE]: {
          post: {
            responses: Object.fromEntries(
              [400, 401, 403, 413, 503].map((status) => [
                status,
                {
                  content: {
                    "application/json": { schema: expect.any(Object) },
                  },
                },
              ]),
            ),
          },
        },
      },
    });
    const preflight = await f.app.request(
      `http://127.0.0.1${SYNC_DEMO_ROUTE}`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "app://obsidian.md",
          "Access-Control-Request-Method": "POST",
        },
      },
    );
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "app://obsidian.md",
    );
  });
});
