import type {
	CoexistenceConfirmation,
	DeviceState,
	PendingOperation,
} from "@obsidian-ai-bridge/protocol";
import type { CoexistenceEffectFence } from "@plugin/sync/coexistence-effect-fence";
import type { PluginOriginProof } from "@plugin/sync/desktop-sync";
import type { DeviceJournal } from "@plugin/sync/device-journal";
import {
	classifyEnrollmentPath,
	DEFAULT_SETTINGS_SYNC_POLICY,
	type SettingsSyncPolicy,
} from "@plugin/sync/enrollment-scope";
import type { PublicationEvent } from "@plugin/sync/publication";

/** Frozen event-time authority and affected paths used if destructive proof is uncertain. */
type FrozenCoexistenceCapture =
	| Omit<Extract<CoexistenceConfirmation, { kind: "delete" }>, "id">
	| Omit<Extract<CoexistenceConfirmation, { kind: "rename" }>, "id">;

/** Copies confirmation authority synchronously before any origin-proof wait. */
function freezeCoexistenceEvent(
	event: Extract<PublicationEvent, { type: "delete" | "rename" }>,
	state: DeviceState,
	at: number,
): FrozenCoexistenceCapture {
	const staleBase = state.stale_base_paths.includes(event.path);
	const observed = {
		path: event.path,
		observed_epoch: staleBase ? null : (state.epoch ?? null),
		observed_base: staleBase
			? null
			: state.base[event.path]
				? structuredClone(state.base[event.path])
				: null,
		at,
		...(staleBase
			? { stale_reason: "The source base is stale after a vault epoch change." }
			: {}),
	};
	return event.type === "rename"
		? { ...observed, kind: "rename", to: event.to }
		: { ...observed, kind: "delete" };
}

