import { TFile } from "@plugin/obsidian-api";
import type { PluginOriginProof } from "@plugin/sync/desktop-sync";
import type { PublicationEvent } from "@plugin/sync/publication";
import type { EventRef, TAbstractFile, Vault } from "obsidian";

/** Host event boundary that routes local intent to the single lifecycle owner. */
export interface VaultEventObserver {
	/** Admits each event and carries its bounded origin proof to capture and activity policy. */
	observe(
		event: PublicationEvent,
		originProof?: PluginOriginProof,
	): Promise<void>;
}

/** Exact visible content that one plugin mutation intends to leave at its target path. */
export type PluginMutationTarget =
	| { kind: "text"; value: string }
	| { kind: "binary"; value: Uint8Array };

/** Tracks one mutation's evidence until its effect settles. */
interface PluginEventMarker {
	/** Number of overlapping host mutations for this event key. */
	operationCount: number;
	/** True when overlapping mutations make one origin claim uncertain. */
	ambiguous: boolean;
	/** True after one event consumes this mutation's evidence. */
	claimed: boolean;
	/** True when no later read can establish this mutation's event bytes. */
	settled: boolean;
	/** True only when every wrapped effect and conditional gate accepts. */
	allEffectsAccepted: boolean;
	/** Intended visible bytes used only with active-read and effect evidence. */
	target: PluginMutationTarget | null;
	/** Exact host object passed to the accepted destructive effect. */
	source: TAbstractFile | null;
	/** Resolves after all overlapping mutation effects settle. */
	settlement: Promise<boolean>;
	/** Resolves the shared settlement proof once no wrapped effect remains. */
	resolveSettlement: (accepted: boolean) => void;
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

/** Tracks one plugin effect so its host event can prove exact origin after effect acceptance. */
export async function withPluginVaultMutation<T>(
	vault: Vault,
	event: PublicationEvent,
	mutate: () => Promise<T>,
	target?: PluginMutationTarget,
	effectAccepted: () => boolean = () => true,
	source?: TAbstractFile,
): Promise<T> {
	const tracker = trackerFor(vault);
	const key = eventKey(event);
	const previous = tracker.markers.get(key);
	const marker =
		previous ?? createPluginEventMarker(target ?? null, source ?? null);
	if (marker.operationCount > 0) marker.ambiguous = true;
	if (marker.source !== (source ?? null)) marker.ambiguous = true;
	marker.operationCount += 1;
	tracker.markers.set(key, marker);
	let accepted = false;
	try {
		const result = await mutate();
		accepted = effectAccepted();
		return result;
	} finally {
		marker.operationCount -= 1;
		marker.allEffectsAccepted = marker.allEffectsAccepted && accepted;
		if (marker.operationCount === 0) {
			marker.settled = true;
			tracker.markers.delete(key);
			marker.resolveSettlement(
				marker.allEffectsAccepted &&
					!marker.ambiguous &&
					(marker.target !== null || event.type === "delete"),
			);
		}
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

/** Proves destructive events by source identity and accepted effects, and content events by exact bytes. */
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
		((event.type === "delete" || event.type === "rename") &&
			marker.source !== source)
	)
		return false;
	if (event.type === "delete") {
		if (source.path !== event.path) return false;
		marker.claimed = true;
		return marker.settlement;
	}
	if (
		event.type === "rename" &&
		marker.target &&
		source instanceof TFile &&
		source.path === event.to
	) {
		try {
			const target = marker.target;
			const observation =
				target.kind === "text"
					? await vault.read(source).then((value) => ({
							value,
							completedBeforeSettlement: !marker.settled,
						}))
					: await vault.readBinary(source).then((bytes) => ({
							value: new Uint8Array(bytes),
							completedBeforeSettlement: !marker.settled,
						}));
			const matches =
				target.kind === "text"
					? typeof observation.value === "string" &&
						observation.value === target.value
					: observation.value instanceof Uint8Array &&
						equalBytes(observation.value, target.value);
			if (
				!matches ||
				!observation.completedBeforeSettlement ||
				marker.ambiguous ||
				marker.claimed
			)
				return false;
			marker.claimed = true;
			return marker.settlement;
		} catch {
			return false;
		}
	}
	if (
		!marker.target ||
		(event.type !== "create" && event.type !== "modify") ||
		!(source instanceof TFile) ||
		source.path !== event.path
	)
		return false;
	try {
		const target = marker.target;
		let matches: boolean;
		if (target.kind === "text") {
			const observation = await vault.read(source).then((value) => ({
				value,
				completedBeforeSettlement: !marker.settled,
			}));
			matches =
				observation.completedBeforeSettlement &&
				observation.value === target.value;
		} else {
			const observation = await vault.readBinary(source).then((bytes) => ({
				value: new Uint8Array(bytes),
				completedBeforeSettlement: !marker.settled,
			}));
			matches =
				observation.completedBeforeSettlement &&
				equalBytes(observation.value, target.value);
		}
		if (!matches || marker.ambiguous || marker.claimed) return false;
		marker.claimed = true;
		return marker.settlement;
	} catch {
		return false;
	}
}

/** Creates a marker whose final result reflects every overlapping effect. */
function createPluginEventMarker(
	target: PluginMutationTarget | null,
	source: TAbstractFile | null,
): PluginEventMarker {
	/** Resolves after every overlapping effect settles. */
	let resolveSettlement: (accepted: boolean) => void = () => undefined;
	const settlement = new Promise<boolean>((resolve) => {
		resolveSettlement = resolve;
	});
	return {
		operationCount: 0,
		ambiguous: false,
		claimed: false,
		settled: false,
		allEffectsAccepted: true,
		target: target ? copyTarget(target) : null,
		source,
		settlement,
		resolveSettlement,
	};
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
