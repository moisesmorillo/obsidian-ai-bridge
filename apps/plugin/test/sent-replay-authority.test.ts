import type { DevicePrecondition, PendingOperation } from "@vaultwire/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSyncController } from "../src/sync/desktop-sync";
import { DeviceJournal } from "../src/sync/device-journal";
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

/** Keeps journal state and immutable operation payloads across controller reloads. */
class MemoryStorage {
	state: unknown = null;
	payloads = new Map<string, Uint8Array>();
	/** Reads the last verified device journal document. */
	async readState(): Promise<unknown> {
		return this.state;
	}
	/** Persists a defensive copy of the complete journal document. */
	async writeState(state: unknown): Promise<void> {
		this.state = structuredClone(state);
	}
	/** Returns exact saved operation bytes for one payload reference. */
	async readPayload(path: string): Promise<Uint8Array> {
		const bytes = this.payloads.get(path);
		if (!bytes) throw new Error("Missing operation payload");
		return bytes.slice();
	}
	/** Saves an immutable copy of one operation payload. */
	async writePayload(path: string, bytes: Uint8Array): Promise<void> {
		this.payloads.set(path, bytes.slice());
	}
}

/** Provides exact local text operations for publication and remote apply. */
class MemoryVault implements TextVault {
	files = new Map<string, string>();
	/** Reads exact local text or reports that the path is absent. */
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	/** Lists visible local paths without inferring deletions. */
	async list(): Promise<string[]> {
		return [...this.files.keys()];
	}
	/** Returns exact UTF-8 bytes for queued publication verification. */
	async readBinary(path: string): Promise<Uint8Array | null> {
		const text = this.files.get(path);
		return text === undefined ? null : new TextEncoder().encode(text);
	}
	/** Returns exact UTF-8 size or reports that the path is absent. */
	async size(path: string): Promise<number | null> {
		const text = this.files.get(path);
		return text === undefined
			? null
			: new TextEncoder().encode(text).byteLength;
	}
	/** Replaces content only when it matches the guarded observation. */
	async process(
		path: string,
		expected: string | null,
		next: string,
	): Promise<boolean> {
		if ((this.files.get(path) ?? null) !== expected) return false;
		this.files.set(path, next);
		return true;
	}
	/** Creates visible text only when the destination is absent. */
	async create(path: string, text: string): Promise<boolean> {
		if (this.files.has(path)) return false;
		this.files.set(path, text);
		return true;
	}
	/** Removes text only when it matches the guarded observation. */
	async trash(path: string, expected: string): Promise<boolean> {
		if (this.files.get(path) !== expected) return false;
		this.files.delete(path);
		return true;
	}
	/** Moves text only when the source matches and the destination is absent. */
	async rename(from: string, to: string, expected: string): Promise<boolean> {
		if (this.files.get(from) !== expected || this.files.has(to)) return false;
		this.files.set(to, expected);
		this.files.delete(from);
		return true;
	}
}

