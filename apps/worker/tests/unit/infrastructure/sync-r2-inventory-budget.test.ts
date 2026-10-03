import type {
  R2ConditionalBucketPort,
  R2ListResult,
} from "@worker/infrastructure/r2.types";
import {
  createSyncInventoryInvocationBudget,
  SyncInventoryBudgetExhaustedError,
} from "@worker/infrastructure/sync/sync-r2-inventory-budget";
import { describe, expect, it } from "vitest";

/** Captures calls made to the only synthetic R2 binding in this budget test.
 * @returns Conditional bucket fixture and its physical-call trace.
 */
function bucket() {
  const calls: string[] = [];
  const port: R2ConditionalBucketPort = {
    async get(key) {
      calls.push(`get:${key}`);
      return null;
    },
    async list(options): Promise<R2ListResult> {
      calls.push(`list:${options.prefix}`);
      return { objects: [], truncated: false };
    },
    async put(key) {
      calls.push(`put:${key}`);
      return null;
    },
  };
  return { port, calls };
}

describe("inventory invocation budget", () => {
  it("reserves a complete step before any call and counts raw GET, LIST, PUT and read-back", async () => {
    const { port, calls } = bucket();
    const budget = createSyncInventoryInvocationBudget(() => 20);
    const counted = budget.wrap(port);
    expect(budget.reserve(4, 10)).toBe(true);
    await counted.get("manifest");
    await counted.list({ prefix: "heads/", limit: 1 });
    await counted.put("manifest", "bytes", {
      onlyIf: { etagMatches: "etag" },
      customMetadata: {},
      httpMetadata: { contentType: "application/json" },
    });
    await counted.get("manifest");
    expect(budget.actualCalls).toBe(4);
    expect(calls).toEqual([
      "get:manifest",
      "list:heads/",
      "put:manifest",
      "get:manifest",
    ]);
  });

  it("rejects call #401 before R2 and cannot reserve across simultaneous held credits", async () => {
    const { port, calls } = bucket();
    const budget = createSyncInventoryInvocationBudget(() => 20);
    const counted = budget.wrap(port);
    expect(budget.reserve(400, 10)).toBe(true);
    expect(budget.reserve(1, 0)).toBe(false);
    for (let attempt = 0; attempt < 400; attempt += 1) await counted.get("key");
    expect(budget.actualCalls).toBe(400);
    expect(() => counted.get("key")).toThrow(SyncInventoryBudgetExhaustedError);
    expect(calls).toHaveLength(400);
  });

  it("defers a one-page reservation before consuming its attempt when CPU or call capacity is inadequate", async () => {
    const { port, calls } = bucket();
    let remainingCpu = 4;
    const budget = createSyncInventoryInvocationBudget(() => remainingCpu);
    const counted = budget.wrap(port);
    expect(budget.reserve(4, 5)).toBe(false);
    expect(calls).toEqual([]);
    remainingCpu = 20;
    expect(budget.reserve(399, 5)).toBe(true);
    expect(budget.reserve(2, 0)).toBe(false);
    expect(budget.actualCalls).toBe(0);
    await counted.get("manifest");
    expect(budget.actualCalls).toBe(1);
  });

  it("rejects non-finite or negative CPU estimates before reserving any storage call", () => {
    const nanBudget = createSyncInventoryInvocationBudget(() => Number.NaN);
    expect(nanBudget.reserve(1, 1)).toBe(false);
    expect(nanBudget.actualCalls).toBe(0);
    const negativeBudget = createSyncInventoryInvocationBudget(() => -1);
    expect(negativeBudget.reserve(1, 0)).toBe(false);
  });

  it("counts a scoped cleanup DELETE against the same 400 physical calls", async () => {
    const budget = createSyncInventoryInvocationBudget(() => 20);
    const deleted: string[] = [];
    const remove = budget.wrapDelete(async (key: string) => {
      deleted.push(key);
    });
    expect(budget.reserve(1, 1)).toBe(true);
    await remove("expired-scan/chunks/0.json");
    expect(budget.actualCalls).toBe(1);
    expect(() => remove("expired-scan/chunks/1.json")).toThrow(
      SyncInventoryBudgetExhaustedError,
    );
    expect(deleted).toEqual(["expired-scan/chunks/0.json"]);
  });

  it("rejects invalid reservation quantities without dispatching or consuming credits", () => {
    const budget = createSyncInventoryInvocationBudget(() => 20);
    expect(budget.reserve(-1, 0)).toBe(false);
    expect(budget.reserve(1.5, 0)).toBe(false);
    expect(budget.reserve(1, Number.NaN)).toBe(false);
    expect(budget.reserve(401, 0)).toBe(false);
    expect(budget.actualCalls).toBe(0);
    expect(budget.reserve(400, 1)).toBe(true);
  });
});
