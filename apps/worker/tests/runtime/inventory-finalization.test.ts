import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION } from "@protocol/sync.constants";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const directory = mkdtempSync(join(tmpdir(), "m7-finalization-workerd-"));
let runtime: Miniflare | undefined;
const callsSchema = z.object({
  method: z.enum(["start", "continue", "page"]),
  get: z.number().int(),
  put: z.number().int(),
  list: z.number().int(),
  native: z.object({
    get: z.number().int(),
    put: z.number().int(),
    list: z.number().int(),
  }),
});
const resultSchema = z.object({
  kind: z.enum(["inventory_in_progress", "complete", "error"]),
  code: z.literal("effect_unknown").optional(),
  entryCount: z.number().optional(),
});
const slotSchema = z.object({
  state: z.enum(["active", "empty"]),
  inventoryId: z.string().optional(),
});
const replySchema = z.object({
  boundary: resultSchema,
  recovery: resultSchema,
  terminal: resultSchema,
  page: z
    .object({
      kind: z.literal("complete"),
      summaries: z.array(
        z.object({
          path: z.string(),
          revision: z.string(),
          kind: z.enum(["live", "tombstone"]),
        }),
      ),
      final: z.boolean(),
      nextCursor: z.null(),
    })
    .nullable(),
  fired: z.boolean(),
  conditionalRefused: z.boolean(),
  phaseAtBoundary: z.enum(["scanning", "complete"]),
  slotAtBoundary: slotSchema,
  finalSlot: slotSchema,
  manifestUnchangedAtBoundary: z.boolean(),
  slotUnchangedAtBoundary: z.boolean(),
  peerSlotPreserved: z.boolean().nullable(),
  peerPreserved: z.boolean(),
  v2Preserved: z.boolean(),
  boundaryCalls: callsSchema,
  recoveryCalls: callsSchema,
  traces: z.array(callsSchema),
});

beforeAll(async () => {
  const entry = new URL(
    "./fixtures/inventory-finalization.worker.ts",
    import.meta.url,
  ).pathname;
  const output = join(directory, "worker.mjs");
  execFileSync(
    "bun",
    [
      "build",
      entry,
      "--target",
      "browser",
      "--format",
      "esm",
      "--outfile",
      output,
    ],
    { cwd: new URL("../../../../", import.meta.url).pathname, stdio: "pipe" },
  );
  runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "inventory-finalization",
          type: "worker",
          compatibilityDate: "2026-09-09",
          manifest: {
            mainModule: "worker.mjs",
            modulesRoot: directory,
            modules: {
              "worker.mjs": {
                type: "esm",
                contents: readFileSync(output, "utf8"),
              },
            },
          },
          env: { BUCKET: { type: "r2", name: "inventory-finalization" } },
        },
      },
    ],
  });
  await runtime.ready;
});
afterAll(async () => {
  await runtime?.dispose();
  rmSync(directory, { recursive: true, force: true });
});

// Removing the final-vector comparison, treating an unknown write as complete,
// or refreshing the owned-slot predicate after a CAS refusal must fail these rows.
const scenarios = [
  ["changed", "error", "scanning", "active", 0],
  ["pending", "error", "scanning", "active", 0],
  ["manifest_before", "error", "scanning", "active", 1],
  ["manifest_lost_reply", "inventory_in_progress", "complete", "active", 1],
  ["manifest_unknown", "error", "complete", "active", 1],
  ["release_before", "error", "complete", "active", 1],
  ["release_lost_reply", "complete", "complete", "empty", 1],
  ["release_unknown", "error", "complete", "empty", 1],
  ["peer_race", "error", "complete", "active", 1],
] as const;

