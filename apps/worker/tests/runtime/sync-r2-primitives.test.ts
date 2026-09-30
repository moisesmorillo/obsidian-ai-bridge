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
    const sentinelBefore = Array.from(new Uint8Array(await (await env.BUCKET.get(legacyKey)).arrayBuffer()));
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
    const sentinelAfter = Array.from(new Uint8Array(await sentinel.arrayBuffer()));
    const object = await env.BUCKET.get(key);
    const activeKey = "sync/v1/vaults/11111111-1111-4111-8111-111111111111/inventories/active.json";
    const activeBytes = new TextEncoder().encode("{\\"state\\":\\"empty\\"}");
    const activeCreate = await env.BUCKET.put(activeKey, activeBytes, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    const activeObservation = await env.BUCKET.get(activeKey);
    const activeReplace = await env.BUCKET.put(
      activeKey,
      new TextEncoder().encode("{\\"state\\":\\"active\\"}"),
      { onlyIf: { etagMatches: activeObservation.etag } },
    );
    const operationKey = "sync/v1/vaults/11111111-1111-4111-8111-111111111111/operations/22222222-2222-4222-8222-222222222222.json";
    const journalBytes = new TextEncoder().encode("exact-journal-bytes");
    const journalCreate = await env.BUCKET.put(operationKey, journalBytes, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    const journalCreated = await env.BUCKET.get(operationKey);
    const journalReadBack = new Uint8Array(await journalCreated.arrayBuffer());
    const journalReplay = await env.BUCKET.put(operationKey, journalBytes, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    const journalCas = await env.BUCKET.put(operationKey, new TextEncoder().encode("journal-cas-winner"), {
      onlyIf: { etagMatches: journalCreate.etag },
    });
    const journalStaleCas = await env.BUCKET.put(operationKey, journalBytes, {
      onlyIf: { etagMatches: journalCreate.etag },
    });
    const eventKey = "sync/v1/vaults/11111111-1111-4111-8111-111111111111/feed/03/events/00000000000000000001.json";
    const eventBytes = new TextEncoder().encode("exact-event-bytes");
    const eventCreate = await env.BUCKET.put(eventKey, eventBytes, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    const eventReplay = await env.BUCKET.put(eventKey, eventBytes, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    return Response.json({
      journalCreated: journalCreate !== null,
      journalExactReadBack: JSON.stringify(Array.from(journalReadBack)) === JSON.stringify(Array.from(journalBytes)),
      journalReplayRefused: journalReplay === null,
      journalExactEtagCas: journalCas !== null,
      journalStaleEtagRefused: journalStaleCas === null,
      eventCreated: eventCreate !== null,
      eventReplayRefused: eventReplay === null,
      inventoryCreateOnly: activeCreate !== null,
      inventoryExactCas: activeReplace !== null,
      first: first !== null,
      createOnlyPredicateRefused: absentPredicate === null,
      exactPredicateAccepted: exact !== null,
      stalePredicateRefused: stale === null,
      bytes: Array.from(new Uint8Array(await stored.arrayBuffer())),
      createdBytes,
      exactReadBack: JSON.stringify(createdBytes) === JSON.stringify(Array.from(body)),
      sentinelUnchanged: JSON.stringify(sentinelBefore) === JSON.stringify(sentinelAfter),
      sentinel: new TextDecoder().decode(new Uint8Array(sentinelAfter)),
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
        inventoryCreateOnly: z.boolean(),
        inventoryExactCas: z.boolean(),
        journalCreated: z.boolean(),
        journalExactReadBack: z.boolean(),
        journalReplayRefused: z.boolean(),
        journalExactEtagCas: z.boolean(),
        journalStaleEtagRefused: z.boolean(),
        eventCreated: z.boolean(),
        eventReplayRefused: z.boolean(),
        first: z.boolean(),
        createOnlyPredicateRefused: z.boolean(),
        exactPredicateAccepted: z.boolean(),
        stalePredicateRefused: z.boolean(),
        bytes: z.array(z.number()),
        createdBytes: z.array(z.number()),
        exactReadBack: z.boolean(),
        sentinelUnchanged: z.boolean(),
        sentinel: z.string(),
        uploaded: z.string(),
        listedSyncOnly: z.array(z.string()),
      })
      .parse(await response.json());
    expect(result).toMatchObject({
      inventoryCreateOnly: true,
      inventoryExactCas: true,
      journalCreated: true,
      journalExactReadBack: true,
      journalReplayRefused: true,
      journalExactEtagCas: true,
      journalStaleEtagRefused: true,
      eventCreated: true,
      eventReplayRefused: true,
      first: true,
      createOnlyPredicateRefused: true,
      exactPredicateAccepted: true,
      stalePredicateRefused: true,
      bytes: Array.from(new TextEncoder().encode("cas-winner")),
      createdBytes: Array.from(payload),
      exactReadBack: true,
      sentinelUnchanged: true,
      sentinel: "unchanged-v2-sentinel",
    });
    expect(Number.isFinite(new Date(result.uploaded).getTime())).toBe(true);
    expect(result.listedSyncOnly).toContain(
      "sync/v1/vaults/11111111-1111-4111-8111-111111111111/vault.json",
    );
    expect(result.listedSyncOnly).toContain(
      "sync/v1/vaults/11111111-1111-4111-8111-111111111111/inventories/active.json",
    );
    expect(result.listedSyncOnly).toContain(
      "sync/v1/vaults/11111111-1111-4111-8111-111111111111/operations/22222222-2222-4222-8222-222222222222.json",
    );
    expect(result.listedSyncOnly).toContain(
      "sync/v1/vaults/11111111-1111-4111-8111-111111111111/feed/03/events/00000000000000000001.json",
    );
    expect(
      result.listedSyncOnly.every((listedKey) =>
        listedKey.startsWith("sync/v1/vaults/"),
      ),
    ).toBe(true);
  });
});
