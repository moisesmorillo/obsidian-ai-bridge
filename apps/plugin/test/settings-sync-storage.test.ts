import type { App } from "obsidian";
import { describe, expect, it } from "vitest";
import {
	readSettingsSyncConfiguration,
	saveSettingsSyncConfiguration,
} from "../src/infrastructure/settings-sync-storage";

/** Models device-only configuration without shared plugin data or vault effects. */
function makeLocalApp() {
	const documents = new Map<string, unknown>();
	const controls = { ignoreWrites: false };
	const app = {
		loadLocalStorage: (key: string) => documents.get(key) ?? null,
		saveLocalStorage: (key: string, value: unknown) => {
			if (!controls.ignoreWrites) documents.set(key, structuredClone(value));
		},
	} as unknown as App;
	return { app, documents, controls };
}

describe("settings sync local configuration", () => {
	it("defaults to no consent and no hydration duty", () => {
		const { app } = makeLocalApp();
		expect(readSettingsSyncConfiguration(app)).toEqual({
			policy: {
				enabled: false,
				appearance: true,
				core: true,
				communityPlugins: true,
			},
			hydrationPending: false,
		});
	});

	it("verifies consent and its duty without depending on property order", async () => {
		const { app } = makeLocalApp();
		const configuration = {
			hydrationPending: true,
			policy: {
				core: false,
				appearance: true,
				enabled: true,
				communityPlugins: false,
			},
		};
		await saveSettingsSyncConfiguration(app, configuration);
		expect(readSettingsSyncConfiguration(app)).toEqual(configuration);
	});

	it("rejects a silent write failure and retains the durable hydration duty", async () => {
		const { app, controls } = makeLocalApp();
		const configuration = {
			policy: {
				enabled: true,
				appearance: true,
				core: true,
				communityPlugins: true,
			},
			hydrationPending: true,
		};
		await saveSettingsSyncConfiguration(app, configuration);
		controls.ignoreWrites = true;
		await expect(
			saveSettingsSyncConfiguration(app, {
				...configuration,
				hydrationPending: false,
			}),
		).rejects.toThrow("did not verify");
		expect(readSettingsSyncConfiguration(app).hydrationPending).toBe(true);
	});

	it("rejects malformed local consent instead of trusting a partial record", async () => {
		const { app, documents } = makeLocalApp();
		await saveSettingsSyncConfiguration(app, {
			policy: {
				enabled: true,
				appearance: true,
				core: true,
				communityPlugins: true,
			},
			hydrationPending: true,
		});
		for (const key of documents.keys())
			documents.set(key, { policy: { enabled: true } });
		expect(() => readSettingsSyncConfiguration(app)).toThrow(
			"configuration is invalid",
		);
	});
});
