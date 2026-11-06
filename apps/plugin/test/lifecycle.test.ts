import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicationEvent } from "../src/sync/publication";

/** Sync commands captured from the plugin settings composition. */
interface CapturedSyncActions {
	/** Requests one immediate synchronization cycle. */
	syncNow(): void;
	/** Pauses the active controller and disposes the current composition. */
	pause(): void;
	/** Resumes the active controller after composition setup. */
	resume(): void;
	/** Confirms one durable observation and starts its immediate sync cycle. */
	confirmCoexistence(id: string): void;
}

const host = vi.hoisted(() => ({
	calls: [] as string[],
	protocolAction: "",
	protocolHandler: null as
		| ((params: Record<string, string | "true">) => void)
		| null,
	settingsTab: null as unknown,
	settingsData: null as unknown,
	serverUrlChange: null as ((url: string) => Promise<void>) | null,
	deviceNameChange: null as ((name: string) => Promise<void>) | null,
	syncActions: null as CapturedSyncActions | null,
	saveDataAction: null as ((data: unknown) => Promise<void>) | null,
	state: null as unknown,
	payloads: new Map<string, Uint8Array>(),
	unavailablePaths: new Set<string>(),
	failSave: false,
	failLocalSave: false,
	loadState: null as (() => unknown) | null,
	vaultListeners: [] as Array<{
		event: string;
		callback: (...args: unknown[]) => void;
	}>,
	compositionNames: [] as string[],
	compositionDisposals: [] as string[],
	publicationEvents: [] as PublicationEvent[],
	publicationStages: [] as string[],
	syncCycles: 0,
	/** Controlled application failure emitted by the real plugin cycle boundary. */
	cycleFailure: null as Error | null,
	cycleGate: null as {
		/** Signals that the controlled synchronization phase reached its wait. */
		started(): void;
		wait: Promise<void>;
	} | null,
}));

vi.mock("obsidian", () => ({
	Platform: {
		/** Reports the test-selected mobile host without modeling native behavior. */
		get isMobile() {
			return host.calls.includes("mobile-platform");
		},
	},
	Notice: class {},
	PluginSettingTab: class {},
	Setting: class {},
	requestUrl: () => {
		throw new Error("requestUrl should not run in lifecycle tests");
	},
	Plugin: class {
		loadData = async () => host.settingsData;
		/** Captures the route and callback registered by the plugin lifecycle. */
		registerObsidianProtocolHandler = (
			action: string,
			handler: (params: Record<string, string | "true">) => void,
		) => {
			host.protocolAction = action;
			host.protocolHandler = handler;
		};
		/** Captures the settings tab registered by plugin composition. */
		addSettingTab = (tab: unknown) => {
			host.settingsTab = tab;
		};
		app = {
			vault: {
				create: (..._args: unknown[]) => host.calls.push("vault.create"),
				modify: (..._args: unknown[]) => host.calls.push("vault.modify"),
				delete: (..._args: unknown[]) => host.calls.push("vault.delete"),
				getFiles: () => [],
				on: (event: string, callback: (...args: unknown[]) => void) => {
					const listener = { event, callback };
					host.vaultListeners.push(listener);
					return listener;
				},
				offref: (reference: unknown) => {
					const index = host.vaultListeners.indexOf(
						reference as (typeof host.vaultListeners)[number],
					);
					if (index >= 0) host.vaultListeners.splice(index, 1);
				},
				adapter: {
					stat: async (path: string) =>
						host.unavailablePaths.has(path)
							? { type: "file", mtime: 0, size: 0 }
							: null,
					exists: async (path: string) => host.payloads.has(path),
					mkdir: async () => undefined,
					readBinary: async (path: string) => {
						const bytes = host.payloads.get(path);
						return bytes ? bytes.slice().buffer : new ArrayBuffer(0);
					},
					writeBinary: async (path: string, value: ArrayBuffer) => {
						host.payloads.set(path, new Uint8Array(value).slice());
					},
				},
			},
			loadLocalStorage: (key: string) => {
				if (key.includes(":credential:")) return null;
				host.calls.push("loadLocalStorage");
				return host.loadState ? host.loadState() : host.state;
			},
			saveLocalStorage: (_key: string, value: unknown) => {
				host.calls.push("saveLocalStorage");
				if (host.failLocalSave) throw new Error("local storage write failed");
				if (!host.failSave) host.state = structuredClone(value);
			},
		};
		requestUrl = (..._args: unknown[]) => host.calls.push("requestUrl");
		saveData = (...args: unknown[]) => {
			host.calls.push("saveData");
			return host.saveDataAction?.(args[0]);
		};
		saveSecretStorage = (..._args: unknown[]) =>
			host.calls.push("saveSecretStorage");
	},
}));

vi.mock("../src/sync/create-publication", () => ({
	/** Captures the active label while leaving controller and event lifetimes real. */
	createPublication: (...args: unknown[]) => {
		const deviceName = args[4] as string;
		host.compositionNames.push(deviceName);
		return {
			publication: {
				/** Captures explicit events admitted by the real controller. */
				observe: async (event: PublicationEvent) => {
					host.publicationEvents.push(structuredClone(event));
				},
				scan: async () => {
					host.publicationStages.push("scan");
					if (host.cycleFailure) throw host.cycleFailure;
				},
				flush: async () => {
					host.publicationStages.push("flush");
				},
			},
			reconciliation: {
				lastHead: null,
				/** Counts actual controller cycles and waits at a test-selected boundary. */
				resume: async () => {
					host.publicationStages.push("resume");
					host.syncCycles += 1;
					const gate = host.cycleGate;
					if (!gate) return;
					host.cycleGate = null;
					gate.started();
					await gate.wait;
				},
				enroll: async () => undefined,
				replay: async () => {
					host.publicationStages.push("replay");
					const gate = host.cycleGate;
					if (!gate) return;
					host.cycleGate = null;
					gate.started();
					await gate.wait;
				},
				close: () => undefined,
			},
			readVaultSummary: async () => null,
			/** Records disposal of one effect composition without closing the controller. */
			dispose: () => host.compositionDisposals.push(deviceName),
		};
	},
}));

