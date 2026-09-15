import {
  type ConditionalMutationRequest,
  createApplicationRevision,
  createMirrorAssociationId,
  createMirrorOperationId,
  createMirrorWriterId,
  createRecoverySnapshotId,
  encodeNotePath,
  formatApplicationEtag,
  isNormalizedNotePath,
  type NotePath,
  normalizeNotePath,
  type RemoteRequestAdmission,
} from "@obsidian-ai-bridge/core";
import { FetchRemoteBridge } from "@obsidian-plugin/remote/fetch-remote-bridge";
import {
  MAX_REMOTE_METADATA_RESPONSE_BYTES,
  REMOTE_NOTE_REQUEST_CONTENT_TYPE,
} from "@obsidian-plugin/remote/fetch-remote-bridge.constants";
import type { RemoteFetch } from "@obsidian-plugin/remote/fetch-remote-bridge.types";
import { afterEach, describe, expect, it, vi } from "vitest";

const ASSOCIATION = required(
  createMirrorAssociationId("11111111-1111-4111-8111-111111111111"),
);
const WRITER = required(
  createMirrorWriterId("22222222-2222-4222-8222-222222222222"),
);
const OPERATION = required(
  createMirrorOperationId("33333333-3333-4333-8333-333333333333"),
);
const REVISION = required(
  createApplicationRevision("44444444-4444-4444-8444-444444444444"),
);
const PARENT = required(
  createApplicationRevision("55555555-5555-4555-8555-555555555555"),
);
const RECOVERY = required(
  createRecoverySnapshotId("66666666-6666-4666-8666-666666666666"),
);
const SEALED_REVISION = required(
  createApplicationRevision("77777777-7777-4777-8777-777777777777"),
);
const PURGED_REVISION = required(
  createApplicationRevision("88888888-8888-4888-8888-888888888888"),
);
const PATH = required(normalizeNotePath("folder/雪.md"));
const LITERAL_PERCENT_PATH = literalPath("folder/a%20b.md");
const HASH = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid test fixture.");
  return value;
}

function literalPath(value: string): NotePath {
  if (!isNormalizedNotePath(value)) throw new Error("Invalid literal path.");
  return value;
}

afterEach(() => vi.unstubAllGlobals());

function admission(): RemoteRequestAdmission & {
  readonly admitMock: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const admitMock = vi.fn().mockResolvedValue({ release });
  return { admit: admitMock, admitMock, release };
}

function adapter(
  fetch: (input: URL, init: RequestInit) => Promise<Response>,
  secret = "first-token",
  deadlineMilliseconds?: number,
) {
  const requestAdmission = admission();
  const storage = { getSecret: vi.fn(() => secret) };
  return {
    bridge: new FetchRemoteBridge({
      origin: "https://bridge.example",
      secretStorage: storage,
      secretReference: "bridge-token",
      admission: requestAdmission,
      fetch,
      crypto: globalThis.crypto,
      ...(deadlineMilliseconds === undefined ? {} : { deadlineMilliseconds }),
    }),
    requestAdmission,
    storage,
  };
}

function json(
  value: object,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders,
  });
}

function requestHeader(
  init: RequestInit | undefined,
  name: string,
): string | null {
  return new Headers(init?.headers).get(name);
}

function acknowledgement(
  action: "create" | "update" = "create",
  path: NotePath = PATH,
) {
  return {
    path,
    revision: REVISION,
    receipt:
      action === "create"
        ? {
            action,
            associationId: ASSOCIATION,
            operationId: OPERATION,
            precondition: { kind: "absent" },
            contentSha256: HASH,
          }
        : {
            action,
            associationId: ASSOCIATION,
            operationId: OPERATION,
            precondition: { kind: "matching-revision", revision: PARENT },
            contentSha256: HASH,
          },
  };
}

const createRequest: ConditionalMutationRequest = {
  action: "create",
  associationId: ASSOCIATION,
  writerId: WRITER,
  operationId: OPERATION,
  path: PATH,
  precondition: { kind: "absent" },
  content: "hello",
};

