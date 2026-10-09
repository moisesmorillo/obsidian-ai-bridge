import { SYNC_DEMO_ROUTE } from "@obsidian-ai-bridge/protocol";
import {
  digestCredentialToken,
  serializeCredentialRegistry,
} from "@worker/auth/credential-registry";
import type {
  R2ConditionalBucketPort,
  R2ConditionalStoredObject,
} from "@worker/infrastructure/r2.types";
import remote from "@worker/remote/index";
import {
  cappedRemoteBucket,
  claimRemoteTicket,
} from "@worker/remote/remote-budget";
import { decodeRemoteConfiguration } from "@worker/remote/remote-configuration";
import { describe, expect, it, vi } from "vitest";

const now = 2_000_000_000_000;
const endpoint = "https://synthetic.example.test";
const token = "remote-synthetic-only";
const config = {
  mode: "synthetic-remote-only",
  endpoint,
  enabled: true,
  experimentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  startsAtEpochMs: now,
  expiresAtEpochMs: now + 3_600_000,
  vaultId: "22222222-2222-4222-8222-222222222222",
  paths: ["demo.md"],
  participants: [
    {
      clientId: "11111111-1111-4111-8111-111111111111",
      origin: "33333333-3333-4333-8333-333333333333",
    },
    {
      clientId: "44444444-4444-4444-8444-444444444444",
      origin: "55555555-5555-4555-8555-555555555555",
    },
    {
      clientId: "66666666-6666-4666-8666-666666666666",
      origin: "77777777-7777-4777-8777-777777777777",
    },
  ] as const,
};
function bucketFixture() {
  const objects = new Map<string, R2ConditionalStoredObject>();
  const calls: string[] = [];
  let generation = 0;
  const bucket: R2ConditionalBucketPort = {
    async get(key) {
      calls.push(`get:${key}`);
      return objects.get(key) ?? null;
    },
    async list() {
      calls.push("list");
      return { objects: [], truncated: false };
    },
    async put(key, content, options) {
      calls.push(`put:${key}`);
      const previous = objects.get(key);
      if (
        options.onlyIf instanceof Headers
          ? options.onlyIf.get("If-None-Match") !== "*" ||
            previous !== undefined
          : previous?.etag !== options.onlyIf.etagMatches
      )
        return null;
      const bytes =
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content.slice();
      const object: R2ConditionalStoredObject = {
        key,
        size: bytes.byteLength,
        etag: String(++generation),
        uploaded: new Date(now),
        arrayBuffer: async () => bytes.slice().buffer,
      };
      objects.set(key, object);
      return object;
    },
  };
  return { bucket, objects, calls };
}
function boundConfig() {
  const decoded = decodeRemoteConfiguration(JSON.stringify(config));
  if (!decoded) throw new Error("invalid fixture");
  return decoded;
}
async function runtimeFixture(
  permissions: readonly ("read" | "write")[] = ["read", "write"],
) {
  const f = bucketFixture();
  const registry = serializeCredentialRegistry({
    version: 1,
    credentials: [
      {
        clientId: config.participants[0].clientId,
        name: "synthetic",
        permissions,
        tokenDigest: await digestCredentialToken(token),
      },
    ],
  });
  const post = (
    body: object,
    ticket = "0",
    patch: Record<string, string> = {},
    configuration = config,
    url = endpoint,
  ) =>
    remote.fetch(
      new Request(`${url}${SYNC_DEMO_ROUTE}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-AI-Bridge-Demo-Vault-Id": config.vaultId,
          "X-AI-Bridge-Demo-Origin": config.participants[0].origin,
          "X-AI-Bridge-Remote-Ticket": ticket,
          ...patch,
        },
        body: JSON.stringify(body),
      }),
      {
        REMOTE_BUCKET: f.bucket,
        REMOTE_CONFIGURATION: JSON.stringify(configuration),
        REMOTE_CREDENTIAL_REGISTRY: registry,
      },
    );
  return { ...f, post };
}
const mutation = {
  operation: "mutate",
  mutation: {
    kind: "create",
    path: "demo.md",
    content: "# Remote\r\n",
    parent: { kind: "never_seen" },
    operationId: "88888888-8888-4888-8888-888888888888",
    revision: "99999999-9999-4999-8999-999999999999",
  },
};

describe("remote synthetic authority", () => {
  it.each([
    undefined,
    "bad",
    JSON.stringify({ ...config, endpoint: "http://synthetic.example.test" }),
    JSON.stringify({ ...config, expiresAtEpochMs: now + 3_600_001 }),
    JSON.stringify({ ...config, paths: ["demo.md", "DEMO.md"] }),
  ])("rejects malformed remote configuration %s", (input) => {
    expect(decodeRemoteConfiguration(input)).toBeNull();
  });
  it("claims at most once across fresh facades and concurrent callers", async () => {
    const f = bucketFixture();
    const c = boundConfig();
    if (!c.participants[0] || !c.participants[1])
      throw new Error("missing participants");
    const results = await Promise.all([
      claimRemoteTicket(
        cappedRemoteBucket(f.bucket),
        c,
        c.participants[0].origin,
        "0",
      ),
      claimRemoteTicket(
        cappedRemoteBucket(f.bucket),
        c,
        c.participants[0].origin,
        "0",
      ),
    ]);
    expect(results.sort((a, b) => Number(a) - Number(b))).toEqual([
      false,
      true,
    ]);
    expect(f.objects.size).toBe(1);
    expect(
      await claimRemoteTicket(
        cappedRemoteBucket(f.bucket),
        c,
        c.participants[0].origin,
        "0",
      ),
    ).toBe(false);
    expect(
      await claimRemoteTicket(
        cappedRemoteBucket(f.bucket),
        c,
        c.participants[1].origin,
        "0",
      ),
    ).toBe(true);
  });
  it.each(["", "00", "-1", "100", "1.0", "999999999999999999999"])(
    "invalid ticket %s performs no PUT",
    async (ticket) => {
      const f = bucketFixture();
      expect(
        await claimRemoteTicket(
          f.bucket,
          boundConfig(),
          config.participants[0].origin,
          ticket,
        ),
      ).toBe(false);
      expect(f.calls).toEqual([]);
    },
  );
  it("does not refund a claim whose response was lost", async () => {
    const f = bucketFixture();
    const put = f.bucket.put.bind(f.bucket);
    f.bucket.put = async (...args) => {
      await put(...args);
      throw new Error("lost");
    };
    expect(
      await claimRemoteTicket(
        f.bucket,
        boundConfig(),
        config.participants[0].origin,
        "0",
      ),
    ).toBe(false);
    f.bucket.put = put;
    expect(
      await claimRemoteTicket(
        f.bucket,
        boundConfig(),
        config.participants[0].origin,
        "0",
      ),
    ).toBe(false);
    expect(f.objects.size).toBe(1);
  });
  it("counts all calls including failures and refuses the 513th", async () => {
    const f = bucketFixture();
    const bucket = cappedRemoteBucket(f.bucket);
    for (const index of Array.from({ length: 512 }, (_, i) => i))
      await bucket.get(String(index));
    await expect(bucket.list({ prefix: "" })).rejects.toThrow();
    expect(f.calls).toHaveLength(512);
    const failed = cappedRemoteBucket({
      ...f.bucket,
      get: async () => {
        throw new Error("lost");
      },
    });
    for (const index of Array.from({ length: 512 }, (_, i) => i))
      await expect(failed.get(String(index))).rejects.toThrow();
    await expect(
      failed.put("extra", "", {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        customMetadata: {},
        httpMetadata: { contentType: "text/plain" },
      }),
    ).rejects.toThrow();
  });
  it("reserves measured UTF-8 PUT bytes before effects, allowing exact limit only", async () => {
    const f = bucketFixture();
    const bucket = cappedRemoteBucket(f.bucket);
    const options = {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      customMetadata: {},
      httpMetadata: { contentType: "text/plain" },
    };
    await bucket.put("bytes", new Uint8Array(1_048_576), options);
    await expect(bucket.put("extra", "é", options)).rejects.toThrow();
    expect(f.objects.size).toBe(1);
    const other = cappedRemoteBucket(f.bucket);
    await expect(
      other.put("large", new Uint8Array(1_048_577), options),
    ).rejects.toThrow();
  });
  it("rejects stop, future/expiry, foreign host, missing auth/binding and reused ticket before store reads", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const f = await runtimeFixture();
      const current = { operation: "current", path: "demo.md" };
      for (const c of [
        { ...config, enabled: false },
        { ...config, startsAtEpochMs: now + 1 },
        { ...config, expiresAtEpochMs: now },
      ])
        expect((await f.post(current, "0", {}, c)).status).toBe(503);
      expect(
        (await f.post(current, "0", {}, config, "https://foreign.example.test"))
          .status,
      ).toBe(503);
      expect((await f.post(current, "0", { Authorization: "" })).status).toBe(
        401,
      );
      expect(
        (await f.post(current, "0", { "X-AI-Bridge-Demo-Origin": "" })).status,
      ).toBe(400);
      expect(f.calls).toEqual([]);
      expect((await f.post(current)).status).toBe(200);
      const calls = f.calls.length;
      expect((await f.post(current)).status).toBe(503);
      expect(f.calls.length).toBe(calls + 1);
    } finally {
      clock.mockRestore();
    }
  });
  it("fails closed for missing arming/registry, non-HTTPS paths and mismatched paired identity without storage", async () => {
    const f = bucketFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const request = new Request(`${endpoint}${SYNC_DEMO_ROUTE}`, {
        method: "POST",
      });
      expect(
        (await remote.fetch(request, { REMOTE_BUCKET: f.bucket })).status,
      ).toBe(503);
      expect(
        (
          await remote.fetch(request, {
            REMOTE_BUCKET: f.bucket,
            REMOTE_CONFIGURATION: JSON.stringify(config),
          })
        ).status,
      ).toBe(401);
      const runtime = await runtimeFixture();
      const current = { operation: "current", path: "demo.md" };
      expect(
        (
          await runtime.post(
            current,
            "0",
            {},
            config,
            "http://synthetic.example.test",
          )
        ).status,
      ).toBe(503);
      expect(
        (await runtime.post(current, "0", {}, config, `${endpoint}/foreign`))
          .status,
      ).toBe(503);
      expect(
        (
          await runtime.post(current, "0", {
            "X-AI-Bridge-Demo-Origin": config.participants[1].origin,
          })
        ).status,
      ).toBe(400);
      expect((await runtime.post(current, "100")).status).toBe(503);
      expect(runtime.calls).toEqual([]);
      expect(f.calls).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });
  it("rechecks expiry after an asynchronous claim before starting the store", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const f = await runtimeFixture();
      const put = f.bucket.put.bind(f.bucket);
      f.bucket.put = async (...args) => {
        const result = await put(...args);
        clock.mockReturnValue(config.expiresAtEpochMs);
        return result;
      };
      const response = await f.post({ operation: "current", path: "demo.md" });
      expect(response.status).toBe(503);
      expect(f.calls).toHaveLength(1);
      expect(f.objects.size).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
  it("denies write to a read-only participant before ticket claims", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const f = await runtimeFixture(["read"]);
      expect((await f.post(mutation)).status).toBe(403);
      expect(f.calls).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });
  it("recovers the identical mutation with fresh transport tickets; no local-v2 namespace", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const f = await runtimeFixture();
      let result: { kind: string } = { kind: "error" };
      for (const index of Array.from({ length: 20 }, (_, i) => i)) {
        clock.mockReturnValue(now + index * 5000);
        const response = await f.post(mutation, String(index));
        expect(response.status).toBe(200);
        result = await response.json();
        if (result.kind === "committed") break;
      }
      expect(result.kind).toBe("committed");
      expect(
        [...f.objects.keys()].every(
          (key) => key.startsWith("sync/") || key.startsWith("remote-lab/"),
        ),
      ).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});
