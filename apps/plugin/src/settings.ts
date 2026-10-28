import type {
	DeviceSession,
	DeviceSessionStatus,
} from "@plugin/auth/device-session";
import type { CredentialStorage } from "@plugin/infrastructure/credential-storage";
import { PluginSettingTab, Setting } from "@plugin/obsidian-api";
import type { App, Plugin } from "obsidian";

/** Non-secret user settings for the desktop enrollment endpoint. */
export interface AIBridgeSettings {
	serverUrl: string;
}

/** Settings page for enrollment controls and safe connection status. */
export class AIBridgeSettingTab extends PluginSettingTab {
	/** Current safe status element, or null before the settings page renders. */
	private statusElement: HTMLElement | null = null;

	/** Binds non-secret settings and controller access to the plugin settings host. */
	constructor(
		app: App,
		plugin: Plugin,
		private readonly settings: AIBridgeSettings,
		private readonly getSession: () => DeviceSession,
		private readonly credentials: CredentialStorage,
		private readonly onServerUrlChange: (url: string) => Promise<void>,
		private readonly getStatus: () => DeviceSessionStatus,
	) {
		super(app, plugin);
	}

	/** Renders one labelled server setting, enrollment action, cancellation, and safe state. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "AI Bridge" });
		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("HTTPS service origin used for enrollment and requests.")
			.addText((text) => {
				text
					.setPlaceholder("https://obsidian-bridge.mmorillo.dev")
					.setValue(this.settings.serverUrl);
				text.inputEl.addEventListener("blur", async () => {
					const nextUrl = text.getValue().trim();
					if (!nextUrl || nextUrl === this.settings.serverUrl) return;
					try {
						await this.onServerUrlChange(nextUrl);
						this.settings.serverUrl = nextUrl;
					} catch {
						text.setValue(this.settings.serverUrl);
					}
				});
			});
		new Setting(containerEl)
			.setName("Device connection")
			.setDesc("Connect this Obsidian device with browser authorization.")
			.addButton((button) =>
				button.setButtonText("Connect").onClick(async () => {
					try {
						await this.getSession().connect();
					} catch {
						button.setDisabled(false);
					}
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("Cancel")
					.onClick(() => this.getSession().cancel()),
			);
		this.statusElement = containerEl.createEl("p", {
			text: `Status: ${this.getStatus()}`,
		});
		if (this.credentials.warning)
			containerEl.createEl("p", { text: this.credentials.warning });
	}

	/** Updates the visible status with a fixed enum value and no OAuth response data. */
	refreshStatus(): void {
		this.statusElement?.setText(`Status: ${this.getStatus()}`);
	}
}
