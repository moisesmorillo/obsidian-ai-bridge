/** Text file identity used by host API tests that mock Obsidian Vault methods. */
export class TFile {
	/** Binds a test file to its current vault path. */
	constructor(public path: string) {}
}

/** Supplies a host class for tests that replace Obsidian through their own lifecycle mock. */
export class Plugin {}
/** Empty host notice used only when tests import the plugin composition. */
export class Notice {}
/** Host settings tab base used to resolve plugin settings imports in tests. */
export class PluginSettingTab {}
/** Host settings control placeholder for tests that do not render the UI. */
export class Setting {}
/** Host request function placeholder for tests that do not send network requests. */
export function requestUrl(_request: unknown): never {
	throw new Error("requestUrl is unavailable in this test");
}
