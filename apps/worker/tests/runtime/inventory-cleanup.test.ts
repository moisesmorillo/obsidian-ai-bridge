import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { z } from "zod";

const directory = mkdtempSync(join(tmpdir(), "m7-native-cleanup-"));
let runtime: Miniflare | undefined;
const callsSchema = z
  .object({
    get: z.number().int().nonnegative(),
    list: z.number().int().nonnegative(),
    put: z.number().int().nonnegative(),
    delete: z.number().int().nonnegative(),
  })
  .strict();
/** Strict unsigned-byte DTO preserves exact evidence instead of normalized text. */
const bytesSchema = z.array(z.number().int().min(0).max(255));
const sentinelBytes = Array.from(
  new TextEncoder().encode("unchanged-native-cleanup-sentinel"),
);
const seedSchema = z
  .object({
    manifestBytes: bytesSchema,
    slotBytes: bytesSchema,
    calls: callsSchema,
  })
  .strict();
const inspectionSchema = z
  .object({
    manifestBytes: bytesSchema.nullable(),
    slotBytes: bytesSchema.nullable(),
    scratchPresent: z.array(z.boolean()).length(3),
    sentinels: z.array(bytesSchema.nullable()).length(2),
    calls: callsSchema,
  })
  .strict();
const cleanupSchema = z
  .object({
    result: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("reaped"), key: z.string() }).strict(),
      z
        .object({ kind: z.enum(["deferred", "effect_unknown", "retained"]) })
        .strict(),
    ]),
    actualCalls: z.number().int().nonnegative(),
    calls: callsSchema,
    faultWrites: z.number().int().min(0).max(1),
    clock: z.literal("injected"),
    cpu: z.literal("unavailable"),
  })
  .strict();

beforeAll(() => {
  const root = new URL("../../../../", import.meta.url).pathname;
  execFileSync(
    "bun",
    [
      "build",
      "apps/worker/tests/runtime/fixtures/inventory-cleanup.worker.ts",
      "--target",
      "browser",
      "--format",
      "esm",
      "--outfile",
      join(directory, "worker.mjs"),
    ],
    { cwd: root, stdio: "pipe" },
  );
});
beforeEach(async () => {
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "native-inventory-cleanup",
          type: "worker",
          compatibilityDate: "2026-09-09",
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: directory,
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: readFileSync(join(directory, "worker.mjs"), "utf8"),
              },
            },
          },
          env: { BUCKET: { type: "r2", name: "native-inventory-cleanup" } },
        },
      },
    ],
  });
  await runtime.ready;
});
afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** Sends one private fixture request and preserves Miniflare's host response type, not the Worker ambient Response.
 * @param input One closed local fixture action with its explicit synthetic expiry/fault options.
 * @param headers Closed test-only transport switches for owned-slot and injected native reply cases.
 * @returns Exact SDK host response; callers immediately validate its JSON with the reply contract.
 */
async function post(
  input:
    | { action: "seed"; live: boolean }
    | { action: "cleanup"; lostDeleteReply: boolean }
    | { action: "inspect" },
  headers = new Headers(),
): ReturnType<Miniflare["dispatchFetch"]> {
  if (runtime === undefined)
    throw new Error("Native cleanup fixture is not ready.");
  const response = await runtime.dispatchFetch(
    "http://native-cleanup.test/check",
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: [...headers.entries()],
    },
  );
  expect(response.status).toBe(200);
  if (input.action === "cleanup") {
    const reply = cleanupSchema.parse(await response.clone().json());
    const physicalCalls = Object.values(reply.calls).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(physicalCalls).toBe(reply.actualCalls + reply.faultWrites);
    expect(physicalCalls).toBeLessThanOrEqual(8);
  }
  return response;
}

it("reaps only canonical expired v2 scratch, preserving exact manifest, peer slot and unrelated objects", async () => {
  const seeded = seedSchema.parse(
    await (await post({ action: "seed", live: false })).json(),
  );
  const keys = new Set<string>();
  for (const _ of Array.from({ length: 3 })) {
    const cleanup = cleanupSchema.parse(
      await (await post({ action: "cleanup", lostDeleteReply: false })).json(),
    );
    expect(cleanup.result.kind).toBe("reaped");
    if (cleanup.result.kind !== "reaped")
      throw new Error("Expected one reaped scratch key.");
    expect(keys.has(cleanup.result.key)).toBe(false);
    keys.add(cleanup.result.key);
    expect(cleanup).toMatchObject({
      actualCalls: 5,
      calls: { get: 3, list: 1, put: 0, delete: 1 },
    });
    expect(cleanup.actualCalls).toBe(
      Object.values(cleanup.calls).reduce((sum, value) => sum + value, 0),
    );
    expect(cleanup.actualCalls).toBeLessThanOrEqual(8);
  }
  const retained = cleanupSchema.parse(
    await (await post({ action: "cleanup", lostDeleteReply: false })).json(),
  );
  expect(retained).toMatchObject({
    result: { kind: "retained" },
    actualCalls: 3,
    calls: { get: 2, list: 1, put: 0, delete: 0 },
  });
  const inspected = inspectionSchema.parse(
    await (await post({ action: "inspect" })).json(),
  );
  expect(inspected).toMatchObject({
    manifestBytes: seeded.manifestBytes,
    slotBytes: seeded.slotBytes,
    scratchPresent: [false, false, false],
    sentinels: [sentinelBytes, sentinelBytes],
  });
});

