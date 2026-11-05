import { TFile } from "@plugin/obsidian-api";
import type { PluginOriginProof } from "@plugin/sync/desktop-sync";
import type { PublicationEvent } from "@plugin/sync/publication";
import type { EventRef, TAbstractFile, Vault } from "obsidian";

/** Host event boundary that routes local intent to the single lifecycle owner. */
export interface VaultEventObserver {
	/** Admits every event in order; proof affects activity timing only. */
	observe(
		event: PublicationEvent,
		originProof?: PluginOriginProof,
	): Promise<void>;
}

/** Exact visible content that one plugin mutation intends to leave at its target path. */
export type PluginMutationTarget =
	| { kind: "text"; value: string }
	| { kind: "binary"; value: Uint8Array };

/** One active effect holds exact evidence and claims at most one matching host dispatch. */
interface PluginEventMarker {
	operationCount: number;
	ambiguous: boolean;
	claimed: boolean;
	target: PluginMutationTarget | null;
}

/** Shares one event proof with every adapter listener for the same host dispatch. */
interface EventDeliveryProof {
	proof: PluginOriginProof;
	remainingAdapters: number;
}

/** Owns origin markers and callback delivery state for one host vault identity. */
interface VaultOriginTracker {
	readonly markers: Map<string, PluginEventMarker>;
	readonly deliveries: WeakMap<TAbstractFile, Map<string, EventDeliveryProof>>;
	adapterCount: number;
}

/** Shares mutation origin and event delivery state across adapters for each host vault. */
const vaultOriginTrackers = new WeakMap<Vault, VaultOriginTracker>();

/** Tracks a visible mutation until settlement and records exact intended bytes for event proof. */
export async function withPluginVaultMutation<T>(
	vault: Vault,
	event: PublicationEvent,
	mutate: () => Promise<T>,
	target?: PluginMutationTarget,
): Promise<T> {
	const tracker = trackerFor(vault);
	const key = eventKey(event);
	const previous = tracker.markers.get(key);
	const marker = previous ?? {
		operationCount: 0,
		ambiguous: false,
		claimed: false,
		target: target ? copyTarget(target) : null,
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

/** Registers one adapter so all listeners share an event proof. */
function registerAdapter(vault: Vault): void {
	trackerFor(vault).adapterCount += 1;
}

/** Releases one adapter from its host vault origin tracker. */
function unregisterAdapter(vault: Vault): void {
	const tracker = trackerFor(vault);
	tracker.adapterCount = Math.max(0, tracker.adapterCount - 1);
}

/** Starts one exact content check and shares it across listeners for that host dispatch. */
function pluginOriginProofFor(
	vault: Vault,
	event: PublicationEvent,
	source: TAbstractFile,
): PluginOriginProof {
	const tracker = trackerFor(vault);
	const key = eventKey(event);
	const deliveries = tracker.deliveries.get(source) ?? new Map();
	const previous = deliveries.get(key);
	if (previous && previous.remainingAdapters > 0) {
		previous.remainingAdapters -= 1;
		return previous.proof;
	}
	const marker = tracker.markers.get(key);
	const proof = verifyMutationTarget(vault, event, source, marker);
	const delivery = {
		proof,
		remainingAdapters: Math.max(0, tracker.adapterCount - 1),
	};
	deliveries.set(key, delivery);
	tracker.deliveries.set(source, deliveries);
	return proof;
}

/** Confirms exact current bytes before consuming one mutation's origin evidence. */
async function verifyMutationTarget(
	vault: Vault,
	event: PublicationEvent,
	source: TAbstractFile,
	marker: PluginEventMarker | undefined,
): Promise<boolean> {
	if (
		!marker ||
		marker.ambiguous ||
		marker.claimed ||
		!marker.target ||
		(event.type !== "create" && event.type !== "modify") ||
		!(source instanceof TFile) ||
		source.path !== event.path
	)
		return false;
	try {
		const matches =
			marker.target.kind === "text"
				? (await vault.read(source)) === marker.target.value
				: equalBytes(
						new Uint8Array(await vault.readBinary(source)),
						marker.target.value,
					);
		if (!matches || marker.ambiguous || marker.claimed) return false;
		marker.claimed = true;
		return true;
	} catch {
		return false;
	}
}

/** Copies binary targets so later caller changes cannot alter mutation evidence. */
function copyTarget(target: PluginMutationTarget): PluginMutationTarget {
	return target.kind === "text"
		? { kind: "text", value: target.value }
		: { kind: "binary", value: target.value.slice() };
}

/** Compares byte arrays by exact length and content without decoding. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return (
		left.byteLength === right.byteLength &&
		left.every((value, index) => value === right[index])
	);
}

/** Creates the vault-local tracker when a mutation or adapter first needs it. */
function trackerFor(vault: Vault): VaultOriginTracker {
	let tracker = vaultOriginTrackers.get(vault);
	if (!tracker) {
		tracker = {
			markers: new Map(),
			deliveries: new WeakMap(),
			adapterCount: 0,
		};
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
		const originProof = pluginOriginProofFor(this.vault, event, source);
		void this.observer.observe(event, originProof).catch(this.onError);
	}
}
