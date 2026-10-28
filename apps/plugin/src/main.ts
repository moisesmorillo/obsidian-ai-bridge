import {
	DeviceSession,
	type DeviceSessionStatus,
} from "@plugin/auth/device-session";
import { ObsidianCredentialStorage } from "@plugin/infrastructure/credential-storage";
import { ObsidianDeviceStorage } from "@plugin/infrastructure/device-storage";
import { ObsidianOAuthTransport } from "@plugin/infrastructure/oauth-transport";
import { Notice, Plugin } from "@plugin/obsidian-api";
import { type AIBridgeSettings, AIBridgeSettingTab } from "@plugin/settings";
import {
	DEVICE_JOURNAL_ATTENTION_REASON,
	DeviceJournal,
} from "@plugin/sync/device-journal";
import type { App, ObsidianProtocolData, PluginManifest } from "obsidian";

/** Default canonical HTTPS service origin stored as a non-secret plugin setting. */
const DEFAULT_SERVER_URL = "https://obsidian-bridge.mmorillo.dev";

/** Owns device-local enrollment and journal admission without starting synchronization or note effects. */
export default class AIBridgePlugin extends Plugin {
	/** Active journal for this plugin lifecycle, or null when unavailable. */
	private journal: DeviceJournal | null = null;
	/** Active authorization controller, replaced only when its non-secret server URL changes. */
	private session: DeviceSession | null = null;
	/** Device-local credential storage selected by Obsidian capability availability. */
	private credentials: ObsidianCredentialStorage | null = null;
	/** Settings view that receives safe status refreshes while it is visible. */
	private settingsTab: AIBridgeSettingTab | null = null;
	/** Non-secret server URL persisted in synced settings. */
	private settingsValue: AIBridgeSettings = { serverUrl: DEFAULT_SERVER_URL };
	/** Safe enrollment status shown in settings. */
	private sessionStatus: DeviceSessionStatus = "disconnected";
	/** Fences asynchronous journal opens when unload or a newer load occurs. */
	private lifecycleGeneration = 0;
	/** Safe user-facing reason when local journal initialization cannot proceed. */
	attentionReason: string | null = null;

	/** Binds the Obsidian host application and manifest to this plugin lifecycle. */
	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
	}

	/** Opens validated device state and wires consent callback and settings controls. */
	async onload(): Promise<void> {
		const generation = ++this.lifecycleGeneration;
		try {
			const stored = await this.loadData();
			if (
				stored &&
				typeof stored === "object" &&
				typeof stored.serverUrl === "string"
			)
				this.settingsValue.serverUrl = stored.serverUrl;
			const journal = await DeviceJournal.open(
				new ObsidianDeviceStorage(this.app),
			);
			if (generation !== this.lifecycleGeneration) {
				journal.close();
				return;
			}
			this.journal = journal;
			this.credentials = new ObsidianCredentialStorage(
				this.app,
				journal.snapshot().device_id,
			);
			const session = this.createSession();
			await session.restore().catch(() => undefined);
			if (generation !== this.lifecycleGeneration) {
				session.close();
				return;
			}
			this.registerObsidianProtocolHandler(
				"ai-bridge/callback",
				(params: ObsidianProtocolData) => {
					const callback = Object.fromEntries(
						Object.entries(params).map(([key, value]) => [key, String(value)]),
					);
					void this.session?.callback(callback).catch(() => {
						this.notice("Device authorization failed");
					});
				},
			);
			this.settingsTab = new AIBridgeSettingTab(
				this.app,
				this,
				this.settingsValue,
				() => this.session ?? this.createSession(),
				this.credentials,
				async (url) => {
					const nextSession = this.buildSession(url);
					await this.saveData({ serverUrl: url });
					this.session?.close();
					this.settingsValue.serverUrl = url;
					this.session = nextSession;
					this.sessionStatus = "disconnected";
					this.settingsTab?.refreshStatus();
				},
				() => this.sessionStatus,
			);
			this.addSettingTab(this.settingsTab);
		} catch {
			if (generation === this.lifecycleGeneration)
				this.attentionReason = DEVICE_JOURNAL_ATTENTION_REASON;
		}
	}

	/** Blocks session and journal actions immediately without deleting local data. */
	onunload(): void {
		this.lifecycleGeneration += 1;
		this.session?.close();
		this.journal?.close();
		this.session = null;
		this.journal = null;
	}

	/** Builds a controller from the current service setting and device-local storage. */
	private createSession(): DeviceSession {
		const nextSession = this.buildSession(this.settingsValue.serverUrl);
		this.session = nextSession;
		return nextSession;
	}

	/** Creates a candidate controller without replacing the active session before validation. */
	private buildSession(serverUrl: string): DeviceSession {
		if (!this.credentials || !this.journal)
			throw new Error("Device enrollment is not available");
		const journal = this.journal;
		return new DeviceSession(serverUrl, {
			transport: new ObsidianOAuthTransport(),
			credentials: this.credentials,
			getClientId: () => journal.snapshot().client_id ?? null,
			openBrowser: (url) => {
				window.open(url, "_blank", "noopener,noreferrer");
			},
			setClientId: (clientId) => {
				if (!this.journal) throw new Error("Device journal is unavailable");
				return journal.setClientId(clientId);
			},
			statusChanged: (status) => {
				this.sessionStatus = status;
				this.settingsTab?.refreshStatus();
			},
		});
	}

	/** Displays only fixed text and never includes provider data or host error details. */
	private notice(message: string): void {
		new Notice(message);
	}
}
