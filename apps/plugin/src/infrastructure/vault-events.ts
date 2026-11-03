import type { PublicationEvent } from "@plugin/sync/publication";
import type { EventRef, Vault } from "obsidian";

/** Host event boundary that routes local intent to the single lifecycle owner. */
export interface VaultEventObserver {
	/** Admits one ordered explicit vault event through the current synchronization lifecycle. */
	observe(event: PublicationEvent): Promise<void>;
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
		void this.observer.observe(event).catch(this.onError);
	}
}
