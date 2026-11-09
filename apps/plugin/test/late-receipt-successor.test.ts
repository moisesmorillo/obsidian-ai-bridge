import type { DevicePrecondition, PendingOperation } from "@vaultwire/protocol";
import { describe, expect, it } from "vitest";
import {
	DeviceJournal,
	type DeviceJournalStorage,
} from "../src/sync/device-journal";
import {
	PublicationController,
	type PublicationReceipt,
	type PublicationRemote,
} from "../src/sync/publication";
import {
	ReconciliationController,
	type ReconciliationRemote,
} from "../src/sync/reconciliation";
import { SyncTransportError } from "../src/sync/remote-text";
import { TextApplyEngine, type TextVault } from "../src/sync/text-apply";

const epoch = "a".repeat(32);

/** Retains journal state and immutable operation payloads across verified writes. */
class MemoryStorage implements DeviceJournalStorage {
	state: unknown = null;
	payloads = new Map<string, Uint8Array>();

	/** Returns the persisted document for schema validation by DeviceJournal. */
	async readState(): Promise<unknown> {
		return this.state;
	}

	/** Stores a defensive copy of one complete journal document. */
	async writeState(state: unknown): Promise<void> {
		this.state = structuredClone(state);
	}

	/** Reads the exact saved payload for one operation. */
	async readPayload(path: string): Promise<Uint8Array> {
		const bytes = this.payloads.get(path);
		if (!bytes) throw new Error("Missing operation payload");
		return bytes.slice();
	}

	/** Stores immutable payload bytes without retaining the caller's buffer. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		this.payloads.set(path, bytes.slice());
	}
}

/** Provides exact local text effects for publication and remote feed application. */
class MemoryVault implements TextVault {
	files = new Map<string, string>();

	/** Reads current exact text or reports absence. */
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	/** Returns exact UTF-8 bytes for the current text fixture. */
	async readBinary(path: string): Promise<Uint8Array | null> {
		const text = this.files.get(path);
		return text === undefined ? null : new TextEncoder().encode(text);
	}

	/** Lists visible test paths without inferring deletions. */
	async list(): Promise<string[]> {
		return [...this.files.keys()];
	}

	/** Returns UTF-8 byte length for the existing test file. */
	async size(path: string): Promise<number | null> {
		const text = this.files.get(path);
		return text === undefined
			? null
			: new TextEncoder().encode(text).byteLength;
	}

	/** Replaces only the exact previously observed text. */
	async process(
		path: string,
		expected: string | null,
		next: string,
	): Promise<boolean> {
		if ((this.files.get(path) ?? null) !== expected) return false;
		this.files.set(path, next);
		return true;
	}

	/** Creates a visible file only at an absent path. */
	async create(path: string, text: string): Promise<boolean> {
		if (this.files.has(path)) return false;
		this.files.set(path, text);
		return true;
	}

	/** Removes exact observed text from the fake vault. */
	async trash(path: string, expected: string): Promise<boolean> {
		if (this.files.get(path) !== expected) return false;
		this.files.delete(path);
		return true;
	}

