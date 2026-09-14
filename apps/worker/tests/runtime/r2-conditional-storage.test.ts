import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const R2_BINDING = "VAULT_BUCKET";
const COMPATIBILITY_DATE = "2026-09-09";
const MODULES_ROOT = new URL(".", import.meta.url).pathname;
const STORED_TEXT = "same note text";
const FIRST_REVISION = "11111111-1111-4111-8111-111111111111";
const SECOND_REVISION = "22222222-2222-4222-8222-222222222222";
const STORAGE_ETAG_HEADER = "Bridge-Test-Storage-Etag";
const STORAGE_VERSION_HEADER = "Bridge-Test-Storage-Version";
const STORAGE_UPLOADED_HEADER = "Bridge-Test-Storage-Uploaded";

const QUALIFICATION_WORKER = `
const ETAG_HEADER = "${STORAGE_ETAG_HEADER}";
const VERSION_HEADER = "${STORAGE_VERSION_HEADER}";
const UPLOADED_HEADER = "${STORAGE_UPLOADED_HEADER}";

function metadataResponse(object, body = "") {
  if (object === null) return new Response("", { status: 412 });
  return new Response(body, {
    status: 200,
    headers: {
      [ETAG_HEADER]: object.etag,
      [VERSION_HEADER]: object.version,
      [UPLOADED_HEADER]: object.uploaded.toISOString(),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const separator = url.pathname.indexOf("/", 1);
    const operation = url.pathname.slice(1, separator);
    const key = decodeURIComponent(url.pathname.slice(separator + 1));

    if (request.method === "GET" && operation === "object") {
      const object = await env.${R2_BINDING}.get(key);
      if (object === null) return new Response("", { status: 404 });
      return metadataResponse(object, await object.text());
    }

    if (request.method === "PUT" && operation === "create") {
      const onlyIf = new Headers();
      onlyIf.set("If-None-Match", "*");
      return metadataResponse(
        await env.${R2_BINDING}.put(key, await request.text(), { onlyIf }),
      );
    }

    if (request.method === "PUT" && operation === "cas") {
      const etagMatches = request.headers.get(ETAG_HEADER);
      if (etagMatches === null) return new Response("", { status: 400 });
      return metadataResponse(
        await env.${R2_BINDING}.put(key, await request.text(), {
          onlyIf: { etagMatches },
        }),
      );
    }

    return new Response("", { status: 404 });
  },
};
`;

/** Metadata returned directly from one successful workerd R2 operation. */
interface StoredObjectMetadata {
  /** Opaque content validator used by R2 conditional writes. */
  readonly etag: string;
  /** Unique upload generation returned for the successful write. */
  readonly version: string;
  /** Runtime-assigned upload timestamp returned by the stored object. */
  readonly uploaded: Date;
}

/**
 * Builds representative revision-bearing bytes without importing future production codecs.
 *
 * @param revision - Fresh generation identity embedded in otherwise same-text bytes.
 * @returns A deterministic representative live-envelope body.
 */
function revisionEnvelope(revision: string): string {
  return JSON.stringify({
    format: 2,
    kind: "live",
    revision,
    content: STORED_TEXT,
  });
}

/** Response type returned across Miniflare's workerd dispatch boundary. */
type RuntimeResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;

/** Request options accepted across Miniflare's workerd dispatch boundary. */
type RuntimeRequestInit = Parameters<Miniflare["dispatchFetch"]>[1];

/**
 * Reads required storage metadata from a successful qualification response.
 *
 * @param response - Workerd response carrying R2 metadata headers.
 * @returns Validated metadata for one stored object generation.
 * @throws {Error} When required metadata is missing or malformed.
 */
function storedMetadata(response: RuntimeResponse): StoredObjectMetadata {
  const etag = response.headers.get(STORAGE_ETAG_HEADER);
  const version = response.headers.get(STORAGE_VERSION_HEADER);
  const uploadedText = response.headers.get(STORAGE_UPLOADED_HEADER);
  if (etag === null || version === null || uploadedText === null) {
    throw new Error("Expected complete R2 object metadata");
  }

  const uploaded = new Date(uploadedText);
  if (!Number.isFinite(uploaded.getTime())) {
    throw new Error("Expected a valid R2 upload timestamp");
  }

  return { etag, version, uploaded };
}

