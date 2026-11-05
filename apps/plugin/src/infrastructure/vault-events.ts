import type { PublicationEvent } from "@plugin/sync/publication";
import type { EventRef, TAbstractFile, Vault } from "obsidian";

/** Host event boundary that routes local intent to the single lifecycle owner. */
export interface VaultEventObserver {
	/** Admits every event in order; plugin origin changes activity timing only. */
	observe(event: PublicationEvent, origin?: "plugin"): Promise<void>;
}

/** One mutation marker accepts one host event and shares that event with all adapters. */
interface PluginEventMarker {
	operationCount: number;
	ambiguous: boolean;
	source: TAbstractFile | null;
	remainingAdapters: number;
}

/** Owns origin markers and listener counts for one host vault identity. */
interface VaultOriginTracker {
	readonly markers: Map<string, PluginEventMarker>;
	adapterCount: number;
}

/** Shares mutation origin and event delivery state across adapters for each host vault. */
const vaultOriginTrackers = new WeakMap<Vault, VaultOriginTracker>();

/** Tracks a visible host mutation until success or failure, then retires its origin marker. */
export async function withPluginVaultMutation<T>(
	vault: Vault,
	event: PublicationEvent,
	mutate: () => Promise<T>,
): Promise<T> {
	const tracker = trackerFor(vault);
	const key = eventKey(event);
	const previous = tracker.markers.get(key);
	const marker = previous ?? {
		operationCount: 0,
		ambiguous: false,
		source: null,
		remainingAdapters: 0,
	};
	if (marker.operationCount > 0) marker.ambiguous = true;
	marker.operationCount += 1;
	tracker.markers.set(key, marker);
	try {
		return await mutate();
	} finally {
		marker.operationCount -= 1;
		if (marker.operationCount === 0) tracker.markers.delete(key);
	}
}

/** Registers one adapter so each event callback receives the same origin classification. */
function registerAdapter(vault: Vault): void {
	trackerFor(vault).adapterCount += 1;
}

/** Releases one adapter from its host vault origin tracker. */
function unregisterAdapter(vault: Vault): void {
	const tracker = trackerFor(vault);
	tracker.adapterCount = Math.max(0, tracker.adapterCount - 1);
}

/** Classifies one event dispatch while keeping repeated or ambiguous events local. */
function pluginOriginFor(
	vault: Vault,
	event: PublicationEvent,
	source: TAbstractFile,
): boolean {
	const tracker = trackerFor(vault);
	const marker = tracker.markers.get(eventKey(event));
	if (!marker || marker.ambiguous) return false;
	if (marker.source === source && marker.remainingAdapters > 0) {
		marker.remainingAdapters -= 1;
		return true;
	}
	if (marker.source !== null) return false;
	marker.source = source;
	marker.remainingAdapters = Math.max(0, tracker.adapterCount - 1);
	return true;
}

/** Creates the vault-local tracker when a mutation or adapter first needs it. */
function trackerFor(vault: Vault): VaultOriginTracker {
	let tracker = vaultOriginTrackers.get(vault);
	if (!tracker) {
		tracker = { markers: new Map(), adapterCount: 0 };
		vaultOriginTrackers.set(vault, tracker);
	}
	return tracker;
}

/** Encodes event kind and exact affected paths for vault-local origin matching. */
function eventKey(event: PublicationEvent): string {
	return event.type === "rename"
		? JSON.stringify([event.type, event.path, event.to])
		: JSON.stringify([event.type, event.path]);
}

/** Routes explicit Obsidian file events into one lifecycle admission queue. */
export class VaultEventAdapter {
	private readonly references: EventRef[] = [];
	private closed = false;

	/** Registers live file callbacks without starting polling or automatic synchronization. */
	constructor(
		private readonly vault: Vault,
		private readonly observer: VaultEventObserver,
		private readonly onError: (error: unknown) => void,
	) {
		registerAdapter(vault);
		this.references.push(
			vault.on("create", (file) =>
				this.send({ type: "create", path: file.path }, file),
			),
			vault.on("modify", (file) =>
				this.send({ type: "modify", path: file.path }, file),
			),
			vault.on("delete", (file) =>
				this.send({ type: "delete", path: file.path }, file),
			),
			vault.on("rename", (file, oldPath) =>
				this.send({ type: "rename", path: oldPath, to: file.path }, file),
			),
		);
	}

	/** Removes host listeners and prevents queued callbacks from admitting work. */
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const reference of this.references) this.vault.offref(reference);
		unregisterAdapter(this.vault);
	}

	/** Reports asynchronous event failures to the composition owner without hiding them. */
	private send(event: PublicationEvent, source: TAbstractFile): void {
		if (this.closed) return;
		const origin = pluginOriginFor(this.vault, event, source)
			? "plugin"
			: undefined;
		void this.observer.observe(event, origin).catch(this.onError);
	}
}