	/** Moves exact observed text to an absent destination. */
	async rename(from: string, to: string, expected: string): Promise<boolean> {
		if (this.files.get(from) !== expected || this.files.has(to)) return false;
		this.files.set(to, expected);
		this.files.delete(from);
		return true;
	}
}

/** Hashes exact UTF-8 bytes using the same digest contract as the publisher. */
async function hashText(text: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("late receipt successor authority", () => {
	it("sends a queued edit at the newer feed revision and commits it after the old receipt returns", async () => {
		const storage = new MemoryStorage();
		const journal = await DeviceJournal.open(storage);
		await journal.resetEpoch(epoch);
		await journal.setCursor(epoch, 0);
		const vault = new MemoryVault();
		const versionText = new Map<number, string>();
		const receipts = new Map<string, PublicationReceipt>();
		const requests: Array<{
			key: string;
			precondition: DevicePrecondition;
			text: string;
		}> = [];
		let serverRev = 0;
		let serverText = "";
		let loseFirstResponse = true;
		const remote: PublicationRemote & ReconciliationRemote = {
			manifest: async () => ({
				epoch,
				head_seq: 2,
				next_page: null,
				entries: [],
			}),
			changes: async (_requestEpoch, since) => ({
				epoch,
				head_seq: 2,
				entries:
					since < 2
						? [
								{
									seq: 2,
									op: "put",
									path: "note.md",
									etag: `"${epoch}.2"`,
									hash: await hashText("feed revision two"),
									origin: "other-device",
									at: 2,
								},
							]
						: [],
			}),
			createText: async () => {
				throw new Error("Unexpected enrollment create");
			},
			readAuthority: async (path, requestEpoch, rev) => {
				const text = versionText.get(rev);
				if (path !== "note.md" || text === undefined)
					throw new Error("Unexpected pinned authority read");
				return {
					deleted: false,
					text,
					epoch: requestEpoch,
					rev,
					hash: await hashText(text),
				};
			},
			readCurrentAuthority: async () => {
				throw new Error("Unexpected current read");
			},
			put: async (path, text, precondition, key) => {
				requests.push({
					key,
					precondition: structuredClone(precondition),
					text,
				});
				const priorReceipt = receipts.get(key);
				if (priorReceipt) return priorReceipt;
				const matches =
					precondition.kind === "absent"
						? serverRev === 0
						: precondition.epoch === epoch && precondition.rev === serverRev;
				if (!matches) throw new SyncTransportError(412, "precondition_failed");
				serverRev += 1;
				serverText = text;
				versionText.set(serverRev, text);
				const receipt = {
					status: 201,
					path,
					etag: `"${epoch}.${serverRev}"`,
					seq: serverRev,
					size: new TextEncoder().encode(text).byteLength,
					hash: await hashText(text),
					deleted: false,
				};
				receipts.set(key, receipt);
				if (loseFirstResponse) {
					loseFirstResponse = false;
					throw new Error("Response lost after commit");
				}
				return receipt;
			},
			delete: async () => {
				throw new Error("Unexpected delete");
			},
			rename: async () => {
				throw new Error("Unexpected rename");
			},
		};
		const engine = new TextApplyEngine(
			journal,
			vault,
			{
				read: async (path, requestEpoch, rev) => {
					const authority = await remote.readAuthority(path, requestEpoch, rev);
					return authority.deleted ? null : authority.text;
				},
			},
			{ deviceName: "Test Device" },
		);
		const reconciliation = new ReconciliationController(
			journal,
			engine,
			vault,
			remote,
		);
		let now = 1_800_000_000_000;
		const publication = new PublicationController(journal, vault, remote, {
			applyEngine: engine,
			now: () => now,
			recoverPrecondition: (operation: PendingOperation) =>
				reconciliation.recoverPrecondition(operation),
		});

		vault.files.set("note.md", "first create");
		await publication.observe({ type: "create", path: "note.md" });
		await publication.flush();
		expect(serverRev).toBe(1);
		now += 3_000;
		await publication.flush();

		versionText.set(2, "feed revision two");
		serverRev = 2;
		serverText = "feed revision two";
		await reconciliation.replay();
		expect(journal.snapshot().base["note.md"]).toEqual({
			deleted: false,
			rev: 2,
			hash: await hashText("feed revision two"),
		});

		vault.files.set("note.md", "later edit after feed revision two");
		await publication.observe({ type: "modify", path: "note.md" });
		await publication.flush();

		expect(requests.map((request) => request.precondition)).toEqual([
			{ kind: "absent" },
			{ kind: "absent" },
			{ kind: "match", epoch, rev: 2 },
		]);
		expect(serverRev).toBe(3);
		expect(serverText).toBe("later edit after feed revision two");
		expect(journal.snapshot().attention).toEqual([]);
	});
});
