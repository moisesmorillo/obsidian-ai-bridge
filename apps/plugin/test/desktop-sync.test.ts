import { describe, expect, it, vi } from "vitest";
import { DesktopSyncController } from "../src/sync/desktop-sync";

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

	it("reports rejected cycle and rebuild work without breaking queue settlement", async () => {
		const failure = new Error("controlled failure");
		const onError = vi.fn();
		const controller = new DesktopSyncController({
			cycle: async () => {
				throw failure;
			},
			rebuild: async () => {
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
		await expect(controller.rebuild()).rejects.toBe(failure);
		await controller.waitForIdle();
		expect(onError).toHaveBeenCalledTimes(2);
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
