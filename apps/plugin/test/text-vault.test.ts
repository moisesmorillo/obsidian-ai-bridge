import type { DeviceState } from "@obsidian-ai-bridge/protocol";
import { type EventRef, TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ObsidianTextVault } from "../src/infrastructure/text-vault";
import { VaultEventAdapter } from "../src/infrastructure/vault-events";
import { CoexistenceController } from "../src/sync/coexistence";
import { CoexistenceEffectFence } from "../src/sync/coexistence-effect-fence";
import { DesktopSyncController } from "../src/sync/desktop-sync";
import { DeviceJournal } from "../src/sync/device-journal";
import type { PublicationEvent } from "../src/sync/publication";
import { ReconciliationController } from "../src/sync/reconciliation";
import { TextApplyEngine } from "../src/sync/text-apply";

/** Provides the exact host methods used by the adapter without a live vault. */
function makeHostVault() {
	const file = Object.assign(new TFile(), {
		path: "notes/a.md",
		stat: { size: new TextEncoder().encode("old").byteLength },
	});
	const contents = new Map([[file.path, "old"]]);
	const binaryContents = new Map<string, Uint8Array>();
	const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
	/** Delivers one host event to every registered test listener. */
	const emit = (event: string, ...args: unknown[]) => {
		for (const callback of handlers.get(event) ?? []) callback(...args);
	};
	const readBinary = vi.fn(async (target: TFile) => {
		const bytes =
			binaryContents.get(target.path) ??
			new TextEncoder().encode(contents.get(target.path) ?? "");
		return bytes.slice().buffer as ArrayBuffer;
	});
	const modifyBinary = vi.fn(async (target: TFile, bytes: ArrayBuffer) => {
		const copy = new Uint8Array(bytes.slice(0));
		binaryContents.set(target.path, copy);
		contents.set(target.path, new TextDecoder().decode(copy));
		emit("modify", target);
	});
	const process = vi.fn(
		async (target: TFile, callback: (text: string) => string) => {
			const current = contents.get(target.path) ?? "";
			const next = callback(current);
			contents.set(target.path, next);
			target.stat.size = new TextEncoder().encode(next).byteLength;
			if (next !== current) emit("modify", target);
			return next;
		},
	);
	const create = vi.fn(async (path: string, text: string) => {
		const created = Object.assign(new TFile(), {
			path,
			stat: { size: new TextEncoder().encode(text).byteLength },
		});
		files.push(created);
		contents.set(path, text);
		emit("create", created);
		return created;
	});
	const trash = vi.fn(async (target: TFile, _system: boolean) => {
		emit("delete", target);
		contents.delete(target.path);
		files.splice(files.indexOf(target), 1);
		return undefined;
	});
	const rename = vi.fn(async (target: TFile, path: string) => {
		const oldPath = target.path;
		files.splice(files.indexOf(target), 1);
		contents.set(path, contents.get(target.path) ?? "");
		contents.delete(target.path);
		target.path = path;
		emit("rename", target, oldPath);
		files.push(target);
	});
	const files = [file];
	const host = {
		getFiles: () => files,
		getAbstractFileByPath: (path: string) =>
			files.find((candidate) => candidate.path === path) ?? null,
		read: async (target: TFile) => contents.get(target.path) ?? "",
		readBinary,
		modifyBinary,
		/** Stores one listener and returns the host reference used for disposal. */
		on: (event: string, callback: (...args: unknown[]) => void) => {
			const listeners = handlers.get(event) ?? new Set();
			listeners.add(callback);
			handlers.set(event, listeners);
			return { event, callback } as unknown as EventRef;
		},
		offref: (reference: EventRef) => {
			const listener = reference as unknown as {
				event: string;
				callback: (...args: unknown[]) => void;
			};
			handlers.get(listener.event)?.delete(listener.callback);
		},
		process,
		create,
		trash,
		rename,
		createFolder: async () => undefined,
		adapter: {
			stat: async () => null,
			list: async () => ({ files: [], folders: [] }),
		},
	};
	return {
		host,
		contents,
		binaryContents,
		create,
		process,
		readBinary,
		modifyBinary,
		trash,
		rename,
		file,
		handlers,
		emit,
	};
}

/** Models hidden adapter files separately from indexed Vault files, including retention time and readback faults. */
function makeRecoveryHostVault() {
	const visible = new Map<string, Uint8Array>();
	const files: TFile[] = [];
	const hidden = new Map<string, { bytes: Uint8Array; mtime: number }>();
	const directories = new Set<string>();
	const controls = { now: 1, corruptWrites: false, refuseRemove: false };
	const adapter = {
		stat: vi.fn(async (path: string) => {
			const entry = hidden.get(path);
			if (entry)
				return {
					type: "file",
					mtime: entry.mtime,
					size: entry.bytes.byteLength,
				};
			if (directories.has(path)) return { type: "folder", mtime: 1, size: 0 };
			const bytes = visible.get(path);
			return bytes ? { type: "file", mtime: 1, size: bytes.byteLength } : null;
		}),
		mkdir: vi.fn(async (path: string) => {
			directories.add(path);
		}),
		readBinary: vi.fn(async (path: string) => {
			const entry = hidden.get(path);
			if (!entry) throw new Error("Hidden file is absent");
			return entry.bytes.slice().buffer;
		}),
		writeBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
			hidden.set(path, {
				bytes: controls.corruptWrites
					? new Uint8Array([9])
					: new Uint8Array(bytes.slice(0)),
				mtime: controls.now,
			});
		}),
		list: vi.fn(async (path: string) => ({
			files: [...hidden.keys()].filter((file) => file.startsWith(`${path}/`)),
			folders: [...directories].filter((folder) =>
				folder.startsWith(`${path}/`),
			),
		})),
		remove: vi.fn(async (path: string) => {
			if (!controls.refuseRemove) hidden.delete(path);
		}),
	};
	const host = {
		getFiles: () => files,
		getAbstractFileByPath: (path: string) =>
			files.find((file) => file.path === path) ?? null,
		readBinary: vi.fn(
			async (file: TFile) =>
				visible.get(file.path)?.slice().buffer ?? new ArrayBuffer(0),
		),
		createBinary: vi.fn(async (path: string, bytes: ArrayBuffer) => {
			if (path.startsWith(".ai-bridge/"))
				throw new Error("Hidden files are not indexed");
			const file = Object.assign(new TFile(), {
				path,
				stat: { size: bytes.byteLength },
			});
			files.push(file);
			visible.set(path, new Uint8Array(bytes.slice(0)));
			return file;
		}),
		modifyBinary: vi.fn(async (file: TFile, bytes: ArrayBuffer) => {
			visible.set(file.path, new Uint8Array(bytes.slice(0)));
		}),
		createFolder: vi.fn(async () => {
			throw new Error("Hidden folders need the adapter");
		}),
		adapter,
	};
	return { host, hidden, visible, files, directories, controls, adapter };
}