describe("FetchRemoteBridge", () => {
  it("constructs canonical v2 Fetch requests and loads the bearer at every dispatch", async () => {
    let token = "first-token";
    const fetch = vi.fn<RemoteFetch>(async () =>
      json({
        protocol: "obsidian-ai-bridge-mirror-v2",
        associationId: ASSOCIATION,
        writerId: WRITER,
        maxNoteSizeBytes: 1024 * 1024,
        maxPageSize: 50,
        recoveryRetentionSeconds: 2_592_000,
      }),
    );
    const requestAdmission = admission();
    const storage = { getSecret: vi.fn(() => token) };
    const bridge = new FetchRemoteBridge({
      origin: "https://bridge.example",
      secretStorage: storage,
      secretReference: "bridge-token",
      admission: requestAdmission,
      fetch,
      crypto: globalThis.crypto,
    });

    await bridge.describe();
    token = "rotated-token";
    await bridge.describe();

    const first = fetch.mock.calls[0];
    const second = fetch.mock.calls[1];
    expect(first?.[0].toString()).toBe("https://bridge.example/api/v2/mirror");
    expect(first?.[1]).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
    });
    expect(requestHeader(first?.[1], "Authorization")).toBe(
      "Bearer first-token",
    );
    expect(requestHeader(second?.[1], "Authorization")).toBe(
      "Bearer rotated-token",
    );
    expect(storage.getSecret).toHaveBeenCalledTimes(2);
    expect(requestAdmission.release).toHaveBeenCalledTimes(2);
  });

  it("sends a canonical encoded conditional create and only confirms its exact receipt", async () => {
    const fetch = vi.fn<RemoteFetch>(async () =>
      json(acknowledgement(), 201, { ETag: formatApplicationEtag(REVISION) }),
    );
    const { bridge } = adapter(fetch);

    await expect(bridge.mutateNote(createRequest)).resolves.toMatchObject({
      kind: "confirmed",
      confirmed: { path: PATH, revision: REVISION },
    });
    const call = fetch.mock.calls[0];
    expect(call?.[0].toString()).toBe(
      "https://bridge.example/api/v2/notes/Zm9sZGVyL-mbqi5tZA",
    );
    expect(call?.[1]).toMatchObject({
      method: "PUT",
      credentials: "omit",
      redirect: "error",
      body: "hello",
    });
    expect(requestHeader(call?.[1], "Authorization")).toBe(
      "Bearer first-token",
    );
    expect(requestHeader(call?.[1], "If-None-Match")).toBe("*");
    expect(requestHeader(call?.[1], "Content-Type")).toBe(
      REMOTE_NOTE_REQUEST_CONTENT_TYPE,
    );
    expect(requestHeader(call?.[1], "Bridge-Association-Id")).toBe(ASSOCIATION);
    expect(requestHeader(call?.[1], "Bridge-Writer-Id")).toBe(WRITER);
    expect(requestHeader(call?.[1], "Bridge-Operation-Id")).toBe(OPERATION);
  });

  it("preserves literal percent paths across pages, state, recovery, and acknowledgements", async () => {
    const percentAcknowledgement = acknowledgement(
      "create",
      LITERAL_PERCENT_PATH,
    );
    const responses = [
      json({ notes: [LITERAL_PERCENT_PATH], nextCursor: null }),
      json(
        {
          kind: "live",
          path: LITERAL_PERCENT_PATH,
          revision: REVISION,
          contentSha256: HASH,
          receipt: percentAcknowledgement.receipt,
        },
        200,
        { ETag: formatApplicationEtag(REVISION) },
      ),
      json(
        {
          recoveries: [
            {
              kind: "prepared",
              id: RECOVERY,
              associationId: ASSOCIATION,
              path: LITERAL_PERCENT_PATH,
              revision: REVISION,
              sourceRevision: PARENT,
              contentSha256: HASH,
            },
          ],
          nextCursor: null,
        },
        200,
      ),
      json(percentAcknowledgement, 201, {
        ETag: formatApplicationEtag(REVISION),
      }),
    ];
    const fetch = vi.fn<RemoteFetch>(async () => required(responses.shift()));
    const { bridge } = adapter(fetch);

    await expect(bridge.listNotes()).resolves.toEqual({
      kind: "success",
      value: { notes: [LITERAL_PERCENT_PATH], nextCursor: null },
    });
    await expect(
      bridge.inspectNote(LITERAL_PERCENT_PATH),
    ).resolves.toMatchObject({
      kind: "success",
      value: { path: LITERAL_PERCENT_PATH },
    });
    await expect(bridge.listRecovery()).resolves.toMatchObject({
      kind: "success",
      value: { recoveries: [{ path: LITERAL_PERCENT_PATH }] },
    });
    await expect(
      bridge.mutateNote({ ...createRequest, path: LITERAL_PERCENT_PATH }),
    ).resolves.toMatchObject({
      kind: "confirmed",
      confirmed: { path: LITERAL_PERCENT_PATH },
    });
    expect(fetch.mock.calls[3]?.[0].toString()).toBe(
      `https://bridge.example/api/v2/notes/${encodeNotePath(LITERAL_PERCENT_PATH)}`,
    );
  });

  it.each([
    ["operationId", "77777777-7777-4777-8777-777777777777"],
    ["associationId", "88888888-8888-4888-8888-888888888888"],
    [
      "contentSha256",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ],
  ] as const)(
    "rejects a successful acknowledgement with the wrong %s",
    async (field, value) => {
      const response = acknowledgement();
      const receipt = { ...response.receipt, [field]: value };
      const { bridge } = adapter(async () =>
        json({ ...response, receipt }, 201, {
          ETag: formatApplicationEtag(REVISION),
        }),
      );

      await expect(bridge.mutateNote(createRequest)).resolves.toEqual({
        kind: "failure",
        failure: "malformed-response",
        effect: "unknown",
      });
    },
  );

  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
    [412, "precondition-failed"],
    [428, "precondition-required"],
  ])(
    "preserves proven mutation refusal status %i despite an invalid body",
    async (status, failure) => {
      const { bridge } = adapter(
        async () => new Response("<html>", { status }),
      );
      await expect(bridge.mutateNote(createRequest)).resolves.toEqual({
        kind: "failure",
        failure,
        effect: "definitely-refused",
      });
    },
  );

  it.each([
    [429, "rate-limited"],
    [500, "server-failed"],
  ])(
    "classifies transient mutation status %i as %s with unknown effect",
    async (status, failure) => {
      const note = adapter(async () => new Response("", { status }));
      await expect(note.bridge.mutateNote(createRequest)).resolves.toEqual({
        kind: "failure",
        failure,
        effect: "unknown",
      });

      const recovery = adapter(async () => new Response("", { status }));
      await expect(
        recovery.bridge.sealRecovery({
          id: RECOVERY,
          associationId: ASSOCIATION,
          writerId: WRITER,
          operationId: OPERATION,
          expectedRevision: REVISION,
        }),
      ).resolves.toEqual({
        kind: "failure",
        failure,
        effect: "unknown",
      });
    },
  );

  it("does not dispatch when the native secret is removed or admission is denied", async () => {
    const fetch = vi.fn<RemoteFetch>();
    const missing = adapter(fetch, "");
    await expect(missing.bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure: "missing-secret",
    });
    expect(fetch).not.toHaveBeenCalled();

    const denied = admission();
    denied.admit = vi.fn().mockResolvedValue(undefined);
    const bridge = new FetchRemoteBridge({
      origin: "https://bridge.example",
      secretStorage: { getSecret: () => "token" },
      secretReference: "reference",
      admission: denied,
      fetch,
    });
    await expect(bridge.mutateNote(createRequest)).resolves.toEqual({
      kind: "failure",
      failure: "admission-denied",
      effect: "not-dispatched",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds JSON bodies by actual streamed bytes rather than Content-Length", async () => {
    const oversized = "x".repeat(MAX_REMOTE_METADATA_RESPONSE_BYTES + 1);
    const { bridge } = adapter(
      async () =>
        new Response(oversized, {
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "1",
          },
        }),
    );
    await expect(bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
    });
  });

  it("rejects malformed UTF-8, wrong success media types, and closed-schema extras", async () => {
    const malformed = adapter(
      async () =>
        new Response(new Uint8Array([0xc3, 0x28]), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(malformed.bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
    });

    const media = adapter(
      async () =>
        new Response("{}", { headers: { "Content-Type": "text/html" } }),
    );
    await expect(media.bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
    });

    const schema = adapter(async () =>
      json({
        protocol: "obsidian-ai-bridge-mirror-v2",
        associationId: ASSOCIATION,
        writerId: WRITER,
        maxNoteSizeBytes: 1024 * 1024,
        maxPageSize: 50,
        recoveryRetentionSeconds: 2_592_000,
        unexpected: true,
      }),
    );
    await expect(schema.bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
    });
  });

  it("classifies a response-stream failure as network unavailable", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("network stream failed"));
      },
    });
    const { bridge } = adapter(
      async () =>
        new Response(stream, {
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure: "network-unavailable",
    });
  });

  it("releases admission after a settled response cancellation rejects", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => Promise.reject(new Error("host cancellation failed")),
      }),
      { status: 404 },
    );
    const { bridge, requestAdmission } = adapter(async () => response);

    await expect(bridge.readNote(PATH)).resolves.toEqual({
      kind: "success",
      value: { kind: "missing" },
    });
    await vi.waitFor(() =>
      expect(requestAdmission.release).toHaveBeenCalledOnce(),
    );
  });

  it("returns the body deadline while retaining admission until cancellation settles", async () => {
    let cancelled = false;
    let settleCancellation: (() => void) | undefined;
    const cancellation = new Promise<void>((resolve) => {
      settleCancellation = resolve;
    });
    const stalled = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
        return cancellation;
      },
    });
    const { bridge, requestAdmission } = adapter(
      async () =>
        new Response(stalled, {
          headers: { "Content-Type": "application/json" },
        }),
      "token",
      5,
    );

    await expect(bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure: "timed-out",
    });
    expect(cancelled).toBe(true);
    expect(requestAdmission.release).not.toHaveBeenCalled();
    required(settleCancellation)();
    await vi.waitFor(() =>
      expect(requestAdmission.release).toHaveBeenCalledOnce(),
    );
  });

  it("returns the Fetch deadline while retaining admission until Fetch settles", async () => {
    let settleFetch: ((response: Response) => void) | undefined;
    const pendingFetch = new Promise<Response>((resolve) => {
      settleFetch = resolve;
    });
    const { bridge, requestAdmission } = adapter(
      () => pendingFetch,
      "token",
      5,
    );

    await expect(bridge.mutateNote(createRequest)).resolves.toEqual({
      kind: "failure",
      failure: "timed-out",
      effect: "unknown",
    });
    expect(requestAdmission.release).not.toHaveBeenCalled();

    let lateBodyCancelled = false;
    required(settleFetch)(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => {
            lateBodyCancelled = true;
          },
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(lateBodyCancelled).toBe(true);
      expect(requestAdmission.release).toHaveBeenCalledOnce();
    });
  });

  it("maps normal note read formats and state variants with their required ETags", async () => {
    const responses = [
      new Response("legacy", {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Bridge-Note-Format": "legacy",
        },
      }),
      new Response("ignored", { status: 404 }),
      json({ kind: "absent", path: PATH }),
      json(
        {
          kind: "tombstone",
          path: PATH,
          revision: REVISION,
          deletedRevision: PARENT,
          recoveryId: OPERATION,
          receipt: {
            action: "tombstone",
            associationId: ASSOCIATION,
            operationId: OPERATION,
            precondition: { kind: "matching-revision", revision: PARENT },
          },
        },
        200,
        { ETag: formatApplicationEtag(REVISION) },
      ),
    ];
    const { bridge } = adapter(async () => required(responses.shift()));

    await expect(bridge.readNote(PATH)).resolves.toEqual({
      kind: "success",
      value: { kind: "legacy", content: "legacy" },
    });
    await expect(bridge.readNote(PATH)).resolves.toEqual({
      kind: "success",
      value: { kind: "missing" },
    });
    await expect(bridge.inspectNote(PATH)).resolves.toEqual({
      kind: "success",
      value: { kind: "absent", path: PATH },
    });
    await expect(bridge.inspectNote(PATH)).resolves.toMatchObject({
      kind: "success",
      value: { kind: "tombstone", recoveryId: OPERATION },
    });
  });

  it("adapts state, list, recovery and raw content operations without accepting tombstones as current reads", async () => {
    const responses = [
      json(
        {
          kind: "live",
          path: PATH,
          revision: REVISION,
          contentSha256: HASH,
          receipt: acknowledgement().receipt,
        },
        200,
        { ETag: formatApplicationEtag(REVISION) },
      ),
      json({ notes: [PATH], nextCursor: "opaque" }),
      json({
        recoveries: [
          {
            kind: "prepared",
            id: RECOVERY,
            associationId: ASSOCIATION,
            path: PATH,
            revision: REVISION,
            sourceRevision: PARENT,
            contentSha256: HASH,
          },
        ],
        nextCursor: null,
      }),
      new Response("saved", {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Bridge-Note-Format": "2",
          ETag: formatApplicationEtag(REVISION),
        },
      }),
    ];
    const { bridge } = adapter(async () => required(responses.shift()));

    await expect(bridge.inspectNote(PATH)).resolves.toMatchObject({
      kind: "success",
      value: { kind: "live", path: PATH },
    });
    await expect(bridge.listNotes("opaque")).resolves.toEqual({
      kind: "success",
      value: { notes: [PATH], nextCursor: "opaque" },
    });
    await expect(bridge.listRecovery()).resolves.toMatchObject({
      kind: "success",
      value: { recoveries: [{ id: RECOVERY }] },
    });
    await expect(bridge.readNote(PATH)).resolves.toEqual({
      kind: "success",
      value: { kind: "live", revision: REVISION, content: "saved" },
    });
  });

  it("adapts recovery metadata, content withholding, and explicit maintenance responses", async () => {
    const prepared = {
      kind: "prepared",
      id: RECOVERY,
      associationId: ASSOCIATION,
      path: PATH,
      revision: REVISION,
      sourceRevision: PARENT,
      contentSha256: HASH,
    };
    const sealed = {
      ...prepared,
      kind: "sealed",
      revision: SEALED_REVISION,
      recoverUntil: "2030-01-01T00:00:00.000Z",
    };
    const purged = {
      ...sealed,
      kind: "purged",
      revision: PURGED_REVISION,
    };
    const responses = [
      new Response("", { status: 404 }),
      new Response("", { status: 410 }),
      new Response("recovery", {
        headers: {
          "Content-Type": "text/markdown",
          "Bridge-Note-Format": "2",
          ETag: formatApplicationEtag(REVISION),
        },
      }),
      json(prepared, 200, { ETag: formatApplicationEtag(REVISION) }),
      json(sealed, 200, { ETag: formatApplicationEtag(SEALED_REVISION) }),
      json(purged, 200, { ETag: formatApplicationEtag(PURGED_REVISION) }),
    ];
    const fetch = vi.fn<RemoteFetch>(async () => required(responses.shift()));
    const { bridge } = adapter(fetch);

    await expect(bridge.readRecoveryContent(RECOVERY)).resolves.toEqual({
      kind: "success",
      value: { kind: "missing" },
    });
    await expect(bridge.readRecoveryContent(RECOVERY)).resolves.toEqual({
      kind: "success",
      value: { kind: "unavailable" },
    });
    await expect(bridge.readRecoveryContent(RECOVERY)).resolves.toEqual({
      kind: "success",
      value: { kind: "recoverable", content: "recovery" },
    });
    await expect(bridge.inspectRecovery(RECOVERY)).resolves.toMatchObject({
      kind: "success",
      value: { id: RECOVERY, kind: "prepared" },
    });
    const maintenance = {
      id: RECOVERY,
      associationId: ASSOCIATION,
      writerId: WRITER,
      operationId: OPERATION,
    };
    await expect(
      bridge.sealRecovery({ ...maintenance, expectedRevision: REVISION }),
    ).resolves.toMatchObject({
      kind: "confirmed",
      confirmed: { kind: "sealed", id: RECOVERY },
    });
    await expect(
      bridge.purgeRecovery({
        ...maintenance,
        expectedRevision: SEALED_REVISION,
      }),
    ).resolves.toMatchObject({
      kind: "confirmed",
      confirmed: { kind: "purged", id: RECOVERY },
    });
    expect(fetch.mock.calls[4]?.[1]).toMatchObject({ method: "POST" });
    expect(requestHeader(fetch.mock.calls[4]?.[1], "If-Match")).toBe(
      formatApplicationEtag(REVISION),
    );
    expect(requestHeader(fetch.mock.calls[5]?.[1], "If-Match")).toBe(
      formatApplicationEtag(SEALED_REVISION),
    );
  });

  it("rejects recovery maintenance responses for the wrong action or unchanged generation", async () => {
    const prepared = {
      kind: "prepared",
      id: RECOVERY,
      associationId: ASSOCIATION,
      path: PATH,
      revision: REVISION,
      sourceRevision: PARENT,
      contentSha256: HASH,
    };
    const sealed = {
      ...prepared,
      kind: "sealed",
      revision: SEALED_REVISION,
      recoverUntil: "2030-01-01T00:00:00.000Z",
    };
    const unchangedSealed = { ...sealed, revision: REVISION };
    const responses = [
      json(prepared, 200, { ETag: formatApplicationEtag(REVISION) }),
      json(sealed, 200, { ETag: formatApplicationEtag(SEALED_REVISION) }),
      json(unchangedSealed, 200, { ETag: formatApplicationEtag(REVISION) }),
    ];
    const { bridge } = adapter(async () => required(responses.shift()));
    const maintenance = {
      id: RECOVERY,
      associationId: ASSOCIATION,
      writerId: WRITER,
      operationId: OPERATION,
      expectedRevision: REVISION,
    };

    await expect(bridge.sealRecovery(maintenance)).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
      effect: "unknown",
    });
    await expect(bridge.purgeRecovery(maintenance)).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
      effect: "unknown",
    });
    await expect(bridge.sealRecovery(maintenance)).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
      effect: "unknown",
    });
  });

  it.each([
    [404, "incompatible-protocol"],
    [409, "malformed-response"],
    [412, "malformed-response"],
    [428, "malformed-response"],
    [429, "rate-limited"],
    [500, "server-failed"],
    [418, "malformed-response"],
  ])("classifies read response %i as %s", async (status, failure) => {
    const { bridge } = adapter(async () => new Response("", { status }));
    await expect(bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure,
    });
  });

  it("treats note-mutation absence as an incompatible v2 route", async () => {
    const note = adapter(async () => new Response("", { status: 404 }));
    await expect(note.bridge.mutateNote(createRequest)).resolves.toEqual({
      kind: "failure",
      failure: "incompatible-protocol",
      effect: "unknown",
    });
  });

  it.each([
    [404, "missing", "definitely-refused"],
    [409, "conflict", "definitely-refused"],
    [412, "precondition-failed", "definitely-refused"],
    [428, "precondition-required", "definitely-refused"],
    [418, "incompatible-protocol", "unknown"],
  ])(
    "classifies recovery mutation response %i as %s with %s effect",
    async (status, failure, effect) => {
      const recovery = adapter(async () => new Response("", { status }));
      await expect(
        recovery.bridge.sealRecovery({
          id: RECOVERY,
          associationId: ASSOCIATION,
          writerId: WRITER,
          operationId: OPERATION,
          expectedRevision: REVISION,
        }),
      ).resolves.toEqual({ kind: "failure", failure, effect });
    },
  );

  it("sends exact update and tombstone conditions while rejecting a mismatched parent receipt", async () => {
    const updateRequest: ConditionalMutationRequest = {
      ...createRequest,
      action: "update",
      precondition: { kind: "matching-revision", revision: PARENT },
    };
    const tombstoneRequest: ConditionalMutationRequest = {
      action: "tombstone",
      associationId: ASSOCIATION,
      writerId: WRITER,
      operationId: OPERATION,
      path: PATH,
      precondition: { kind: "matching-revision", revision: PARENT },
    };
    const tombstone = {
      acknowledgement: {
        path: PATH,
        revision: REVISION,
        receipt: {
          action: "tombstone",
          associationId: ASSOCIATION,
          operationId: OPERATION,
          precondition: { kind: "matching-revision", revision: PARENT },
        },
      },
      recovery: {
        kind: "prepared",
        id: OPERATION,
        associationId: ASSOCIATION,
        path: PATH,
        revision: SEALED_REVISION,
        sourceRevision: PARENT,
        contentSha256: HASH,
      },
      sealing: { kind: "not-dispatched" },
    };
    const responses = [
      json(acknowledgement("update"), 200, {
        ETag: formatApplicationEtag(REVISION),
      }),
      json(tombstone, 200, { ETag: formatApplicationEtag(REVISION) }),
    ];
    const fetch = vi.fn<RemoteFetch>(async () => required(responses.shift()));
    const { bridge } = adapter(fetch);

    await expect(bridge.mutateNote(updateRequest)).resolves.toMatchObject({
      kind: "confirmed",
    });
    await expect(bridge.mutateNote(tombstoneRequest)).resolves.toMatchObject({
      kind: "confirmed",
    });
    expect(requestHeader(fetch.mock.calls[0]?.[1], "If-Match")).toBe(
      formatApplicationEtag(PARENT),
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(requestHeader(fetch.mock.calls[1]?.[1], "If-Match")).toBe(
      formatApplicationEtag(PARENT),
    );
  });

  it.each([
    "AbortController",
    "Headers",
    "URL",
    "TextDecoder",
    "TextEncoder",
    "btoa",
  ])(
    "returns unsupported runtime before admission when %s is absent",
    async (capability) => {
      vi.stubGlobal(capability, undefined);
      const fetch = vi.fn<RemoteFetch>();
      const { bridge, requestAdmission } = adapter(fetch);

      await expect(bridge.readNote(PATH)).resolves.toEqual({
        kind: "failure",
        failure: "unsupported-runtime",
      });
      await expect(bridge.inspectNote(PATH)).resolves.toEqual({
        kind: "failure",
        failure: "unsupported-runtime",
      });
      await expect(bridge.mutateNote(createRequest)).resolves.toEqual({
        kind: "failure",
        failure: "unsupported-runtime",
        effect: "not-dispatched",
      });
      expect(requestAdmission.admitMock).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("distinguishes an unavailable SecretStorage capability from a missing secret", async () => {
    const requestAdmission = admission();
    const fetch = vi.fn<RemoteFetch>();
    const bridge = new FetchRemoteBridge({
      origin: "https://bridge.example",
      secretStorage: {},
      secretReference: "reference",
      admission: requestAdmission,
      fetch,
    });

    await expect(bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure: "unsupported-runtime",
    });
    expect(requestAdmission.admitMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch when crypto cannot hash a content mutation", async () => {
    const fetch = vi.fn<RemoteFetch>();
    const bridge = new FetchRemoteBridge({
      origin: "https://bridge.example",
      secretStorage: { getSecret: () => "token" },
      secretReference: "reference",
      admission: admission(),
      fetch,
      crypto: null,
    });
    await expect(bridge.mutateNote(createRequest)).resolves.toEqual({
      kind: "failure",
      failure: "unsupported-runtime",
      effect: "not-dispatched",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed for wrong successful media types and mismatched state metadata", async () => {
    const responses = [
      new Response("body", { headers: { "Content-Type": "text/plain" } }),
      json({ kind: "absent", path: PATH }, 200, {
        ETag: formatApplicationEtag(REVISION),
      }),
      new Response("{}", {
        status: 201,
        headers: { "Content-Type": "text/plain" },
      }),
    ];
    const { bridge } = adapter(async () => required(responses.shift()));
    await expect(bridge.readNote(PATH)).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
    });
    await expect(bridge.inspectNote(PATH)).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
    });
    await expect(bridge.mutateNote(createRequest)).resolves.toEqual({
      kind: "failure",
      failure: "incompatible-protocol",
      effect: "unknown",
    });
  });

  it("rejects a current representation without a strong application ETag and a wrong update parent", async () => {
    const note = adapter(
      async () =>
        new Response("body", {
          headers: {
            "Content-Type": "text/markdown",
            "Bridge-Note-Format": "2",
          },
        }),
    );
    await expect(note.bridge.readNote(PATH)).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
    });

    const wrongParent = acknowledgement("update");
    const response = {
      ...wrongParent,
      revision: SEALED_REVISION,
      receipt: {
        ...wrongParent.receipt,
        precondition: { kind: "matching-revision", revision: REVISION },
      },
    };
    const { bridge } = adapter(async () =>
      json(response, 200, { ETag: formatApplicationEtag(SEALED_REVISION) }),
    );
    const request: ConditionalMutationRequest = {
      ...createRequest,
      action: "update",
      precondition: { kind: "matching-revision", revision: PARENT },
    };
    await expect(bridge.mutateNote(request)).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
      effect: "unknown",
    });
  });

  it("fails closed for admission and secret host exceptions, invalid JSON, and oversized local content", async () => {
    const unsupported = new FetchRemoteBridge({
      origin: "https://bridge.example",
      secretStorage: { getSecret: () => "token" },
      secretReference: "reference",
      admission: admission(),
      fetch: null,
    });
    await expect(unsupported.describe()).resolves.toEqual({
      kind: "failure",
      failure: "unsupported-runtime",
    });

    const failedAdmission = admission();
    failedAdmission.admit = vi.fn().mockRejectedValue(new Error("quota"));
    const noAdmission = new FetchRemoteBridge({
      origin: "https://bridge.example",
      secretStorage: { getSecret: () => "token" },
      secretReference: "reference",
      admission: failedAdmission,
      fetch: vi.fn<RemoteFetch>(),
    });
    await expect(noAdmission.describe()).resolves.toEqual({
      kind: "failure",
      failure: "admission-denied",
    });

    const secretFailure = new FetchRemoteBridge({
      origin: "https://bridge.example",
      secretStorage: {
        getSecret: () => {
          throw new Error("host");
        },
      },
      secretReference: "reference",
      admission: admission(),
      fetch: vi.fn<RemoteFetch>(),
    });
    await expect(secretFailure.describe()).resolves.toEqual({
      kind: "failure",
      failure: "missing-secret",
    });

    const malformed = adapter(
      async () =>
        new Response("{", { headers: { "Content-Type": "application/json" } }),
    );
    await expect(malformed.bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure: "malformed-response",
    });

    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockRejectedValueOnce(new Error("crypto unavailable"));
    const hashFailure = adapter(vi.fn<RemoteFetch>());
    await expect(hashFailure.bridge.mutateNote(createRequest)).resolves.toEqual(
      {
        kind: "failure",
        failure: "unsupported-runtime",
        effect: "not-dispatched",
      },
    );
    digest.mockRestore();

    const oversized: ConditionalMutationRequest = {
      ...createRequest,
      content: "x".repeat(1024 * 1024 + 1),
    };
    const noDispatch = adapter(vi.fn<RemoteFetch>());
    await expect(noDispatch.bridge.mutateNote(oversized)).resolves.toEqual({
      kind: "failure",
      failure: "incompatible-protocol",
      effect: "not-dispatched",
    });
  });

  it("classifies local request construction failures as not dispatched", async () => {
    const invalidHeaderFetch = vi.fn<RemoteFetch>();
    const invalidHeader = adapter(invalidHeaderFetch, "token\ninvalid");
    await expect(
      invalidHeader.bridge.mutateNote(createRequest),
    ).resolves.toEqual({
      kind: "failure",
      failure: "invalid-configuration",
      effect: "not-dispatched",
    });
    expect(invalidHeaderFetch).not.toHaveBeenCalled();
    expect(invalidHeader.requestAdmission.release).toHaveBeenCalledOnce();

    const synchronousFailureFetch = vi.fn<RemoteFetch>(() => {
      throw new Error("Fetch invocation failed before returning a promise.");
    });
    const synchronousFailure = adapter(synchronousFailureFetch);
    await expect(
      synchronousFailure.bridge.mutateNote(createRequest),
    ).resolves.toEqual({
      kind: "failure",
      failure: "invalid-configuration",
      effect: "not-dispatched",
    });
    expect(synchronousFailureFetch).toHaveBeenCalledOnce();
    expect(synchronousFailure.requestAdmission.release).toHaveBeenCalledOnce();
  });

  it("maps network errors and invalid construction before dispatch without retaining a permit", async () => {
    const unavailable = adapter(async () =>
      Promise.reject(new Error("offline")),
    );
    await expect(unavailable.bridge.describe()).resolves.toEqual({
      kind: "failure",
      failure: "network-unavailable",
    });
    expect(unavailable.requestAdmission.release).toHaveBeenCalledOnce();

    const requestAdmission = admission();
    const bridge = new FetchRemoteBridge({
      origin: "not a URL",
      secretStorage: { getSecret: () => "token" },
      secretReference: "reference",
      admission: requestAdmission,
      fetch: vi.fn<RemoteFetch>(),
    });
    await expect(bridge.mutateNote(createRequest)).resolves.toEqual({
      kind: "failure",
      failure: "invalid-configuration",
      effect: "not-dispatched",
    });
    expect(requestAdmission.release).toHaveBeenCalledOnce();
  });
});
