import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
	calls: [] as string[],
}));

vi.mock("obsidian", () => ({
	Plugin: class {
		app = {
			vault: {
				create: (..._args: unknown[]) => host.calls.push("vault.create"),
				modify: (..._args: unknown[]) => host.calls.push("vault.modify"),
				delete: (..._args: unknown[]) => host.calls.push("vault.delete"),
			},
		};
		requestUrl = (..._args: unknown[]) => host.calls.push("requestUrl");
		saveData = (..._args: unknown[]) => host.calls.push("saveData");
		saveLocalStorage = (..._args: unknown[]) =>
			host.calls.push("saveLocalStorage");
		saveSecretStorage = (..._args: unknown[]) =>
			host.calls.push("saveSecretStorage");
	},
}));

import AIBridgePlugin from "@plugin/main";
import type { App, PluginManifest } from "obsidian";

describe("AIBridgePlugin F0 lifecycle", () => {
	beforeEach(() => host.calls.splice(0));

	it("does not connect, mutate the vault, or persist data on load or unload", async () => {
		const plugin = new AIBridgePlugin({} as App, {} as PluginManifest);

		await plugin.onload();
		plugin.onunload();

		expect(host.calls).toEqual([]);
	});
});