it("does not list or delete scratch before the exact injected expiry", async () => {
  const seeded = seedSchema.parse(
    await (await post({ action: "seed", live: true })).json(),
  );
  const cleanup = cleanupSchema.parse(
    await (await post({ action: "cleanup", lostDeleteReply: false })).json(),
  );
  expect(cleanup).toMatchObject({
    result: { kind: "deferred" },
    actualCalls: 1,
    calls: { get: 1, list: 0, put: 0, delete: 0 },
  });
  const inspected = inspectionSchema.parse(
    await (await post({ action: "inspect" })).json(),
  );
  expect(inspected).toMatchObject({
    manifestBytes: seeded.manifestBytes,
    slotBytes: seeded.slotBytes,
    scratchPresent: [true, true, true],
    sentinels: [sentinelBytes, sentinelBytes],
  });
});

it("keeps a lost DELETE acknowledgement unknown even when the native deletion occurred", async () => {
  const seeded = seedSchema.parse(
    await (await post({ action: "seed", live: false })).json(),
  );
  const cleanup = cleanupSchema.parse(
    await (await post({ action: "cleanup", lostDeleteReply: true })).json(),
  );
  expect(cleanup).toMatchObject({
    result: { kind: "effect_unknown" },
    actualCalls: 4,
    calls: { get: 2, list: 1, put: 0, delete: 1 },
  });
  const inspected = inspectionSchema.parse(
    await (await post({ action: "inspect" })).json(),
  );
  expect(inspected).toMatchObject({
    manifestBytes: seeded.manifestBytes,
    slotBytes: seeded.slotBytes,
    scratchPresent: [false, true, true],
    sentinels: [sentinelBytes, sentinelBytes],
  });
});

it("releases an expired owned slot before any scratch LIST or DELETE", async () => {
  const seeded = seedSchema.parse(
    await (
      await post(
        { action: "seed", live: false },
        new Headers({ "x-test-slot": "owned" }),
      )
    ).json(),
  );
  const cleanup = cleanupSchema.parse(
    await (await post({ action: "cleanup", lostDeleteReply: false })).json(),
  );
  expect(cleanup.result.kind).toBe("deferred");
  expect(cleanup.calls.list).toBe(0);
  expect(cleanup.calls.delete).toBe(0);
  expect(cleanup.calls).toEqual({ get: 4, list: 0, put: 1, delete: 0 });
  expect(cleanup.actualCalls).toBe(5);
  const inspected = inspectionSchema.parse(
    await (await post({ action: "inspect" })).json(),
  );
  expect(inspected.manifestBytes).toEqual(seeded.manifestBytes);
  expect(inspected.slotBytes).not.toEqual(seeded.slotBytes);
  expect(inspected.scratchPresent).toEqual([true, true, true]);
  expect(inspected.sentinels).toEqual([sentinelBytes, sentinelBytes]);
});

it("preserves a competing peer slot when the original-generation release CAS loses", async () => {
  const seeded = seedSchema.parse(
    await (
      await post(
        { action: "seed", live: false },
        new Headers({ "x-test-slot": "owned" }),
      )
    ).json(),
  );
  const cleanup = cleanupSchema.parse(
    await (
      await post(
        { action: "cleanup", lostDeleteReply: false },
        new Headers({ "x-test-fault": "slot_cas_race" }),
      )
    ).json(),
  );
  expect(cleanup.result.kind).toBe("effect_unknown");
  expect(cleanup.calls).toEqual({ get: 4, list: 0, put: 2, delete: 0 });
  expect(cleanup.faultWrites).toBe(1);
  expect(cleanup.actualCalls).toBe(5);
  expect(
    Object.values(cleanup.calls).reduce((sum, count) => sum + count, 0),
  ).toBe(cleanup.actualCalls + cleanup.faultWrites);
  const inspected = inspectionSchema.parse(
    await (await post({ action: "inspect" })).json(),
  );
  expect(inspected.manifestBytes).toEqual(seeded.manifestBytes);
  expect(inspected.scratchPresent).toEqual([true, true, true]);
  expect(inspected.sentinels).toEqual([sentinelBytes, sentinelBytes]);
  if (inspected.slotBytes === null) throw new Error("Missing raced slot.");
  const slot = z
    .object({
      state: z.literal("active"),
      inventoryId: z.literal("33333333-3333-4333-8333-333333333333"),
    })
    .parse(
      JSON.parse(new TextDecoder().decode(new Uint8Array(inspected.slotBytes))),
    );
  expect(slot.state).toBe("active");
});

