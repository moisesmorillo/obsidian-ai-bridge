import {
  SYNC_DEMO_ROUTE,
  syncDemoResponseSchema,
  syncVaultIdSchema,
  syncVaultMarkerKey,
} from "@obsidian-ai-bridge/protocol";
import {
  digestCredentialToken,
  serializeCredentialRegistry,
} from "@worker/auth/credential-registry";
import demo from "@worker/demo/index";
import type {
  R2ConditionalBucketPort,
  R2ConditionalStoredObject,
} from "@worker/infrastructure/r2.types";
import { SYNC_R2_WRITE_COOLDOWN_MS } from "@worker/infrastructure/sync/sync-r2.constants";
import { describe, expect, it, vi } from "vitest";

const clientId = "11111111-1111-4111-8111-111111111111";
const vaultId = syncVaultIdSchema.parse("22222222-2222-4222-8222-222222222222");
const origin = "33333333-3333-4333-8333-333333333333";
const token = "synthetic-runtime-token";
const configuration = JSON.stringify({
  mode: "synthetic-local-only",
  vaultId,
  paths: ["demo.md"],
  participants: [
    { clientId, origin },
    {
      clientId: "44444444-4444-4444-8444-444444444444",
      origin: "55555555-5555-4555-8555-555555555555",
    },
    {
      clientId: "66666666-6666-4666-8666-666666666666",
      origin: "77777777-7777-4777-8777-777777777777",
    },
  ],
});
const mutation = {
  operation: "mutate",
  mutation: {
    kind: "create",
    parent: { kind: "never_seen" },
    path: "demo.md",
    content: "# Preserved bytes\r\n",
    revision: "88888888-8888-4888-8888-888888888888",
    operationId: "99999999-9999-4999-8999-999999999999",
  },
};

async function fixture() {
  const objects = new Map<string, R2ConditionalStoredObject>();
  let generation = 0;
  let now = 2_000_000_000_000;
  const bucket: R2ConditionalBucketPort = {
    get: async (key) => objects.get(key) ?? null,
    list: async () => ({ objects: [], truncated: false }),
    put: async (key, content, options) => {
      const prior = objects.get(key);
      if (options.onlyIf instanceof Headers) {
        if (options.onlyIf.get("If-None-Match") !== "*" || prior) return null;
      } else if (prior?.etag !== options.onlyIf.etagMatches) return null;
      generation += 1;
      const bytes =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content.slice();
      const object: R2ConditionalStoredObject = {
        key,
        size: bytes.byteLength,
        etag: `demo-${generation}`,
        uploaded: new Date(now),
        async arrayBuffer() {
          return bytes.slice().buffer;
        },
      };
      objects.set(key, object);
      return object;
    },
  };
  const registry = serializeCredentialRegistry({
    version: 1,
    credentials: [
      {
        clientId,
        name: "synthetic",
        permissions: ["read", "write"],
        tokenDigest: await digestCredentialToken(token),
      },
    ],
  });
  const post = async (body: object) => {
    now += 5000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const response = await demo.fetch(
        new Request(`http://127.0.0.1${SYNC_DEMO_ROUTE}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        {
          DEMO_BUCKET: bucket,
          DEMO_CONFIGURATION: configuration,
          DEMO_CREDENTIAL_REGISTRY: registry,
        },
      );
      expect(response.status).toBe(200);
      return syncDemoResponseSchema.parse(await response.json());
    } finally {
      clock.mockRestore();
    }
  };
  return { post, bucket, objects };
}

describe("demo composition over deterministic conditional storage", () => {
  it("provisions only on admitted mutation and recovers by identical full-request replay", async () => {
    const f = await fixture();
    expect(await f.post({ operation: "current", path: "demo.md" })).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
    expect(f.objects.size).toBe(0);
    expect(
      await f.post({
        ...mutation,
        mutation: { ...mutation.mutation, path: "foreign.md" },
      }),
    ).toEqual({ kind: "error", code: "invalid_input" });
    expect(f.objects.size).toBe(0);
    let outcome = await f.post(mutation);
    for (const _ of Array.from({ length: 40 })) {
      if (outcome.kind === "committed") break;
      expect(outcome).toMatchObject({ kind: "error" });
      outcome = await f.post(mutation);
    }
    expect(outcome).toMatchObject({
      kind: "committed",
      revision: mutation.mutation.revision,
    });
    expect(await f.post(mutation)).toEqual(outcome);
    expect(
      await f.post({
        operation: "version",
        revision: mutation.mutation.revision,
      }),
    ).toMatchObject({
      kind: "present",
      version: { content: mutation.mutation.content, origin },
    });
    expect(
      await f.post({
        ...mutation,
        mutation: { ...mutation.mutation, content: "different" },
      }),
    ).toEqual({ kind: "error", code: "operation_id_reused" });
  });
  it("returns storage unavailability without provisioning when marker reads fail", async () => {
    const f = await fixture();
    vi.spyOn(f.bucket, "get").mockRejectedValue(new Error("synthetic outage"));
    expect(await f.post(mutation)).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
    expect(f.objects.size).toBe(0);
  });
  it("preserves uncertain marker writes and their retry floor without acknowledging a note mutation", async () => {
    const f = await fixture();
    const put = f.bucket.put.bind(f.bucket);
    vi.spyOn(f.bucket, "put").mockImplementationOnce(async (...arguments_) => {
      await put(...arguments_);
      vi.spyOn(f.bucket, "get").mockRejectedValueOnce(
        new Error("synthetic read-back outage"),
      );
      throw new Error("synthetic lost acknowledgement");
    });
    const outcome = await f.post(mutation);
    expect(outcome).toEqual({
      kind: "error",
      code: "effect_unknown",
      retryAfterEpochMs: 2_000_000_005_000 + SYNC_R2_WRITE_COOLDOWN_MS,
      retryScope: "vault",
    });
    expect([...f.objects.keys()]).toEqual([syncVaultMarkerKey(vaultId)]);
    const retry = await f.post(mutation);
    expect(retry).toMatchObject({ kind: "error", code: "operation_pending" });
  });
  it("forwards an explicit marker write throttle and its original retry floor without provisioning a note", async () => {
    const f = await fixture();
    vi.spyOn(f.bucket, "put").mockRejectedValueOnce(
      new Error("429 too many requests"),
    );
    expect(await f.post(mutation)).toEqual({
      kind: "error",
      code: "storage_throttled",
      retryAfterEpochMs: 2_000_000_005_000 + SYNC_R2_WRITE_COOLDOWN_MS,
      retryScope: "vault",
    });
    expect(f.objects.size).toBe(0);
  });
  it("refuses divergent existing marker bytes without repairing or treating the namespace as empty", async () => {
    const f = await fixture();
    await f.bucket.put(syncVaultMarkerKey(vaultId), "not-a-vault-marker", {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      customMetadata: {},
      httpMetadata: { contentType: "application/octet-stream" },
    });
    expect(await f.post(mutation)).toEqual({
      kind: "error",
      code: "vault_not_found",
    });
    const marker = f.objects.get(syncVaultMarkerKey(vaultId));
    expect(marker && new TextDecoder().decode(await marker.arrayBuffer())).toBe(
      "not-a-vault-marker",
    );
    expect(f.objects.size).toBe(1);
  });
});