/** Produces the journal's canonical time-ordered UUIDv7 key for one uncertain capture. */
function createUuidV7(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let timestamp = Date.now();
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = timestamp & 0xff;
		timestamp = Math.floor(timestamp / 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Metadata-only capability for finding an iCloud placeholder at a source path. */
export interface CoexistenceVault {
	/** Returns true when an adapter stat finds either supported placeholder form. */
	isUnavailable(path: string): Promise<boolean>;
	/** Returns current metadata size for an available exact path, or null when absent. */
	size(path: string): Promise<number | null>;
}

/** Owns durable owner decisions and unavailable-path metadata for coexistence mode. */
export class CoexistenceController {
	/** Weakly associates a host dispatch proof without retaining event objects. */
	private readonly originProofs = new WeakMap<
		PublicationEvent,
		PluginOriginProof
	>();
	/** Remembers successful handling without retaining dispatched event objects. */
	private readonly handledEvents = new WeakSet<PublicationEvent>();
	/** Shares one capture result across replayed delivery of the same live event object. */
	private readonly pendingObservations = new WeakMap<
		PublicationEvent,
		Promise<boolean>
	>();

	/** Binds durable authority to current mode without owning plugin lifecycle. */
	constructor(
		private readonly journal: DeviceJournal,
		private readonly vault: CoexistenceVault,
		private readonly isEnabled: () => boolean,
		private readonly now: () => number = Date.now,
		/** Closes shared effect admission until proof handles the event or intent persists. */
		private readonly effectFence?: CoexistenceEffectFence,
		private readonly settingsPolicy: SettingsSyncPolicy = DEFAULT_SETTINGS_SYNC_POLICY,
	) {}

	/** Associates host-origin evidence with the same event object before desktop admission. */
	registerOriginProof(event: PublicationEvent, proof: PluginOriginProof): void {
		this.originProofs.set(event, proof);
	}

	/** Captures destructive intent before debounce and tracks placeholder transitions. */
	observe(event: PublicationEvent): Promise<boolean> {
		if (this.handledEvents.has(event)) return Promise.resolve(true);
		const pending = this.pendingObservations.get(event);
		if (pending) return pending;
		const observation = this.observeOnce(event);
		this.pendingObservations.set(event, observation);
		void observation.then(
			(result) => {
				if (result) this.handledEvents.add(event);
				if (this.pendingObservations.get(event) === observation)
					this.pendingObservations.delete(event);
			},
			() => {
				if (this.pendingObservations.get(event) === observation)
					this.pendingObservations.delete(event);
			},
		);
		return observation;
	}

	/** Captures one dispatch while its weakly associated proof settles. */
	private async observeOnce(event: PublicationEvent): Promise<boolean> {
		if (!this.isEnabled()) return false;
		const destructive =
			(event.type === "delete" || event.type === "rename") &&
			classifyEnrollmentPath(event.path, 0, this.settingsPolicy) !== "excluded";
		const releaseCapture = destructive
			? this.effectFence?.beginCapture()
			: undefined;
		let succeeded = false;
		try {
			const frozen = destructive
				? freezeCoexistenceEvent(event, this.journal.snapshot(), this.now())
				: null;
			const proof = this.originProofs.get(event);
			this.originProofs.delete(event);
			let pluginHandled = false;
			if (frozen && proof) {
				try {
					pluginHandled = await proof;
				} catch {
					pluginHandled = false;
				}
			}
			if (frozen && pluginHandled) {
				succeeded = true;
				return true;
			}
			if (frozen) {
				await this.journal.saveCoexistenceConfirmation({
					...frozen,
					id: createUuidV7(),
				});
				this.handledEvents.add(event);
				succeeded = true;
			}
			const placeholder = placeholderSource(
				event.type === "rename" ? event.to : event.path,
			);
			const placeholderDetected =
				placeholder !== null && (await this.vault.isUnavailable(placeholder));
			if (placeholderDetected && placeholder)
				await this.journal.markUnavailable(placeholder);
			else if (
				placeholder &&
				this.journal.snapshot().unavailable_paths.includes(placeholder)
			)
				await this.journal.clearUnavailable(placeholder);
			if (event.type === "delete" || event.type === "rename") {
				if (!destructive) return false;
				if (await this.vault.isUnavailable(event.path))
					await this.journal.markUnavailable(event.path);
				return true;
			}
			if (placeholderDetected) return true;
			if (
				this.journal.snapshot().unavailable_paths.includes(event.path) &&
				!(await this.vault.isUnavailable(event.path))
			)
				await this.journal.clearUnavailable(event.path);
			return false;
		} finally {
			releaseCapture?.(succeeded);
		}
	}

	/** Transfers only an unchanged observed source into durable outgoing work. */
	async confirm(id: string): Promise<PendingOperation | null> {
		const item = this.journal
			.snapshot()
			.coexistence_confirmations.find((candidate) => candidate.id === id);
		if (!item) return null;
		const unavailable = await this.vault.isUnavailable(item.path);
		const sourceExists = (await this.vault.size(item.path)) !== null;
		if (unavailable) {
			await this.journal.markUnavailable(item.path);
			await this.journal.markCoexistenceStale(
				id,
				"The source path is unavailable while iCloud holds a placeholder.",
			);
			return null;
		}
		if (sourceExists) {
			await this.journal.markCoexistenceStale(
				id,
				"The source path exists again. Keep server state or review it.",
			);
			return null;
		}
		if (item.kind === "rename") {
			if (
				classifyEnrollmentPath(item.to, 0, this.settingsPolicy) === "excluded"
			) {
				await this.journal.markCoexistenceStale(
					id,
					"The rename destination is excluded from synchronization.",
				);
				return null;
			}
			if (await this.vault.isUnavailable(item.to)) {
				await this.journal.markUnavailable(item.to);
				await this.journal.markCoexistenceStale(
					id,
					"The rename destination is unavailable while iCloud holds a placeholder.",
				);
				return null;
			}
			if ((await this.vault.size(item.to)) === null) {
				await this.journal.markCoexistenceStale(
					id,
					"The rename destination is no longer available.",
				);
				return null;
			}
		}
		return this.journal.confirmCoexistence(id);
	}

	/** Removes one decision while leaving remote state and placeholder protection unchanged. */
	keepServerState(id: string): Promise<void> {
		return this.journal.clearCoexistenceConfirmation(id);
	}
}

/** Maps a placeholder's visible name to the original source path without reading bytes. */
function placeholderSource(path: string): string | null {
	if (!path.endsWith(".icloud")) return null;
	const nameStart = path.lastIndexOf("/") + 1;
	const name = path.slice(nameStart, -".icloud".length);
	const sourceName = name.startsWith(".") ? name.slice(1) : name;
	if (!sourceName) return null;
	return `${path.slice(0, nameStart)}${sourceName}`;
}
