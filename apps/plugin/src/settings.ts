import type {
	DeviceSession,
	DeviceSessionStatus,
} from "@plugin/auth/device-session";
import type { CredentialStorage } from "@plugin/infrastructure/credential-storage";
import { PluginSettingTab, Setting } from "@plugin/obsidian-api";
import { type SyncStatusActions, SyncStatusPanel } from "@plugin/status-panel";
import type { SyncStatusProjection } from "@plugin/sync/sync-status";
import type { App, Plugin } from "obsidian";

/** Non-secret user settings for the desktop enrollment endpoint. */
export interface AIBridgeSettings {
	serverUrl: string;
	/** Local label used to distinguish this device's conflict copies. */
	deviceName: string;
}

/** Settings page for enrollment controls and safe connection status. */
export class AIBridgeSettingTab extends PluginSettingTab {
	/** Current safe status element, or null before the settings page renders. */
	private statusElement: HTMLElement | null = null;
	private syncElement: HTMLElement | null = null;

	/** Binds non-secret settings and controller access to the plugin settings host. */
	constructor(
		app: App,
		plugin: Plugin,
		private readonly settings: AIBridgeSettings,
		private readonly getSession: () => DeviceSession,
		private readonly credentials: CredentialStorage,
		private readonly onServerUrlChange: (url: string) => Promise<void>,
		private readonly onDeviceNameChange: (name: string) => Promise<void>,
		private readonly getStatus: () => DeviceSessionStatus,
		private readonly syncProjection?: () => SyncStatusProjection | null,
		private readonly syncActions?: SyncStatusActions,
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
			.setName("Device name")
			.setDesc("Name used in conflict copies for this device.")
			.addText((text) => {
				text
					.setPlaceholder("Obsidian desktop")
					.setValue(this.settings.deviceName);
				text.inputEl.addEventListener("blur", async () => {
					const nextName = text.getValue().trim();
					if (!nextName || nextName === this.settings.deviceName) return;
					try {
						await this.onDeviceNameChange(nextName);
						this.settings.deviceName = nextName;
					} catch {
						text.setValue(this.settings.deviceName);
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
		this.syncElement = containerEl.createEl("div", {
			cls: "ai-bridge-sync-status",
		});
		this.renderSyncStatus();
		if (this.credentials.warning)
			containerEl.createEl("p", { text: this.credentials.warning });
	}

	/** Updates the visible status with a fixed enum value and no OAuth response data. */
	refreshStatus(): void {
		this.statusElement?.setText(`Status: ${this.getStatus()}`);
		this.renderSyncStatus();
	}

	/** Refreshes the safe sync projection without exposing transport or credential data. */
	private renderSyncStatus(): void {
		if (!this.syncElement || !this.syncProjection || !this.syncActions) return;
		const projection = this.syncProjection();
		if (projection)
			new SyncStatusPanel(this.syncActions).render(
				this.syncElement,
				projection,
			);
	}
}
