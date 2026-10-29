import type {
	PublicationController,
	PublicationEvent,
} from "@plugin/sync/publication";
import type { EventRef, Vault } from "obsidian";

/** Routes explicit Obsidian file events into one publication admission queue. */
export class VaultEventAdapter {
	private readonly references: EventRef[] = [];
	private closed = false;

	/** Registers live file callbacks without starting polling or automatic synchronization. */
	constructor(
		private readonly vault: Vault,
		private readonly publication: PublicationController,
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
		void this.publication.observe(event).catch(this.onError);
	}
}