let runtime: Miniflare | undefined;

beforeAll(async () => {
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "storage-qualification",
          type: "worker",
          compatibilityDate: COMPATIBILITY_DATE,
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: MODULES_ROOT,
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: QUALIFICATION_WORKER,
              },
            },
          },
          env: {
            [R2_BINDING]: { type: "r2", name: "storage-qualification" },
          },
        },
      },
    ],
  });
  await runtime.ready;
});

afterAll(async () => {
  await runtime?.dispose();
});

/**
 * Dispatches a request through the local workerd isolate under qualification.
 *
 * @param operation - Test-only Worker operation to invoke.
 * @param key - Exact current or recovery object key.
 * @param init - Optional request method, body, and observed validator.
 * @returns The local workerd response after the R2 operation settles.
 */
function dispatch(
  operation: "cas" | "create" | "object",
  key: string,
  init?: RuntimeRequestInit,
): Promise<RuntimeResponse> {
  if (runtime === undefined) {
    throw new Error("Expected the qualification runtime to be ready");
  }

  return runtime.dispatchFetch(
    `http://storage-qualification.test/${operation}/${encodeURIComponent(key)}`,
    init,
  );
}

/**
 * Attempts an R2 create with a constructed If-None-Match Headers predicate.
 *
 * @param key - Exact object key that must be absent.
 * @param body - Candidate object bytes.
 * @returns The workerd response identifying success or conditional refusal.
 */
function create(key: string, body: string): Promise<RuntimeResponse> {
  return dispatch("create", key, { method: "PUT", body });
}

/**
 * Attempts an R2 compare-and-swap using the supplied observed object ETag.
 *
 * @param key - Exact object key to replace conditionally.
 * @param body - Candidate replacement bytes.
 * @param etagMatches - Storage validator observed before this attempt.
 * @returns The workerd response identifying success or conditional refusal.
 */
function compareAndSwap(
  key: string,
  body: string,
  etagMatches: string,
): Promise<RuntimeResponse> {
  return dispatch("cas", key, {
    method: "PUT",
    body,
    headers: { [STORAGE_ETAG_HEADER]: etagMatches },
  });
}

/**
 * Retrieves the current stored object and its runtime metadata.
 *
 * @param key - Exact object key to inspect after a conditional operation.
 * @returns The workerd response containing stored bytes and metadata.
 */
function get(key: string): Promise<RuntimeResponse> {
  return dispatch("object", key);
}

describe.each([
  ["current", "vault/create-only.md", "vault/etag-cas.md"],
  [
    "recovery",
    "recovery/11111111-1111-4111-8111-111111111111",
    "recovery/22222222-2222-4222-8222-222222222222",
  ],
])(
  "workerd R2 %s-object conditions",
  (_objectKind, createOnlyKey, compareAndSwapKey) => {
    it("accepts one constructed Headers create and refuses a second write", async () => {
      const testKey = createOnlyKey;
      const originalBody = revisionEnvelope(FIRST_REVISION);
      const createdResponse = await create(testKey, originalBody);
      expect(createdResponse.status).toBe(200);
      const created = storedMetadata(createdResponse);

      const refused = await create(testKey, revisionEnvelope(SECOND_REVISION));
      const storedResponse = await get(testKey);

      expect(refused.status).toBe(412);
      expect(await storedResponse.text()).toBe(originalBody);
      expect(storedMetadata(storedResponse)).toEqual(created);
    });

    it("accepts a matching ETag CAS and rejects a stale ETag without writing", async () => {
      const testKey = compareAndSwapKey;
      const initialResponse = await create(
        testKey,
        revisionEnvelope(FIRST_REVISION),
      );
      expect(initialResponse.status).toBe(200);
      const initial = storedMetadata(initialResponse);
      const replacementBody = revisionEnvelope(SECOND_REVISION);
      const replacementResponse = await compareAndSwap(
        testKey,
        replacementBody,
        initial.etag,
      );
      expect(replacementResponse.status).toBe(200);
      const replacement = storedMetadata(replacementResponse);

      const refused = await compareAndSwap(
        testKey,
        "stale replacement",
        initial.etag,
      );
      const storedResponse = await get(testKey);

      expect(refused.status).toBe(412);
      expect(await storedResponse.text()).toBe(replacementBody);
      expect(storedMetadata(storedResponse)).toEqual(replacement);
    });
  },
);