/** Hashes exact UTF-8 content for receipts and feed authority. */
async function hash(text: string): Promise<string> {
	const value = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(value)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("sent operation replay authority", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_800_000_000_000);
	});

	it("defers its committed feed row until retry receipt, then publishes the successor at the same path", async () => {
		const storage = new MemoryStorage();
		const journal = await DeviceJournal.open(storage);
		await journal.resetEpoch(epoch);
		await journal.setCursor(epoch, 0);
		const path = "notes/sent.md";
		const first = "first immutable edit";
		const successor = "later local edit";
		const vault = new MemoryVault();
		vault.files.set(path, first);
		let now = Date.now();
		const requests: Array<{
			path: string;
			key: string;
			text: string;
			precondition: DevicePrecondition;
		}> = [];
		const commits: Array<{ path: string; rev: number; text: string }> = [];
		const versions = new Map<string, { rev: number; text: string }>();
		const receipts = new Map<string, PublicationReceipt>();
		let firstRequest = true;
		/** Retains ordered service changes until reconciliation accepts their cursor. */
		let feed: ReconciliationRemote["changes"] = async () => ({
			epoch,
			head_seq: 0,
			entries: [],
		});
		const remote: PublicationRemote = {
			readAuthority: async () => {
				throw new Error("Unexpected pinned read");
			},
			readCurrentAuthority: async (readPath) => {
				const item = versions.get(readPath);
				if (!item) throw new SyncTransportError(404, "not_found");
				return {
					deleted: false,
					text: item.text,
					epoch,
					rev: item.rev,
					hash: await hash(item.text),
				};
			},
			put: async (putPath, text, precondition, key) => {
				requests.push({
					path: putPath,
					key,
					text,
					precondition: structuredClone(precondition),
				});
				const prior = receipts.get(key);
				if (prior) return structuredClone(prior);
				const current = versions.get(putPath);
				const preconditionMatches =
					precondition.kind === "absent"
						? current === undefined
						: precondition.epoch === epoch && precondition.rev === current?.rev;
				if (!preconditionMatches)
					throw new SyncTransportError(412, "precondition_failed");
				const rev = (current?.rev ?? 0) + 1;
				const receipt = {
					status: 200,
					path: putPath,
					etag: `"${epoch}.${rev}"`,
					seq: rev,
					size: new TextEncoder().encode(text).byteLength,
					hash: await hash(text),
					deleted: false,
				};
				versions.set(putPath, { rev, text });
				commits.push({ path: putPath, rev, text });
				receipts.set(key, receipt);
				if (firstRequest) {
					firstRequest = false;
					versions.set("notes/foreign.md", {
						rev: 1,
						text: "foreign remote edit",
					});
					feed = async () => ({
						epoch,
						head_seq: 2,
						entries: [
							{
								seq: 1,
								op: "put",
								path: putPath,
								etag: receipt.etag,
								hash: receipt.hash,
								origin: "device",
								at: now,
							},
							{
								seq: 2,
								op: "put",
								path: "notes/foreign.md",
								etag: `"${epoch}.1"`,
								hash: await hash("foreign remote edit"),
								origin: "agent",
								at: now,
							},
						],
					});
					throw new SyncTransportError(503, "importing");
				}
				return structuredClone(receipt);
			},
			delete: async () => {
				throw new Error("Unexpected delete");
			},
			rename: async () => {
				throw new Error("Unexpected rename");
			},
		};
		const applyEngine = new TextApplyEngine(
			journal,
			vault,
			{
				...remote,
				read: async (readPath, requestedEpoch, rev) => {
					const item = versions.get(readPath);
					return requestedEpoch === epoch && item?.rev === rev
						? item.text
						: null;
				},
			},
			{ deviceName: "test", now: () => now },
		);
		const publication = new PublicationController(journal, vault, remote, {
			applyEngine,
			now: () => now,
			recoverPrecondition: async () => undefined,
		});
		const reconcileRemote: ReconciliationRemote = {
			manifest: async () => ({
				epoch,
				head_seq: 2,
				next_page: null,
				entries: [],
			}),
			changes: async (requestedEpoch, since) =>
				requestedEpoch === epoch
					? feed(epoch, since)
					: { epoch, head_seq: 0, entries: [] },
			createText: async () => {
				throw new Error("Unexpected enrollment create");
			},
		};
		const reconciliation = new ReconciliationController(
			journal,
			applyEngine,
			vault,
			reconcileRemote,
		);
		const desktop = new DesktopSyncController({
			cycle: async () => reconciliation.replay(),
			host: {
				setTimeout: () => 1,
				clearTimeout: () => undefined,
				setInterval: () => 2,
				clearInterval: () => undefined,
			},
		});

		try {
			await publication.scan();
			expect(journal.snapshot().pending_ops.length).toBe(1);
			await publication.flush();
			const sent = journal
				.snapshot()
				.pending_ops.find(
					(operation: PendingOperation) => operation.state === "sent",
				);
			expect(sent).toBeDefined();
			if (!sent)
				throw new Error("Expected the lost-response operation to remain sent");
			const sentPayload = await journal.readPayload(
				sent.payload_ref,
				sent.payload_hash,
			);
			expect(sentPayload).toEqual(new TextEncoder().encode(first));
			expect(sent.retry_at).toBe(now + 2_000);
			vault.files.set(path, successor);
			await publication.scan();
			await desktop.syncNow();
			expect(journal.snapshot().cursor).toBe(0);
			expect(journal.snapshot().base[path]).toBeUndefined();
			expect(vault.files.get(path)).toBe(successor);
			expect(
				[...vault.files.keys()].filter((name) => name.includes("conflict")),
			).toEqual([]);
			const immutable = journal
				.snapshot()
				.pending_ops.find(
					(operation: PendingOperation) => operation.key === sent?.key,
				);
			expect(immutable).toEqual(sent);
			expect(
				await journal.readPayload(sent.payload_ref, sent.payload_hash),
			).toEqual(sentPayload);
			now += 2_000;
			await publication.flush();
			await desktop.syncNow();
			expect(requests[0]?.path).toBe(path);
			expect(requests[1]?.path).toBe(path);
			expect(requests[2]?.path).toBe(path);
			expect(requests[0]?.key).toBe(sent?.key);
			expect(requests[1]?.key).toBe(sent?.key);
			expect(requests[2]?.key).not.toBe(sent?.key);
			expect(requests.slice(0, 2).map((request) => request.text)).toEqual([
				first,
				first,
			]);
			expect(
				requests.slice(0, 2).map((request) => request.precondition),
			).toEqual([{ kind: "absent" }, { kind: "absent" }]);
			expect(requests[2]).toMatchObject({
				text: successor,
				precondition: { kind: "match", epoch, rev: 1 },
			});
			expect(commits).toEqual([
				{ path, rev: 1, text: first },
				{ path, rev: 2, text: successor },
			]);
			expect(
				[...versions.values()].map((version) => version.rev).sort(),
			).toEqual([1, 2]);
			expect(journal.snapshot().pending_ops).toEqual([]);
			expect(journal.snapshot().cursor).toBe(2);
			expect(vault.files.get("notes/foreign.md")).toBe("foreign remote edit");
			expect(
				[...vault.files.keys()].filter((name) => name.includes("conflict")),
			).toEqual([]);
		} finally {
			desktop.close();
			reconciliation.close();
			publication.close();
			applyEngine.close();
			journal.close();
			vi.useRealTimers();
		}
	});

	it("defers an unresolved sent path during full manifest reconciliation", async () => {
		const storage = new MemoryStorage();
		const journal = await DeviceJournal.open(storage);
		await journal.resetEpoch(epoch);
		const path = "notes/manifest-replay.md";
		const sentText = "committed sent bytes";
		const localText = "newer local bytes";
		const sentHash = await hash(sentText);
		const vault = new MemoryVault();
		vault.files.set(path, localText);
		const previousBase = {
			deleted: false as const,
			rev: 1,
			hash: await hash("previous confirmed bytes"),
		};
		await journal.setBase(path, previousBase);
		const operation = await journal.enqueue(
			{ op: "put", path, precondition: { kind: "match", epoch, rev: 1 } },
			new TextEncoder().encode(sentText),
		);
		await journal.prepareSend(operation.key, { kind: "match", epoch, rev: 1 });
		const remote: ReconciliationRemote = {
			manifest: async () => ({
				epoch,
				head_seq: 1,
				next_page: null,
				entries: [
					{
						path,
						etag: `"${epoch}.2"`,
						seq: 1,
						hash: sentHash,
						kind: "text",
						deleted: false,
					},
				],
			}),
			changes: async () => ({ epoch, head_seq: 0, entries: [] }),
			createText: async () => {
				throw new Error("Unexpected enrollment create");
			},
		};
		const engine = new TextApplyEngine(
			journal,
			vault,
			{
				read: async (readPath, requestedEpoch, rev) =>
					readPath === path && requestedEpoch === epoch && rev === 2
						? sentText
						: null,
			},
			{ deviceName: "test" },
		);
		const reconciliation = new ReconciliationController(
			journal,
			engine,
			vault,
			remote,
		);
		try {
			await reconciliation.resume();
			expect(vault.files.get(path)).toBe(localText);
			expect(
				[...vault.files.keys()].filter((localPath) =>
					localPath.includes("conflict"),
				),
			).toEqual([]);
			expect(journal.snapshot().base[path]).toEqual(previousBase);
			expect(journal.snapshot().cursor).toBeNull();
			expect(journal.snapshot().reconciliation).toMatchObject({
				epoch,
				stage: "manifest",
				pending_paths: [path],
			});
			expect(journal.snapshot().pending_ops[0]).toMatchObject({
				key: operation.key,
				state: "sent",
			});
		} finally {
			reconciliation.close();
			engine.close();
			journal.close();
		}
	});

	it("resets the epoch through replay when old sent work blocks cursor recovery", async () => {
		const oldEpoch = "b".repeat(32);
		const newEpoch = "c".repeat(32);
		const storage = new MemoryStorage();
		const journal = await DeviceJournal.open(storage);
		await journal.resetEpoch(oldEpoch);
		await journal.setCursor(oldEpoch, 0);
		const path = "notes/restored-after-replay.md";
		const sentText = "old sent payload";
		const restoredText = "restored content";
		const vault = new MemoryVault();
		vault.files.set(path, sentText);
		const operation = await journal.enqueue(
			{ op: "put", path, precondition: { kind: "absent" } },
			new TextEncoder().encode(sentText),
		);
		await journal.prepareSend(operation.key, { kind: "absent" });
		let changesCalls = 0;
		const remote: ReconciliationRemote = {
			manifest: async () => ({
				epoch: newEpoch,
				head_seq: 1,
				next_page: null,
				entries: [
					{
						path,
						etag: `"${newEpoch}.1"`,
						seq: 1,
						hash: await hash(restoredText),
						kind: "text",
						deleted: false,
					},
				],
			}),
			changes: async () => {
				changesCalls += 1;
				if (changesCalls === 1)
					throw new SyncTransportError(409, "epoch_mismatch");
				return { epoch: newEpoch, head_seq: 1, entries: [] };
			},
			createText: async () => {
				throw new Error("Unexpected enrollment create");
			},
		};
		const engine = new TextApplyEngine(
			journal,
			vault,
			{ read: async () => restoredText },
			{ deviceName: "test" },
		);
		const reconciliation = new ReconciliationController(
			journal,
			engine,
			vault,
			remote,
		);
		const published: Array<{ path: string; text: string; epoch: string }> = [];
		const publication = new PublicationController(
			journal,
			vault,
			{
				readAuthority: async () => ({
					deleted: true,
					text: null,
					epoch: newEpoch,
					rev: 1,
					hash: "",
				}),
				readCurrentAuthority: async () => ({
					deleted: true,
					text: null,
					epoch: newEpoch,
					rev: 1,
					hash: "",
				}),
				put: async (putPath, text, _precondition, _key, publishEpoch) => {
					published.push({ path: putPath, text, epoch: publishEpoch });
					return {
						status: 200,
						path: putPath,
						etag: `"${newEpoch}.2"`,
						seq: 2,
						size: new TextEncoder().encode(text).byteLength,
						hash: await hash(text),
						deleted: false,
					};
				},
				delete: async () => {
					throw new Error("Unexpected delete");
				},
				rename: async () => {
					throw new Error("Unexpected rename");
				},
			},
			{
				applyEngine: engine,
				now: () => Date.now(),
				recoverPrecondition: async () => undefined,
			},
		);
		try {
			await reconciliation.replay();
			expect(journal.snapshot().epoch).toBe(newEpoch);
			expect(journal.snapshot().pending_ops).toEqual([]);
			expect(journal.snapshot().attention).toContainEqual(
				expect.objectContaining({
					path,
					reason: "Operation belongs to an old vault epoch",
					operation: expect.objectContaining({ key: operation.key }),
				}),
			);
			expect(vault.files.get(path)).toBe(restoredText);
			expect(journal.snapshot().cursor).toBe(1);
			const newPath = "notes/new-epoch-work.md";
			const newText = "published under the reset epoch";
			vault.files.set(newPath, newText);
			await journal.enqueue(
				{ op: "put", path: newPath, precondition: { kind: "absent" } },
				new TextEncoder().encode(newText),
			);
			await publication.flush();
			expect(published).toEqual([
				{ path: newPath, text: newText, epoch: newEpoch },
			]);
			expect(journal.snapshot().pending_ops).toEqual([]);
		} finally {
			publication.close();
			reconciliation.close();
			engine.close();
			journal.close();
		}
	});

	it("moves old-epoch sent work to attention before applying a new manifest", async () => {
		const oldEpoch = "b".repeat(32);
		const storage = new MemoryStorage();
		const journal = await DeviceJournal.open(storage);
		await journal.resetEpoch(oldEpoch);
		const path = "notes/restored.md";
		const oldBaseText = "old confirmed content";
		const sentText = "old sent payload";
		const restoredText = "new epoch content";
		const vault = new MemoryVault();
		vault.files.set(path, sentText);
		await journal.setBase(path, {
			deleted: false,
			rev: 8,
			hash: await hash(oldBaseText),
		});
		const operation = await journal.enqueue(
			{
				op: "put",
				path,
				precondition: { kind: "match", epoch: oldEpoch, rev: 8 },
			},
			new TextEncoder().encode(sentText),
		);
		await journal.prepareSend(operation.key, {
			kind: "match",
			epoch: oldEpoch,
			rev: 8,
		});
		const restoredHash = await hash(restoredText);
		const remote: ReconciliationRemote = {
			manifest: async () => ({
				epoch,
				head_seq: 1,
				next_page: null,
				entries: [
					{
						path,
						etag: `"${epoch}.1"`,
						seq: 1,
						hash: restoredHash,
						kind: "text",
						deleted: false,
					},
				],
			}),
			changes: async () => ({ epoch, head_seq: 0, entries: [] }),
			createText: async () => {
				throw new Error("Unexpected enrollment create");
			},
		};
		const engine = new TextApplyEngine(
			journal,
			vault,
			{
				read: async (readPath, requestedEpoch, rev) =>
					readPath === path && requestedEpoch === epoch && rev === 1
						? restoredText
						: null,
			},
			{ deviceName: "test" },
		);
		const reconciliation = new ReconciliationController(
			journal,
			engine,
			vault,
			remote,
		);
		try {
			await reconciliation.reconcile();
			expect(journal.snapshot().epoch).toBe(epoch);
			expect(journal.snapshot().pending_ops).toEqual([]);
			expect(journal.snapshot().attention).toContainEqual(
				expect.objectContaining({
					path,
					reason: "Operation belongs to an old vault epoch",
					operation: expect.objectContaining({ key: operation.key }),
				}),
			);
			expect(vault.files.get(path)).toBe(restoredText);
			expect(journal.snapshot().cursor).toBe(1);
		} finally {
			reconciliation.close();
			engine.close();
			journal.close();
		}
	});

	it("keeps blocked feed authority across journal restart and controller close", async () => {
		const storage = new MemoryStorage();
		let journal = await DeviceJournal.open(storage);
		await journal.resetEpoch(epoch);
		await journal.setCursor(epoch, 0);
		const path = "notes/restart.md";
		const localText = "sent payload";
		const hashValue = await hash(localText);
		const base = { deleted: false as const, rev: 1, hash: await hash("base") };
		const vault = new MemoryVault();
		vault.files.set(path, localText);
		await journal.setBase(path, base);
		const operation = await journal.enqueue(
			{ op: "put", path, precondition: { kind: "match", epoch, rev: 1 } },
			new TextEncoder().encode(localText),
		);
		await journal.prepareSend(operation.key, { kind: "match", epoch, rev: 1 });
		let cursorExpired = true;
		let manifestReads = 0;
		const remote = {
			manifest: async () => {
				manifestReads += 1;
				return { epoch, head_seq: 1, next_page: null, entries: [] };
			},
			changes: async () => {
				if (cursorExpired) throw new SyncTransportError(410, "cursor_expired");
				return {
					epoch,
					head_seq: 1,
					entries: [
						{
							seq: 1,
							op: "put" as const,
							path,
							etag: `"${epoch}.2"`,
							hash: hashValue,
							origin: "untrusted-origin",
							at: 1,
						},
					],
				};
			},
			createText: async () => {
				throw new Error("Unexpected enrollment create");
			},
		};
		/** Binds one reopened journal to fresh apply and replay lifetimes. */
		const createControllers = () => {
			const engine = new TextApplyEngine(
				journal,
				vault,
				{
					read: async (readPath, requestedEpoch, rev) =>
						readPath === path && requestedEpoch === epoch && rev === 2
							? localText
							: null,
				},
				{ deviceName: "test" },
			);
			return {
				engine,
				reconciliation: new ReconciliationController(
					journal,
					engine,
					vault,
					remote,
				),
			};
		};
		let controllers = createControllers();
		try {
			await controllers.reconciliation.replay();
			expect(manifestReads).toBe(0);
			expect(journal.snapshot().cursor).toBe(0);
			cursorExpired = false;
			await controllers.reconciliation.replay();
			expect(journal.snapshot().base[path]).toEqual(base);
			controllers.reconciliation.close();
			controllers.engine.close();
			await journal.close();
			journal = await DeviceJournal.open(storage);
			controllers = createControllers();
			await controllers.reconciliation.replay();
			expect(journal.snapshot().cursor).toBe(0);
			expect(journal.snapshot().base[path]).toEqual(base);
			expect(journal.snapshot().pending_ops[0]).toMatchObject({
				key: operation.key,
				state: "sent",
			});
		} finally {
			controllers.reconciliation.close();
			controllers.engine.close();
			journal.close();
		}
	});
});
