import { PathSchema } from "@obsidian-ai-bridge/protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopSyncController } from "../src/sync/desktop-sync";
import { classifyEnrollmentPath } from "../src/sync/enrollment-scope";

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
