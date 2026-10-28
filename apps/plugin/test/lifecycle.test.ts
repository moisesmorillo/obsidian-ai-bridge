import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
	calls: [] as string[],
	protocolAction: "",
	protocolHandler: null as
		| ((params: Record<string, string | "true">) => void)
		| null,
	settingsTab: null as unknown,
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
		saveData = (..._args: unknown[]) => host.calls.push("saveData");
		saveSecretStorage = (..._args: unknown[]) =>
			host.calls.push("saveSecretStorage");
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
