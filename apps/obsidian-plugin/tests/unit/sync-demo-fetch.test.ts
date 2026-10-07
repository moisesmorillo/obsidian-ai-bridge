import { createContentSha256 } from "@obsidian-ai-bridge/core";
import {
  SYNC_DEMO_BINDING_HEADER,
  syncDeviceIdSchema,
  syncNotePathSchema,
  syncOperationIdSchema,
  syncRevisionSchema,
  syncVaultIdSchema,
} from "@obsidian-ai-bridge/protocol";
import { SyncDemoFetchRemote } from "@obsidian-plugin/demo/sync-demo-fetch";
import { describe, expect, it, vi } from "vitest";

const binding = {
  vaultId: syncVaultIdSchema.parse("22222222-2222-4222-8222-222222222222"),
  deviceId: syncDeviceIdSchema.parse("33333333-3333-4333-8333-333333333333"),
  paths: [syncNotePathSchema.parse("demo.md")],
};
const path = syncNotePathSchema.parse("demo.md");
const revision = syncRevisionSchema.parse(
  "44444444-4444-4444-8444-444444444444",
);
const operationId = syncOperationIdSchema.parse(
  "55555555-5555-4555-8555-555555555555",
);
const contentSha256 = createContentSha256("a".repeat(64));
if (contentSha256 === undefined) throw new Error("Invalid fixture digest");
const request = {
  kind: "create" as const,
  vaultId: binding.vaultId,
  path,
  origin: binding.deviceId,
  operationId,
  revision,
  parent: { kind: "never_seen" as const },
  contentSha256,
  content: "synthetic",
  mediaType: "text/markdown" as const,
};
function remote(
  fetcher: typeof fetch,
  secret = async () => "synthetic-token",
  timeout = 10_000,
) {
  return new SyncDemoFetchRemote(
    "http://127.0.0.1:8789",
    binding,
    secret,
    fetcher,
    timeout,
  );
}