/** Composes real plugin controllers over the in-memory host without starting timers. */
async function makeCoexistenceOriginHarness(
	fake: ReturnType<typeof makeHostVault>,
	epoch: string,
	bases: Array<{
		path: string;
		rev: number;
		text: string;
		bytes?: Uint8Array;
	}>,
	readPinned: (
		path: string,
		epoch: string,
		rev: number,
	) => Promise<string | null> = async () => null,
) {
	let persisted: unknown = null;
	const storage = {
		readState: async () => persisted,
		writeState: async (state: DeviceState) => {
			persisted = structuredClone(state);
		},
		readPayload: async () => new Uint8Array(),
		writePayload: async () => undefined,
	};
	const journal = await DeviceJournal.open(storage);
	await journal.resetEpoch(epoch);
	for (const base of bases)
		await journal.setBase(base.path, {
			deleted: false,
			rev: base.rev,
			hash: await recoveryHash(
				base.bytes ?? new TextEncoder().encode(base.text),
			),
		});
	const vault = new ObsidianTextVault(fake.host as unknown as Vault);
	const fence = new CoexistenceEffectFence(
		() => journal.snapshot().coexistence_confirmations.length > 0,
	);
	const coexistence = new CoexistenceController(
		journal,
		vault,
		() => true,
		() => 1_000,
		fence,
	);
	const timeouts: Array<() => void> = [];
	const observedEvents: PublicationEvent[] = [];
	const originProofs: Promise<boolean>[] = [];
	const completedObservations: PublicationEvent[] = [];
	const desktop = new DesktopSyncController({
		cycle: async () => undefined,
		onCaptureEvent: (event) => coexistence.observe(event),
		isEffectBlocked: () => fence.isBlocked(),
		onEvent: async () => undefined,
		host: {
			setTimeout: (callback) => {
				timeouts.push(callback);
				return timeouts.length;
			},
			clearTimeout: () => undefined,
			setInterval: () => 1,
			clearInterval: () => undefined,
		},
	});
	const adapter = new VaultEventAdapter(
		fake.host as unknown as Vault,
		{
			observe: async (event, proof) => {
				observedEvents.push(event);
				if (proof) {
					originProofs.push(proof);
					coexistence.registerOriginProof(event, proof);
				}
				await desktop.observe(event, proof);
				completedObservations.push(event);
			},
		},
		(error) => {
			throw error;
		},
	);
	const engine = new TextApplyEngine(
		journal,
		vault,
		{ read: readPinned },
		{ deviceName: "test", isEffectBlocked: () => fence.isBlocked() },
	);
	return {
		journal,
		vault,
		fence,
		desktop,
		adapter,
		engine,
		timeouts,
		coexistence,
		observedEvents,
		originProofs,
		completedObservations,
		reopenJournal: () => DeviceJournal.open(storage),
	};
}

