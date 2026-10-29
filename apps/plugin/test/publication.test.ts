import type {
	DevicePrecondition,
	PendingOperation,
} from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";
import {
	DeviceJournal,
	type DeviceJournalStorage,
} from "../src/sync/device-journal";
import {
	PublicationController,
	type PublicationRead,
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

/** Keeps validated journal state and immutable payload bytes across controller restarts. */
class MemoryStorage implements DeviceJournalStorage {
	state: unknown = null;
	payloads = new Map<string, Uint8Array>();
	/** Returns the last complete JSON-compatible device state. */
	async readState(): Promise<unknown> {
		return this.state;
	}
	/** Stores a defensive full-document copy for verified journal writes. */
	async writeState(state: unknown): Promise<void> {
		this.state = structuredClone(state);
	}
	/** Reads exact saved payload bytes or reports a missing immutable reference. */
	async readPayload(path: string): Promise<Uint8Array> {
		const bytes = this.payloads.get(path);
		if (!bytes) throw new Error("missing payload");
		return bytes.slice();
	}
	/** Stores a defensive copy without changing the caller's byte buffer. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		this.payloads.set(path, bytes.slice());
	}
}

/** Models guarded text operations and confirmed files without Obsidian host types. */
class MemoryVault implements TextVault {
	readonly files = new Map<string, string>();
	afterTrash: (() => void) | null = null;
	/** Returns exact current text or null for an absent path. */
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	/** Returns all current paths for startup scan and collision checks. */
	async list(): Promise<string[]> {
		return [...this.files.keys()];
	}
	/** Measures current UTF-8 text bytes or returns null for an absent path. */
	async size(path: string): Promise<number | null> {
		const text = this.files.get(path);
		return text === undefined
			? null
			: new TextEncoder().encode(text).byteLength;
	}
	/** Replaces bytes only when the current value equals the observed value. */
	async process(
		path: string,
		expected: string | null,
		next: string,
	): Promise<boolean> {
		if ((this.files.get(path) ?? null) !== expected) return false;
		this.files.set(path, next);
		return true;
	}
	/** Creates text only when the exact path does not exist. */
	async create(path: string, text: string): Promise<boolean> {
		if (this.files.has(path)) return false;
		this.files.set(path, text);
		return true;
	}
	/** Removes only the exact observed value from the test vault. */
	async trash(path: string, expected: string): Promise<boolean> {
		if (this.files.get(path) !== expected) return false;
		this.files.delete(path);
		this.afterTrash?.();
		return true;
	}
	/** Moves only an exact source value into an absent destination. */
	async rename(from: string, to: string, expected: string): Promise<boolean> {
		if (this.files.get(from) !== expected || this.files.has(to)) return false;
		this.files.set(to, expected);
		this.files.delete(from);
		return true;
	}
}

/** Records immutable remote requests and lets tests provide authoritative outcomes. */
class MemoryRemote implements PublicationRemote {
	readonly writes: Array<{
		path: string;
		text: string;
		precondition: DevicePrecondition;
		key: string;
	}> = [];
	readonly deletes: Array<{
		path: string;
		precondition: DevicePrecondition;
		key: string;
	}> = [];
	private revision = 0;
	failure: unknown = null;
	beforeReceipt: (() => Promise<void>) | null = null;
	receiptHashOverride: string | null = null;
	receiptSizeOverride: number | null = null;
	/** Returns a revision-pinned fixture for startup restoration. */
	async readAuthority(
		_path: string,
		requestEpoch: string,
		rev: number,
	): Promise<PublicationRead> {
		return {
			deleted: false,
			text: "remote exact bytes",
			epoch: requestEpoch,
			rev,
			hash: "b".repeat(64),
		};
	}
	/** Fails tests that unexpectedly need an unpinned authority read. */
	async readCurrentAuthority(_path: string): Promise<PublicationRead> {
		throw new Error("Unexpected current read");
	}
	/** Records immutable put identity and returns a valid next-revision receipt. */
	async put(
		path: string,
		text: string,
		precondition: DevicePrecondition,
		key: string,
		_epoch: string,
	): Promise<PublicationReceipt> {
		this.writes.push({ path, text, precondition, key });
		if (this.failure) {
			const error = this.failure;
			this.failure = null;
			throw error;
		}
		await this.beforeReceipt?.();
		this.revision += 1;
		return {
			status: 201,
			path,
			etag: `"${epoch}.${this.revision}"`,
			seq: this.revision + 7,
			size:
				this.receiptSizeOverride ?? new TextEncoder().encode(text).byteLength,
			hash: this.receiptHashOverride ?? (await digestText(text)),
			deleted: false,
		};
	}
	/** Records one exact source precondition and returns its next tombstone revision. */
	async delete(
		path: string,
		precondition: DevicePrecondition,
		key: string,
	): Promise<PublicationReceipt> {
		this.deletes.push({ path, precondition, key });
		const rev = precondition.kind === "match" ? precondition.rev + 1 : 2;
		return {
			status: 200,
			path,
			etag: `"${epoch}.${rev}"`,
			seq: 9,
			size: 0,
			hash: "",
			deleted: true,
		};
	}
	/** Returns destination metadata without inventing source revision authority. */
	async rename(_path: string, to: string): Promise<PublicationReceipt> {
		return {
			status: 201,
			path: to,
			etag: `"${epoch}.2"`,
			seq: 9,
			size: 0,
			hash: "b".repeat(64),
			deleted: false,
		};
	}
}

/** Hashes test text with the same raw UTF-8 rule used by the publication contract. */
async function digestText(text: string): Promise<string> {
	const result = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(result)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Opens the real journal and controller around in-memory effect ports. */
async function openController(
	storage = new MemoryStorage(),
	vault = new MemoryVault(),
	remote = new MemoryRemote(),
	now: () => number = () => 1_800_000_000_000,
	recoverPrecondition: () => Promise<void> = async () => {},
) {
	const journal = await DeviceJournal.open(storage);
	await journal.resetEpoch(epoch);
	const controller = new PublicationController(journal, vault, remote, {
		now,
		recoverPrecondition,
	});
	return { controller, journal, remote, storage, vault };
}

describe("PublicationController", () => {
	it("restores a startup-missing file at the confirmed base without publishing a delete", async () => {
		const { controller, journal, remote, vault } = await openController();
		await journal.setBase("note.md", {
			deleted: false,
			rev: 6,
			hash: "b".repeat(64),
		});
		const reads: Array<{ path: string; epoch: string; rev: number }> = [];
		const recoveryRemote: PublicationRemote = {
			readAuthority: async (
				path: string,
				requestEpoch: string,
				rev: number,
			) => {
				reads.push({ path, epoch: requestEpoch, rev });
				return {
					deleted: false,
					text: "remote exact bytes",
					epoch: requestEpoch,
					rev,
					hash: "b".repeat(64),
				};
			},
			readCurrentAuthority: async () => {
				throw new Error("Unexpected current read");
			},
			put: remote.put.bind(remote),
			delete: remote.delete.bind(remote),
			rename: remote.rename.bind(remote),
		};
		const recovery = new PublicationController(journal, vault, recoveryRemote, {
			now: () => 1_800_000_000_000,
			recoverPrecondition: async () => {},
		});

		await recovery.scan();

		expect(await vault.read("note.md")).toBe("remote exact bytes");
		expect(reads).toEqual([{ path: "note.md", epoch, rev: 6 }]);
		expect(remote.writes).toEqual([]);
		expect(journal.snapshot().base["note.md"]).toEqual({
			deleted: false,
			rev: 6,
			hash: "b".repeat(64),
		});
		controller.close();
	});

	it("publishes post-rename local edits as puts after the server rename settles", async () => {
		const storage = new MemoryStorage();
		const vault = new MemoryVault();
		const journal = await DeviceJournal.open(storage);
		await journal.resetEpoch(epoch);
		await journal.setBase("source.md", {
			deleted: false,
			rev: 4,
			hash: await digestText("server source"),
		});
		vault.files.set("target.md", "rewritten links");
		const putCalls: Array<{ text: string; precondition: DevicePrecondition }> =
			[];
		const remote: PublicationRemote = {
			readAuthority: async () => {
				throw new Error("Unexpected pinned read");
			},
			readCurrentAuthority: async (path) =>
				path === "source.md"
					? { deleted: true, text: null, epoch, rev: 5, hash: "" }
					: {
							deleted: false,
							text: "server source",
							epoch,
							rev: 5,
							hash: await digestText("server source"),
						},
			put: async (path, text, precondition) => {
				putCalls.push({ text, precondition });
				const hash = await digestText(text);
				return {
					status: 200,
					path,
					etag: `"${epoch}.6"`,
					seq: 3,
					size: new TextEncoder().encode(text).byteLength,
					hash,
					deleted: false,
				};
			},
			delete: async () => {
				throw new Error("Unexpected delete");
			},
			rename: async (_path, to) => ({
				status: 200,
				path: to,
				etag: `"${epoch}.5"`,
				seq: 2,
				size: new TextEncoder().encode("server source").byteLength,
				hash: await digestText("server source"),
				deleted: false,
			}),
		};
		const controller = new PublicationController(journal, vault, remote, {
			now: () => 1_800_000_000_000,
			recoverPrecondition: async () => {},
		});
		await controller.observe({
			type: "rename",
			path: "source.md",
			to: "target.md",
		});
		await controller.scan();

		expect(journal.snapshot().pending_ops).toHaveLength(1);
		expect(journal.snapshot().pending_ops[0]?.op).toBe("rename");
		await controller.flush();
		expect(journal.snapshot().pending_ops[0]).toMatchObject({
			op: "put",
			path: "target.md",
			state: "queued",
		});
		await controller.flush();

		expect(putCalls).toEqual([
			{
				text: "rewritten links",
				precondition: { kind: "match", epoch, rev: 5 },
			},
		]);
		expect(journal.snapshot().pending_ops).toEqual([]);
		controller.close();
	});

	it("admits a live case-only rename with distinct canonical spellings", async () => {
		const { controller, journal } = await openController();
		await journal.setBase("notes/a.md", {
			deleted: false,
			rev: 4,
			hash: await digestText("case rename"),
		});

		await controller.observe({
			type: "rename",
			path: "notes/a.md",
			to: "notes/A.md",
		});

		expect(journal.snapshot().pending_ops[0]).toMatchObject({
			op: "rename",
			path: "notes/a.md",
			to: "notes/A.md",
			precondition: { kind: "match", epoch, rev: 4 },
		});
		controller.close();
	});

	it("does not publish a live edit event when the text still matches its base", async () => {
		const { controller, journal, vault } = await openController();
		const text = "unchanged confirmed text";
		await journal.setBase("note.md", {
			deleted: false,
			rev: 3,
			hash: await digestText(text),
		});
		vault.files.set("note.md", text);

		await controller.observe({ type: "modify", path: "note.md" });

		expect(journal.snapshot().pending_ops).toEqual([]);
		controller.close();
	});

	it("consumes only the exact expected-write echo and queues a concurrent edit", async () => {
		const { controller, journal, vault } = await openController();
		const originalHash = await digestText("remote apply");
		await journal.setExpectedWrite("note.md", originalHash);
		vault.files.set("note.md", "remote apply");
		await controller.observe({ type: "modify", path: "note.md" });
		expect(journal.snapshot().pending_ops).toEqual([]);
		expect(journal.snapshot().expected_writes["note.md"]).toBeUndefined();

		await journal.setExpectedWrite("note.md", originalHash);
		vault.files.set("note.md", "user edit during apply");
		await controller.observe({ type: "modify", path: "note.md" });
		expect(journal.snapshot().pending_ops).toHaveLength(1);
		expect(
			await journal.readPayload(
				journal.snapshot().pending_ops[0]?.payload_ref ?? "",
				journal.snapshot().pending_ops[0]?.payload_hash ?? "",
			),
		).toEqual(new TextEncoder().encode("user edit during apply"));
		controller.close();
	});

	it("stops after revocation and keeps every unsent operation and payload", async () => {
		const { controller, journal, remote, vault, storage } =
			await openController();
		vault.files.set("one.md", "first queued text");
		vault.files.set("two.md", "second queued text");
		await controller.scan();
		remote.failure = new SyncTransportError(401, "revoked");

		await controller.flush();

		expect(remote.writes).toHaveLength(1);
		expect(journal.snapshot().pending_ops).toHaveLength(2);
		for (const operation of journal.snapshot().pending_ops)
			expect(await storage.readPayload(operation.payload_ref)).toEqual(
				new TextEncoder().encode(
					operation.path === "one.md"
						? "first queued text"
						: "second queued text",
				),
			);
		expect(journal.snapshot().attention).toContainEqual({
			path: "one.md",
			reason: "Device authorization was revoked",
		});
		controller.close();
	});

	it("retains rejected payload evidence after a text size refusal", async () => {
		const { controller, journal, remote, storage, vault } =
			await openController();
		vault.files.set("note.md", "oversize refusal evidence");
		await controller.scan();
		remote.failure = new SyncTransportError(413, "text_too_large");
		await controller.flush();
		const retained = journal.snapshot().attention[0]?.operation;
		expect(retained).toMatchObject({ state: "sent", path: "note.md" });
		expect(await storage.readPayload(retained?.payload_ref ?? "")).toEqual(
			new TextEncoder().encode("oversize refusal evidence"),
		);
		expect(journal.snapshot().pending_ops).toEqual([]);
		controller.close();
	});

	it("cancels an unsent create when a live delete arrives before flush", async () => {
		const { controller, journal, remote, vault } = await openController();
		vault.files.set("new.md", "not yet published");
		await controller.observe({ type: "create", path: "new.md" });
		vault.files.delete("new.md");

		await controller.observe({ type: "delete", path: "new.md" });
		await controller.flush();

		expect(journal.snapshot().pending_ops).toEqual([]);
		expect(remote.writes).toEqual([]);
		expect(remote.deletes).toEqual([]);
		controller.close();
	});

	it("preserves a sent create and queues its delete after the receipt", async () => {
		let now = 1_800_000_000_000;
		const { controller, journal, remote, vault } = await openController(
			undefined,
			undefined,
			undefined,
			() => now,
		);
		vault.files.set("new.md", "uncertain create");
		await controller.observe({ type: "create", path: "new.md" });
		remote.failure = new Error("Create response was lost");
		await controller.flush();
		const sent = journal.snapshot().pending_ops[0];
		if (!sent) throw new Error("Expected a sent create");
		vault.files.delete("new.md");
		await controller.observe({ type: "delete", path: "new.md" });

		expect(journal.snapshot().pending_ops).toMatchObject([
			{ key: sent.key, state: "sent", op: "put" },
			{ state: "queued", op: "delete", depends_on: sent.key },
		]);
		now += 2_000;
		await controller.flush();

		expect(remote.writes).toHaveLength(2);
		expect(remote.writes[0]?.key).toBe(sent.key);
		expect(remote.writes[1]?.precondition).toEqual({ kind: "absent" });
		expect(remote.deletes[0]?.precondition).toEqual({
			kind: "match",
			epoch,
			rev: 1,
		});
		expect(journal.snapshot().pending_ops).toEqual([]);
		expect(journal.snapshot().base["new.md"]).toEqual({
			deleted: true,
			rev: 2,
		});
		controller.close();
	});

	it("blocks a dependent delete when its sent create is rejected", async () => {
		let now = 1_800_000_000_000;
		const { controller, journal, remote, vault } = await openController(
			undefined,
			undefined,
			undefined,
			() => now,
		);
		vault.files.set("new.md", "uncertain create");
		await controller.observe({ type: "create", path: "new.md" });
		remote.failure = new Error("Create response was lost");
		await controller.flush();
		const sent = journal.snapshot().pending_ops[0];
		if (!sent) throw new Error("Expected a sent create");
		vault.files.delete("new.md");
		await controller.observe({ type: "delete", path: "new.md" });
		now += 2_000;
		remote.failure = new SyncTransportError(412, "precondition_failed");

		await controller.flush();

		expect(remote.deletes).toEqual([]);
		expect(journal.snapshot().pending_ops).toEqual([]);
		expect(journal.snapshot().attention).toMatchObject([
			{ operation: { key: sent.key, state: "sent", op: "put" } },
			{
				path: "new.md",
				reason: "Delete intent was blocked by its rejected create",
				operation: {
					state: "queued",
					op: "delete",
					depends_on: sent.key,
				},
			},
		]);
		controller.close();
	});

	it("does not restore a file while an explicit live delete is pending", async () => {
		const { controller, journal, vault } = await openController();
		await journal.setBase("note.md", {
			deleted: false,
			rev: 3,
			hash: await digestText("server text"),
		});
		await controller.observe({ type: "delete", path: "note.md" });

		await controller.scan();

		expect(await vault.read("note.md")).toBeNull();
		expect(journal.snapshot().pending_ops[0]).toMatchObject({ op: "delete" });
		controller.close();
	});

	it("publishes only an explicit delete under its exact observed source revision", async () => {
		const { controller, journal, remote } = await openController();
		await journal.setBase("note.md", {
			deleted: false,
			rev: 3,
			hash: await digestText("confirmed text"),
		});
		await controller.observe({ type: "delete", path: "note.md" });

		await controller.flush();

		expect(remote.deletes).toHaveLength(1);
		expect(remote.deletes[0]).toMatchObject({
			path: "note.md",
			precondition: { kind: "match", epoch, rev: 3 },
		});
		expect(journal.snapshot().base["note.md"]).toEqual({
			deleted: true,
			rev: 4,
		});
		expect(journal.snapshot().pending_ops).toEqual([]);
		controller.close();
	});

	it("does not advance the feed cursor from a successful mutation receipt", async () => {
		const { controller, journal, remote, vault } = await openController();
		vault.files.set("note.md", "local edit");
		await controller.scan();
		await controller.flush();

		expect(remote.writes).toHaveLength(1);
		expect(journal.snapshot().cursor).toBeNull();
		expect(journal.snapshot().base["note.md"]).toEqual({
			deleted: false,
			rev: 1,
			hash: await digestText("local edit"),
		});
		controller.close();
	});

	it("does not send scan bytes after a newer remote apply changes the base and file", async () => {
		const { controller, journal, remote, vault } = await openController();
		const oldBase = "old confirmed text";
		await journal.setBase("note.md", {
			deleted: false,
			rev: 1,
			hash: await digestText(oldBase),
		});
		vault.files.set("note.md", "queued local bytes");
		await controller.scan();
		const newerText = "new authoritative text";
		const engine = new TextApplyEngine(
			journal,
			vault,
			{ read: async () => newerText },
			{ deviceName: "Test Device" },
		);
		await engine.apply({
			seq: 5,
			op: "put",
			path: "note.md",
			etag: `"${epoch}.5"`,
			hash: await digestText(newerText),
			origin: "remote",
			at: 5,
		});

		await controller.flush();

		expect(await vault.read("note.md")).toBe(newerText);
		expect(journal.snapshot().base["note.md"]).toEqual({
			deleted: false,
			rev: 5,
			hash: await digestText(newerText),
		});
		expect(remote.writes).toEqual([]);
		expect(journal.snapshot().pending_ops).toEqual([]);
		expect(
			[...vault.files.entries()].some(
				([path, text]) =>
					path.includes("(conflict ") && text === "queued local bytes",
			),
		).toBe(true);
		controller.close();
		engine.close();
	});

	it.each([
		{ cursor: 1, destination: "original source bytes", label: "clean before" },
		{ cursor: 2, destination: "original source bytes", label: "clean after" },
		{
			cursor: 1,
			destination: "edited destination bytes",
			label: "edited before",
		},
		{
			cursor: 2,
			destination: "edited destination bytes",
			label: "edited after",
		},
	] as const)(
		"recovers a $label stale rename when the feed cursor is $cursor",
		async ({ cursor, destination }) => {
			const storage = new MemoryStorage();
			const vault = new MemoryVault();
			const journal = await DeviceJournal.open(storage);
			await journal.resetEpoch(epoch);
			const oldSource = "original source bytes";
			const currentSource = "new remote source bytes";
			const oldHash = await digestText(oldSource);
			const currentHash = await digestText(currentSource);
			await journal.setBase("x.md", {
				deleted: false,
				rev: 1,
				hash: oldHash,
			});
			await journal.setCursor(epoch, cursor);
			vault.files.set("y.md", destination);
			let feedReads = 0;
			const published: Array<{
				path: string;
				text: string;
				precondition: DevicePrecondition;
			}> = [];
			const remote: PublicationRemote &
				ReconciliationRemote & {
					/** Reads exact text for the matching current source revision only. */
					read(
						path: string,
						epoch: string,
						rev: number,
					): Promise<string | null>;
				} = {
				readAuthority: async (_path, requestEpoch, rev) => ({
					deleted: false,
					text: currentSource,
					epoch: requestEpoch,
					rev,
					hash: currentHash,
				}),
				readCurrentAuthority: async () => ({
					deleted: false,
					text: currentSource,
					epoch,
					rev: 2,
					hash: currentHash,
				}),
				read: async (_path, _requestEpoch, rev) =>
					rev === 2 ? currentSource : null,
				manifest: async () => {
					throw new Error("Unexpected manifest read");
				},
				changes: async (_requestEpoch, since) => {
					feedReads += 1;
					return {
						epoch,
						head_seq: 2,
						entries:
							since < 2
								? [
										{
											seq: 2,
											op: "put" as const,
											path: "x.md",
											etag: `"${epoch}.2"`,
											hash: currentHash,
											origin: "remote",
											at: 2,
										},
									]
								: [],
					};
				},
				createText: async () => {
					throw new Error("Unexpected enrollment create");
				},
				put: async (path, text, precondition, _key) => {
					published.push({ path, text, precondition });
					return {
						status: 201,
						path,
						etag: `"${epoch}.3"`,
						seq: 3,
						size: new TextEncoder().encode(text).byteLength,
						hash: await digestText(text),
						deleted: false,
					};
				},
				delete: async () => {
					throw new Error("Unexpected delete");
				},
				rename: async () => {
					throw new SyncTransportError(412, "precondition_failed");
				},
			};
			const engine = new TextApplyEngine(journal, vault, remote, {
				deviceName: "Test Device",
			});
			const reconciliation = new ReconciliationController(
				journal,
				engine,
				vault,
				remote,
			);
			let activeReconciliation = reconciliation;
			let activeJournal = journal;
			let activeController = new PublicationController(journal, vault, remote, {
				now: () => 1_800_000_000_000,
				recoverPrecondition: (operation) =>
					activeReconciliation.recoverPrecondition(operation),
			});
			await activeController.observe({
				type: "rename",
				path: "x.md",
				to: "y.md",
			});

			if (cursor === 2 && destination === oldSource) {
				vault.afterTrash = () => {
					vault.afterTrash = null;
					throw new Error("simulated interruption after trash");
				};
				await expect(activeController.flush()).rejects.toThrow(
					"simulated interruption after trash",
				);
				expect(journal.snapshot().pending_ops[0]).toMatchObject({
					state: "sent",
					source_hash: oldHash,
				});
				expect(await vault.read("y.md")).toBeNull();
				activeController.close();
				activeReconciliation.close();
				activeJournal = await DeviceJournal.open(storage);
				const restartedEngine = new TextApplyEngine(
					activeJournal,
					vault,
					remote,
					{ deviceName: "Test Device" },
				);
				activeReconciliation = new ReconciliationController(
					activeJournal,
					restartedEngine,
					vault,
					remote,
				);
				activeController = new PublicationController(
					activeJournal,
					vault,
					remote,
					{
						now: () => 1_800_000_000_000,
						recoverPrecondition: (operation) =>
							activeReconciliation.recoverPrecondition(operation),
					},
				);
				await activeController.flush();
			} else {
				await activeController.flush();
				if (destination !== oldSource) await activeController.flush();
			}

			expect(feedReads).toBe(cursor === 2 && destination === oldSource ? 2 : 1);
			expect(activeJournal.snapshot().cursor).toBe(2);
			expect(await vault.read("x.md")).toBe(currentSource);
			expect(activeJournal.snapshot().base["x.md"]).toEqual({
				deleted: false,
				rev: 2,
				hash: currentHash,
			});
			const rejectedRename = activeJournal
				.snapshot()
				.attention.find(
					(item: { operation?: PendingOperation }) =>
						item.operation?.op === "rename",
				)?.operation;
			expect(rejectedRename).toMatchObject({ source_hash: oldHash });
			if (destination === oldSource) {
				expect(await vault.read("y.md")).toBeNull();
				expect(published).toEqual([]);
			} else {
				expect(await vault.read("y.md")).toBe(destination);
				expect(published).toEqual([
					{
						path: "y.md",
						text: destination,
						precondition: { kind: "absent" },
					},
				]);
			}
			expect(activeJournal.snapshot().pending_ops).toEqual([]);
			activeController.close();
			activeReconciliation.close();
		},
	);

	it("keeps sent payload and precondition immutable after a newer remote apply", async () => {
		let now = 1_800_000_000_000;
		const { controller, journal, remote, vault } = await openController(
			undefined,
			undefined,
			undefined,
			() => now,
		);
		const oldBase = "old confirmed text";
		await journal.setBase("note.md", {
			deleted: false,
			rev: 1,
			hash: await digestText(oldBase),
		});
		vault.files.set("note.md", "sent local bytes");
		await controller.scan();
		remote.failure = new Error("Response was lost");
		await controller.flush();
		const sent = journal.snapshot().pending_ops[0];
		if (!sent) throw new Error("Expected a sent operation");
		const engine = new TextApplyEngine(
			journal,
			vault,
			{ read: async () => "new remote text" },
			{ deviceName: "Test Device" },
		);
		await engine.apply({
			seq: 5,
			op: "put",
			path: "note.md",
			etag: `"${epoch}.5"`,
			hash: await digestText("new remote text"),
			origin: "remote",
			at: 5,
		});
		now += 2_000;
		remote.failure = new SyncTransportError(412, "precondition_failed");

		await controller.flush();

		expect(remote.writes).toHaveLength(2);
		expect(remote.writes[0]).toMatchObject({
			key: sent.key,
			text: "sent local bytes",
			precondition: { kind: "match", epoch, rev: 1 },
		});
		expect(remote.writes[1]).toEqual(remote.writes[0]);
		expect(journal.snapshot().pending_ops).toEqual([]);
		expect(journal.snapshot().attention.at(-1)?.operation).toMatchObject({
			key: sent.key,
			state: "sent",
		});
		controller.close();
		engine.close();
	});

	it("keeps a lost sent payload immutable when a later scan sees another edit", async () => {
		let now = 1_800_000_000_000;
		const storage = new MemoryStorage();
		const vault = new MemoryVault();
		const remote = new MemoryRemote();
		const { controller, journal } = await openController(
			storage,
			vault,
			remote,
			() => now,
		);
		vault.files.set("note.md", "first bytes");
		await controller.scan();
		const original = journal.snapshot().pending_ops[0];
		if (!original) throw new Error("Expected a queued operation");
		remote.failure = new Error("Response was lost");
		await controller.flush();
		vault.files.set("note.md", "second bytes");
		await controller.scan();

		const operations = journal.snapshot().pending_ops;
		expect(operations).toHaveLength(2);
		expect(operations[0]).toMatchObject({ key: original.key, state: "sent" });
		expect(await storage.readPayload(original.payload_ref)).toEqual(
			new TextEncoder().encode("first bytes"),
		);
		now += 2_000;
		await controller.flush();
		expect(remote.writes.map((write) => write.text)).toEqual([
			"first bytes",
			"first bytes",
			"second bytes",
		]);
		expect(remote.writes[0]?.key).toBe(remote.writes[1]?.key);
		expect(remote.writes.map((write) => write.precondition)).toEqual([
			{ kind: "absent" },
			{ kind: "absent" },
			{ kind: "match", epoch, rev: 1 },
		]);
		expect(journal.snapshot().pending_ops).toEqual([]);
		controller.close();
	});

	it("keeps a sent operation unresolved when close fences an in-flight receipt", async () => {
		const { controller, journal, remote, vault } = await openController();
		vault.files.set("note.md", "in flight bytes");
		await controller.scan();
		/** Releases the fake response only after controller close. */
		let releaseReceipt = () => {};
		/** Signals that the mutation request reached its pending response. */
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		remote.beforeReceipt = () =>
			new Promise<void>((resolve) => {
				releaseReceipt = resolve;
				markStarted();
			});

		const flushing = controller.flush();
		await started;
		controller.close();
		releaseReceipt();
		await expect(flushing).rejects.toThrow("Publication controller is closed");

		expect(journal.snapshot().pending_ops[0]).toMatchObject({
			state: "sent",
			path: "note.md",
		});
		expect(journal.snapshot().base["note.md"]).toBeUndefined();
	});

	it("retains a sent operation when its receipt size does not match its payload", async () => {
		const { controller, journal, remote, vault } = await openController();
		vault.files.set("note.md", "size authority");
		await controller.scan();
		remote.receiptSizeOverride = 999;

		await controller.flush();

		expect(journal.snapshot().base["note.md"]).toBeUndefined();
		expect(journal.snapshot().pending_ops[0]).toMatchObject({
			state: "sent",
			attempts: 1,
		});
		controller.close();
	});

	it("retains a sent operation when its receipt hash does not match its payload", async () => {
		const { controller, journal, remote, storage, vault } =
			await openController();
		vault.files.set("note.md", "payload authority");
		await controller.scan();
		remote.receiptHashOverride = "d".repeat(64);

		await controller.flush();

		expect(journal.snapshot().base["note.md"]).toBeUndefined();
		const operation = journal.snapshot().pending_ops[0];
		expect(operation).toMatchObject({ state: "sent", attempts: 1 });
		expect(await storage.readPayload(operation?.payload_ref ?? "")).toEqual(
			new TextEncoder().encode("payload authority"),
		);
		controller.close();
	});

	it("does not replace a newer feed base when an older receipt returns", async () => {
		const { controller, journal, remote, vault } = await openController();
		vault.files.set("note.md", "local edit");
		await controller.scan();
		remote.beforeReceipt = () =>
			journal.setBase("note.md", {
				deleted: false,
				rev: 5,
				hash: "c".repeat(64),
			});

		await controller.flush();

		expect(journal.snapshot().base["note.md"]).toEqual({
			deleted: false,
			rev: 5,
			hash: "c".repeat(64),
		});
		expect(journal.snapshot().pending_ops).toEqual([]);
		controller.close();
	});

	it("delegates 412 recovery to the shared reconciler and retains sent evidence", async () => {
		let recoveryCalls = 0;
		const { controller, journal, remote, storage, vault } =
			await openController(
				undefined,
				undefined,
				undefined,
				undefined,
				async () => {
					recoveryCalls += 1;
				},
			);
		vault.files.set("note.md", "conflicted local text");
		await controller.scan();
		remote.failure = new SyncTransportError(
			412,
			"precondition_failed",
			null,
			null,
		);

		await controller.flush();

		const attention = journal.snapshot().attention.at(-1);
		expect(recoveryCalls).toBe(1);
		expect(journal.snapshot().pending_ops).toEqual([]);
		expect(attention).toMatchObject({
			path: "note.md",
			reason: "Local text met newer remote content",
			operation: { state: "sent", path: "note.md" },
		});
		const operation = attention?.operation;
		expect(operation).toBeDefined();
		if (operation) {
			expect(await storage.readPayload(operation.payload_ref)).toEqual(
				new TextEncoder().encode("conflicted local text"),
			);
		}
		controller.close();
	});

	it("persists bounded Retry-After eligibility across controller restart", async () => {
		const storage = new MemoryStorage();
		const vault = new MemoryVault();
		const remote = new MemoryRemote();
		let now = 1_800_000_000_000;
		const firstJournal = await DeviceJournal.open(storage);
		await firstJournal.resetEpoch(epoch);
		const first = new PublicationController(firstJournal, vault, remote, {
			now: () => now,
			recoverPrecondition: async () => {},
		});
		vault.files.set("note.md", "retry bytes");
		await first.scan();
		remote.failure = new SyncTransportError(503, "importing", null, "12");
		await first.flush();
		const sent = firstJournal.snapshot().pending_ops[0];
		expect(sent).toMatchObject({ attempts: 1, state: "sent" });
		first.close();

		const restartedJournal = await DeviceJournal.open(storage);
		const restarted = new PublicationController(
			restartedJournal,
			vault,
			remote,
			{
				now: () => now,
				recoverPrecondition: async () => {},
			},
		);
		await restarted.flush();
		expect(remote.writes).toHaveLength(1);
		now += 12_000;
		await restarted.flush();
		expect(remote.writes).toHaveLength(2);
		expect(remote.writes[0]?.key).toBe(remote.writes[1]?.key);
		expect(remote.writes[0]?.text).toBe(remote.writes[1]?.text);
		restarted.close();
	});
});
