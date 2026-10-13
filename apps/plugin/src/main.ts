import { Plugin } from "obsidian";

/** Minimal inert plugin shell; lifecycle hooks intentionally have no effects. */
export default class AIBridgePlugin extends Plugin {
	/** Initializes the plugin without registering commands, routes, or effects. */
	async onload(): Promise<void> {}

	/** Releases no resources because this plugin currently creates none. */
	onunload(): void {}
}