/** Computes the canonical hash-addressed recovery identity from exact fixture bytes. */
async function recoveryHash(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("ObsidianTextVault", () => {
	it("keeps remote tombstone apply out of coexistence confirmations", async () => {
		const fake = makeHostVault();
		const epoch = "b".repeat(32);
		const harness = await makeCoexistenceOriginHarness(fake, epoch, [
			{ path: fake.file.path, rev: 1, text: "old" },
		]);
		const apply = {
			seq: 2,
			op: "delete" as const,
			path: fake.file.path,
			etag: `"${epoch}.2"`,
			hash: "",
			origin: "remote" as const,
			at: 2,
		};

		await harness.engine.apply(apply);
		await vi.waitFor(() => expect(harness.fence.isBlocked()).toBe(false));

		expect(harness.journal.snapshot().pending_apply).toEqual([]);
		expect(harness.journal.snapshot().base[fake.file.path]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(harness.journal.snapshot().coexistence_confirmations).toEqual([]);
		expect(harness.fence.isBlocked()).toBe(false);
		expect(fake.contents.has(fake.file.path)).toBe(false);
		harness.adapter.dispose();
		harness.desktop.close();
		harness.engine.close();
		harness.journal.close();
	});

	it("keeps a binary remote tombstone out of coexistence confirmations", async () => {
		const fake = makeHostVault();
		const path = "assets/image.png";
		const bytes = new Uint8Array([0xff, 0x00, 0x7f]);
		fake.file.path = path;
		fake.file.stat = { size: bytes.byteLength } as TFile["stat"];
		fake.contents.delete("notes/a.md");
		fake.contents.set(path, "binary fixture");
		fake.binaryContents.set(path, bytes.slice());
		const epoch = "a".repeat(32);
		const harness = await makeCoexistenceOriginHarness(fake, epoch, [
			{ path, rev: 1, text: "binary fixture", bytes },
		]);

		await harness.engine.apply(
			{
				seq: 2,
				op: "delete",
				path,
				etag: `"${epoch}.2"`,
				hash: "",
				origin: "remote",
				at: 2,
			},
			"blob",
		);
		await vi.waitFor(() => expect(harness.fence.isBlocked()).toBe(false));

		expect(harness.journal.snapshot().pending_apply).toEqual([]);
		expect(harness.journal.snapshot().base[path]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(harness.journal.snapshot().coexistence_confirmations).toEqual([]);
		expect(harness.fence.isBlocked()).toBe(false);
		harness.adapter.dispose();
		harness.desktop.close();
		harness.engine.close();
		harness.journal.close();
	});

	it("replays remote create, rename, and put without a false coexistence confirmation", async () => {
		const fake = makeHostVault();
		const source = "Sin título.md";
		const destination = "iphone-test-1.md";
		fake.contents.delete(fake.file.path);
		fake.host.getFiles().splice(0, 1);
		const epoch = "f".repeat(32);
		const content = "edited on iPhone";
		const emptyHash = await recoveryHash(new Uint8Array());
		const contentHash = await recoveryHash(new TextEncoder().encode(content));
		const harness = await makeCoexistenceOriginHarness(
			fake,
			epoch,
			[],
			async (path, _epoch, rev) => {
				if (path === source && rev === 1) return "";
				if (path === destination && rev === 1) return "";
				if (path === destination && rev === 2) return content;
				return null;
			},
		);
		await harness.journal.setCursor(epoch, 0);
		/** Signals that the rename proof started its destination-byte read. */
		let startOriginRead: () => void = () => undefined;
		/** Releases destination bytes after the host rename settles. */
		let releaseOriginRead: (text: string) => void = () => undefined;
		const originReadStarted = new Promise<void>((resolve) => {
			startOriginRead = resolve;
		});
		const originRead = new Promise<string>((resolve) => {
			releaseOriginRead = resolve;
		});
		let destinationReadHeld = false;
		const hostRead = fake.host.read;
		fake.host.read = async (file: TFile) => {
			if (!destinationReadHeld && file.path === destination) {
				destinationReadHeld = true;
				startOriginRead();
				return originRead;
			}
			return hostRead(file);
		};
		const entries = [
			{
				seq: 1,
				op: "put" as const,
				path: source,
				etag: `"${epoch}.1"`,
				hash: emptyHash,
				origin: "remote",
				at: 1,
			},
			{
				seq: 2,
				op: "rename" as const,
				from_path: source,
				path: destination,
				from_etag: `"${epoch}.2"`,
				etag: `"${epoch}.1"`,
				hash: emptyHash,
				origin: "remote",
				at: 2,
			},
			{
				seq: 3,
				op: "put" as const,
				path: destination,
				etag: `"${epoch}.2"`,
				hash: contentHash,
				origin: "remote",
				at: 3,
			},
		];
		const reconciliation = new ReconciliationController(
			harness.journal,
			harness.engine,
			harness.vault,
			{
				manifest: async () => ({
					epoch,
					head_seq: 3,
					next_page: null,
					entries: [],
				}),
				changes: async (_epoch, cursor) => ({
					epoch,
					head_seq: 3,
					entries:
						cursor === 0
							? entries.slice(0, 1)
							: cursor === 1
								? entries.slice(1, 2)
								: entries.slice(2),
				}),
				createText: async () => {
					throw new Error("Replay must not enroll local content");
				},
			},
			() => harness.fence.isBlocked(),
		);

		try {
			await reconciliation.replay();
			const renamePage = reconciliation.replay();
			await originReadStarted;
			await renamePage;
			expect(
				fake.rename,
				JSON.stringify({
					cursor: harness.journal.snapshot().cursor,
					entries: harness.observedEvents,
					paths: fake.host.getFiles().map((file) => file.path),
				}),
			).toHaveBeenCalledOnce();
			expect(harness.journal.snapshot().cursor).toBe(2);
			expect(harness.journal.snapshot().base[source]).toEqual({
				deleted: true,
				rev: 2,
			});
			expect(harness.journal.snapshot().base[destination]).toEqual({
				deleted: false,
				rev: 1,
				hash: emptyHash,
			});
			expect(harness.journal.snapshot().coexistence_confirmations).toEqual([]);
			expect(harness.fence.isBlocked()).toBe(true);
			releaseOriginRead("");
			await vi.waitFor(() =>
				expect(harness.completedObservations).toHaveLength(2),
			);
			expect(harness.journal.snapshot().coexistence_confirmations).toEqual([]);
			expect(harness.fence.isBlocked()).toBe(false);
			await reconciliation.replay();

			expect(fake.host.getAbstractFileByPath(source)).toBeNull();
			expect(fake.contents.get(destination)).toBe(content);
			expect(harness.journal.snapshot().pending_apply).toEqual([]);
			expect(harness.journal.snapshot().coexistence_confirmations).toEqual([]);
			expect(harness.journal.snapshot().cursor).toBe(3);
			expect(harness.journal.snapshot().base[destination]).toEqual({
				deleted: false,
				rev: 2,
				hash: contentHash,
			});
			expect(harness.fence.isBlocked()).toBe(false);
		} finally {
			releaseOriginRead("");
			reconciliation.close();
			harness.adapter.dispose();
			harness.desktop.close();
			harness.engine.close();
			harness.journal.close();
		}
	});

	it("keeps remote rename apply out of coexistence and advances both authorities", async () => {
		const fake = makeHostVault();
		const epoch = "c".repeat(32);
		const hash = await recoveryHash(new TextEncoder().encode("old"));
		const harness = await makeCoexistenceOriginHarness(fake, epoch, [
			{ path: fake.file.path, rev: 1, text: "old" },
		]);
		const destination = "notes/renamed.md";
		const rename = {
			seq: 2,
			op: "rename" as const,
			from_path: fake.file.path,
			path: destination,
			from_etag: `"${epoch}.2"`,
			etag: `"${epoch}.3"`,
			hash,
			origin: "remote" as const,
			at: 3,
		};

		await harness.engine.apply(rename);
		await vi.waitFor(() => expect(harness.fence.isBlocked()).toBe(false));

		expect(harness.journal.snapshot().pending_apply).toEqual([]);
		expect(harness.journal.snapshot().base["notes/a.md"]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(harness.journal.snapshot().base[destination]).toEqual({
			deleted: false,
			rev: 3,
			hash,
		});
		expect(await harness.vault.readBinary(destination)).toEqual(
			new TextEncoder().encode("old"),
		);
		expect(harness.journal.snapshot().coexistence_confirmations).toEqual([]);
		expect(harness.fence.isBlocked()).toBe(false);
		harness.adapter.dispose();
		harness.desktop.close();
		harness.engine.close();
		harness.journal.close();
	});
	it("captures genuine same-path delete and rename events before debounce", async () => {
		for (const kind of ["delete", "rename"] as const) {
			const fake = makeHostVault();
			const epoch = kind === "delete" ? "8a".repeat(16) : "7b".repeat(16);
			const harness = await makeCoexistenceOriginHarness(fake, epoch, [
				{ path: fake.file.path, rev: 4, text: "old" },
			]);
			if (kind === "delete") fake.emit("delete", fake.file);
			else
				fake.emit(
					"rename",
					Object.assign(new TFile(), { path: "notes/user-renamed.md" }),
					"notes/a.md",
				);
			await vi.waitFor(() =>
				expect(
					harness.journal.snapshot().coexistence_confirmations,
				).toHaveLength(1),
			);
			const captured = harness.journal.snapshot().coexistence_confirmations[0];
			expect(captured).toMatchObject({
				kind,
				path: "notes/a.md",
				observed_epoch: epoch,
				observed_base: {
					deleted: false,
					rev: 4,
					hash: await recoveryHash(new TextEncoder().encode("old")),
				},
				at: 1_000,
			});
			if (kind === "rename")
				expect(captured).toMatchObject({ to: "notes/user-renamed.md" });
			expect(harness.fence.isBlocked()).toBe(true);
			await expect(
				harness.engine.apply({
					seq: 5,
					op: "delete",
					path: "notes/a.md",
					etag: `"${epoch}.5"`,
					hash: "",
					origin: "remote",
					at: 5,
				}),
			).rejects.toThrow("Coexistence effect admission is blocked");
			harness.adapter.dispose();
			harness.desktop.close();
			harness.engine.close();
			harness.journal.close();
		}
	});

	describe.each(["delete", "rename"] as const)(
		"concurrent %s capture under a pending host effect",
		(kind) => {
			it.each([
				{ order: "plugin-first", identity: "same-source" },
				{ order: "plugin-first", identity: "replacement" },
				{ order: "user-first", identity: "same-source" },
				{ order: "user-first", identity: "replacement" },
			] as const)(
				"$order with $identity callbacks",
				async ({ order, identity }) => {
					const fake = makeHostVault();
					const sourcePath = fake.file.path;
					const destination = "notes/remote-name.md";
					const epoch = kind === "delete" ? "5a".repeat(16) : "6b".repeat(16);
					const hash = await recoveryHash(new TextEncoder().encode("old"));
					const base = { deleted: false as const, rev: 1, hash };
					const harness = await makeCoexistenceOriginHarness(fake, epoch, [
						{ path: sourcePath, rev: 1, text: "old" },
					]);
					const effectStarted = Promise.withResolvers<TFile>();
					const pluginDispatch = Promise.withResolvers<void>();
					const pluginDispatched = Promise.withResolvers<void>();
					const settlement = Promise.withResolvers<void>();
					const dispatchOrder: string[] = [];
					const proofResults: Array<boolean | undefined> = [];
					let applyCompleted = false;
					let effectCompleted = false;

					/** Sends an independent host callback while the wrapped host call stays pending. */
					const dispatch = (origin: "plugin" | "user", target: TFile) => {
						const eventSource =
							origin === "user" && identity === "replacement"
								? Object.assign(new TFile(), {
										path: target.path,
										stat: target.stat,
									})
								: target;
						if (identity === "same-source") {
							expect(eventSource).toBe(fake.file);
							expect(fake.host.getAbstractFileByPath(eventSource.path)).toBe(
								eventSource,
							);
						}
						dispatchOrder.push(origin);
						if (kind === "delete") fake.emit("delete", eventSource);
						else fake.emit("rename", eventSource, sourcePath);
						const index = harness.originProofs.length - 1;
						proofResults.push(undefined);
						void harness.originProofs[index].then((proved) => {
							proofResults[index] = proved;
						});
					};
					/** Holds plugin dispatch and settlement while the test sends a separate user callback. */
					const dispatchWhilePending = async (target: TFile) => {
						effectStarted.resolve(target);
						await pluginDispatch.promise;
						dispatch("plugin", target);
						pluginDispatched.resolve();
						await settlement.promise;
						effectCompleted = true;
					};
					fake.trash.mockImplementation(async (target) => {
						await dispatchWhilePending(target);
						fake.contents.delete(sourcePath);
						fake.binaryContents.delete(sourcePath);
						fake.host
							.getFiles()
							.splice(fake.host.getFiles().indexOf(target), 1);
					});
					fake.rename.mockImplementation(async (target, to) => {
						fake.contents.set(to, fake.contents.get(sourcePath) ?? "");
						fake.contents.delete(sourcePath);
						target.path = to;
						await dispatchWhilePending(target);
					});
					const change =
						kind === "delete"
							? {
									seq: 2,
									op: "delete" as const,
									path: sourcePath,
									etag: `"${epoch}.2"`,
									hash: "",
									origin: "remote" as const,
									at: 2,
								}
							: {
									seq: 2,
									op: "rename" as const,
									from_path: sourcePath,
									path: destination,
									from_etag: `"${epoch}.2"`,
									etag: `"${epoch}.3"`,
									hash,
									origin: "remote" as const,
									at: 3,
								};
					const apply = harness.engine.apply(change).then(() => {
						applyCompleted = true;
					});
					try {
						const target = await effectStarted.promise;
						if (order === "plugin-first") {
							pluginDispatch.resolve();
							await pluginDispatched.promise;
						} else dispatch("user", target);
						// Finish the first rename read before the second dispatch, not the held host effect.
						await Promise.resolve();
						expect(dispatchOrder).toEqual([
							order === "plugin-first" ? "plugin" : "user",
						]);
						expect(effectCompleted).toBe(false);
						expect(applyCompleted).toBe(false);
						expect(harness.journal.snapshot().pending_apply).toHaveLength(1);
						expect(harness.journal.snapshot().base[sourcePath]).toEqual(base);
						expect(harness.fence.isBlocked()).toBe(true);
						const firstClaimsEvidence =
							order === "plugin-first" || identity === "same-source";
						if (firstClaimsEvidence) {
							expect(proofResults).toEqual([undefined]);
							expect(harness.completedObservations).toEqual([]);
							expect(
								harness.journal.snapshot().coexistence_confirmations,
							).toEqual([]);
						}

						if (order === "plugin-first") dispatch("user", target);
						else {
							pluginDispatch.resolve();
							await pluginDispatched.promise;
						}
						await vi.waitFor(() =>
							expect(harness.completedObservations).toHaveLength(1),
						);
						expect(dispatchOrder).toEqual(
							order === "plugin-first"
								? ["plugin", "user"]
								: ["user", "plugin"],
						);
						expect(proofResults).toEqual(
							firstClaimsEvidence ? [undefined, false] : [false, undefined],
						);
						expect(effectCompleted).toBe(false);
						expect(applyCompleted).toBe(false);
						expect(harness.journal.snapshot().pending_apply).toHaveLength(1);
						expect(harness.journal.snapshot().base[sourcePath]).toEqual(base);
						expect(harness.timeouts).toEqual([]);
						const confirmations =
							harness.journal.snapshot().coexistence_confirmations;
						expect(confirmations).toHaveLength(1);
						expect(confirmations[0]).toEqual({
							id: expect.any(String),
							kind,
							path: sourcePath,
							...(kind === "rename" ? { to: destination } : {}),
							observed_epoch: epoch,
							observed_base: base,
							at: 1_000,
						});
						expect(harness.fence.isBlocked()).toBe(true);

						settlement.resolve();
						await apply;
						await vi.waitFor(() =>
							expect(harness.completedObservations).toHaveLength(2),
						);
						expect(await Promise.all(harness.originProofs)).toEqual(
							firstClaimsEvidence ? [true, false] : [false, true],
						);
						expect(effectCompleted).toBe(true);
						expect(applyCompleted).toBe(true);
						expect(harness.journal.snapshot().pending_apply).toEqual([]);
						expect(harness.journal.snapshot().base[sourcePath]).toEqual({
							deleted: true,
							rev: 2,
						});
						if (kind === "rename") {
							expect(harness.journal.snapshot().base[destination]).toEqual({
								deleted: false,
								rev: 3,
								hash,
							});
							expect(await harness.vault.readBinary(destination)).toEqual(
								new TextEncoder().encode("old"),
							);
						}
						expect(
							harness.journal.snapshot().coexistence_confirmations,
						).toEqual(confirmations);
						expect(harness.fence.isBlocked()).toBe(true);
						await harness.coexistence.keepServerState(confirmations[0].id);
						expect(
							harness.journal.snapshot().coexistence_confirmations,
						).toEqual([]);
						expect(harness.fence.isBlocked()).toBe(false);
					} finally {
						pluginDispatch.resolve();
						settlement.resolve();
						await apply;
						harness.adapter.dispose();
						harness.desktop.close();
						harness.engine.close();
						harness.journal.close();
					}
				},
			);
		},
	);

	it("preserves handled replay and restart, then captures a later same-path user delete", async () => {
		const fake = makeHostVault();
		const epoch = "d".repeat(32);
		const harness = await makeCoexistenceOriginHarness(fake, epoch, [
			{ path: fake.file.path, rev: 1, text: "old" },
		]);
		harness.desktop.pause();
		await harness.engine.apply({
			seq: 2,
			op: "delete",
			path: fake.file.path,
			etag: `"${epoch}.2"`,
			hash: "",
			origin: "remote",
			at: 2,
		});
		await vi.waitFor(() => expect(harness.fence.isBlocked()).toBe(false));
		const handledEvent = harness.observedEvents.find(
			(event) => event.type === "delete",
		);
		if (!handledEvent) throw new Error("Expected the remote delete event");
		await expect(harness.coexistence.observe(handledEvent)).resolves.toBe(true);
		expect(harness.journal.snapshot().coexistence_confirmations).toEqual([]);
		await harness.desktop.resume();
		const userFile = Object.assign(new TFile(), {
			path: "notes/a.md",
			stat: { size: new TextEncoder().encode("later user bytes").byteLength },
		});
		fake.contents.set(userFile.path, "later user bytes");
		fake.host.getFiles().push(userFile);
		fake.emit("delete", userFile);
		await vi.waitFor(() =>
			expect(harness.journal.snapshot().coexistence_confirmations).toHaveLength(
				1,
			),
		);
		expect(
			harness.journal.snapshot().coexistence_confirmations[0],
		).toMatchObject({
			kind: "delete",
			path: userFile.path,
			observed_epoch: epoch,
			observed_base: { deleted: true, rev: 2 },
		});
		expect(harness.fence.isBlocked()).toBe(true);
		harness.adapter.dispose();
		harness.desktop.close();
		harness.engine.close();
		harness.journal.close();

		const restarted = await harness.reopenJournal();
		expect(restarted.snapshot().coexistence_confirmations).toHaveLength(1);
		expect(restarted.snapshot().base["notes/a.md"]).toEqual({
			deleted: true,
			rev: 2,
		});
		restarted.close();
	});

	it("keeps same-path user bytes local when a user event arrives before plugin output", async () => {
		const fake = makeHostVault();
		const time = vi.spyOn(Date, "now").mockReturnValue(301_001);
		const intervals: number[] = [];
		const timeouts: Array<() => void> = [];
		const admitted: string[] = [];
		const lifecycle = new DesktopSyncController({
			cycle: async () => undefined,
			onEvent: async (event) => {
				admitted.push(event.path);
			},
			host: {
				setTimeout: (callback) => {
					timeouts.push(callback);
					return timeouts.length;
				},
				clearTimeout: () => undefined,
				setInterval: (_callback, delay) => {
					intervals.push(delay);
					return intervals.length;
				},
				clearInterval: () => undefined,
			},
		});
		const errors: unknown[] = [];
		const adapter = new VaultEventAdapter(
			fake.host as unknown as Vault,
			lifecycle,
			(error) => errors.push(error),
		);
		const textVault = new ObsidianTextVault(fake.host as unknown as Vault);
		/** Signals that the fake host emitted the concurrent user event. */
		let startMutation: () => void = () => undefined;
		const mutationStarted = new Promise<void>((resolve) => {
			startMutation = resolve;
		});
		/** Lets the fake plugin effect write its target bytes after the user event. */
		let releaseMutation: () => void = () => undefined;
		const holdMutation = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		const pluginBytes = new TextEncoder().encode("plugin target bytes");
		const userBytes = new TextEncoder().encode("different user bytes");
		fake.modifyBinary.mockImplementation(async (target, bytes) => {
			fake.binaryContents.set(target.path, userBytes);
			fake.contents.set(target.path, new TextDecoder().decode(userBytes));
			fake.emit("modify", target);
			startMutation();
			await holdMutation;
			const copy = new Uint8Array(bytes.slice(0));
			fake.binaryContents.set(target.path, copy);
			fake.contents.set(target.path, new TextDecoder().decode(copy));
			fake.emit("modify", target);
		});

		const mutation = textVault.modifyBinary(fake.file.path, pluginBytes);
		await mutationStarted;
		await Promise.resolve();
		expect(intervals.at(-1)).toBe(15_000);
		timeouts[0]?.();
		await lifecycle.waitForIdle();
		expect(admitted).toEqual([fake.file.path]);

		time.mockReturnValue(602_002);
		releaseMutation();
		expect(await mutation).toBe(true);
		await Promise.resolve();
		expect(intervals.at(-1)).toBe(60_000);
		timeouts.at(-1)?.();
		await lifecycle.waitForIdle();
		expect(admitted).toEqual([fake.file.path, fake.file.path]);
		expect(errors).toEqual([]);

		time.mockReturnValue(903_003);
		const pluginFirstBytes = new TextEncoder().encode("second plugin target");
		const laterUserBytes = new TextEncoder().encode("later user content");
		fake.modifyBinary.mockImplementation(async (target) => {
			fake.binaryContents.set(target.path, pluginFirstBytes);
			fake.contents.set(
				target.path,
				new TextDecoder().decode(pluginFirstBytes),
			);
			fake.emit("modify", target);
			fake.binaryContents.set(target.path, laterUserBytes);
			fake.contents.set(target.path, new TextDecoder().decode(laterUserBytes));
			fake.emit("modify", target);
		});
		expect(await textVault.modifyBinary(fake.file.path, pluginFirstBytes)).toBe(
			false,
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(intervals.at(-1)).toBe(15_000);
		timeouts.at(-1)?.();
		await lifecycle.waitForIdle();
		expect(admitted).toEqual([
			fake.file.path,
			fake.file.path,
			fake.file.path,
			fake.file.path,
		]);

		adapter.dispose();
		lifecycle.close();
		time.mockRestore();
	});

	it("keeps a user event local when a conditional process callback refuses it", async () => {
		const fake = makeHostVault();
		const intervals: number[] = [];
		const timeouts: Array<() => void> = [];
		const admitted: string[] = [];
		const lifecycle = new DesktopSyncController({
			cycle: async () => undefined,
			onEvent: async (event) => {
				admitted.push(event.path);
			},
			host: {
				setTimeout: (callback) => {
					timeouts.push(callback);
					return timeouts.length;
				},
				clearTimeout: () => undefined,
				setInterval: (_callback, delay) => {
					intervals.push(delay);
					return intervals.length;
				},
				clearInterval: () => undefined,
			},
		});
		const adapter = new VaultEventAdapter(
			fake.host as unknown as Vault,
			lifecycle,
			() => undefined,
		);
		const textVault = new ObsidianTextVault(fake.host as unknown as Vault);
		fake.process.mockImplementation(async (_file, callback) => {
			fake.contents.set(fake.file.path, "next");
			fake.emit("modify", fake.file);
			const current = fake.contents.get(fake.file.path) ?? "";
			const returned = callback(current);
			if (returned !== current) {
				fake.contents.set(fake.file.path, returned);
				fake.emit("modify", fake.file);
			}
			return returned;
		});

		expect(await textVault.process(fake.file.path, "old", "next")).toBe(false);
		await vi.waitFor(() => expect(intervals.at(-1)).toBe(15_000));
		timeouts.at(-1)?.();
		await lifecycle.waitForIdle();
		expect(admitted).toEqual([fake.file.path]);

		adapter.dispose();
		lifecycle.close();
	});

	it("keeps delayed origin reads local after the mutation settles", async () => {
		const fake = makeHostVault();
		const intervals: number[] = [];
		const timeouts: Array<() => void> = [];
		const lifecycle = new DesktopSyncController({
			cycle: async () => undefined,
			host: {
				setTimeout: (callback) => {
					timeouts.push(callback);
					return timeouts.length;
				},
				clearTimeout: () => undefined,
				setInterval: (_callback, delay) => {
					intervals.push(delay);
					return intervals.length;
				},
				clearInterval: () => undefined,
			},
		});
		const adapter = new VaultEventAdapter(
			fake.host as unknown as Vault,
			lifecycle,
			() => undefined,
		);
		const textVault = new ObsidianTextVault(fake.host as unknown as Vault);
		/** Releases the origin read after the later plugin write. */
		let releaseDelayedRead: (bytes: ArrayBuffer) => void = () => undefined;
		const delayedUserRead = new Promise<ArrayBuffer>((resolve) => {
			releaseDelayedRead = resolve;
		});
		let firstRead = true;
		fake.readBinary.mockImplementation(async (target) => {
			if (firstRead) {
				firstRead = false;
				return delayedUserRead;
			}
			const bytes = fake.binaryContents.get(target.path);
			return (bytes?.slice() ?? new Uint8Array()).buffer as ArrayBuffer;
		});
		const pluginBytes = new TextEncoder().encode("later plugin bytes");
		const userBytes = new TextEncoder().encode("event-time user bytes");
		fake.modifyBinary.mockImplementation(async (target, bytes) => {
			fake.binaryContents.set(target.path, userBytes);
			fake.contents.set(target.path, new TextDecoder().decode(userBytes));
			fake.emit("modify", target);
			const copy = new Uint8Array(bytes.slice(0));
			fake.binaryContents.set(target.path, copy);
			fake.contents.set(target.path, new TextDecoder().decode(copy));
		});

		expect(await textVault.modifyBinary(fake.file.path, pluginBytes)).toBe(
			true,
		);
		const bytesAfterWrite = fake.binaryContents.get(fake.file.path);
		if (!bytesAfterWrite) throw new Error("Expected written plugin bytes");
		releaseDelayedRead(bytesAfterWrite.slice().buffer as ArrayBuffer);
		await vi.waitFor(() => expect(intervals.at(-1)).toBe(15_000));
		timeouts.at(-1)?.();
		await lifecycle.waitForIdle();

		adapter.dispose();
		lifecycle.close();
	});

	it("labels visible text mutations at the shared vault event boundary", async () => {
		const fake = makeHostVault();
		const origins: boolean[] = [];
		const adapter = new VaultEventAdapter(
			fake.host as unknown as Vault,
			{
				observe: async (_event, originProof) => {
					origins.push((await originProof) ?? false);
				},
			},
			() => undefined,
		);
		const vault = new ObsidianTextVault(fake.host as unknown as Vault);

		expect(await vault.create("notes/new.md", "plugin text")).toBe(true);
		expect(await vault.create("notes/a.md", "ignored")).toBe(false);
		fake.emit("create", Object.assign(new TFile(), { path: "notes/a.md" }));
		await Promise.resolve();

		expect(origins).toEqual([true, false]);
		adapter.dispose();
	});

	it("finds both iCloud placeholder names from metadata without reading bytes", async () => {
		const fake = makeRecoveryHostVault();
		const vault = new ObsidianTextVault(fake.host as unknown as Vault);
		fake.hidden.set("notes/a.md.icloud", {
			bytes: new Uint8Array(),
			mtime: 1,
		});
		expect(await vault.isUnavailable?.("notes/a.md")).toBe(true);
		fake.hidden.delete("notes/a.md.icloud");
		fake.hidden.set("notes/.a.md.icloud", {
			bytes: new Uint8Array(),
			mtime: 1,
		});
		expect(await vault.isUnavailable?.("notes/a.md")).toBe(true);
		expect(fake.adapter.readBinary).not.toHaveBeenCalled();
	});

	it("stores and refreshes hidden recovery without indexed Vault files", async () => {
		const fake = makeRecoveryHostVault();
		const vault = new ObsidianTextVault(fake.host as unknown as Vault);
		const bytes = new Uint8Array([0xff, 0x28, 0]);
		const hash = await recoveryHash(bytes);
		const path = `.ai-bridge/pre-apply/${hash}`;
		expect(await vault.createBinary(path, bytes)).toBe(true);
		expect(fake.host.getAbstractFileByPath(path)).toBeNull();
		expect(fake.host.getFiles()).toEqual([]);
		expect(await vault.readBinary(path)).toEqual(bytes);
		expect(await vault.stat(path)).toEqual({
			mtime: 1,
			size: bytes.byteLength,
		});
		expect(await vault.list()).toEqual([path]);
		expect(fake.adapter.mkdir.mock.calls).toEqual([
			[".ai-bridge"],
			[".ai-bridge/pre-apply"],
		]);
		expect(await vault.createBinary(path, bytes)).toBe(true);
		expect(fake.adapter.writeBinary).toHaveBeenCalledTimes(1);
		fake.controls.now = 100;
		expect(await vault.modifyBinary(path, bytes)).toBe(true);
		expect((await vault.stat(path))?.mtime).toBe(100);
		expect(fake.host.createBinary).not.toHaveBeenCalled();
		expect(fake.host.modifyBinary).not.toHaveBeenCalled();
		expect(fake.host.readBinary).not.toHaveBeenCalled();
		expect(fake.host.createFolder).not.toHaveBeenCalled();
	});

	it("refuses corrupt hidden recovery bytes without replacing them", async () => {
		const fake = makeRecoveryHostVault();
		const vault = new ObsidianTextVault(fake.host as unknown as Vault);
		const expected = new Uint8Array([1, 2]);
		const different = new Uint8Array([3, 4]);
		const hash = await recoveryHash(expected);
		const path = `.ai-bridge/pre-apply/${hash}`;
		fake.hidden.set(path, { bytes: different, mtime: 1 });
		expect(await vault.createBinary(path, expected)).toBe(false);
		expect(await vault.modifyBinary(path, expected)).toBe(false);
		expect(await vault.removeRecoveryCopy(path, hash)).toBe(false);
		expect(await vault.readBinary(path)).toEqual(different);
		expect(fake.adapter.writeBinary).not.toHaveBeenCalled();
		expect(fake.adapter.remove).not.toHaveBeenCalled();
	});

	it("refuses invalid recovery paths and verifies hidden writes and removals", async () => {
		const fake = makeRecoveryHostVault();
		const vault = new ObsidianTextVault(fake.host as unknown as Vault);
		const bytes = new Uint8Array([1, 2]);
		const hash = await recoveryHash(bytes);
		for (const path of [
			".ai-bridge/pre-apply/../other",
			".ai-bridge/pre-apply/not-a-hash",
			`.ai-bridge/pre-apply/${"f".repeat(64)}`,
		]) {
			expect(await vault.createBinary(path, bytes)).toBe(false);
			expect(await vault.modifyBinary(path, bytes)).toBe(false);
		}
		expect(fake.adapter.writeBinary).not.toHaveBeenCalled();
		const path = `.ai-bridge/pre-apply/${hash}`;
		fake.controls.corruptWrites = true;
		expect(await vault.createBinary(path, bytes)).toBe(false);
		expect(fake.hidden.get(path)?.bytes).toEqual(new Uint8Array([9]));
		fake.hidden.set(path, { bytes, mtime: 1 });
		fake.controls.refuseRemove = true;
		expect(await vault.removeRecoveryCopy(path, hash)).toBe(false);
		fake.controls.refuseRemove = false;
		expect(await vault.removeRecoveryCopy(path, hash)).toBe(true);
		expect(await vault.readBinary(path)).toBeNull();
	});

	it("discovers hidden recovery for guarded apply and seven-day engine cleanup", async () => {
		const fake = makeRecoveryHostVault();
		const vault = new ObsidianTextVault(fake.host as unknown as Vault);
		const path = "clean.png";
		const local = new Uint8Array([0xff, 0x28, 0]);
		const remote = new Uint8Array([0xfe, 0x28, 1]);
		const localHash = await recoveryHash(local);
		const remoteHash = await recoveryHash(remote);
		const recoveryPath = `.ai-bridge/pre-apply/${localHash}`;
		await fake.host.createBinary(path, local.slice().buffer);
		let state: unknown = null;
		const journal = await DeviceJournal.open({
			readState: async () => state,
			writeState: async (next: DeviceState) => {
				state = structuredClone(next);
			},
			readPayload: async () => {
				throw new Error("unused");
			},
			writePayload: async () => {
				throw new Error("unused");
			},
		});
		const epoch = "b".repeat(32);
		await journal.setBase(path, { deleted: false, rev: 1, hash: localHash });
		const engine = new TextApplyEngine(
			journal,
			vault,
			{
				read: async () => null,
				readBlob: async () => ({
					bytes: remote,
					hash: remoteHash,
					epoch,
					rev: 2,
				}),
			},
			{ deviceName: "test", now: () => fake.controls.now },
		);
		const row = {
			seq: 2,
			op: "put" as const,
			path,
			etag: `"${epoch}.2"`,
			hash: remoteHash,
			origin: "remote",
			at: 2,
		};
		await engine.apply(row, "blob");
		expect(fake.visible.get(path)).toEqual(remote);
		expect(fake.hidden.get(recoveryPath)?.bytes).toEqual(local);
		expect(fake.host.getFiles().map((file) => file.path)).toEqual([path]);
		expect(journal.snapshot().attention).toEqual([]);
		fake.controls.now += 6 * 24 * 60 * 60 * 1000;
		await engine.resume();
		expect(fake.hidden.has(recoveryPath)).toBe(true);
		fake.controls.now += 2 * 24 * 60 * 60 * 1000;
		fake.hidden.set(".ai-bridge/pre-apply/not-a-hash", {
			bytes: local,
			mtime: 1,
		});
		await engine.resume();
		expect(fake.hidden.has(recoveryPath)).toBe(false);
		expect(fake.hidden.has(".ai-bridge/pre-apply/not-a-hash")).toBe(true);
		expect(fake.visible.get(path)).toEqual(remote);
		expect(fake.adapter.remove).toHaveBeenCalledWith(recoveryPath);
		engine.close();
		journal.close();
	});
	it("uses process for exact text and local trash for deletes", async () => {
		const fake = makeHostVault();
		const vault = new ObsidianTextVault(fake.host as unknown as Vault);
		expect(await vault.process("notes/a.md", "old", "new")).toBe(true);
		expect(fake.process).toHaveBeenCalledOnce();
		expect(fake.contents.get("notes/a.md")).toBe("new");
		expect(await vault.trash("notes/a.md", "new")).toBe(true);
		expect(fake.trash).toHaveBeenCalledWith(fake.file, false);
	});

	it("preserves raw bytes through binary reads, creates, and writes", async () => {
		const file = Object.assign(new TFile(), { path: "notes/image.png" });
		let bytes = new Uint8Array([0, 255, 128]);
		const vault = {
			getFiles: () => [file],
			getAbstractFileByPath: (path: string) =>
				path === file.path ? file : null,
			readBinary: async () => bytes.slice().buffer,
			modifyBinary: async (_target: TFile, next: ArrayBuffer) => {
				bytes = new Uint8Array(next.slice(0));
			},
			createBinary: async (_path: string, next: ArrayBuffer) => {
				bytes = new Uint8Array(next.slice(0));
				return file;
			},
			adapter: { stat: async () => ({ type: "file", mtime: 10, size: 3 }) },
			createFolder: async () => undefined,
		};
		const adapter = new ObsidianTextVault(vault as unknown as Vault);
		expect(await adapter.readBinary(file.path)).toEqual(
			new Uint8Array([0, 255, 128]),
		);
		expect(await adapter.stat(file.path)).toEqual({ mtime: 10, size: 3 });
		expect(
			await adapter.modifyBinary(file.path, new Uint8Array([255, 0])),
		).toBe(true);
		expect(bytes).toEqual(new Uint8Array([255, 0]));
	});

	it("removes only bytes that match a hash-addressed recovery path", async () => {
		const bytes = new Uint8Array([0, 255, 128]);
		const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
		const hash = [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		const path = `.ai-bridge/pre-apply/${hash}`;
		const fake = makeRecoveryHostVault();
		fake.hidden.set(path, { bytes: bytes.slice(), mtime: 1 });
		const remove = fake.adapter.remove;
		const adapter = new ObsidianTextVault(fake.host as unknown as Vault);

		expect(await adapter.removeRecoveryCopy("notes/user.txt", hash)).toBe(
			false,
		);
		expect(await adapter.removeRecoveryCopy(path, "f".repeat(64))).toBe(false);
		expect(remove).not.toHaveBeenCalled();
		expect(await adapter.removeRecoveryCopy(path, hash)).toBe(true);
		expect(remove).toHaveBeenCalledWith(path);
	});

	it("renames binary files by exact bytes without decoding", async () => {
		const source = Object.assign(new TFile(), { path: "assets/source.png" });
		const bytes = new Uint8Array([0, 255, 128]);
		const files = [source];
		const rename = vi.fn(async (file: TFile, path: string) => {
			file.path = path;
		});
		const host = {
			getFiles: () => files,
			getAbstractFileByPath: (path: string) =>
				files.find((candidate) => candidate.path === path) ?? null,
			readBinary: async () => bytes.slice().buffer,
			rename,
			createFolder: async () => undefined,
		};
		const adapter = new ObsidianTextVault(host as unknown as Vault);

		expect(
			await adapter.renameBinary(source.path, "assets/renamed.png", bytes),
		).toBe(true);
		expect(source.path).toBe("assets/renamed.png");
		expect(rename).toHaveBeenCalledOnce();
	});

	it("creates and renames text without link rewriting", async () => {
		const fake = makeHostVault();
		const vault = new ObsidianTextVault(fake.host as unknown as Vault);
		expect(await vault.create("notes/b.md", "new note")).toBe(true);
		expect(fake.create).toHaveBeenCalledWith("notes/b.md", "new note");
		expect(await vault.rename("notes/a.md", "notes/c.md", "old")).toBe(true);
		expect(fake.rename).toHaveBeenCalledWith(fake.file, "notes/c.md");
	});
});
