import type { PublicationEvent } from "@plugin/sync/publication";
import type { EventRef, Vault } from "obsidian";

/** Host event boundary that routes local intent to the single lifecycle owner. */
export interface VaultEventObserver {
	/** Admits every event in order; plugin origin changes activity timing only. */
	observe(event: PublicationEvent, origin?: "plugin"): Promise<void>;
}

/** Tracks active mutation calls by host vault identity, event kind, and exact paths. */
const activePluginEvents = new WeakMap<Vault, Map<string, number>>();

/** Tracks a visible host mutation until success or failure, then retires its origin marker. */
export async function withPluginVaultMutation<T>(
	vault: Vault,
	event: PublicationEvent,
	mutate: () => Promise<T>,
): Promise<T> {
	const key = eventKey(event);
	let active = activePluginEvents.get(vault);
	if (!active) {
		active = new Map();
		activePluginEvents.set(vault, active);
	}
	active.set(key, (active.get(key) ?? 0) + 1);
	try {
		return await mutate();
	} finally {
		const count = active.get(key) ?? 0;
		if (count <= 1) active.delete(key);
		else active.set(key, count - 1);
		if (active.size === 0) activePluginEvents.delete(vault);
	}
}

/** Reads exact in-flight mutation origin without changing event admission or queue intent. */
function hasPluginOrigin(vault: Vault, event: PublicationEvent): boolean {
	return activePluginEvents.get(vault)?.get(eventKey(event)) === 1;
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
		this.references.push(
			vault.on("create", (file) =>
				this.send({ type: "create", path: file.path }),
			),
			vault.on("modify", (file) =>
				this.send({ type: "modify", path: file.path }),
			),
			vault.on("delete", (file) =>
				this.send({ type: "delete", path: file.path }),
			),
			vault.on("rename", (file, oldPath) =>
				this.send({ type: "rename", path: oldPath, to: file.path }),
			),
		);
	}

	/** Removes host listeners and prevents queued callbacks from admitting work. */
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const reference of this.references) this.vault.offref(reference);
	}

	/** Reports asynchronous event failures to the composition owner without hiding them. */
	private send(event: PublicationEvent): void {
		if (this.closed) return;
		const origin = hasPluginOrigin(this.vault, event) ? "plugin" : undefined;
		void this.observer.observe(event, origin).catch(this.onError);
	}
}