vi.mock("../src/settings", () => ({
	/** Captures settings callbacks without rendering Obsidian controls. */
	AIBridgeSettingTab: class {
		/** Captures server, device-name, and sync callbacks from plugin composition. */
		constructor(...args: unknown[]) {
			host.serverUrlChange = args[5] as (url: string) => Promise<void>;
			host.deviceNameChange = args[6] as (name: string) => Promise<void>;
			host.syncActions = args[10] as CapturedSyncActions;
		}

		/** Satisfies the composition status-refresh call. */
		refreshStatus(): void {}
	},
}));

import type { App, PluginManifest } from "obsidian";
import {
	DeviceSession,
	type DeviceSessionHost,
	DeviceSessionNetworkError,
} from "../src/auth/device-session";
import { VaultEventAdapter } from "../src/infrastructure/vault-events";
import AIBridgePlugin from "../src/main";
import { DesktopSyncController } from "../src/sync/desktop-sync";
import { DeviceJournal } from "../src/sync/device-journal";
import { SyncTransportError } from "../src/sync/remote-text";

/** Starts a plugin with real controller and vault-event owners. */
async function startConnectedPlugin(
	connectDuringRestore = true,
): Promise<AIBridgePlugin> {
	vi.useFakeTimers();
	vi.stubGlobal("window", {
		setTimeout: (callback: () => void, delay: number) =>
			globalThis.setTimeout(callback, delay),
		clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
		setInterval: (callback: () => void, delay: number) =>
			globalThis.setInterval(callback, delay),
		clearInterval: (handle: number) => globalThis.clearInterval(handle),
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	});
	vi.stubGlobal("document", {
		visibilityState: "visible",
		hasFocus: () => true,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	});
	vi.spyOn(DeviceSession.prototype, "restore").mockImplementation(
		async function (this: DeviceSession) {
			if (!connectDuringRestore) return;
			const sessionHost = Reflect.get(this, "host") as DeviceSessionHost;
			sessionHost.statusChanged("connected");
		},
	);
	const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
	await plugin.onload();
	const controller = Reflect.get(
		plugin,
		"desktopSync",
	) as DesktopSyncController | null;
	await controller?.waitForIdle();
	return plugin;
}

/** Settles queued promise turns after the real controller drains an event. */
async function settleController(
	controller: DesktopSyncController,
): Promise<void> {
	for (let turn = 0; turn < 6; turn += 1) {
		await Promise.resolve();
		await controller.waitForIdle();
	}
}

/** Waits for queued sync transitions and any cycle they admitted. */
async function settleSyncEffects(plugin: AIBridgePlugin): Promise<void> {
	await (Reflect.get(plugin, "syncEffectTail") as Promise<void>);
	const controller = Reflect.get(
		plugin,
		"desktopSync",
	) as DesktopSyncController | null;
	await controller?.waitForIdle();
	await (Reflect.get(plugin, "syncEffectTail") as Promise<void>);
}

/** Sends one synthetic Obsidian callback through the registered production adapter. */
function emitVaultEvent(event: string, ...args: unknown[]): void {
	const listener = host.vaultListeners.find(
		(candidate) => candidate.event === event,
	);
	if (!listener) throw new Error(`Vault ${event} listener is not registered`);
	listener.callback(...args);
}

