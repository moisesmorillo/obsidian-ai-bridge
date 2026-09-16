import { MirrorObservationEpochCoordinator } from "@obsidian-plugin/runtime/mirror-observation-epoch";
import { describe, expect, it, vi } from "vitest";

describe("MirrorObservationEpochCoordinator", () => {
  it("assigns one reconciliation boundary per attachment gap", () => {
    const coordinator = new MirrorObservationEpochCoordinator();
    const firstChanged = vi.fn();
    expect(
      coordinator.attach({ id: "first", onChanged: firstChanged }),
    ).toEqual({ kind: "attached" });
    expect(coordinator.readyEpoch()).toBeNull();
    expect(coordinator.markLayoutReady("first")).toEqual({
      kind: "ready",
      epoch: 1,
    });
    expect(coordinator.markLayoutReady("first")).toEqual({ kind: "duplicate" });
    coordinator.notify();
    expect(firstChanged).toHaveBeenCalledOnce();

    expect(coordinator.detach("first")).toBe(true);
    expect(coordinator.readyEpoch()).toBeNull();
    const secondChanged = vi.fn();
    expect(
      coordinator.attach({ id: "second", onChanged: secondChanged }),
    ).toEqual({ kind: "attached" });
    expect(coordinator.markLayoutReady("second")).toEqual({
      kind: "ready",
      epoch: 2,
    });
    coordinator.notify();
    expect(firstChanged).toHaveBeenCalledOnce();
    expect(secondChanged).toHaveBeenCalledOnce();
  });

  it("refuses competing attachments and stale lifecycle callbacks", () => {
    const coordinator = new MirrorObservationEpochCoordinator();
    coordinator.attach({ id: "current", onChanged: vi.fn() });
    expect(coordinator.attach({ id: "other", onChanged: vi.fn() })).toEqual({
      kind: "already-attached",
    });
    expect(coordinator.markLayoutReady("other")).toEqual({ kind: "stale" });
    expect(coordinator.detach("other")).toBe(false);
    expect(coordinator.isAttached("current")).toBe(true);
  });
});
