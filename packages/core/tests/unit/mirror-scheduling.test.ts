import {
  FairMirrorScheduler,
  inspectBoundedMirrorInventory,
  MAX_ACTIVE_MIRROR_JOBS,
  MAX_REMOTE_INVENTORY_PAGES,
  MIRROR_INVENTORY_INCOMPLETE_REASON,
  normalizeNotePath,
  REMOTE_BRIDGE_FAILURE,
  type RemoteBridge,
} from "@obsidian-ai-bridge/core";
import { describe, expect, it, vi } from "vitest";

const PATH = required(normalizeNotePath("notes/a.md"));

describe("FairMirrorScheduler", () => {
  it("serves stable FIFO jobs with two global slots and one reservation per key", async () => {
    const scheduler = new FairMirrorScheduler();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const order: string[] = [];
    let maximumActive = 0;
    const enqueue = (key: string, barrier?: Promise<void>) =>
      scheduler.enqueue({
        key,
        run: async () => {
          order.push(key);
          maximumActive = Math.max(maximumActive, scheduler.activeCount());
          await barrier;
        },
      });

    expect(enqueue("a", first.promise)).toBe(true);
    expect(enqueue("b", second.promise)).toBe(true);
    expect(enqueue("a")).toBe(false);
    expect(enqueue("c")).toBe(true);
    expect(enqueue("hot")).toBe(true);
    expect(enqueue("other")).toBe(true);
    expect(scheduler.activeCount()).toBe(MAX_ACTIVE_MIRROR_JOBS);
    expect(order).toEqual(["a", "b"]);

    first.resolve();
    await vi.waitFor(() =>
      expect(order).toEqual(["a", "b", "c", "hot", "other"]),
    );
    second.resolve();
    await scheduler.whenIdle();
    expect(order).toEqual(["a", "b", "c", "hot", "other"]);
    expect(maximumActive).toBe(2);
    expect(scheduler.activeCount()).toBe(0);
    expect(scheduler.isReserved("a")).toBe(false);
  });

  it("reserves both rename paths lexically through actual settlement", async () => {
    const scheduler = new FairMirrorScheduler();
    const barrier = Promise.withResolvers<void>();
    const completion = scheduler.enqueueAndWait({
      key: "a.md",
      reservationKeys: ["a.md", "b.md"],
      run: () => barrier.promise,
    });

    expect(completion).toBeDefined();
    expect(scheduler.isReserved("a.md")).toBe(true);
    expect(scheduler.isReserved("b.md")).toBe(true);
    expect(
      scheduler.enqueue({ key: "b.md", run: () => Promise.resolve() }),
    ).toBe(false);
    expect(() =>
      scheduler.enqueue({
        key: "b.md",
        reservationKeys: ["b.md", "a.md"],
        run: () => Promise.resolve(),
      }),
    ).toThrow("lexically ordered");

    barrier.resolve();
    await completion;
    expect(scheduler.isReserved("a.md")).toBe(false);
    expect(scheduler.isReserved("b.md")).toBe(false);
  });

  it("releases reservations and reports rejected jobs to waiting policy owners", async () => {
    const scheduler = new FairMirrorScheduler();
    const completion = scheduler.enqueueAndWait({
      key: "failed",
      run: () => Promise.reject(new Error("raw adapter failure")),
    });
    await expect(completion).rejects.toThrow("Mirror scheduled job failed");
    await scheduler.whenIdle();
    expect(scheduler.isReserved("failed")).toBe(false);

    expect(
      scheduler.enqueue({
        key: "fire-and-forget",
        run: () => Promise.reject(new Error("raw adapter failure")),
      }),
    ).toBe(true);
    await scheduler.whenIdle();
    expect(scheduler.isReserved("fire-and-forget")).toBe(false);
  });
});

describe("bounded mirror inventory", () => {
  it("reports a repeated cursor without recursively restarting", async () => {
    const listNotes = vi
      .fn<RemoteBridge["listNotes"]>()
      .mockResolvedValueOnce({
        kind: "success",
        value: { notes: [PATH], nextCursor: "again" },
      })
      .mockResolvedValueOnce({
        kind: "success",
        value: { notes: [], nextCursor: "again" },
      });
    const result = await inspectBoundedMirrorInventory({ listNotes });
    expect(result).toEqual({
      kind: "incomplete",
      paths: [PATH],
      pagesRead: 2,
      reason: MIRROR_INVENTORY_INCOMPLETE_REASON.repeatedCursor,
    });
  });

  it("bounds endless distinct and empty pages by the total inventory budget", async () => {
    let page = 0;
    const listNotes = vi.fn<RemoteBridge["listNotes"]>(async () => ({
      kind: "success",
      value: { notes: [], nextCursor: `cursor-${page++}` },
    }));
    const result = await inspectBoundedMirrorInventory({ listNotes });
    expect(result).toEqual({
      kind: "incomplete",
      paths: [],
      pagesRead: MAX_REMOTE_INVENTORY_PAGES,
      reason: MIRROR_INVENTORY_INCOMPLETE_REASON.pageBudgetExhausted,
    });
    expect(listNotes).toHaveBeenCalledTimes(MAX_REMOTE_INVENTORY_PAGES);
  });

  it("returns sorted unique complete paths and exposes a read failure", async () => {
    const other = required(normalizeNotePath("notes/b.md"));
    const complete = await inspectBoundedMirrorInventory({
      listNotes: vi.fn(async () => ({
        kind: "success" as const,
        value: { notes: [other, PATH, PATH], nextCursor: null },
      })),
    });
    expect(complete).toEqual({
      kind: "complete",
      paths: [PATH, other],
      pagesRead: 1,
    });
    const failed = await inspectBoundedMirrorInventory({
      listNotes: vi.fn(async () => ({
        kind: "failure" as const,
        failure: REMOTE_BRIDGE_FAILURE.networkUnavailable,
      })),
    });
    expect(failed).toEqual({
      kind: "incomplete",
      paths: [],
      pagesRead: 0,
      reason: MIRROR_INVENTORY_INCOMPLETE_REASON.remoteFailure,
      remoteFailure: REMOTE_BRIDGE_FAILURE.networkUnavailable,
    });
  });
});

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Invalid fixture.");
  return value;
}
