import {
	DEFAULT_SETTINGS_SYNC_POLICY,
	type SettingsSyncPolicy,
} from "@plugin/sync/enrollment-scope";
import type { App } from "obsidian";

/** Device-only configuration key, separate from the protocol journal and shared plugin data. */
const SETTINGS_SYNC_STORAGE_KEY = "obsidian-ai-bridge:settings-sync:v1";

/** Keeps consent and its full-manifest duty in one local configuration write. */
export interface SettingsSyncConfiguration {
	policy: SettingsSyncPolicy;
	hydrationPending: boolean;
}

/** Reads device consent only. Shared plugin settings never grant consent. */
export function readSettingsSyncConfiguration(
	app: App,
): SettingsSyncConfiguration {
	const value: unknown = app.loadLocalStorage(SETTINGS_SYNC_STORAGE_KEY);
	if (value === null || value === undefined)
		return {
			policy: { ...DEFAULT_SETTINGS_SYNC_POLICY },
			hydrationPending: false,
		};
	if (!isRecord(value) || !isRecord(value.policy))
		throw new Error("Local settings sync configuration is invalid");
	const policy = value.policy;
	if (
		typeof policy.enabled !== "boolean" ||
		typeof policy.appearance !== "boolean" ||
		typeof policy.core !== "boolean" ||
		typeof policy.communityPlugins !== "boolean" ||
		typeof value.hydrationPending !== "boolean"
	)
		throw new Error("Local settings sync configuration is invalid");
	return {
		policy: {
			enabled: policy.enabled,
			appearance: policy.appearance,
			core: policy.core,
			communityPlugins: policy.communityPlugins,
		},
		hydrationPending: value.hydrationPending,
	};
}

/** Writes consent and hydration duty together, then verifies the exact local document. */
export async function saveSettingsSyncConfiguration(
	app: App,
	configuration: SettingsSyncConfiguration,
): Promise<void> {
	await app.saveLocalStorage(
		SETTINGS_SYNC_STORAGE_KEY,
		structuredClone(configuration),
	);
	const saved = readSettingsSyncConfiguration(app);
	if (
		saved.hydrationPending !== configuration.hydrationPending ||
		saved.policy.enabled !== configuration.policy.enabled ||
		saved.policy.appearance !== configuration.policy.appearance ||
		saved.policy.core !== configuration.policy.core ||
		saved.policy.communityPlugins !== configuration.policy.communityPlugins
	)
		throw new Error("Local settings sync configuration did not verify");
}

/** Narrows local configuration values without trusting persisted keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