describe("bounded uncomposed loopback Fetch adapter", () => {
  it.each([0, -1, 0.5, 10_001, Number.POSITIVE_INFINITY])(
    "does not permit an unbounded deadline %s",
    (timeout) => {
      expect(() =>
        remote(
          async () => Response.json({ kind: "never_seen" }),
          undefined,
          timeout,
        ),
      ).toThrow();
    },
  );
  it.each([
    "https://example.com",
    "http://example.com",
    "http://localhost@evil.example",
    "http://127.0.0.1/path",
    "http://127.0.0.1?token=secret",
    "http://127.0.0.1#fragment",
  ])("rejects endpoint authority %s before secrets or requests", (endpoint) => {
    expect(
      () => new SyncDemoFetchRemote(endpoint, binding, async () => "secret"),
    ).toThrow();
  });
  it("retrieves the bearer at dispatch and forbids redirects", async () => {
    let received: RequestInit | undefined;
    let endpoint: string | URL | Request | undefined;
    const f: typeof fetch = async (input, init) => {
      endpoint = input;
      received = init;
      return Response.json({ kind: "never_seen" });
    };
    const r = remote(f);
    expect(await r.current(path)).toEqual({ kind: "never_seen" });
    expect(endpoint).toBe("http://127.0.0.1:8789/demo/v1/request");
    expect(received?.redirect).toBe("error");
    expect(
      new Headers(received?.headers).get(SYNC_DEMO_BINDING_HEADER.vaultId),
    ).toBe(binding.vaultId);
    expect(
      new Headers(received?.headers).get(SYNC_DEMO_BINDING_HEADER.origin),
    ).toBe(binding.deviceId);
    expect(new Headers(received?.headers).get("Authorization")).toBe(
      "Bearer synthetic-token",
    );
    if (typeof received?.body !== "string")
      throw new Error("Expected JSON command");
    expect(JSON.parse(received.body)).toEqual({
      operation: "current",
      path,
    });
  });
  it.each([
    {
      status: 400,
      body: { kind: "error", code: "binding_mismatch" },
      code: "invalid_input",
    },
    {
      status: 400,
      body: { kind: "error", code: "invalid_request" },
      code: "effect_unknown",
    },
    {
      status: 400,
      body: {
        kind: "committed",
        operationId,
        revision,
        position: { lane: 0, sequence: "00000000000000000001" },
      },
      code: "effect_unknown",
    },
    {
      status: 200,
      body: { kind: "error", code: "binding_mismatch" },
      code: "effect_unknown",
    },
    {
      status: 400,
      body: {
        kind: "error",
        code: "binding_mismatch",
        vaultId: binding.vaultId,
      },
      code: "effect_unknown",
    },
  ])(
    "translates only strict known binding refusal, never error-status success ($status/$code)",
    async ({ status, body, code }) => {
      const r = remote(async () => Response.json(body, { status }));
      expect(await r.mutate(request)).toMatchObject({ kind: "error", code });
    },
  );
  it("enforces 32 requests even across exhausted subsequent calls", async () => {
    let calls = 0;
    const r = remote(async () => {
      calls += 1;
      return Response.json({ kind: "never_seen" });
    });
    for (const _ of Array.from({ length: 40 })) await r.current(path);
    expect(calls).toBe(32);
    r.beginPass();
    await r.current(path);
    expect(calls).toBe(33);
  });
  it.each([
    () =>
      new Response('{"kind":"never_seen"}', {
        headers: { "Content-Type": "text/html" },
      }),
    () =>
      new Response(
        " ".repeat(131073) + JSON.stringify({ kind: "never_seen" }),
        {
          headers: { "Content-Type": "application/json" },
        },
      ),
    () =>
      new Response(Uint8Array.of(0xff), {
        headers: { "Content-Type": "application/json" },
      }),
    () =>
      Response.json({
        kind: "committed",
        operationId,
        revision,
        position: { lane: 0, sequence: "00000000000000000001" },
      }),
    () => Response.json({ kind: "never_seen", token: "secret" }),
    () => new Response(null, { status: 401 }),
  ])(
    "does not turn malformed/oversized/wrong-operation responses into evidence %#",
    async (response) => {
      expect(await remote(async () => response()).current(path)).toEqual({
        kind: "error",
        code: "storage_unavailable",
      });
    },
  );
  it("retains mutation uncertainty for a lost response and never treats HTTP 200 pending as an ACK", async () => {
    const r = remote(async () =>
      Response.json({
        kind: "error",
        code: "operation_pending",
        operationId,
        retryAfterEpochMs: 1234,
      }),
    );
    expect(await r.mutate(request)).toEqual({
      kind: "error",
      code: "operation_pending",
      operationId,
      retryAfterEpochMs: 1234,
    });
    expect(
      await remote(async () => {
        throw new Error("private failure");
      }).mutate(request),
    ).toEqual({ kind: "error", code: "effect_unknown", operationId });
  });
  it.each([
    { kind: "error", code: "storage_throttled", retryAfterEpochMs: 7000 },
    { kind: "error", code: "operation_pending", operationId },
    { kind: "error", code: "mutation_not_admitted", operationId },
    { kind: "error", code: "effect_unknown" },
    {
      kind: "error",
      code: "effect_unknown",
      operationId,
      retryAfterEpochMs: 8000,
    },
    { kind: "error", code: "invalid_input" },
    { kind: "error", code: "storage_unavailable" },
  ])(
    "preserves exact code/context certainty from a strict error %#",
    async (outcome) => {
      expect(
        await remote(async () => Response.json(outcome)).mutate(request),
      ).toEqual(outcome);
    },
  );
  it("does not dispatch without a current secret", async () => {
    let calls = 0;
    const r = new SyncDemoFetchRemote(
      "http://127.0.0.1:8789",
      binding,
      async () => null,
      async () => {
        calls += 1;
        return Response.json({ kind: "never_seen" });
      },
    );
    expect(await r.mutate(request)).toEqual({
      kind: "error",
      code: "effect_unknown",
      operationId,
    });
    expect(calls).toBe(0);
  });
  it("rejects caller-supplied foreign path and participant identity before dispatch", async () => {
    const r = remote(async () => {
      throw new Error("must not dispatch");
    });
    expect(await r.current(syncNotePathSchema.parse("foreign.md"))).toEqual({
      kind: "error",
      code: "invalid_input",
    });
    expect(
      await r.mutate({
        ...request,
        origin: syncDeviceIdSchema.parse(
          "66666666-6666-4666-8666-666666666666",
        ),
      }),
    ).toEqual({ kind: "error", code: "invalid_input" });
  });
  it("does not acknowledge a mismatched or read-shaped mutation response", async () => {
    expect(
      await remote(async () => Response.json({ kind: "never_seen" })).mutate(
        request,
      ),
    ).toEqual({ kind: "error", code: "effect_unknown", operationId });
    expect(
      await remote(async () =>
        Response.json({
          kind: "committed",
          operationId,
          revision: "66666666-6666-4666-8666-666666666666",
          position: { lane: 0, sequence: "00000000000000000001" },
        }),
      ).mutate(request),
    ).toEqual({ kind: "error", code: "effect_unknown", operationId });
  });
  it("distinguishes immutable absence from invalid/wrong-operation version responses", async () => {
    expect(
      await remote(async () => Response.json({ kind: "absent" })).version(
        revision,
      ),
    ).toEqual({ kind: "absent" });
    expect(
      await remote(async () => Response.json({ kind: "never_seen" })).version(
        revision,
      ),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
    expect(
      await remote(async () =>
        Response.json({ kind: "error", code: "invalid_input" }),
      ).version(revision),
    ).toEqual({ kind: "error", code: "invalid_input" });
  });
  it("keeps invalid cursor input typed and refuses a foreign next checkpoint", async () => {
    const { encodeSyncCursor, syncSequenceSchema } = await import(
      "@obsidian-ai-bridge/protocol"
    );
    const cursor = encodeSyncCursor({
      protocolMajor: 1,
      vaultId: binding.vaultId,
      laneSequences: Array.from({ length: 64 }, () =>
        syncSequenceSchema.parse("00000000000000000000"),
      ),
      nextLane: 0,
    });
    const r = remote(async () =>
      Response.json({
        kind: "page",
        events: [],
        nextCursor: encodeSyncCursor({
          protocolMajor: 1,
          vaultId: syncVaultIdSchema.parse(
            "66666666-6666-4666-8666-666666666666",
          ),
          laneSequences: Array.from({ length: 64 }, () =>
            syncSequenceSchema.parse("00000000000000000000"),
          ),
          nextLane: 0,
        }),
      }),
    );
    expect(await r.changes("invalid")).toEqual({
      kind: "error",
      code: "invalid_cursor",
    });
    expect(await r.changes(cursor)).toEqual({
      kind: "error",
      code: "invalid_cursor",
    });
    expect(
      await remote(async () =>
        Response.json({ kind: "error", code: "cursor_expired" }),
      ).changes(cursor),
    ).toEqual({ kind: "error", code: "cursor_expired" });
    expect(
      await remote(async () => Response.json({ kind: "never_seen" })).changes(
        cursor,
      ),
    ).toEqual({ kind: "error", code: "storage_unavailable" });
  });
  it("contains rejected cancellation after an oversized stream without exposing raw failures", async () => {
    const r = remote(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(" ".repeat(131073)));
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ kind: "never_seen" }),
                ),
              );
              controller.close();
            },
            cancel() {
              throw new Error("private cancel failure");
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    expect(await r.current(path)).toEqual({
      kind: "error",
      code: "storage_unavailable",
    });
  });
  it("admits a full 100-event feed page for a maximum-length admitted ASCII path", async () => {
    const { encodeSyncCursor, syncSequenceSchema } = await import(
      "@obsidian-ai-bridge/protocol"
    );
    const longPath = syncNotePathSchema.parse(
      `${"a".repeat(235)}/${"b".repeat(235)}/${"c".repeat(245)}.md`,
    );
    const positions = Array.from({ length: 64 }, () =>
      syncSequenceSchema.parse("00000000000000000000"),
    );
    const cursor = encodeSyncCursor({
      protocolMajor: 1,
      vaultId: binding.vaultId,
      laneSequences: positions,
      nextLane: 0,
    });
    const nextCursor = encodeSyncCursor({
      protocolMajor: 1,
      vaultId: binding.vaultId,
      laneSequences: positions.map((sequence, lane) =>
        lane === 63
          ? syncSequenceSchema.parse("00000000000000000100")
          : sequence,
      ),
      nextLane: 63,
    });
    const events = Array.from({ length: 100 }, (_, index) => ({
      kind: "changed",
      lane: 63,
      sequence: (index + 1).toString().padStart(20, "0"),
      path: longPath,
      result: {
        kind: "live",
        revision: `${(index + 1).toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
      },
      operationId: `${(index + 101).toString().padStart(8, "0")}-1111-4111-8111-111111111111`,
      origin: binding.deviceId,
      committedAtEpochMs: 2_000_000_000_000 + index,
    }));
    const page = { kind: "page", events, nextCursor };
    expect(
      new TextEncoder().encode(JSON.stringify(page)).byteLength,
    ).toBeGreaterThan(102400);
    const r = new SyncDemoFetchRemote(
      "http://127.0.0.1:8789",
      { ...binding, paths: [longPath] },
      async () => "synthetic",
      async () => Response.json(page),
    );
    expect(await r.changes(cursor)).toEqual(page);
  });
  it("includes body consumption in the deadline and retains a late request permit", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const r = remote(
        async () => {
          calls += 1;
          return new Response(new ReadableStream({ start() {} }), {
            headers: { "Content-Type": "application/json" },
          });
        },
        undefined,
        100,
      );
      const pending = r.current(path);
      await vi.advanceTimersByTimeAsync(101);
      expect(await pending).toEqual({
        kind: "error",
        code: "storage_unavailable",
      });
      r.beginPass();
      expect(await r.current(path)).toEqual({
        kind: "error",
        code: "storage_unavailable",
      });
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
