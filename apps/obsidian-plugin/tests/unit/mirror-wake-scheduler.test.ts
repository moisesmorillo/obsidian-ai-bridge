import {
  MINIMUM_MIRROR_WAKE_DELAY_MILLISECONDS,
  type MirrorTimerHost,
  MirrorWakeScheduler,
  type MirrorWakeSource,
} from "@obsidian-plugin/runtime/mirror-wake-scheduler";
import { describe, expect, it, vi } from "vitest";

class FakeTimerHost implements MirrorTimerHost {
  now = 100;
  nextHandle = 1;
  readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];
  readonly cancelled: number[] = [];

  nowMilliseconds(): number {
    return this.now;
  }

  setTimeout(callback: () => void, delayMilliseconds: number): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    this.delays.push(delayMilliseconds);
    return handle;
  }

  clearTimeout(handle: number): void {
    this.cancelled.push(handle);
    this.callbacks.delete(handle);
  }

  fire(handle: number): void {
    const callback = this.callbacks.get(handle);
    this.callbacks.delete(handle);
    callback?.();
  }
}

describe("MirrorWakeScheduler", () => {
  it("schedules only the earliest finite wake and reschedules changed observations", () => {
    const timer = new FakeTimerHost();
    let deadline: number | null = 150;
    const source: MirrorWakeSource = {
      nextWakeAtMilliseconds: () => deadline,
      synchronizeReady: vi.fn(async () => ({ kind: "completed" as const })),
    };
    const scheduler = new MirrorWakeScheduler(source, timer, vi.fn());
    scheduler.reconcile();
    expect(timer.delays).toEqual([50]);
    deadline = 125;
    scheduler.reconcile();
    expect(timer.cancelled).toEqual([1]);
    expect(timer.delays).toEqual([50, 25]);
    deadline = null;
    scheduler.reconcile();
    expect(timer.cancelled).toEqual([1, 2]);
    expect(timer.callbacks.size).toBe(0);
  });

  it("does not reschedule unchanged overdue work after a fenced or rejected run", async () => {
    const timer = new FakeTimerHost();
    const fenced: MirrorWakeSource = {
      nextWakeAtMilliseconds: () => 100,
      synchronizeReady: vi.fn(async () => ({ kind: "fenced" as const })),
    };
    const settled = vi.fn();
    const scheduler = new MirrorWakeScheduler(fenced, timer, settled);
    scheduler.reconcile();
    timer.fire(1);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    expect(timer.delays).toEqual([MINIMUM_MIRROR_WAKE_DELAY_MILLISECONDS]);
    expect(timer.callbacks.size).toBe(0);

    const rejectedTimer = new FakeTimerHost();
    const rejected: MirrorWakeSource = {
      nextWakeAtMilliseconds: () => 100,
      synchronizeReady: vi.fn(async () =>
        Promise.reject(new Error("expected")),
      ),
    };
    const rejectedSettled = vi.fn();
    const rejectedScheduler = new MirrorWakeScheduler(
      rejected,
      rejectedTimer,
      rejectedSettled,
    );
    rejectedScheduler.reconcile();
    rejectedTimer.fire(1);
    await vi.waitFor(() => expect(rejectedSettled).toHaveBeenCalledOnce());
    expect(rejectedTimer.delays).toEqual([
      MINIMUM_MIRROR_WAKE_DELAY_MILLISECONDS,
    ]);
    expect(rejectedTimer.callbacks.size).toBe(0);
  });

  it("avoids zero-delay loops and detaches callbacks without falsifying settlement", async () => {
    const timer = new FakeTimerHost();
    const pending = Promise.withResolvers<{ readonly kind: "completed" }>();
    const run = vi.fn(() => pending.promise);
    const source: MirrorWakeSource = {
      nextWakeAtMilliseconds: () => 100,
      synchronizeReady: run,
    };
    const settled = vi.fn();
    const scheduler = new MirrorWakeScheduler(source, timer, settled);
    scheduler.reconcile();
    expect(timer.delays).toEqual([MINIMUM_MIRROR_WAKE_DELAY_MILLISECONDS]);
    timer.fire(1);
    expect(run).toHaveBeenCalledOnce();
    scheduler.detach();
    pending.resolve({ kind: "completed" });
    await pending.promise;
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(timer.callbacks.size).toBe(0);
  });
});
