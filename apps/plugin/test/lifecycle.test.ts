import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
	calls: [] as string[],
	state: null as unknown,
	failSave: false,
	loadState: null as (() => unknown) | null,
}));

vi.mock("obsidian", () => ({
	Plugin: class {
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
			loadLocalStorage: () => {
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
import AIBridgePlugin from "../src/main";
import { DeviceJournal } from "../src/sync/device-journal";

describe("AIBridgePlugin device-local lifecycle", () => {
	beforeEach(() => {
		host.calls.splice(0);
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
		host.loadState = () => {
			host.loadState = null;
			return new Promise((resolve) => {
				finishRead = resolve;
			});
		};
		const close = vi.spyOn(DeviceJournal.prototype, "close");
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);
		const opening = plugin.onload();
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
