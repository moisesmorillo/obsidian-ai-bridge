import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
	calls: [] as string[],
	protocolAction: "",
	protocolHandler: null as
		| ((params: Record<string, string | "true">) => void)
		| null,
	settingsTab: null as unknown,
	serverUrlChange: null as ((url: string) => Promise<void>) | null,
	saveDataAction: null as ((data: unknown) => Promise<void>) | null,
	state: null as unknown,
	failSave: false,
	loadState: null as (() => unknown) | null,
}));

vi.mock("obsidian", () => ({
	Notice: class {},
	PluginSettingTab: class {},
	Setting: class {},
	requestUrl: () => {
		throw new Error("requestUrl should not run in lifecycle tests");
	},
	Plugin: class {
		loadData = async () => undefined;
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
				adapter: {
					exists: async () => false,
					mkdir: async () => undefined,
					readBinary: async () => new ArrayBuffer(0),
					writeBinary: async () => undefined,
				},
			},
			loadLocalStorage: (key: string) => {
				if (key.includes(":credential:")) return null;
				host.calls.push("loadLocalStorage");
				return host.loadState ? host.loadState() : host.state;
			},
			saveLocalStorage: (_key: string, value: unknown) => {
				host.calls.push("saveLocalStorage");
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

vi.mock("../src/settings", () => ({
	/** Captures the URL update callback without rendering Obsidian controls. */
	AIBridgeSettingTab: class {
		/** Captures constructor policy so lifecycle tests can invoke server updates. */
		constructor(...args: unknown[]) {
			host.serverUrlChange = args[5] as (url: string) => Promise<void>;
		}

		/** Satisfies the composition status-refresh call. */
		refreshStatus(): void {}
	},
}));

import type { App, PluginManifest } from "obsidian";
import { DeviceSession } from "../src/auth/device-session";
import AIBridgePlugin from "../src/main";
import { DeviceJournal } from "../src/sync/device-journal";

describe("AIBridgePlugin device-local lifecycle", () => {
	beforeEach(() => {
		host.calls.splice(0);
		host.protocolAction = "";
		host.protocolHandler = null;
		host.settingsTab = null;
		host.serverUrlChange = null;
		host.saveDataAction = null;
		host.state = null;
		host.failSave = false;
		host.loadState = null;
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
