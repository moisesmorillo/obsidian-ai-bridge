import type { VaultReadResult } from "@obsidian-ai-bridge/protocol";
import {
	DeviceSession,
	DeviceSessionNetworkError,
	type DeviceSessionStatus,
} from "@plugin/auth/device-session";
import { ObsidianCredentialStorage } from "@plugin/infrastructure/credential-storage";
import { ObsidianDeviceStorage } from "@plugin/infrastructure/device-storage";
import { ObsidianOAuthTransport } from "@plugin/infrastructure/oauth-transport";
import { SyncTransportError } from "@plugin/infrastructure/sync-transport";
import { ObsidianTextVault } from "@plugin/infrastructure/text-vault";
import { VaultEventAdapter } from "@plugin/infrastructure/vault-events";
import { Notice, Plugin } from "@plugin/obsidian-api";
import {
	type AIBridgeSettings,
	AIBridgeSettingTab,
	resolveDeviceName,
} from "@plugin/settings";
import { CoexistenceController } from "@plugin/sync/coexistence";
import {
	CoexistenceEffectBlockedError,
	CoexistenceEffectFence,
} from "@plugin/sync/coexistence-effect-fence";
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
import type { DeleteResponseDiagnostic } from "@plugin/sync/remote-text";
import {
	projectSyncStatus,
	type SyncFailureDiagnostic,
} from "@plugin/sync/sync-status";
import type { App, ObsidianProtocolData, PluginManifest } from "obsidian";

