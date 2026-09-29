import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const MODULES_ROOT = new URL(".", import.meta.url).pathname;
const WORKER = `
const ETAG = "Test-Etag";
const UPLOADED = "Test-Uploaded";
function metadata(object) {
  return Response.json({ etag: object.etag, uploaded: object.uploaded.toISOString() });
}
export default {
  async fetch(request, env) {
    const body = new Uint8Array(await request.arrayBuffer());
    const legacyKey = "vault/synthetic-m7-sentinel.md";
    const legacyBytes = new TextEncoder().encode("unchanged-v2-sentinel");
    await env.BUCKET.put(legacyKey, legacyBytes);
    const key = "sync/v1/vaults/11111111-1111-4111-8111-111111111111/vault.json";
    const createOnly = new Headers({ "If-None-Match": "*" });
    const first = await env.BUCKET.put(key, body, { onlyIf: createOnly });
    const created = await env.BUCKET.get(key);
    const createdBytes = Array.from(new Uint8Array(await created.arrayBuffer()));
    const absentPredicate = await env.BUCKET.put(key, body, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    const exact = await env.BUCKET.put(key, new TextEncoder().encode("cas-winner"), {
      onlyIf: { etagMatches: first.etag },
    });
    const stale = await env.BUCKET.put(key, new TextEncoder().encode("stale"), {
      onlyIf: { etagMatches: first.etag },
    });
    const stored = await env.BUCKET.get(key);
    const sentinel = await env.BUCKET.get(legacyKey);
    const object = await env.BUCKET.get(key);
    return Response.json({
      first: first !== null,
      createOnlyPredicateRefused: absentPredicate === null,
      exactPredicateAccepted: exact !== null,
      stalePredicateRefused: stale === null,
      bytes: Array.from(new Uint8Array(await stored.arrayBuffer())),
      createdBytes,
      sentinel: new TextDecoder().decode(await sentinel.arrayBuffer()),
      uploaded: object.uploaded.toISOString(),
      listedSyncOnly: (await env.BUCKET.list({ prefix: "sync/v1/vaults/" })).objects.map((item) => item.key),
    });
  },
};
`;

type DispatchResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;
let runtime: Miniflare | undefined;

beforeAll(async () => {
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "sync-r2-primitives",
          type: "worker",
          compatibilityDate: "2026-09-09",
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: MODULES_ROOT,
            modules: { "worker.mjs": { type: "esm", contents: WORKER } },
          },
          env: { BUCKET: { type: "r2", name: "sync-r2-primitives" } },
        },
      },
    ],
  });
  await runtime.ready;
});

afterAll(async () => runtime?.dispose());

describe("local workerd isolated sync R2 predicates", () => {
  it("requires absence and exact ETag predicates and leaves synthetic v2 data untouched", async () => {
    if (runtime === undefined)
      throw new Error("Expected workerd runtime to be ready.");
    const payload = new Uint8Array([0, 1, 2, 255]);
    const response: DispatchResponse = await runtime.dispatchFetch(
      "http://sync-r2-primitives.test/verify",
      { method: "POST", body: payload },
    );
    expect(response.status).toBe(200);
    const result = z
      .object({
        first: z.boolean(),
        createOnlyPredicateRefused: z.boolean(),
        exactPredicateAccepted: z.boolean(),
        stalePredicateRefused: z.boolean(),
        bytes: z.array(z.number()),
        createdBytes: z.array(z.number()),
        sentinel: z.string(),
        uploaded: z.string(),
        listedSyncOnly: z.array(z.string()),
      })
      .parse(await response.json());
    expect(result).toMatchObject({
      first: true,
      createOnlyPredicateRefused: true,
      exactPredicateAccepted: true,
      stalePredicateRefused: true,
      bytes: Array.from(new TextEncoder().encode("cas-winner")),
      createdBytes: Array.from(payload),
      sentinel: "unchanged-v2-sentinel",
    });
    expect(Number.isFinite(new Date(result.uploaded).getTime())).toBe(true);
    expect(result.listedSyncOnly).toEqual([
      "sync/v1/vaults/11111111-1111-4111-8111-111111111111/vault.json",
    ]);
  });
});