it("retains effect_unknown after a real DELETE and lost native absence read-back", async () => {
  const seeded = seedSchema.parse(
    await (await post({ action: "seed", live: false })).json(),
  );
  const cleanup = cleanupSchema.parse(
    await (
      await post(
        { action: "cleanup", lostDeleteReply: false },
        new Headers({ "x-test-fault": "lost_readback_reply" }),
      )
    ).json(),
  );
  expect(cleanup.result.kind).toBe("effect_unknown");
  expect(cleanup.calls).toEqual({ get: 3, list: 1, put: 0, delete: 1 });
  const inspected = inspectionSchema.parse(
    await (await post({ action: "inspect" })).json(),
  );
  expect(inspected.manifestBytes).toEqual(seeded.manifestBytes);
  expect(inspected.slotBytes).toEqual(seeded.slotBytes);
  expect(inspected.scratchPresent).toEqual([false, true, true]);
});

it("refuses an injected oversized LIST after a real native LIST without deleting anything", async () => {
  await post({ action: "seed", live: false });
  const cleanup = cleanupSchema.parse(
    await (
      await post(
        { action: "cleanup", lostDeleteReply: false },
        new Headers({ "x-test-fault": "oversized_list" }),
      )
    ).json(),
  );
  expect(cleanup.result.kind).toBe("effect_unknown");
  expect(cleanup.calls).toEqual({ get: 2, list: 1, put: 0, delete: 0 });
  const inspected = inspectionSchema.parse(
    await (await post({ action: "inspect" })).json(),
  );
  expect(inspected.scratchPresent).toEqual([true, true, true]);
});

it("reaps historical v1 chunk scratch without creating newer claim/witness authority", async () => {
  const seeded = seedSchema.parse(
    await (
      await post(
        { action: "seed", live: false },
        new Headers({ "x-test-version": "1" }),
      )
    ).json(),
  );
  const before = inspectionSchema.parse(
    await (await post({ action: "inspect" })).json(),
  );
  expect(before.scratchPresent).toEqual([true, false, false]);
  const cleanup = cleanupSchema.parse(
    await (await post({ action: "cleanup", lostDeleteReply: false })).json(),
  );
  expect(cleanup.result.kind).toBe("reaped");
  const retained = cleanupSchema.parse(
    await (await post({ action: "cleanup", lostDeleteReply: false })).json(),
  );
  expect(retained.result.kind).toBe("retained");
  const after = inspectionSchema.parse(
    await (await post({ action: "inspect" })).json(),
  );
  expect(after.manifestBytes).toEqual(seeded.manifestBytes);
  expect(after.slotBytes).toEqual(seeded.slotBytes);
  expect(after.scratchPresent).toEqual([false, false, false]);
});

it("refuses a deliberately injected newer claim under a historical v1 manifest", async () => {
  const seeded = seedSchema.parse(
    await (
      await post(
        { action: "seed", live: false },
        new Headers({
          "x-test-version": "1",
          "x-test-fault": "v1_forbidden_claim",
        }),
      )
    ).json(),
  );
  const first = cleanupSchema.parse(
    await (await post({ action: "cleanup", lostDeleteReply: false })).json(),
  );
  expect(first.result.kind).toBe("reaped");
  const refused = cleanupSchema.parse(
    await (await post({ action: "cleanup", lostDeleteReply: false })).json(),
  );
  expect(refused.result.kind).toBe("effect_unknown");
  expect(refused.calls.delete).toBe(0);
  const inspected = inspectionSchema.parse(
    await (await post({ action: "inspect" })).json(),
  );
  expect(inspected.manifestBytes).toEqual(seeded.manifestBytes);
  expect(inspected.slotBytes).toEqual(seeded.slotBytes);
  expect(inspected.scratchPresent).toEqual([false, true, false]);
  expect(inspected.sentinels).toEqual([sentinelBytes, sentinelBytes]);
});