/** Default canonical HTTPS service origin stored as a non-secret plugin setting. */
const DEFAULT_SERVER_URL = "https://obsidian-bridge.mmorillo.dev";
/** Owns device-local enrollment and starts serialized synchronization after connection restore. */
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
	/** Captures destructive events and metadata-only placeholder state for this lifecycle. */
	private coexistence: CoexistenceController | null = null;
	/** Shared capture and effect-admission authority for one journal lifetime. */
	private coexistenceEffectFence: CoexistenceEffectFence | null = null;
	/** Window visibility callback registered only for the active sync composition. */
	private visibilityHandler: (() => void) | null = null;
	/** Tracks safe lifecycle presentation independently from the credential status. */
	private syncPaused = false;
	/** Keeps status callbacks from starting sync before credential restore completes. */
	private sessionRestoreComplete = false;
	private syncActive = false;
	private syncRevoked = false;
	/** Safe active cycle failure, cleared only after a complete successful cycle. */
	private syncFailure: SyncFailureDiagnostic | null = null;
	/** UTC failure time retained for this plugin session after recovery. */
	private lastFailureAt: string | null = null;
	/** UTC completion time retained for this plugin session. */
	private lastSuccessAt: string | null = null;
	/** Safe metadata from the latest DELETE response, retained across pause. */
	private deleteResponseDiagnostic: DeleteResponseDiagnostic | null = null;
	private vaultSummary: VaultReadResult | null = null;
	/** Non-secret server and local device labels persisted in this plugin's settings. */
	private settingsValue: AIBridgeSettings = {
		serverUrl: DEFAULT_SERVER_URL,
		deviceName: resolveDeviceName(undefined),
		coexistenceMode: false,
	};
	/** Safe enrollment status shown in settings. */
	private sessionStatus: DeviceSessionStatus = "disconnected";
	/** Fences asynchronous journal opens when unload or a newer load occurs. */
	private lifecycleGeneration = 0;
	/** Orders non-secret settings saves and fences every older update callback. */
	private settingsUpdateGeneration = 0;
	/** Serializes settings writes so the latest accepted values persist last. */
	private settingsSaveTail: Promise<void> = Promise.resolve();
	/** Serializes controller resumes and composition changes around retained event intent. */
	private syncEffectTail: Promise<void> = Promise.resolve();
	/** Fences a pending resume when the user selects Pause again. */
	private syncPauseGeneration = 0;
	/** Safe user-facing reason when local journal initialization cannot proceed. */
	attentionReason: string | null = null;

	/** Binds the Obsidian host application and manifest to this plugin lifecycle. */
	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
	}

	/** Opens validated device state and wires consent callback and settings controls. */
	async onload(): Promise<void> {
		const generation = ++this.lifecycleGeneration;
		this.sessionRestoreComplete = false;
		try {
			const stored = await this.loadData();
			if (stored && typeof stored === "object") {
				if (typeof stored.serverUrl === "string")
					this.settingsValue.serverUrl = stored.serverUrl;
				this.settingsValue.coexistenceMode = stored.coexistenceMode === true;
				this.settingsValue.deviceName = resolveDeviceName(stored.deviceName);
			}
			const journal = await DeviceJournal.open(
				new ObsidianDeviceStorage(this.app),
			);
			if (generation !== this.lifecycleGeneration) {
				journal.close();
				return;
			}
			this.journal = journal;
			this.syncPaused = journal.snapshot().sync_paused;
			this.coexistenceEffectFence = new CoexistenceEffectFence(
				() =>
					(this.journal?.snapshot().coexistence_confirmations.length ?? 0) > 0,
			);
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
			this.sessionRestoreComplete = true;
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
					const update = ++this.settingsUpdateGeneration;
					const save = this.settingsSaveTail.then(async () => {
						if (!this.ownsSettingsUpdate(generation, update))
							throw new Error("Server setting update is stale");
						const nextSession = this.buildSession(url);
						try {
							await this.saveData({ ...this.settingsValue, serverUrl: url });
						} catch (error) {
							nextSession.close();
							throw error;
						}
						if (!this.ownsSettingsUpdate(generation, update)) {
							nextSession.close();
							throw new Error("Server setting update is stale");
						}
						await this.stopSync();
						if (!this.ownsSettingsUpdate(generation, update)) {
							nextSession.close();
							throw new Error("Server setting update is stale");
						}
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
				(name) => {
					const update = ++this.settingsUpdateGeneration;
					const save = this.settingsSaveTail.then(async () => {
						if (!this.ownsSettingsUpdate(generation, update))
							throw new Error("Device name update is stale");
						if (!name.trim() || name.length > 80)
							throw new Error("Device name is invalid");
						const nextComposition =
							this.desktopSync && !this.syncRevoked
								? this.createSyncComposition(name)
								: null;
						try {
							await this.saveData({ ...this.settingsValue, deviceName: name });
						} catch (error) {
							nextComposition?.dispose();
							throw error;
						}
						if (!this.ownsSettingsUpdate(generation, update)) {
							nextComposition?.dispose();
							throw new Error("Device name update is stale");
						}
						await this.reconfigureDeviceName(
							generation,
							update,
							name,
							nextComposition,
						);
					});
					this.settingsSaveTail = save.then(
						() => undefined,
						() => undefined,
					);
					return save;
				},
				(enabled) => this.changeCoexistenceMode(generation, enabled),
				() => this.sessionStatus,
				() => this.syncStatus(),
				{
					syncNow: () => {
						this.runSyncAction(
							() => this.desktopSync?.syncNow() ?? Promise.resolve(),
						);
					},
					pause: () => {
						const controller = this.desktopSync;
						this.syncPauseGeneration += 1;
						this.syncPaused = true;
						controller?.pause();
						this.settingsTab?.refreshStatus();
						this.runSyncAction(async () => {
							await this.persistSyncPaused(true, this.syncPauseGeneration);
							await this.disposePausedComposition(controller);
						});
					},
					resume: () => {
						this.runSyncAction(() => this.resumeSync());
					},
					reconnect: () => {
						void this.session?.connect().catch(() => undefined);
					},
					openPath: (path) => {
						void this.app.workspace.openLinkText(path, "", true);
					},
					unsupportedFiles: () => this.filesByScope("unsupported"),
					excludedFiles: () => this.filesByScope("excluded"),
					confirmCoexistence: (id) => {
						this.runSyncAction(async () => {
							const operation = await this.coexistence?.confirm(id);
							this.settingsTab?.refreshStatus();
							if (operation && !this.syncPaused)
								await this.desktopSync?.syncNow();
						});
					},
					keepServerState: (id) => {
						this.runSyncAction(async () => {
							await this.coexistence?.keepServerState(id);
							this.settingsTab?.refreshStatus();
							if (!this.syncPaused) await this.desktopSync?.syncNow();
						});
					},
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
		this.sessionRestoreComplete = false;
		this.settingsUpdateGeneration += 1;
		this.releaseSyncOwners();
		this.desktopSync = null;
		this.session?.close();
		this.journal?.close();
		this.session = null;
		this.journal = null;
	}

	/** Checks that one queued settings save still owns its plugin lifecycle and update order. */
	private ownsSettingsUpdate(lifecycle: number, update: number): boolean {
		return (
			lifecycle === this.lifecycleGeneration &&
			update === this.settingsUpdateGeneration
		);
	}

	/** Disposes pause-scoped effects only after work admitted before Pause settles. */
	private async disposePausedComposition(
		controller: DesktopSyncController | null,
	): Promise<void> {
		await this.serializeSyncEffect(async () => {
			await controller?.waitForIdle();
			if (controller !== this.desktopSync || !this.syncPaused) return;
			this.composition?.dispose();
			this.composition = null;
			this.settingsTab?.refreshStatus();
		});
	}

	/** Serializes one controller or composition transition and releases the queue after failure. */
	private serializeSyncEffect<T>(effect: () => Promise<T>): Promise<T> {
		const result = this.syncEffectTail.then(effect);
		this.syncEffectTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Replaces only label-dependent effects after the retained controller reaches idle. */
	private async reconfigureDeviceName(
		lifecycle: number,
		update: number,
		name: string,
		candidate: PublicationComposition | null,
	): Promise<void> {
		await this.serializeSyncEffect(async () => {
			if (!this.ownsSettingsUpdate(lifecycle, update)) {
				candidate?.dispose();
				throw new Error("Device name update is stale");
			}
			const controller = this.desktopSync;
			if (!controller || this.syncRevoked) {
				candidate?.dispose();
				this.settingsValue.deviceName = name;
				if (
					!controller &&
					this.sessionStatus === "connected" &&
					!this.syncPaused &&
					!this.syncRevoked
				)
					this.startSync();
				this.settingsTab?.refreshStatus();
				return;
			}

			const nextComposition = candidate ?? this.createSyncComposition(name);
			const previousComposition = this.composition;
			const shouldResume =
				this.sessionStatus === "connected" &&
				!this.syncPaused &&
				!this.syncRevoked;
			controller.pause();
			try {
				await controller.waitForIdle();
			} catch (error) {
				nextComposition.dispose();
				await this.resumeControllerIfOwned(
					controller,
					previousComposition,
					shouldResume,
				);
				throw error;
			}

			if (!this.ownsSettingsUpdate(lifecycle, update)) {
				nextComposition.dispose();
				await this.resumeControllerIfOwned(
					controller,
					previousComposition,
					shouldResume,
				);
				throw new Error("Device name update is stale");
			}
			if (controller !== this.desktopSync || this.syncRevoked) {
				nextComposition.dispose();
				this.settingsValue.deviceName = name;
				this.settingsTab?.refreshStatus();
				return;
			}

			this.composition = nextComposition;
			this.settingsValue.deviceName = name;
			this.vaultSummary = null;
			previousComposition?.dispose();
			await this.resumeControllerIfOwned(
				controller,
				nextComposition,
				shouldResume,
			);
			this.settingsTab?.refreshStatus();
		});
	}

	/** Resumes only when the controller and expected composition still own active sync. */
	private async resumeControllerIfOwned(
		controller: DesktopSyncController,
		composition: PublicationComposition | null,
		shouldResume: boolean,
	): Promise<void> {
		if (
			!shouldResume ||
			controller !== this.desktopSync ||
			this.composition !== composition ||
			this.syncPaused ||
			this.syncRevoked ||
			this.sessionStatus !== "connected"
		)
			return;
		try {
			await controller.resume();
		} catch (error) {
			this.reportSyncFailure(error);
		}
	}

	/** Builds a controller from the current service setting and device-local storage. */
	private createSession(): DeviceSession {
		const nextSession = this.buildSession(this.settingsValue.serverUrl);
		this.session = nextSession;
		return nextSession;
	}

	/** Saves Pause state in the device journal while lifecycle and generation remain current. */
	private persistSyncPaused(
		paused: boolean,
		generation: number,
	): Promise<void> {
		const lifecycle = this.lifecycleGeneration;
		const journal = this.journal;
		if (!journal)
			return Promise.reject(new Error("Device journal is unavailable"));
		return journal.setSyncPaused(
			paused,
			() =>
				lifecycle === this.lifecycleGeneration &&
				generation === this.syncPauseGeneration &&
				journal === this.journal,
		);
	}

	/** Saves the mode change and rejects exit while captured event work remains. */
	private changeCoexistenceMode(
		lifecycle: number,
		enabled: boolean,
	): Promise<void> {
		const update = ++this.settingsUpdateGeneration;
		const save = this.settingsSaveTail.then(async () => {
			if (!this.ownsSettingsUpdate(lifecycle, update))
				throw new Error("Coexistence setting update is stale");
			if (
				!enabled &&
				(this.journal?.snapshot().coexistence_confirmations.length ||
					this.desktopSync?.isBusy)
			)
				throw new Error("Resolve pending coexistence work before exit");
			await this.saveData({ ...this.settingsValue, coexistenceMode: enabled });
			if (!this.ownsSettingsUpdate(lifecycle, update))
				throw new Error("Coexistence setting update is stale");
			this.settingsValue.coexistenceMode = enabled;
			this.settingsTab?.refreshStatus();
		});
		this.settingsSaveTail = save.then(
			() => undefined,
			() => undefined,
		);
		return save;
	}

	/** Creates a candidate controller without replacing the active session before validation. */
	private buildSession(serverUrl: string): DeviceSession {
		if (!this.credentials || !this.journal)
			throw new Error("Device enrollment is not available");
		const journal = this.journal;
		return new DeviceSession(serverUrl, {
			transport: new ObsidianOAuthTransport(),
			credentials: this.credentials,
			getDeviceName: () => this.settingsValue.deviceName,
			getClientId: () => journal.snapshot().client_id ?? null,
			openBrowser: (url) => {
				try {
					window.open(url, "_blank", "noopener,noreferrer");
				} catch {
					// The settings link remains available if the host blocks this call.
				}
			},
			setClientId: (clientId, isCurrent) => {
				if (!this.journal) throw new Error("Device journal is unavailable");
				return journal.setClientId(clientId, isCurrent);
			},
			statusChanged: (status) => {
				this.sessionStatus = status;
				if (status === "connected") {
					this.syncRevoked = false;
					if (this.sessionRestoreComplete) {
						if (!this.desktopSync) this.startSync();
						else if (!this.syncPaused)
							this.runSyncAction(() => this.resumeSync());
					}
				}
				this.settingsTab?.refreshStatus();
			},
		});
	}

	/** Creates one retained controller and starts recovery only when sync is not paused. */
	private startSync(): void {
		if (this.desktopSync || !this.journal || !this.session) return;
		this.composition = this.createSyncComposition();
		this.coexistence = new CoexistenceController(
			this.journal,
			new ObsidianTextVault(this.app.vault),
			() => this.settingsValue.coexistenceMode,
			Date.now,
			this.coexistenceEffectFence ?? undefined,
		);
		/** Stops all sync effects while owner confirmation remains durable. */
		const runCycle = async (): Promise<void> => {
			this.syncActive = true;
			this.settingsTab?.refreshStatus();
			try {
				const composition = this.composition;
				if (!composition || this.isCoexistenceEffectBlocked()) return;
				if (!this.vaultSummary) {
					this.vaultSummary = await composition.readVaultSummary();
					if (this.isCoexistenceEffectBlocked()) return;
				}
				await composition.reconciliation.resume();
				if (this.isCoexistenceEffectBlocked()) return;
				if (this.journal?.snapshot().epoch === undefined) {
					await composition.reconciliation.enroll();
					if (this.isCoexistenceEffectBlocked()) return;
				}
				await composition.publication.scan();
				if (this.isCoexistenceEffectBlocked()) return;
				await composition.publication.flush();
				if (this.isCoexistenceEffectBlocked()) return;
				await composition.reconciliation.replay();
				if (this.isCoexistenceEffectBlocked()) return;
				const summary = await composition.readVaultSummary();
				if (
					this.composition !== composition ||
					this.syncPaused ||
					this.syncRevoked ||
					this.isCoexistenceEffectBlocked()
				)
					return;
				this.vaultSummary = summary;
				this.syncFailure = null;
				this.lastSuccessAt = new Date(Date.now()).toISOString();
			} catch (error) {
				if (error instanceof CoexistenceEffectBlockedError) return;
				this.reportSyncFailure(error);
				throw error;
			} finally {
				this.syncActive = false;
				this.settingsTab?.refreshStatus();
			}
		};
		this.desktopSync = new DesktopSyncController({
			cycle: runCycle,
			isEffectBlocked: () => this.isCoexistenceEffectBlocked(),
			onCaptureEvent: (event) =>
				this.coexistence?.observe(event) ?? Promise.resolve(false),
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
			onError: (error) => this.reportSyncFailure(error),
			onStateChanged: () => this.settingsTab?.refreshStatus(),
		});
		this.vaultEvents = new VaultEventAdapter(
			this.app.vault,
			{
				observe: async (event, originProof) => {
					if (originProof)
						this.coexistence?.registerOriginProof(event, originProof);
					await this.desktopSync?.observe(event, originProof);
				},
			},
			(error) => this.reportSyncFailure(error),
		);
		this.visibilityHandler = () => {
			this.runSyncAction(
				() => this.desktopSync?.visibilityChanged() ?? Promise.resolve(),
			);
		};
		document.addEventListener("visibilitychange", this.visibilityHandler);
		window.addEventListener("focus", this.visibilityHandler);
		window.addEventListener("blur", this.visibilityHandler);
		if (this.syncPaused) this.desktopSync.pause();
		else
			this.runSyncAction(() => this.desktopSync?.start() ?? Promise.resolve());
	}

	/** Creates one publication and apply composition with the supplied device label. */
	private createSyncComposition(
		deviceName = this.settingsValue.deviceName,
	): PublicationComposition {
		if (!this.session || !this.journal)
			throw new Error("Sync session is unavailable");
		return createPublication(
			this.settingsValue.serverUrl,
			this.session,
			this.journal,
			this.app.vault,
			deviceName,
			{
				now: Date.now,
				registerEvents: false,
				onEventError: (error) => this.reportSyncFailure(error),
				onDeleteResponseDiagnostic: (diagnostic) => {
					this.deleteResponseDiagnostic = diagnostic;
					this.settingsTab?.refreshStatus();
				},
				onRevoked: () => {
					this.runSyncAction(() => this.handleRevocation());
				},
				isEffectBlocked: () => this.isCoexistenceEffectBlocked(),
				onConflictCopy: (path) =>
					this.notice(`AI Bridge kept your version as ${path}`),
			},
		);
	}

	/** Fences and settles old lifecycle work before a server or session replacement. */
	private async stopSync(): Promise<void> {
		const controller = this.releaseSyncOwners();
		await controller?.waitForIdle();
		if (controller === this.desktopSync) this.desktopSync = null;
	}

	/** Waits for composition changes before it resumes the retained event owner. */
	private async resumeSync(): Promise<void> {
		const pauseGeneration = this.syncPauseGeneration;
		await this.serializeSyncEffect(async () => {
			const controller = this.desktopSync;
			if (!controller || !this.session || this.syncRevoked) return;
			await controller.waitForIdle();
			if (
				controller !== this.desktopSync ||
				this.sessionStatus !== "connected" ||
				pauseGeneration !== this.syncPauseGeneration
			)
				return;
			await this.persistSyncPaused(false, pauseGeneration);
			if (pauseGeneration !== this.syncPauseGeneration) return;
			if (!this.composition) this.composition = this.createSyncComposition();
			this.vaultSummary = null;
			this.syncPaused = false;
			try {
				await controller.resume();
			} catch (error) {
				this.reportSyncFailure(error);
			}
			this.settingsTab?.refreshStatus();
		});
	}

	/** Closes effect owners immediately after a confirmed revocation, preserving journal state. */
	private async handleRevocation(): Promise<void> {
		this.syncRevoked = true;
		const controller = this.releaseSyncOwners();
		this.settingsTab?.refreshStatus();
		await controller?.waitForIdle();
		if (controller === this.desktopSync) this.desktopSync = null;
		if (!this.syncRevoked && this.sessionStatus === "connected")
			this.startSync();
	}

	/** Closes timer, event, and application owners before any session replacement. */
	private releaseSyncOwners(): DesktopSyncController | null {
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
		this.coexistence = null;
		this.composition = null;
		this.vaultSummary = null;
		return controller;
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
				storageFailureStage: this.journal.attentionStage,
				deleteResponseDiagnostic: this.deleteResponseDiagnostic,
				active: this.syncActive || (this.desktopSync?.isBusy ?? false),
				failure: this.syncFailure,
				lastFailureAt: this.lastFailureAt,
				lastSuccessAt: this.lastSuccessAt,
				paused: this.syncPaused,
				revoked: this.syncRevoked,
				coexistenceEnabled: this.settingsValue.coexistenceMode,
			},
			this.vaultSummary,
		);
	}

	/** Reads the shared journal and capture latch before any later effect admission. */
	private isCoexistenceEffectBlocked(): boolean {
		return this.coexistenceEffectFence?.isBlocked() ?? false;
	}

	/** Projects only known transport metadata and records its plugin-session time. */
	private reportSyncFailure(error?: unknown): void {
		let transportClass: SyncFailureDiagnostic["transportClass"] = "other";
		let code: SyncFailureDiagnostic["code"] = null;
		let retryAfterSeconds: string | null = null;
		if (error instanceof SyncTransportError) {
			transportClass =
				error.statusClass === "4xx" || error.statusClass === "5xx"
					? error.statusClass
					: "other";
			code = error.code;
			retryAfterSeconds = error.retryAfter;
		} else if (error instanceof DeviceSessionNetworkError) {
			transportClass = "network";
		}
		this.syncFailure = { transportClass, code, retryAfterSeconds };
		this.lastFailureAt = new Date(Date.now()).toISOString();
		this.settingsTab?.refreshStatus();
	}

	/** Consumes rejected host actions so window and UI callbacks cannot leak rejections. */
	private runSyncAction(action: () => Promise<void>): void {
		try {
			void action().catch((error: unknown) => this.reportSyncFailure(error));
		} catch {
			this.reportSyncFailure();
		}
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