describe.each([0, 1] as const)(
  "native inventory finalization with %i head(s)",
  (headCount) => {
    it.each(scenarios)(
      "fails closed or reconciles exact persisted authority at %s",
      async (scenario, kind, phase, slotState, puts) => {
        if (runtime === undefined)
          throw new Error("Local workerd is not ready");
        const response = await runtime.dispatchFetch(
          "http://inventory-finalization.test/verify",
          { method: "POST", body: JSON.stringify({ scenario, headCount }) },
        );
        expect(response.status).toBe(200);
        const reply = replySchema.parse(await response.json());
        expect(reply.boundary.kind).toBe(kind);
        if (kind === "error")
          expect(reply.boundary.code).toBe("effect_unknown");
        expect(reply.phaseAtBoundary).toBe(phase);
        expect(reply.slotAtBoundary.state).toBe(slotState);
        if (slotState === "active")
          expect(reply.slotAtBoundary.inventoryId).toBe(
            scenario === "peer_race"
              ? "66666666-6666-4666-8666-666666666666"
              : "22222222-2222-4222-8222-222222222222",
          );
        expect(reply.boundaryCalls).toMatchObject({
          method: "continue",
          list: 0,
          put: puts,
          get:
            scenario.startsWith("release") || scenario === "peer_race"
              ? 6
              : puts === 0
                ? 132
                : 134,
        });
        expect(reply.boundaryCalls.native).toEqual({
          get: reply.boundaryCalls.get - (scenario.endsWith("unknown") ? 1 : 0),
          put: scenario.endsWith("before") ? 0 : puts,
          list: 0,
        });
        expect(reply.recoveryCalls.native).toEqual({
          get: reply.recoveryCalls.get,
          put: reply.recoveryCalls.put,
          list: reply.recoveryCalls.list,
        });
        expect(reply.fired).toBe(puts === 1);
        expect(reply.peerPreserved).toBe(true);
        expect(reply.v2Preserved).toBe(true);
        expect(
          Math.max(
            ...reply.traces.map((calls) => calls.get + calls.put + calls.list),
          ),
        ).toBe(135);
        for (const calls of reply.traces)
          expect(calls.get + calls.put + calls.list).toBeLessThanOrEqual(
            MAX_INVENTORY_SUBREQUESTS_PER_INVOCATION,
          );
        if (
          scenario === "changed" ||
          scenario === "pending" ||
          scenario === "peer_race"
        ) {
          expect(reply.recovery).toMatchObject({
            kind: "error",
            code: "effect_unknown",
          });
          expect(reply.terminal.kind).toBe("error");
          expect(reply.page).toBeNull();
          expect(reply.finalSlot.state).toBe("active");
          expect(reply.recoveryCalls.put).toBe(0);
          if (scenario === "peer_race") {
            expect(reply.conditionalRefused).toBe(true);
            expect(reply.peerSlotPreserved).toBe(true);
            expect(reply.finalSlot.inventoryId).toBe(
              "66666666-6666-4666-8666-666666666666",
            );
          } else {
            expect(reply.manifestUnchangedAtBoundary).toBe(true);
            expect(reply.slotUnchangedAtBoundary).toBe(true);
          }
          return;
        }
        expect(reply.terminal).toMatchObject({
          kind: "complete",
          entryCount: headCount,
        });
        expect(reply.finalSlot.state).toBe("empty");
        expect(reply.page).toMatchObject({
          kind: "complete",
          final: true,
          nextCursor: null,
        });
        expect(reply.page?.summaries).toEqual(
          headCount === 0
            ? []
            : [
                {
                  path: "synthetic.md",
                  revision: "33333333-3333-4333-8333-333333333333",
                  kind: "live",
                },
              ],
        );
        expect(reply.recovery.kind).toBe(
          scenario === "manifest_before" ? "inventory_in_progress" : "complete",
        );
        if (scenario !== "release_unknown" && scenario !== "release_lost_reply")
          expect(reply.recoveryCalls).toMatchObject({
            get: scenario === "manifest_before" ? 134 : 6,
            put: 1,
            list: 0,
          });
        if (scenario === "manifest_before" || scenario === "release_before") {
          expect(reply.manifestUnchangedAtBoundary).toBe(true);
          expect(reply.slotUnchangedAtBoundary).toBe(true);
        }
        if (scenario === "release_unknown" || scenario === "release_lost_reply")
          expect(reply.recoveryCalls).toMatchObject({
            get: 4,
            put: 0,
            list: 0,
          });
      },
    );
  },
);