describe("AIBridgePlugin device-local lifecycle", () => {
	beforeEach(() => {
		host.calls.splice(0);
		host.protocolAction = "";
		host.protocolHandler = null;
		host.settingsTab = null;
		host.settingsData = null;
		host.serverUrlChange = null;
		host.deviceNameChange = null;
		host.syncActions = null;
		host.saveDataAction = null;
		host.state = null;
		host.payloads.clear();
		host.unavailablePaths.clear();
		host.failSave = false;
		host.failLocalSave = false;
		host.loadState = null;
		host.vaultListeners.splice(0);
		host.compositionNames.splice(0);
		host.compositionDisposals.splice(0);
		host.publicationEvents.splice(0);
		host.publicationStages.splice(0);
		host.syncCycles = 0;
		host.cycleFailure = null;
		host.cycleGate = null;
	});

	it.each(["resume", "device-name"] as const)(
		"preserves 429 diagnostics after %s catches settle",
		async (recoveryPath) => {
			const plugin = await startConnectedPlugin();
			try {
				/** Reads safe failure fields after plugin and controller catches settle. */
				const status = () =>
					Reflect.apply(
						Reflect.get(plugin, "syncStatus") as () => unknown,
						plugin,
						[],
					) as {
						failure: {
							transportClass: string;
							code: string | null;
							retryAfterSeconds: string | null;
						} | null;
					};
				const updateName = host.deviceNameChange;
				const failure = new SyncTransportError(
					429,
					"admission_limited",
					null,
					"30",
				);
				host.cycleFailure = failure;
				if (recoveryPath === "resume") {
					host.syncActions?.pause();
					await settleSyncEffects(plugin);
					host.syncActions?.resume();
					await settleSyncEffects(plugin);
				} else {
					if (!updateName) throw new Error("Device name callback is missing");
					await updateName("diagnostic test device");
					await settleSyncEffects(plugin);
				}

				expect(status().failure).toEqual({
					transportClass: "4xx",
					code: "admission_limited",
					retryAfterSeconds: "30",
				});
			} finally {
				plugin.onunload();
				vi.useRealTimers();
				vi.unstubAllGlobals();
			}
		},
	);

	it("shows a safe host-network failure through the real controller", async () => {
		const plugin = await startConnectedPlugin();
		try {
			const controller = Reflect.get(
				plugin,
				"desktopSync",
			) as DesktopSyncController;
			host.cycleFailure = new DeviceSessionNetworkError();
			await controller.syncNow().catch(() => undefined);
			await controller.waitForIdle();
			const status = Reflect.apply(
				Reflect.get(plugin, "syncStatus") as () => unknown,
				plugin,
				[],
			) as { failure: { transportClass: string; code: string | null } | null };

			expect(status.failure).toEqual({
				transportClass: "network",
				code: null,
				retryAfterSeconds: null,
			});
			expect(JSON.stringify(status)).not.toContain("private");
		} finally {
			plugin.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("classifies application failures as other and retains session times after recovery", async () => {
		const plugin = await startConnectedPlugin();
		try {
			const controller = Reflect.get(
				plugin,
				"desktopSync",
			) as DesktopSyncController;
			/** Reads only safe cycle diagnostics from the plugin's live projection. */
			const status = () =>
				Reflect.apply(
					Reflect.get(plugin, "syncStatus") as () => unknown,
					plugin,
					[],
				) as {
					failure: { transportClass: string } | null;
					lastFailureAt: string | null;
					lastSuccessAt: string | null;
				};
			vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
			host.cycleFailure = new Error("private application detail");
			await controller.syncNow().catch(() => undefined);
			await controller.waitForIdle();
			expect(status()).toMatchObject({
				failure: { transportClass: "other" },
				lastFailureAt: "2026-11-09T12:00:00.000Z",
			});
			expect(JSON.stringify(status())).not.toContain(
				"private application detail",
			);

			vi.setSystemTime(new Date("2026-11-09T12:01:00.000Z"));
			host.cycleFailure = null;
			await controller.syncNow();
			expect(status()).toMatchObject({
				failure: null,
				lastFailureAt: "2026-11-09T12:00:00.000Z",
				lastSuccessAt: "2026-11-09T12:01:00.000Z",
			});
		} finally {
			plugin.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("suspends a hidden mobile document and recovers when it becomes visible", async () => {
		host.calls.push("mobile-platform");
		const plugin = await startConnectedPlugin();
		try {
			const controller = Reflect.get(
				plugin,
				"desktopSync",
			) as DesktopSyncController;
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				value: "hidden",
			});
			Reflect.apply(
				Reflect.get(plugin, "visibilityHandler") as () => void,
				plugin,
				[],
			);
			await settleController(controller);
			const cyclesWhileHidden = host.syncCycles;
			await vi.advanceTimersByTimeAsync(300_000);
			expect(host.syncCycles).toBe(cyclesWhileHidden);

			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				value: "visible",
			});
			Reflect.apply(
				Reflect.get(plugin, "visibilityHandler") as () => void,
				plugin,
				[],
			);
			await settleSyncEffects(plugin);
			expect(host.syncCycles).toBe(cyclesWhileHidden + 1);
		} finally {
			plugin.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("keeps the 300-second hidden polling interval on desktop", async () => {
		const plugin = await startConnectedPlugin();
		try {
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				value: "hidden",
			});
			Reflect.apply(
				Reflect.get(plugin, "visibilityHandler") as () => void,
				plugin,
				[],
			);
			await settleSyncEffects(plugin);
			const cyclesBeforePoll = host.syncCycles;
			await vi.advanceTimersByTimeAsync(300_000);
			await settleSyncEffects(plugin);
			expect(host.syncCycles).toBeGreaterThan(cyclesBeforePoll);
		} finally {
			plugin.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("defers sync until connected credential restore completes", async () => {
		vi.stubGlobal("window", {
			setTimeout: () => 1,
			clearTimeout: () => undefined,
			setInterval: () => 2,
			clearInterval: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		});
		vi.stubGlobal("document", {
			visibilityState: "hidden",
			hasFocus: () => false,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
		});
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		const startSync = vi.fn();
		Reflect.set(plugin, "startSync", startSync);
		let startsDuringRestore = -1;
		const restore = vi
			.spyOn(DeviceSession.prototype, "restore")
			.mockImplementation(async () => {
				const session = Reflect.get(plugin, "session");
				const sessionHost = Reflect.get(session, "host") as DeviceSessionHost;
				sessionHost.statusChanged("connected");
				startsDuringRestore = startSync.mock.calls.length;
			});

		try {
			await plugin.onload();
			expect(startsDuringRestore).toBe(0);
			expect(startSync).toHaveBeenCalledOnce();
			const session = Reflect.get(plugin, "session");
			const sessionHost = Reflect.get(session, "host") as DeviceSessionHost;
			sessionHost.statusChanged("connected");
			expect(startSync).toHaveBeenCalledTimes(2);
		} finally {
			plugin.onunload();
			Reflect.deleteProperty(plugin, "startSync");
			restore.mockRestore();
			vi.unstubAllGlobals();
		}
	});
	it("restores device-local Pause before startup and saves Resume locally", async () => {
		host.settingsData = { coexistenceMode: true, syncPaused: true };
		host.state = {
			version: 1,
			device_id: "018f47b2-5c00-7000-8000-000000000001",
			pending_ops: [],
			sync_paused: true,
		};
		const plugin = await startConnectedPlugin();
		try {
			await settleSyncEffects(plugin);
			expect(Reflect.get(plugin, "syncPaused")).toBe(true);
			expect(host.publicationStages).toEqual([]);
			expect(host.syncCycles).toBe(0);
			host.syncActions?.resume();
			await settleSyncEffects(plugin);
			expect(Reflect.get(plugin, "syncPaused")).toBe(false);
			expect(host.state).toMatchObject({ sync_paused: false });
			expect(host.settingsData).toEqual({
				coexistenceMode: true,
				syncPaused: true,
			});
			expect(host.syncCycles).toBeGreaterThan(0);
			host.syncActions?.pause();
			await settleSyncEffects(plugin);
			expect(Reflect.get(plugin, "syncPaused")).toBe(true);
			expect(host.state).toMatchObject({ sync_paused: true });
		} finally {
			plugin.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("ignores shared Pause settings when no local Pause record exists", async () => {
		host.settingsData = { coexistenceMode: true, syncPaused: true };
		const plugin = await startConnectedPlugin();
		try {
			await settleSyncEffects(plugin);
			expect(Reflect.get(plugin, "syncPaused")).toBe(false);
			expect(host.syncCycles).toBeGreaterThan(0);
		} finally {
			plugin.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("keeps Pause active and reports attention when its local save fails", async () => {
		const plugin = await startConnectedPlugin();
		try {
			host.failLocalSave = true;
			host.syncActions?.pause();
			await settleSyncEffects(plugin);
			expect(Reflect.get(plugin, "syncPaused")).toBe(true);
			expect(
				(Reflect.get(plugin, "journal") as DeviceJournal).attentionReason,
			).toBeTruthy();
			expect(Reflect.get(plugin, "settingsValue")).not.toHaveProperty(
				"syncPaused",
			);
		} finally {
			plugin.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("keeps Resume blocked when its local save fails", async () => {
		host.state = {
			version: 1,
			device_id: "018f47b2-5c00-7000-8000-000000000001",
			pending_ops: [],
			sync_paused: true,
		};
		const plugin = await startConnectedPlugin();
		try {
			host.failLocalSave = true;
			host.syncActions?.resume();
			await settleSyncEffects(plugin);
			expect(Reflect.get(plugin, "syncPaused")).toBe(true);
			expect(host.syncCycles).toBe(0);
			expect(
				(Reflect.get(plugin, "journal") as DeviceJournal).attentionReason,
			).toBeTruthy();
		} finally {
			plugin.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("does not persist a stale Pause after plugin unload", async () => {
		const plugin = await startConnectedPlugin();
		const journal = Reflect.get(plugin, "journal") as DeviceJournal;
		host.syncActions?.pause();
		plugin.onunload();
		await Promise.resolve();
		await Promise.resolve();
		expect(journal.snapshot().sync_paused).toBe(false);
		expect(host.state).toMatchObject({ sync_paused: false });
	});

	it("keeps historical work unchanged when capture fences plugin reload", async () => {
		host.settingsData = { coexistenceMode: true };
		const plugin = await startConnectedPlugin(false);
		const journal = Reflect.get(plugin, "journal") as DeviceJournal;
		const epoch = "d".repeat(32);
		await journal.resetEpoch(epoch);
		await journal.enqueue(
			{
				op: "put",
				path: "history/queued.md",
				precondition: { kind: "absent" },
			},
			new TextEncoder().encode("historical operation payload"),
		);
		await journal.beginApply({
			seq: 2,
			op: "put",
			path: "history/pending-apply.md",
			etag: `"${epoch}.2"`,
			hash: "e".repeat(64),
			origin: "remote",
			at: 100,
		});
		await journal.recordAttention("history/attention.md", "historical blocker");
		host.syncActions?.pause();
		const session = Reflect.get(plugin, "session") as DeviceSession;
		const sessionHost = Reflect.get(session, "host") as DeviceSessionHost;
		sessionHost.statusChanged("connected");
		const controller = Reflect.get(
			plugin,
			"desktopSync",
		) as DesktopSyncController;
		const fixture = "oab-10.1/dev-1/simulated-eviction.md";
		host.unavailablePaths.add(`${fixture}.icloud`);
		emitVaultEvent("delete", { path: fixture });
		await settleController(controller);
		emitVaultEvent("create", { path: `${fixture}.icloud` });
		await settleController(controller);
		const captured = journal.snapshot();
		const historical = structuredClone({
			pending_ops: captured.pending_ops,
			pending_apply: captured.pending_apply,
			attention: captured.attention,
		});
		expect(captured.coexistence_confirmations).toHaveLength(1);
		expect(captured.unavailable_paths).toContain(fixture);
		plugin.onunload();
		host.publicationStages.splice(0);
		host.syncCycles = 0;

		const reloaded = await startConnectedPlugin();
		try {
			await settleSyncEffects(reloaded);
			const afterReload = (
				Reflect.get(reloaded, "journal") as DeviceJournal
			).snapshot();
			expect(afterReload.coexistence_confirmations).toEqual(
				captured.coexistence_confirmations,
			);
			expect(afterReload.unavailable_paths).toContain(fixture);
			expect(afterReload.base[`${fixture}.icloud`]).toBeUndefined();
			expect(
				afterReload.pending_ops.some(
					(operation: (typeof afterReload.pending_ops)[number]) =>
						operation.path === `${fixture}.icloud` ||
						(operation.op === "rename" && operation.to === `${fixture}.icloud`),
				),
			).toBe(false);
			expect({
				pending_ops: afterReload.pending_ops,
				pending_apply: afterReload.pending_apply,
				attention: afterReload.attention,
			}).toEqual(historical);
			expect(host.publicationStages).toEqual([]);
			expect(host.syncCycles).toBe(0);
		} finally {
			reloaded.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("stops starting later recovery stages after mobile suspension", async () => {
		host.calls.push("mobile-platform");
		const plugin = await startConnectedPlugin();
		const controller = Reflect.get(
			plugin,
			"desktopSync",
		) as DesktopSyncController;
		let startCycle: (() => void) | undefined;
		let releaseCycle: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			startCycle = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseCycle = resolve;
		});
		host.publicationStages.splice(0);
		host.cycleGate = { started: () => startCycle?.(), wait: release };
		const cycle = controller.syncNow();
		await started;
		try {
			Object.defineProperty(document, "visibilityState", {
				configurable: true,
				value: "hidden",
			});
			Reflect.apply(
				Reflect.get(plugin, "visibilityHandler") as () => void,
				plugin,
				[],
			);
			releaseCycle?.();
			await cycle;
			await settleSyncEffects(plugin);
			expect(host.publicationStages).toEqual(["resume"]);
		} finally {
			releaseCycle?.();
			plugin.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("stops later cycle stages when capture begins during recovery", async () => {
		host.settingsData = { coexistenceMode: true };
		const plugin = await startConnectedPlugin();
		const controller = Reflect.get(
			plugin,
			"desktopSync",
		) as DesktopSyncController;
		const journal = Reflect.get(plugin, "journal") as DeviceJournal;
		/** Reads only safe cycle diagnostics from the plugin's live projection. */
		const status = () =>
			Reflect.apply(
				Reflect.get(plugin, "syncStatus") as () => unknown,
				plugin,
				[],
			) as {
				failure: unknown;
				lastSuccessAt: string | null;
			};
		const lastSuccessAt = status().lastSuccessAt;
		vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
		let startCycle: (() => void) | undefined;
		let releaseCycle: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			startCycle = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseCycle = resolve;
		});
		host.publicationStages.splice(0);
		host.cycleGate = { started: () => startCycle?.(), wait: release };
		const cycle = controller.syncNow();
		await started;
		try {
			emitVaultEvent("delete", { path: "notes/captured.md" });
			for (let turn = 0; turn < 20; turn += 1) {
				if (journal.snapshot().coexistence_confirmations.length > 0) break;
				await Promise.resolve();
			}
			expect(journal.snapshot().coexistence_confirmations).toHaveLength(1);
			releaseCycle?.();
			await cycle;
			expect(host.publicationStages).toEqual(["resume"]);
			expect(status().lastSuccessAt).toBe(lastSuccessAt);
			expect(status().failure).toBeNull();
		} finally {
			releaseCycle?.();
			plugin.onunload();
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it("creates a paused controller after connection from a disconnected state", async () => {
		const plugin = await startConnectedPlugin(false);
		try {
			expect(Reflect.get(plugin, "sessionStatus")).toBe("disconnected");
			expect(Reflect.get(plugin, "desktopSync")).toBeNull();
			host.syncActions?.pause();
			await settleSyncEffects(plugin);
			expect(Reflect.get(plugin, "syncPaused")).toBe(true);

			const session = Reflect.get(plugin, "session") as DeviceSession;
			const sessionHost = Reflect.get(session, "host") as DeviceSessionHost;
			sessionHost.statusChanged("connected");
			await settleSyncEffects(plugin);

			const controller = Reflect.get(plugin, "desktopSync");
			const adapter = Reflect.get(plugin, "vaultEvents");
			expect(controller).toBeInstanceOf(DesktopSyncController);
			expect(adapter).toBeInstanceOf(VaultEventAdapter);
			expect(Reflect.get(controller, "paused")).toBe(true);
			expect(host.syncCycles).toBe(0);

			emitVaultEvent("modify", { path: "connected-before-resume.md" });
			expect((controller as DesktopSyncController).isBusy).toBe(true);
			expect(host.publicationEvents).toEqual([]);
			host.syncActions?.resume();
			await settleSyncEffects(plugin);

			expect(Reflect.get(plugin, "syncPaused")).toBe(false);
			expect(Reflect.get(plugin, "desktopSync")).toBe(controller);
			expect(host.publicationEvents).toEqual([
				{ type: "modify", path: "connected-before-resume.md" },
			]);
			expect(host.syncCycles).toBeGreaterThan(0);
		} finally {
			plugin.onunload();
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it("recreates a paused controller after paused server replacement reconnects", async () => {
		const plugin = await startConnectedPlugin();
		try {
			const originalController = Reflect.get(
				plugin,
				"desktopSync",
			) as DesktopSyncController;
			host.syncActions?.pause();
			await settleSyncEffects(plugin);
			const updateServer = host.serverUrlChange;
			if (!updateServer)
				throw new Error("Server URL callback was not registered");
			await updateServer("https://replacement-service.test");
			expect(Reflect.get(plugin, "desktopSync")).toBeNull();
			expect(Reflect.get(plugin, "syncPaused")).toBe(true);
			expect(Reflect.get(plugin, "sessionStatus")).toBe("disconnected");
			host.syncCycles = 0;

			const replacement = Reflect.get(plugin, "session") as DeviceSession;
			const replacementHost = Reflect.get(
				replacement,
				"host",
			) as DeviceSessionHost;
			replacementHost.statusChanged("connected");
			await settleSyncEffects(plugin);

			const controller = Reflect.get(plugin, "desktopSync");
			const adapter = Reflect.get(plugin, "vaultEvents");
			expect(controller).toBeInstanceOf(DesktopSyncController);
			expect(controller).not.toBe(originalController);
			expect(adapter).toBeInstanceOf(VaultEventAdapter);
			expect(Reflect.get(controller, "paused")).toBe(true);
			expect(host.syncCycles).toBe(0);

			emitVaultEvent("delete", { path: "replacement-before-resume.md" });
			expect((controller as DesktopSyncController).isBusy).toBe(true);
			expect(host.publicationEvents).toEqual([]);
			host.syncActions?.resume();
			await settleSyncEffects(plugin);

			expect(Reflect.get(plugin, "desktopSync")).toBe(controller);
			expect(Reflect.get(plugin, "syncPaused")).toBe(false);
			expect(host.publicationEvents).toEqual([
				{ type: "delete", path: "replacement-before-resume.md" },
			]);
			expect(host.syncCycles).toBeGreaterThan(0);
		} finally {
			plugin.onunload();
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it("opens one local journal without network requests or vault mutation", async () => {
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		plugin.onunload();

		expect(host.calls).toEqual([
			"loadLocalStorage",
			"saveLocalStorage",
			"loadLocalStorage",
		]);
		expect(plugin.attentionReason).toBeNull();
	});

	it("wires the exact Obsidian callback action to the session adapter", async () => {
		const callback = vi
			.spyOn(DeviceSession.prototype, "callback")
			.mockResolvedValue();
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		expect(host.protocolAction).toBe("ai-bridge/callback");
		expect(host.settingsTab).not.toBeNull();
		host.protocolHandler?.({
			action: "ai-bridge/callback",
			code: "synthetic-code",
			state: "synthetic-state",
		});
		await Promise.resolve();
		expect(callback).toHaveBeenCalledWith({
			action: "ai-bridge/callback",
			code: "synthetic-code",
			state: "synthetic-state",
		});
		plugin.onunload();
		callback.mockRestore();
	});

	it("records a localStorage write failure as attention", async () => {
		host.failSave = true;
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		expect(plugin.attentionReason).toBe(
			"Device journal storage needs attention",
		);
		expect(host.calls).toEqual([
			"loadLocalStorage",
			"saveLocalStorage",
			"loadLocalStorage",
		]);
		expect(host.state).toBeNull();
	});

	it("does not install a journal opened after unload", async () => {
		let finishRead: ((value: unknown) => void) | undefined;
		let markReadStarted: (() => void) | undefined;
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		host.loadState = () => {
			host.loadState = null;
			return new Promise((resolve) => {
				finishRead = resolve;
				markReadStarted?.();
			});
		};
		const close = vi.spyOn(DeviceJournal.prototype, "close");
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		const opening = plugin.onload();
		await readStarted;
		plugin.onunload();
		finishRead?.(null);
		await opening;
		expect(close).toHaveBeenCalledOnce();
		close.mockRestore();
	});

	it("closes a settings candidate when unload occurs during saveData", async () => {
		const close = vi.spyOn(DeviceSession.prototype, "close");
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		let releaseSave: (() => void) | undefined;
		let markSaveStarted: (() => void) | undefined;
		const saveStarted = new Promise<void>((resolve) => {
			markSaveStarted = resolve;
		});
		host.saveDataAction = () =>
			new Promise((resolve) => {
				releaseSave = resolve;
				markSaveStarted?.();
			});
		const update = host.serverUrlChange;
		if (!update) throw new Error("Settings callback was not registered");
		const pending = update("https://next-service.test");
		await saveStarted;
		plugin.onunload();
		releaseSave?.();
		await expect(pending).rejects.toThrow();
		expect(close).toHaveBeenCalledTimes(2);
		close.mockRestore();
	});

	it("keeps the real controller and event adapter across paused and debounced name changes", async () => {
		const plugin = await startConnectedPlugin();
		try {
			const controller = Reflect.get(plugin, "desktopSync");
			const adapter = Reflect.get(plugin, "vaultEvents");
			const journal = Reflect.get(plugin, "journal");
			const journalState = structuredClone(
				Reflect.get(journal, "snapshot").call(journal),
			);
			expect(controller).toBeInstanceOf(DesktopSyncController);
			expect(adapter).toBeInstanceOf(VaultEventAdapter);
			const update = host.deviceNameChange;
			if (!update) throw new Error("Device name callback was not registered");

			host.syncActions?.pause();
			emitVaultEvent("delete", { path: "paused-delete.md" });
			await update("device with paused delete");
			expect(Reflect.get(plugin, "desktopSync")).toBe(controller);
			expect(Reflect.get(plugin, "vaultEvents")).toBe(adapter);
			expect(Reflect.get(plugin, "syncPaused")).toBe(true);
			host.syncActions?.resume();
			await settleController(controller as DesktopSyncController);
			expect(Reflect.get(plugin, "syncPaused")).toBe(false);
			expect(Reflect.get(controller, "paused")).toBe(false);
			expect(host.publicationEvents).toEqual([
				{ type: "delete", path: "paused-delete.md" },
			]);

			host.syncActions?.pause();
			emitVaultEvent(
				"rename",
				{ path: "renamed-target.md" },
				"rename-source.md",
			);
			await update("device with paused rename");
			expect(Reflect.get(plugin, "desktopSync")).toBe(controller);
			expect(Reflect.get(plugin, "vaultEvents")).toBe(adapter);
			host.syncActions?.resume();
			await settleController(controller as DesktopSyncController);
			expect(host.publicationEvents).toEqual([
				{ type: "delete", path: "paused-delete.md" },
				{
					type: "rename",
					path: "rename-source.md",
					to: "renamed-target.md",
				},
			]);

			emitVaultEvent("modify", { path: "debounced-modify.md" });
			await update("device with debounced event");
			expect(Reflect.get(plugin, "desktopSync")).toBe(controller);
			expect(Reflect.get(plugin, "vaultEvents")).toBe(adapter);
			await settleController(controller as DesktopSyncController);
			expect(host.publicationEvents).toEqual([
				{ type: "delete", path: "paused-delete.md" },
				{
					type: "rename",
					path: "rename-source.md",
					to: "renamed-target.md",
				},
				{ type: "modify", path: "debounced-modify.md" },
			]);
			expect(
				host.publicationEvents.filter((event) => event.type === "delete"),
			).toHaveLength(1);
			expect(host.compositionNames).toContain("device with paused delete");
			expect(host.compositionNames).toContain("device with paused rename");
			expect(host.compositionNames).toContain("device with debounced event");
			expect(Reflect.get(plugin, "journal")).toBe(journal);
			expect(Reflect.get(journal, "snapshot").call(journal)).toEqual(
				journalState,
			);
		} finally {
			plugin.onunload();
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it("rejects a stale name change after real controller work settles", async () => {
		const plugin = await startConnectedPlugin();
		const controller = Reflect.get(
			plugin,
			"desktopSync",
		) as DesktopSyncController;
		let releaseWork: (() => void) | undefined;
		let markWorkStarted: (() => void) | undefined;
		const workStarted = new Promise<void>((resolve) => {
			markWorkStarted = resolve;
		});
		host.cycleGate = {
			started: () => markWorkStarted?.(),
			wait: new Promise<void>((resolve) => {
				releaseWork = resolve;
			}),
		};
		const cycle = controller.syncNow();
		await workStarted;
		const update = host.deviceNameChange;
		if (!update) throw new Error("Device name callback was not registered");
		const older = update("obsolete device name");
		for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
		const newer = update("current device name");
		releaseWork?.();
		await cycle;
		await expect(older).rejects.toThrow("Device name update is stale");
		await newer;
		await settleController(controller);

		expect(Reflect.get(plugin, "desktopSync")).toBe(controller);
		expect(controller.isBusy).toBe(false);
		expect(Reflect.get(controller, "closed")).toBe(false);
		expect(Reflect.get(controller, "paused")).toBe(false);
		expect(Reflect.get(plugin, "settingsValue")).toMatchObject({
			deviceName: "current device name",
		});
		expect(host.compositionNames).toContain("obsolete device name");
		expect(host.compositionDisposals).toContain("obsolete device name");
		expect(host.compositionNames).toContain("current device name");
		plugin.onunload();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("resumes old effects when a newer name save fails during quiescence", async () => {
		const plugin = await startConnectedPlugin();
		const controller = Reflect.get(
			plugin,
			"desktopSync",
		) as DesktopSyncController;
		let releaseWork: (() => void) | undefined;
		let markWorkStarted: (() => void) | undefined;
		const workStarted = new Promise<void>((resolve) => {
			markWorkStarted = resolve;
		});
		host.cycleGate = {
			started: () => markWorkStarted?.(),
			wait: new Promise<void>((resolve) => {
				releaseWork = resolve;
			}),
		};
		const cycle = controller.syncNow();
		await workStarted;
		const update = host.deviceNameChange;
		if (!update) throw new Error("Device name callback was not registered");
		const older = update("older device name");
		for (let turn = 0; turn < 12; turn += 1) {
			if (Reflect.get(controller, "paused")) break;
			await Promise.resolve();
		}
		expect(Reflect.get(controller, "paused")).toBe(true);
		host.saveDataAction = async () => {
			throw new Error("newer settings write failed");
		};
		const newer = update("newer device name");
		releaseWork?.();
		await cycle;
		await expect(older).rejects.toThrow("Device name update is stale");
		await expect(newer).rejects.toThrow("newer settings write failed");
		await settleController(controller);

		expect(Reflect.get(plugin, "desktopSync")).toBe(controller);
		expect(Reflect.get(controller, "closed")).toBe(false);
		expect(Reflect.get(controller, "paused")).toBe(false);
		expect(Reflect.get(plugin, "settingsValue")).toMatchObject({
			deviceName: "Obsidian desktop",
		});
		expect(host.compositionDisposals).toContain("older device name");
		expect(host.compositionDisposals).toContain("newer device name");
		plugin.onunload();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("keeps the active controller when device-name persistence fails", async () => {
		const plugin = await startConnectedPlugin();
		const controller = Reflect.get(
			plugin,
			"desktopSync",
		) as DesktopSyncController;
		const initialCompositionCount = host.compositionNames.length;
		host.saveDataAction = async () => {
			throw new Error("settings write failed");
		};
		const update = host.deviceNameChange;
		if (!update) throw new Error("Device name callback was not registered");

		await expect(update("unsaved device name")).rejects.toThrow(
			"settings write failed",
		);
		expect(Reflect.get(plugin, "desktopSync")).toBe(controller);
		expect(Reflect.get(controller, "paused")).toBe(false);
		expect(Reflect.get(controller, "closed")).toBe(false);
		expect(Reflect.get(plugin, "settingsValue")).toMatchObject({
			deviceName: "Obsidian desktop",
		});
		expect(host.compositionNames).toHaveLength(initialCompositionCount + 1);
		expect(host.compositionDisposals).toContain("unsaved device name");
		plugin.onunload();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("does not install a name composition after unload during controller quiescence", async () => {
		const plugin = await startConnectedPlugin();
		const controller = Reflect.get(
			plugin,
			"desktopSync",
		) as DesktopSyncController;
		let releaseWork: (() => void) | undefined;
		let markWorkStarted: (() => void) | undefined;
		const workStarted = new Promise<void>((resolve) => {
			markWorkStarted = resolve;
		});
		host.cycleGate = {
			started: () => markWorkStarted?.(),
			wait: new Promise<void>((resolve) => {
				releaseWork = resolve;
			}),
		};
		const cycle = controller.syncNow();
		await workStarted;
		const update = host.deviceNameChange;
		if (!update) throw new Error("Device name callback was not registered");
		const pending = update("unloaded device name");
		for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
		plugin.onunload();
		releaseWork?.();
		await cycle;
		await expect(pending).rejects.toThrow("Device name update is stale");

		expect(Reflect.get(plugin, "desktopSync")).toBeNull();
		expect(host.compositionNames).toContain("unloaded device name");
		expect(host.compositionDisposals).toContain("unloaded device name");
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("closes a server candidate that becomes stale during sync shutdown", async () => {
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		Reflect.set(plugin, "sessionStatus", "connected");
		const initialSession = Reflect.get(plugin, "session");
		const buildSession = Reflect.get(plugin, "buildSession").bind(plugin);
		const candidates: unknown[] = [];
		Reflect.set(plugin, "buildSession", (url: string) => {
			const candidate = buildSession(url);
			candidates.push(candidate);
			return candidate;
		});
		let releaseShutdown: (() => void) | undefined;
		let markShutdownStarted: (() => void) | undefined;
		const shutdownStarted = new Promise<void>((resolve) => {
			markShutdownStarted = resolve;
		});
		let shutdownCount = 0;
		Reflect.set(
			plugin,
			"stopSync",
			vi.fn(() => {
				shutdownCount += 1;
				if (shutdownCount > 1) return Promise.resolve();
				return new Promise<void>((resolve) => {
					releaseShutdown = resolve;
					markShutdownStarted?.();
				});
			}),
		);
		const update = host.serverUrlChange;
		if (!update) throw new Error("Server URL callback was not registered");
		const older = update("https://older-service.test");
		await shutdownStarted;
		const staleCandidate = candidates[0] as DeviceSession;
		const closeStaleCandidate = vi.spyOn(staleCandidate, "close");
		const newer = update("https://newer-service.test");
		releaseShutdown?.();
		await expect(older).rejects.toThrow("Server setting update is stale");
		await newer;

		expect(candidates).toHaveLength(2);
		expect(closeStaleCandidate).toHaveBeenCalledOnce();
		expect(Reflect.get(plugin, "session")).toBe(candidates[1]);
		expect(Reflect.get(plugin, "session")).not.toBe(initialSession);
		expect(Reflect.get(plugin, "settingsValue")).toMatchObject({
			serverUrl: "https://newer-service.test",
		});
		plugin.onunload();
	});

	it("closes a server candidate when unload occurs during sync shutdown", async () => {
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		const buildSession = Reflect.get(plugin, "buildSession").bind(plugin);
		let candidate: DeviceSession | undefined;
		Reflect.set(plugin, "buildSession", (url: string) => {
			candidate = buildSession(url);
			return candidate;
		});
		let releaseShutdown: (() => void) | undefined;
		let markShutdownStarted: (() => void) | undefined;
		const shutdownStarted = new Promise<void>((resolve) => {
			markShutdownStarted = resolve;
		});
		Reflect.set(
			plugin,
			"stopSync",
			() =>
				new Promise<void>((resolve) => {
					releaseShutdown = resolve;
					markShutdownStarted?.();
				}),
		);
		const update = host.serverUrlChange;
		if (!update) throw new Error("Server URL callback was not registered");
		const pending = update("https://unloaded-service.test");
		await shutdownStarted;
		if (!candidate) throw new Error("Server candidate was not created");
		const closeCandidate = vi.spyOn(candidate, "close");
		plugin.onunload();
		releaseShutdown?.();

		await expect(pending).rejects.toThrow("Server setting update is stale");
		expect(closeCandidate).toHaveBeenCalledOnce();
		expect(Reflect.get(plugin, "session")).toBeNull();
	});

	it("persists the local device name with existing non-secret settings", async () => {
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		const saved: unknown[] = [];
		host.saveDataAction = async (data) => {
			saved.push(structuredClone(data));
		};
		const update = host.deviceNameChange;
		if (!update) throw new Error("Device name callback was not registered");
		await update("oab-8.8 dev-1");
		expect(saved).toEqual([
			{
				serverUrl: "https://obsidian-bridge.mmorillo.dev",
				deviceName: "oab-8.8 dev-1",
				coexistenceMode: false,
			},
		]);
		expect(Reflect.get(plugin, "settingsValue")).toEqual({
			serverUrl: "https://obsidian-bridge.mmorillo.dev",
			deviceName: "oab-8.8 dev-1",
			coexistenceMode: false,
		});
		plugin.onunload();
	});

	it("loads an existing local device name from plugin settings", async () => {
		host.settingsData = {
			serverUrl: "https://saved-service.test",
			deviceName: "oab-8.8 dev-2",
			coexistenceMode: false,
			syncPaused: true,
		};
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		expect(Reflect.get(plugin, "settingsValue")).toEqual({
			serverUrl: "https://saved-service.test",
			deviceName: "oab-8.8 dev-2",
			coexistenceMode: false,
		});
		expect(Reflect.get(plugin, "syncPaused")).toBe(false);
		plugin.onunload();
	});

	it("serializes overlapping server URL saves and keeps the latest update", async () => {
		const close = vi.spyOn(DeviceSession.prototype, "close");
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		let releaseFirst: (() => void) | undefined;
		let markFirstStarted: (() => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const savedUrls: string[] = [];
		host.saveDataAction = async (data) => {
			const url = (data as { serverUrl: string }).serverUrl;
			savedUrls.push(url);
			if (url === "https://first-service.test")
				await new Promise<void>((resolve) => {
					releaseFirst = resolve;
					markFirstStarted?.();
				});
		};
		const update = host.serverUrlChange;
		if (!update) throw new Error("Settings callback was not registered");
		const first = update("https://first-service.test");
		await firstStarted;
		const second = update("https://second-service.test");
		releaseFirst?.();
		await expect(first).rejects.toThrow();
		await second;
		expect(savedUrls).toEqual([
			"https://first-service.test",
			"https://second-service.test",
		]);
		expect(close).toHaveBeenCalledTimes(2);
		plugin.onunload();
		close.mockRestore();
	});

	it("catches rejected Sync now promises at the settings boundary", async () => {
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		const failure = new Error("cycle failed");
		const syncNow = Promise.reject<void>(failure);
		const syncNowCatch = vi.spyOn(syncNow, "catch");
		Reflect.set(plugin, "desktopSync", {
			/** Returns the controlled rejected cycle promise. */
			syncNow: () => syncNow,
			/** Satisfies plugin teardown for the injected controller double. */
			close: () => undefined,
		});
		host.syncActions?.syncNow();
		await expect(syncNow).rejects.toThrow("cycle failed");
		expect(syncNowCatch).toHaveBeenCalledOnce();
		expect(host.syncActions).not.toHaveProperty("rebuild");
		plugin.onunload();
	});

	it("starts sync after an owner confirms a captured destructive event", async () => {
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		const confirm = vi.fn().mockResolvedValue({ key: "operation" });
		const syncNow = vi.fn().mockResolvedValue(undefined);
		Reflect.set(plugin, "coexistence", { confirm });
		Reflect.set(plugin, "desktopSync", {
			syncNow,
			/** Satisfies plugin teardown for the controller test double. */
			close: () => undefined,
		});
		host.syncActions?.confirmCoexistence("confirmation");
		await Promise.resolve();
		await Promise.resolve();
		expect(confirm).toHaveBeenCalledWith("confirmation");
		expect(syncNow).toHaveBeenCalledOnce();
		plugin.onunload();
	});

	it("records journal initialization failure as attention without erasing state", async () => {
		host.state = { version: 99, device_id: "invalid", pending_ops: [] };
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		await plugin.onload();
		expect(plugin.attentionReason).toBe(
			"Device journal storage needs attention",
		);
		expect(host.calls).toEqual(["loadLocalStorage"]);
		expect(host.state).toEqual({
			version: 99,
			device_id: "invalid",
			pending_ops: [],
		});
	});
});
