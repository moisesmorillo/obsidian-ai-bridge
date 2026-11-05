import { PathSchema } from "@obsidian-ai-bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopSyncController } from "../src/sync/desktop-sync";
import { classifyEnrollmentPath } from "../src/sync/enrollment-scope";

/** Creates a promise whose settlement the test controls. */
function deferred<T>(): {
	promise: Promise<T>;
	/** Settles the promise with the test-selected value. */
	settle(value: T): void;
} {
	/** Receives the test-controlled promise settlement function. */
	let settle!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		settle = done;
	});
	return { promise, settle };
}

describe("DesktopSyncController", () => {
	it("serializes overlapping triggers and starts one cycle immediately", async () => {
		let finish: (() => void) | undefined;
		const cycle = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const controller = new DesktopSyncController({
			cycle,
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 2,
				clearInterval: () => undefined,
			},
		});
		const first = controller.start();
		const second = controller.syncNow();
		await Promise.resolve();
		expect(cycle).toHaveBeenCalledOnce();
		finish?.();
		await Promise.all([first, second]);
		controller.close();
	});

	it("reports a rejected cycle without breaking queue settlement", async () => {
		const failure = new Error("controlled failure");
		const onError = vi.fn();
		const controller = new DesktopSyncController({
			cycle: async () => {
				throw failure;
			},
			onError,
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 2,
				clearInterval: () => undefined,
			},
		});

		await expect(controller.syncNow()).rejects.toBe(failure);
		await controller.waitForIdle();
		expect(onError).toHaveBeenCalledOnce();
		controller.close();
	});

	it("restores polling after resuming an already-started empty controller", async () => {
		const delays: number[] = [];
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: (_callback, delay) => {
					delays.push(delay);
					return delays.length;
				},
				clearInterval: () => undefined,
			},
		});

		await controller.start();
		controller.pause();
		await controller.resume();

		expect(delays).toHaveLength(2);
		expect(controller.isBusy).toBe(false);
		controller.close();
	});

	it("restores polling while it drains retained events on resume", async () => {
		const delays: number[] = [];
		const observed: string[] = [];
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			onEvent: async (event) => {
				observed.push(event.path);
			},
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: (_callback, delay) => {
					delays.push(delay);
					return delays.length;
				},
				clearInterval: () => undefined,
			},
		});

		await controller.start();
		controller.pause();
		await controller.observe({ type: "modify", path: "kept.md" });
		await controller.resume();

		expect(delays).toHaveLength(2);
		expect(observed).toEqual(["kept.md"]);
		expect(controller.isBusy).toBe(false);
		controller.close();
	});

	it("captures and suppresses a destructive event before debounce and while paused", async () => {
		const captured: string[] = [];
		const admitted: string[] = [];
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			onCaptureEvent: async (event) => {
				captured.push(event.path);
				return event.type === "delete" || event.path.endsWith(".icloud");
			},
			onEvent: async (event) => {
				admitted.push(event.path);
			},
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 2,
				clearInterval: () => undefined,
			},
		});
		controller.pause();
		await controller.observe({ type: "delete", path: "captured.md" });
		await controller.observe({ type: "create", path: "notes/a.md.icloud" });
		expect(captured).toEqual(["captured.md", "notes/a.md.icloud"]);
		expect(admitted).toEqual([]);
		await controller.resume();
		expect(admitted).toEqual([]);
		controller.close();
	});

	it("rechecks current coexistence mode before delayed event admission", async () => {
		let enabled = false;
		const captured: string[] = [];
		const admitted: string[] = [];
		const timeouts: Array<() => void> = [];
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			onCaptureEvent: async (event) => {
				if (!enabled || event.type !== "delete") return false;
				captured.push(event.path);
				return true;
			},
			onEvent: async (event) => {
				admitted.push(event.path);
			},
			host: {
				setTimeout: (callback) => {
					timeouts.push(callback);
					return timeouts.length;
				},
				clearTimeout: () => undefined,
				setInterval: () => 1,
				clearInterval: () => undefined,
			},
		});
		await controller.observe({ type: "delete", path: "late.md" });
		enabled = true;
		timeouts[0]?.();
		await controller.waitForIdle();
		expect(captured).toEqual(["late.md"]);
		expect(admitted).toEqual([]);
		controller.close();
	});

	it("retains later events when capture blocks an active event drain", async () => {
		let blocked = false;
		const observed: string[] = [];
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			isEffectBlocked: () => blocked,
			onEvent: async (event) => {
				observed.push(event.path);
				if (event.path === "first.md") blocked = true;
			},
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 2,
				clearInterval: () => undefined,
			},
		});
		controller.pause();
		await controller.observe({ type: "modify", path: "first.md" });
		await controller.observe({ type: "modify", path: "second.md" });
		await controller.resume();

		expect(observed).toEqual(["first.md"]);
		blocked = false;
		await controller.syncNow();
		expect(observed).toEqual(["first.md", "second.md"]);
		controller.close();
	});

	it("drops terminal invalid paths before they can block valid queued events", async () => {
		const events: string[] = [];
		const cycles = vi.fn(async () => undefined);
		const controller = new DesktopSyncController({
			cycle: cycles,
			onEvent: async (event) => {
				PathSchema.parse(event.path);
				events.push(event.path);
			},
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 2,
				clearInterval: () => undefined,
			},
		});
		const invalidPath = `folder/${"x".repeat(600)}.md`;
		expect(classifyEnrollmentPath(invalidPath, 0)).toBe("excluded");

		await controller.observe({ type: "create", path: invalidPath });
		await controller.observe({ type: "create", path: "valid/note.md" });
		await controller.syncNow();

		expect(events).toEqual(["valid/note.md"]);
		expect(cycles).toHaveBeenCalledOnce();
		expect(controller.isBusy).toBe(false);
		controller.close();
	});

	it("emits an idle status after the cycle promise settles", async () => {
		let controller: DesktopSyncController;
		const busySnapshots: boolean[] = [];
		controller = new DesktopSyncController({
			cycle: async () => undefined,
			onStateChanged: () => busySnapshots.push(controller.isBusy),
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 2,
				clearInterval: () => undefined,
			},
		});

		await controller.syncNow();
		expect(busySnapshots.at(-1)).toBe(false);
		controller.close();
	});

	it("retains ordered events during pause and drains them on resume", async () => {
		const observed: string[] = [];
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			onEvent: async (event) => {
				observed.push(event.path);
			},
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 2,
				clearInterval: () => undefined,
			},
		});
		controller.pause();
		await controller.observe({ type: "create", path: "a.md" });
		await controller.observe({ type: "modify", path: "b.md" });
		expect(observed).toEqual([]);
		await controller.resume();
		expect(observed).toEqual(["a.md", "b.md"]);
		controller.close();
	});

	it("waits for a held cycle before it admits paused event intent on resume", async () => {
		let release: (() => void) | undefined;
		let cycles = 0;
		const observed: string[] = [];
		const controller = new DesktopSyncController({
			cycle: async () => {
				cycles += 1;
				if (cycles === 1)
					await new Promise<void>((resolve) => {
						release = resolve;
					});
			},
			onEvent: async (event) => {
				observed.push(event.path);
			},
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 2,
				clearInterval: () => undefined,
			},
		});
		const first = controller.start();
		await Promise.resolve();
		controller.pause();
		await controller.observe({ type: "delete", path: "saved.md" });
		const resumed = controller.resume();
		await Promise.resolve();
		expect(observed).toEqual([]);
		release?.();
		await Promise.all([first, resumed]);
		expect(observed).toEqual(["saved.md"]);
		expect(cycles).toBe(2);
		controller.close();
	});

	it("keeps plugin events out of the user activity window", async () => {
		const intervalDelays: number[] = [];
		const intervalCallbacks: Array<() => void> = [];
		const clock = vi.spyOn(Date, "now");
		clock.mockReturnValue(1_000);
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: (callback, delay) => {
					intervalDelays.push(delay);
					intervalCallbacks.push(callback);
					return intervalDelays.length;
				},
				clearInterval: () => undefined,
			},
		});

		await controller.start();
		await controller.observe(
			{ type: "modify", path: "plugin.md" },
			Promise.resolve(true),
		);
		expect(intervalDelays.at(-1)).toBe(60_000);
		await controller.observe({ type: "modify", path: "user.md" });
		expect(intervalDelays.at(-1)).toBe(15_000);
		clock.mockReturnValue(301_001);
		await controller.observe(
			{ type: "modify", path: "plugin.md" },
			Promise.resolve(true),
		);
		expect(intervalDelays.at(-1)).toBe(60_000);
		intervalCallbacks.at(-1)?.();
		expect(intervalDelays.at(-1)).toBe(60_000);

		controller.close();
		clock.mockRestore();
	});

	it("retains events in order and starts debounce before origin proof settles", async () => {
		const timers: Array<() => void> = [];
		const delays: number[] = [];
		const admitted: string[] = [];
		const proof = deferred<boolean>();
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			onEvent: async (event) => {
				admitted.push(event.path);
			},
			host: {
				setTimeout: (callback, delay) => {
					delays.push(delay);
					timers.push(callback);
					return timers.length;
				},
				clearTimeout: () => undefined,
				setInterval: (_callback, delay) => delay,
				clearInterval: () => undefined,
			},
		});
		await controller.start();

		const firstAdmission = controller.observe(
			{ type: "modify", path: "first.md" },
			proof.promise,
		);
		await Promise.resolve();
		expect(delays.at(-1)).toBe(2_000);
		expect(controller.isBusy).toBe(true);
		await controller.observe({ type: "modify", path: "second.md" });
		expect(admitted).toEqual([]);
		timers.at(-1)?.();
		await controller.waitForIdle();
		expect(admitted).toEqual(["first.md", "second.md"]);
		expect(controller.isBusy).toBe(false);

		proof.settle(true);
		await firstAdmission;
		expect(admitted).toEqual(["first.md", "second.md"]);
		expect(controller.isBusy).toBe(false);
		controller.close();
	});

	it("fences deferred cadence proof across pause and resume", async () => {
		const timers: Array<() => void> = [];
		const delays: number[] = [];
		const admitted: string[] = [];
		const proof = deferred<boolean>();
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			onEvent: async (event) => {
				admitted.push(event.path);
			},
			host: {
				setTimeout: (callback) => {
					timers.push(callback);
					return timers.length;
				},
				clearTimeout: () => undefined,
				setInterval: (_callback, delay) => {
					delays.push(delay);
					return delays.length;
				},
				clearInterval: () => undefined,
			},
		});
		await controller.start();
		controller.pause();
		const pausedAdmission = controller.observe(
			{ type: "modify", path: "paused.md" },
			proof.promise,
		);
		await Promise.resolve();
		expect(timers).toHaveLength(0);
		expect(controller.isBusy).toBe(true);
		await controller.resume();
		expect(admitted).toEqual(["paused.md"]);
		const intervalsAfterResume = delays.length;

		proof.settle(true);
		await pausedAdmission;
		expect(delays).toHaveLength(intervalsAfterResume);
		expect(controller.isBusy).toBe(false);
		controller.close();
	});

	it("does not install cadence timers when proof resolves after close", async () => {
		const timers: Array<() => void> = [];
		const delays: number[] = [];
		const proof = deferred<boolean>();
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			host: {
				setTimeout: (callback) => {
					timers.push(callback);
					return timers.length;
				},
				clearTimeout: () => undefined,
				setInterval: (_callback, delay) => {
					delays.push(delay);
					return delays.length;
				},
				clearInterval: () => undefined,
			},
		});
		await controller.start();
		const closedAdmission = controller.observe(
			{ type: "modify", path: "closed.md" },
			proof.promise,
		);
		await Promise.resolve();
		const intervalsBeforeClose = delays.length;
		controller.close();
		await controller.waitForIdle();
		expect(controller.isBusy).toBe(true);

		proof.settle(true);
		await closedAdmission;
		expect(delays).toHaveLength(intervalsBeforeClose);
		expect(controller.isBusy).toBe(true);
	});

	it("uses the focused-active, idle, hidden, and event debounce budgets", async () => {
		const intervalDelays: number[] = [];
		const timeoutDelays: number[] = [];
		const callbacks: Array<() => void> = [];
		const intervalCallbacks: Array<() => void> = [];
		let visible = true;
		const clock = vi.spyOn(Date, "now");
		clock.mockReturnValue(1_000);
		const controller = new DesktopSyncController({
			cycle: async () => undefined,
			onEvent: async () => undefined,
			host: {
				setTimeout: (callback, delay) => {
					timeoutDelays.push(delay);
					callbacks.push(callback);
					return callbacks.length;
				},
				clearTimeout: () => undefined,
				setInterval: (callback, delay) => {
					intervalDelays.push(delay);
					intervalCallbacks.push(callback);
					return intervalDelays.length;
				},
				clearInterval: () => undefined,
				isVisible: () => visible,
			},
		});
		await controller.start();
		expect(intervalDelays[0]).toBe(60_000);
		await controller.observe({ type: "modify", path: "n.md" });
		expect(controller.isBusy).toBe(true);
		expect(intervalDelays).toContain(15_000);
		expect(timeoutDelays).toEqual([2_000]);
		callbacks[0]?.();
		await controller.waitForIdle();
		expect(controller.isBusy).toBe(false);
		clock.mockReturnValue(301_001);
		intervalCallbacks[0]?.();
		expect(intervalDelays).toContain(60_000);
		visible = false;
		intervalCallbacks.at(-1)?.();
		expect(intervalDelays).toContain(300_000);
		controller.close();
		clock.mockRestore();
	});
});
