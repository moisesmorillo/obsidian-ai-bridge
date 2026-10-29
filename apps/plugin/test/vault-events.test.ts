import type { DevicePrecondition } from "@obsidian-ai-bridge/protocol";
import type { EventRef, Vault } from "obsidian";
import { describe, expect, it } from "vitest";
import { VaultEventAdapter } from "../src/infrastructure/vault-events";
import type { DeviceJournalStorage } from "../src/sync/device-journal";
import { DeviceJournal } from "../src/sync/device-journal";
import {
	PublicationController,
	type PublicationRead,
	type PublicationReceipt,
	type PublicationRemote,
} from "../src/sync/publication";
import { TextApplyEngine, type TextVault } from "../src/sync/text-apply";

const epoch = "a".repeat(32);

/** Keeps event-adapter test state in the same JSON and payload shape as production storage. */
class MemoryStorage implements DeviceJournalStorage {
	state: unknown = null;
	readonly payloads = new Map<string, Uint8Array>();
	/** Returns the most recent complete state document. */
	async readState(): Promise<unknown> {
		return this.state;
	}
	/** Stores the complete state document for journal read-back. */
	async writeState(state: unknown): Promise<void> {
		this.state = structuredClone(state);
	}
	/** Reads an exact journal payload without exposing the stored buffer. */
	async readPayload(path: string): Promise<Uint8Array> {
		return this.payloads.get(path)?.slice() ?? new Uint8Array();
	}
	/** Stores an immutable payload copy under its journal reference. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		this.payloads.set(path, bytes.slice());
	}
}

/** Provides one in-memory text path to the production publication controller. */
class MemoryVault implements TextVault {
	readonly files = new Map<string, string>([["note.md", "edited from event"]]);
	/** Returns current test text or null for an absent path. */
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	/** Lists exact vault paths visible to a startup scan. */
	async list(): Promise<string[]> {
		return [...this.files.keys()];
	}
	/** Returns the UTF-8 byte length or null when a path is absent. */
	async size(path: string): Promise<number | null> {
		const text = this.files.get(path);
		return text === undefined
			? null
			: new TextEncoder().encode(text).byteLength;
	}
	/** Refuses mutation because the adapter test only checks event admission. */
	async process(): Promise<boolean> {
		return false;
	}
	/** Refuses creation because the adapter test only checks event admission. */
	async create(): Promise<boolean> {
		return false;
	}
	/** Refuses trash because the adapter test only checks event admission. */
	async trash(): Promise<boolean> {
		return false;
	}
	/** Refuses rename because the adapter test only checks event admission. */
	async rename(): Promise<boolean> {
		return false;
	}
}

/** Supplies transport capabilities that remain unused during event admission. */
class UnusedRemote implements PublicationRemote {
	/** Fails if event admission tries a remote revision read. */
	async readAuthority(): Promise<PublicationRead> {
		throw new Error("Unexpected read");
	}
	/** Fails if event admission tries a remote current read. */
	async readCurrentAuthority(): Promise<PublicationRead> {
		throw new Error("Unexpected read");
	}
	/** Fails if event admission sends a mutation before an explicit flush. */
	async put(
		_path: string,
		_text: string,
		_precondition: DevicePrecondition,
		_key: string,
		_requestEpoch: string,
	): Promise<PublicationReceipt> {
		throw new Error("Unexpected put");
	}
	/** Fails if the modify event produces a delete. */
	async delete(): Promise<PublicationReceipt> {
		throw new Error("Unexpected delete");
	}
	/** Fails if the modify event produces a rename. */
	async rename(): Promise<PublicationReceipt> {
		throw new Error("Unexpected rename");
	}
}

describe("VaultEventAdapter", () => {
	it("routes live modify events into publication and removes listeners on disposal", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const removed: EventRef[] = [];
		const vault = {
			/** Captures one production listener for controlled event delivery. */
			on(event: string, callback: (...args: unknown[]) => void) {
				handlers.set(event, callback);
				return { event } as EventRef;
			},
			/** Records listener disposal calls from the production adapter. */
			offref(reference: EventRef) {
				removed.push(reference);
			},
		} as unknown as Vault;
		const journal = await DeviceJournal.open(new MemoryStorage());
		await journal.resetEpoch(epoch);
		const textVault = new MemoryVault();
		const controller = new PublicationController(
			journal,
			textVault,
			new UnusedRemote(),
			{
				applyEngine: new TextApplyEngine(
					journal,
					textVault,
					{
						/** Rejects remote apply in this event-admission test. */
						read: async () => {
							throw new Error("Unexpected apply read");
						},
					},
					{ deviceName: "Test Device" },
				),
				now: () => 1_800_000_000_000,
				recoverPrecondition: async () => {},
			},
		);
		const errors: unknown[] = [];
		const adapter = new VaultEventAdapter(vault, controller, (error) =>
			errors.push(error),
		);

		handlers.get("modify")?.({ path: "note.md" });
		await controller.flush();

		expect([...handlers.keys()]).toContain("modify");
		expect(errors).toEqual([]);
		expect(journal.snapshot().pending_ops).toHaveLength(1);
		adapter.dispose();
		expect(removed).toHaveLength(4);
		controller.close();
	});
});