describe("workerd R2 current-generation evidence", () => {
  it("linearizes two concurrently dispatched create-only writes so exactly one wins", async () => {
    const key = "vault/concurrent-create.md";
    const candidates = [
      revisionEnvelope(FIRST_REVISION),
      revisionEnvelope(SECOND_REVISION),
    ];

    const responses = await Promise.all(
      candidates.map((body) => create(key, body)),
    );
    const storedBody = await (await get(key)).text();

    expect(
      responses
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([200, 412]);
    expect(candidates).toContain(storedBody);
  });

  it("linearizes two CAS attempts from the same observation and preserves the winner", async () => {
    const key = "vault/concurrent-cas.md";
    const initialResponse = await create(key, revisionEnvelope(FIRST_REVISION));
    const initial = storedMetadata(initialResponse);
    const candidates = [
      revisionEnvelope(SECOND_REVISION),
      JSON.stringify({
        format: 2,
        kind: "tombstone",
        revision: "33333333-3333-4333-8333-333333333333",
      }),
    ];

    const responses = await Promise.all(
      candidates.map((body) => compareAndSwap(key, body, initial.etag)),
    );
    const storedResponse = await get(key);

    expect(
      responses
        .map((response) => response.status)
        .sort((left, right) => left - right),
    ).toEqual([200, 412]);
    expect(candidates).toContain(await storedResponse.text());
    expect(storedMetadata(storedResponse).etag).not.toBe(initial.etag);
  });

  it("changes the storage generation and validator for same note text with a fresh embedded revision", async () => {
    const key = "vault/same-text.md";
    const firstResponse = await create(key, revisionEnvelope(FIRST_REVISION));
    expect(firstResponse.status).toBe(200);
    const first = storedMetadata(firstResponse);

    const secondResponse = await compareAndSwap(
      key,
      revisionEnvelope(SECOND_REVISION),
      first.etag,
    );
    expect(secondResponse.status).toBe(200);
    const second = storedMetadata(secondResponse);

    expect(second.etag).not.toBe(first.etag);
    expect(second.version).not.toBe(first.version);
    expect(await (await get(key)).text()).toBe(
      revisionEnvelope(SECOND_REVISION),
    );
  });

  it("returns the stored successful PUT timestamp and leaves it unchanged after stale refusal", async () => {
    const key = "vault/deletion-timestamp.md";
    const liveResponse = await create(key, revisionEnvelope(FIRST_REVISION));
    expect(liveResponse.status).toBe(200);
    const live = storedMetadata(liveResponse);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const beforeTombstone = Date.now();
    const tombstoneBody = JSON.stringify({
      format: 2,
      kind: "tombstone",
      revision: SECOND_REVISION,
      deletedRevision: FIRST_REVISION,
    });
    const tombstoneResponse = await compareAndSwap(
      key,
      tombstoneBody,
      live.etag,
    );
    const afterTombstone = Date.now();
    expect(tombstoneResponse.status).toBe(200);
    const tombstone = storedMetadata(tombstoneResponse);

    expect(tombstone.uploaded.getTime()).toBeGreaterThanOrEqual(
      beforeTombstone,
    );
    expect(tombstone.uploaded.getTime()).toBeLessThanOrEqual(afterTombstone);
    expect(tombstone.uploaded.getTime()).toBeGreaterThan(
      live.uploaded.getTime(),
    );

    const refused = await compareAndSwap(key, "stale tombstone", live.etag);
    const storedResponse = await get(key);

    expect(refused.status).toBe(412);
    expect(await storedResponse.text()).toBe(tombstoneBody);
    expect(storedMetadata(storedResponse)).toEqual(tombstone);
  });
});
