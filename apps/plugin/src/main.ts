import type { VaultReadResult } from "@obsidian-ai-bridge/protocol";
import {
	DeviceSession,
	type DeviceSessionStatus,
} from "@plugin/auth/device-session";
import { ObsidianCredentialStorage } from "@plugin/infrastructure/credential-storage";
import { ObsidianDeviceStorage } from "@plugin/infrastructure/device-storage";
import { ObsidianOAuthTransport } from "@plugin/infrastructure/oauth-transport";
import { VaultEventAdapter } from "@plugin/infrastructure/vault-events";
import { Notice, Plugin } from "@plugin/obsidian-api";
import { type AIBridgeSettings, AIBridgeSettingTab } from "@plugin/settings";
import {
	createPublication,
	type PublicationComposition,
} from "@plugin/sync/create-publication";
import { DesktopSyncController } from "@plugin/sync/desktop-sync";
import {
	DEVICE_JOURNAL_ATTENTION_REASON,
	DeviceJournal,
} from "@plugin/sync/device-journal";
import { classifyEnrollmentPath } from "@plugin/sync/enrollment-scope";
import { projectSyncStatus } from "@plugin/sync/sync-status";
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
	/** Shared application effect owners for the active credential and server lifetime. */
	private composition: PublicationComposition | null = null;
	/** Sole timer and event admission owner for desktop synchronization. */
	private desktopSync: DesktopSyncController | null = null;
	/** Obsidian event listener owner; every event enters the serialized loop. */
	private vaultEvents: VaultEventAdapter | null = null;
	/** Window visibility callback registered only for the active sync composition. */
	private visibilityHandler: (() => void) | null = null;
	/** Tracks safe lifecycle presentation independently from the credential status. */
	private syncPaused = false;
	private syncActive = false;
	private syncRevoked = false;
	private syncFailure: string | null = null;
	private vaultSummary: VaultReadResult | null = null;
	/** Non-secret server URL persisted in synced settings. */
	private settingsValue: AIBridgeSettings = { serverUrl: DEFAULT_SERVER_URL };
	/** Safe enrollment status shown in settings. */
	private sessionStatus: DeviceSessionStatus = "disconnected";
	/** Fences asynchronous journal opens when unload or a newer load occurs. */
	private lifecycleGeneration = 0;
	/** Orders server URL saves and fences every older settings callback. */
	private serverSettingsGeneration = 0;
	/** Serializes settings writes so the latest accepted URL persists last. */
	private settingsSaveTail: Promise<void> = Promise.resolve();
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
			if (this.sessionStatus === "connected") this.startSync();
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
				(url) => {
					const update = ++this.serverSettingsGeneration;
					const save = this.settingsSaveTail.then(async () => {
						if (!this.ownsServerSettingsUpdate(generation, update))
							throw new Error("Server setting update is stale");
						const nextSession = this.buildSession(url);
						try {
							await this.saveData({ serverUrl: url });
						} catch (error) {
							nextSession.close();
							throw error;
						}
						if (!this.ownsServerSettingsUpdate(generation, update)) {
							nextSession.close();
							throw new Error("Server setting update is stale");
						}
						await this.stopSync();
						const previousSession = this.session;
						this.session = nextSession;
						this.settingsValue.serverUrl = url;
						this.sessionStatus = "disconnected";
						previousSession?.close();
						this.settingsTab?.refreshStatus();
					});
					this.settingsSaveTail = save.then(
						() => undefined,
						() => undefined,
					);
					return save;
				},

				() => this.sessionStatus,
				() => this.syncStatus(),
				{
					syncNow: () => {
						void this.desktopSync?.syncNow();
					},
					pause: () => {
						this.syncPaused = true;
						this.desktopSync?.pause();
						this.composition?.dispose();
						this.composition = null;
						this.settingsTab?.refreshStatus();
					},
					resume: () => {
						void this.resumeSync();
					},
					rebuild: () => {
						void this.desktopSync?.rebuild();
					},
					reconnect: () => {
						void this.session?.connect().catch(() => undefined);
					},
					openPath: (path) => {
						void this.app.workspace.openLinkText(path, "", true);
					},
					unsupportedFiles: () => this.filesByScope("unsupported"),
					excludedFiles: () => this.filesByScope("excluded"),
				},
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
		this.serverSettingsGeneration += 1;
		this.desktopSync?.close();
		this.vaultEvents?.dispose();
		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
			window.removeEventListener("focus", this.visibilityHandler);
			window.removeEventListener("blur", this.visibilityHandler);
		}
		this.composition?.dispose();
		this.desktopSync = null;
		this.composition = null;
		this.session?.close();
		this.journal?.close();
		this.session = null;
		this.journal = null;
	}

	/** Checks that one queued URL save still owns its plugin lifecycle and update order. */
	private ownsServerSettingsUpdate(lifecycle: number, update: number): boolean {
		return (
			lifecycle === this.lifecycleGeneration &&
			update === this.serverSettingsGeneration
		);
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
			setClientId: (clientId, isCurrent) => {
				if (!this.journal) throw new Error("Device journal is unavailable");
				return journal.setClientId(clientId, isCurrent);
			},
			statusChanged: (status) => {
				this.sessionStatus = status;
				if (status === "connected") {
					this.syncRevoked = false;
					this.startSync();
				}
				this.settingsTab?.refreshStatus();
			},
		});
	}

	/** Creates the shared synchronizer once for a connected session and starts recovery. */
	private startSync(): void {
		if (this.desktopSync || !this.journal || !this.session) return;
		this.composition = this.createSyncComposition();
		/** Serializes restart recovery, local scan, outgoing work, and feed confirmation. */
		const runCycle = async (): Promise<void> => {
			this.syncActive = true;
			this.settingsTab?.refreshStatus();
			try {
				const composition = this.composition;
				if (!composition) return;
				this.syncFailure = null;
				if (!this.vaultSummary)
					this.vaultSummary = await composition.readVaultSummary();
				await composition.reconciliation.resume();
				await composition.publication.scan();
				await composition.publication.flush();
				await composition.reconciliation.replay();
			} catch {
				this.syncFailure =
					"Sync request failed. The device will retry on the next cycle.";
				throw new Error(this.syncFailure);
			} finally {
				this.syncActive = false;
				this.settingsTab?.refreshStatus();
			}
		};
		this.desktopSync = new DesktopSyncController({
			cycle: runCycle,
			rebuild: () =>
				this.composition?.reconciliation.reconcile() ?? Promise.resolve(),
			onEvent: (event) =>
				this.composition?.publication.observe(event) ?? Promise.resolve(),
			host: {
				setTimeout: (callback, delay) => window.setTimeout(callback, delay),
				clearTimeout: (handle) => window.clearTimeout(handle),
				setInterval: (callback, delay) => window.setInterval(callback, delay),
				clearInterval: (handle) => window.clearInterval(handle),
				isVisible: () =>
					document.visibilityState === "visible" && document.hasFocus(),
			},
			onError: () => this.settingsTab?.refreshStatus(),
			onStateChanged: () => this.settingsTab?.refreshStatus(),
		});
		this.vaultEvents = new VaultEventAdapter(
			this.app.vault,
			this.desktopSync,
			() => this.settingsTab?.refreshStatus(),
		);
		this.visibilityHandler = () => {
			void this.desktopSync?.visibilityChanged();
		};
		document.addEventListener("visibilitychange", this.visibilityHandler);
		window.addEventListener("focus", this.visibilityHandler);
		window.addEventListener("blur", this.visibilityHandler);
		void this.desktopSync.start().then(() => this.settingsTab?.refreshStatus());
	}

	/** Creates one shared publication and apply composition for the active session lifetime. */
	private createSyncComposition(): PublicationComposition {
		if (!this.session || !this.journal)
			throw new Error("Sync session is unavailable");
		return createPublication(
			this.settingsValue.serverUrl,
			this.session,
			this.journal,
			this.app.vault,
			"Obsidian desktop",
			{
				now: Date.now,
				registerEvents: false,
				onEventError: () => this.settingsTab?.refreshStatus(),
				onRevoked: () => this.handleRevocation(),
			},
		);
	}

	/** Fences and settles old lifecycle work before a server or session replacement. */
	private async stopSync(): Promise<void> {
		const controller = this.desktopSync;
		controller?.close();
		this.vaultEvents?.dispose();
		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
			window.removeEventListener("focus", this.visibilityHandler);
			window.removeEventListener("blur", this.visibilityHandler);
		}
		this.visibilityHandler = null;
		this.composition?.dispose();
		await controller?.waitForIdle();
		if (controller === this.desktopSync) this.desktopSync = null;
		this.vaultEvents = null;
		this.composition = null;
		this.vaultSummary = null;
	}

	/** Waits for fenced work before constructing fresh effect owners and resuming. */
	private async resumeSync(): Promise<void> {
		const controller = this.desktopSync;
		if (!controller || !this.session || this.syncRevoked) return;
		await controller.waitForIdle();
		if (controller !== this.desktopSync || this.sessionStatus !== "connected")
			return;
		this.composition = this.createSyncComposition();
		this.vaultSummary = null;
		this.syncPaused = false;
		await controller.resume();
		this.settingsTab?.refreshStatus();
	}

	/** Closes effect owners immediately after a confirmed revocation, preserving journal state. */
	private async handleRevocation(): Promise<void> {
		this.syncRevoked = true;
		const controller = this.desktopSync;
		controller?.close();
		this.vaultEvents?.dispose();
		if (this.visibilityHandler) {
			document.removeEventListener("visibilitychange", this.visibilityHandler);
			window.removeEventListener("focus", this.visibilityHandler);
			window.removeEventListener("blur", this.visibilityHandler);
		}
		this.visibilityHandler = null;
		this.composition?.dispose();
		this.vaultEvents = null;
		this.composition = null;
		this.settingsTab?.refreshStatus();
		await controller?.waitForIdle();
		if (controller === this.desktopSync) this.desktopSync = null;
		if (!this.syncRevoked && this.sessionStatus === "connected")
			this.startSync();
	}

	/** Projects only verified journal data and validated feed observations. */
	private syncStatus() {
		if (!this.journal) return null;
		return projectSyncStatus(
			{
				state: this.journal.snapshot(),
				session: this.sessionStatus,
				head: this.composition?.reconciliation.lastHead ?? null,
				persisted: this.journal.attentionReason === null,
				active: this.syncActive || (this.desktopSync?.isBusy ?? false),
				failure: this.syncFailure,
				paused: this.syncPaused,
				revoked: this.syncRevoked,
			},
			this.vaultSummary,
		);
	}

	/** Lists vault paths that match one scope class only when the owner requests them. */
	private filesByScope(scope: "unsupported" | "excluded"): string[] {
		return this.app.vault
			.getFiles()
			.filter(
				(file) => classifyEnrollmentPath(file.path, file.stat.size) === scope,
			)
			.map((file) => file.path);
	}

	/** Displays only fixed text and never includes provider data or host error details. */
	private notice(message: string): void {
		new Notice(message);
	}
}
