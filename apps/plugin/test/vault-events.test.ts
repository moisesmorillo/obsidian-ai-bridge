import type {
	DevicePrecondition,
	PendingOperation,
} from "@obsidian-ai-bridge/protocol";
import { type EventRef, TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
	VaultEventAdapter,
	withPluginVaultMutation,
} from "../src/infrastructure/vault-events";
import { DesktopSyncController } from "../src/sync/desktop-sync";
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
	/** Returns exact UTF-8 bytes for the current text fixture. */
	async readBinary(path: string): Promise<Uint8Array | null> {
		const text = this.files.get(path);
		return text === undefined ? null : new TextEncoder().encode(text);
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
	it("proves an accepted plugin delete for its exact host dispatch", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const vault = {
			/** Registers one callback for the in-memory host dispatch. */
			on(event: string, callback: (...args: unknown[]) => void) {
				handlers.set(event, callback);
				return { event } as EventRef;
			},
			offref: () => undefined,
		} as unknown as Vault;
		const proofs: Promise<boolean>[] = [];
		const adapter = new VaultEventAdapter(
			vault,
			{
				observe: async (_event, originProof) => {
					proofs.push(originProof ?? Promise.resolve(false));
				},
			},
			() => undefined,
		);
		const source = Object.assign(new TFile(), { path: "deleted.md" });
		const concurrentUserFile = Object.assign(new TFile(), {
			path: "deleted.md",
		});
		await withPluginVaultMutation(
			vault,
			{ type: "delete", path: "deleted.md" },
			async () => {
				handlers.get("delete")?.(concurrentUserFile);
				handlers.get("delete")?.(source);
			},
			undefined,
			() => true,
			source,
		);

		handlers.get("delete")?.(concurrentUserFile);
		await vi.waitFor(() => expect(proofs).toHaveLength(3));
		expect(await Promise.all(proofs)).toEqual([false, true, false]);
		adapter.dispose();
	});
	it("rejects refused, failed, and overlapping destructive effects", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const vault = {
			/** Registers one fake host callback for effect-proof tests. */
			on(event: string, callback: (...args: unknown[]) => void) {
				handlers.set(event, callback);
				return { event } as EventRef;
			},
			offref: () => undefined,
			read: async () => "target bytes",
		} as unknown as Vault;
		const proofs: Promise<boolean>[] = [];
		const adapter = new VaultEventAdapter(
			vault,
			{
				observe: async (_event, proof) => {
					proofs.push(proof ?? Promise.resolve(false));
				},
			},
			() => undefined,
		);
		const refused = Object.assign(new TFile(), { path: "refused.md" });
		await withPluginVaultMutation(
			vault,
			{ type: "delete", path: refused.path },
			async () => handlers.get("delete")?.(refused),
			undefined,
			() => false,
			refused,
		);
		const failed = Object.assign(new TFile(), { path: "failed.md" });
		await expect(
			withPluginVaultMutation(
				vault,
				{ type: "delete", path: failed.path },
				async () => {
					handlers.get("delete")?.(failed);
					throw new Error("trash failed");
				},
				undefined,
				() => true,
				failed,
			),
		).rejects.toThrow("trash failed");
		const failedRename = Object.assign(new TFile(), {
			path: "failed-rename.md",
		});
		await expect(
			withPluginVaultMutation(
				vault,
				{
					type: "rename",
					path: "old-name.md",
					to: failedRename.path,
				},
				async () => {
					handlers.get("rename")?.(failedRename, "old-name.md");
					throw new Error("rename failed");
				},
				{ kind: "text", value: "target bytes" },
				() => true,
				failedRename,
			),
		).rejects.toThrow("rename failed");

		const overlapping = Object.assign(new TFile(), {
			path: "overlapping.md",
		});
		/** Settles the first effect after the overlapping marker is recorded. */
		let releaseFirst: () => void = () => undefined;
		const firstEffect = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = withPluginVaultMutation(
			vault,
			{ type: "delete", path: overlapping.path },
			async () => {
				handlers.get("delete")?.(overlapping);
				await firstEffect;
			},
			undefined,
			() => true,
			overlapping,
		);
		await vi.waitFor(() => expect(proofs).toHaveLength(4));
		const second = withPluginVaultMutation(
			vault,
			{ type: "delete", path: overlapping.path },
			async () => undefined,
			undefined,
			() => true,
			overlapping,
		);
		releaseFirst();
		await Promise.all([first, second]);
		expect(await Promise.all(proofs)).toEqual([false, false, false, false]);
		adapter.dispose();
	});

	it("shares plugin origin across adapters for one host vault", async () => {
		const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
		const vault = {
			/** Adds an event listener to the shared in-memory host vault. */
			on(event: string, callback: (...args: unknown[]) => void) {
				const listeners = handlers.get(event) ?? new Set();
				listeners.add(callback);
				handlers.set(event, listeners);
				return { event, callback } as EventRef;
			},
			/** Removes one callback registered by the production adapter. */
			offref(reference: EventRef) {
				const listener = reference as unknown as {
					event: string;
					callback: (...args: unknown[]) => void;
				};
				handlers.get(listener.event)?.delete(listener.callback);
			},
			read: async () => "plugin target",
		} as unknown as Vault;
		const firstOrigins: boolean[] = [];
		const secondOrigins: boolean[] = [];
		const first = new VaultEventAdapter(
			vault,
			{
				observe: async (_event, originProof) => {
					firstOrigins.push((await originProof) ?? false);
				},
			},
			() => undefined,
		);
		const second = new VaultEventAdapter(
			vault,
			{
				observe: async (_event, originProof) => {
					secondOrigins.push((await originProof) ?? false);
				},
			},
			() => undefined,
		);

		const file = Object.assign(new TFile(), { path: "shared.md" });
		/** Sends one host event to every listener before the next dispatch. */
		const dispatch = () => {
			for (const callback of handlers.get("modify") ?? []) callback(file);
		};
		await withPluginVaultMutation(
			vault,
			{ type: "modify", path: "shared.md" },
			async () => dispatch(),
			{ kind: "text", value: "plugin target" },
		);
		await vi.waitFor(() => expect(firstOrigins).toHaveLength(1));
		dispatch();
		await vi.waitFor(() => expect(firstOrigins).toHaveLength(2));

		expect(firstOrigins).toEqual([true, false]);
		expect(secondOrigins).toEqual([true, false]);
		first.dispose();
		second.dispose();
	});

	it("proves rename only for the original host object and exact destination bytes", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const vault = {
			/** Registers the callback used by this fake host dispatch. */
			on(event: string, callback: (...args: unknown[]) => void) {
				handlers.set(event, callback);
				return { event } as EventRef;
			},
			offref: () => undefined,
			read: async () => "renamed bytes",
		} as unknown as Vault;
		const proofs: Promise<boolean>[] = [];
		const adapter = new VaultEventAdapter(
			vault,
			{
				observe: async (_event, originProof) => {
					proofs.push(originProof ?? Promise.resolve(false));
				},
			},
			() => undefined,
		);
		const source = Object.assign(new TFile(), { path: "new.md" });
		const concurrentUserFile = Object.assign(new TFile(), {
			path: "new.md",
		});
		await withPluginVaultMutation(
			vault,
			{ type: "rename", path: "old.md", to: "new.md" },
			async () => {
				handlers.get("rename")?.(concurrentUserFile, "old.md");
				handlers.get("rename")?.(source, "old.md");
			},
			{ kind: "text", value: "renamed bytes" },
			() => true,
			source,
		);

		handlers.get("rename")?.(concurrentUserFile, "old.md");
		await vi.waitFor(() => expect(proofs).toHaveLength(3));
		expect(await Promise.all(proofs)).toEqual([false, true, false]);
		adapter.dispose();
	});

	it("rejects mismatched and late destructive destination reads", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		/** Completes destination bytes only after the rename effect settles. */
		let releaseLateRead: (text: string) => void = () => undefined;
		const lateRead = new Promise<string>((resolve) => {
			releaseLateRead = resolve;
		});
		const vault = {
			/** Registers one host callback for rename evidence. */
			on(event: string, callback: (...args: unknown[]) => void) {
				handlers.set(event, callback);
				return { event } as EventRef;
			},
			offref: () => undefined,
			read: async (source: TFile) =>
				source.path === "late.md" ? lateRead : "mismatched bytes",
		} as unknown as Vault;
		const proofs: Promise<boolean>[] = [];
		const adapter = new VaultEventAdapter(
			vault,
			{
				observe: async (_event, proof) => {
					proofs.push(proof ?? Promise.resolve(false));
				},
			},
			() => undefined,
		);
		const mismatched = Object.assign(new TFile(), { path: "wrong.md" });
		await withPluginVaultMutation(
			vault,
			{ type: "rename", path: "old.md", to: mismatched.path },
			async () => handlers.get("rename")?.(mismatched, "old.md"),
			{ kind: "text", value: "expected bytes" },
			() => true,
			mismatched,
		);
		const late = Object.assign(new TFile(), { path: "late.md" });
		await withPluginVaultMutation(
			vault,
			{ type: "rename", path: "late-source.md", to: late.path },
			async () => handlers.get("rename")?.(late, "late-source.md"),
			{ kind: "text", value: "late bytes" },
			() => true,
			late,
		);
		releaseLateRead("late bytes");
		await vi.waitFor(() => expect(proofs).toHaveLength(2));
		expect(await Promise.all(proofs)).toEqual([false, false]);
		adapter.dispose();
	});

	it("keeps a read that finishes after mutation settlement local", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		/** Releases the read after the mutation marker retires. */
		let releaseRead: (text: string) => void = () => undefined;
		const delayedRead = new Promise<string>((resolve) => {
			releaseRead = resolve;
		});
		const vault = {
			/** Captures one listener for delayed-read regression delivery. */
			on(event: string, callback: (...args: unknown[]) => void) {
				handlers.set(event, callback);
				return { event } as EventRef;
			},
			offref: () => undefined,
			read: async () => delayedRead,
		} as unknown as Vault;
		let originProof: Promise<boolean> | undefined;
		const adapter = new VaultEventAdapter(
			vault,
			{
				observe: async (_event, proof) => {
					originProof = proof;
				},
			},
			() => undefined,
		);
		const file = Object.assign(new TFile(), { path: "late.md" });
		await withPluginVaultMutation(
			vault,
			{ type: "modify", path: "late.md" },
			async () => handlers.get("modify")?.(file),
			{ kind: "text", value: "later plugin bytes" },
		);
		if (!originProof) throw new Error("Expected an origin proof");

		releaseRead("later plugin bytes");
		expect(await originProof).toBe(false);
		adapter.dispose();
	});

	it("proves only exact targeted bytes and retires missing or failed effects", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const vault = {
			/** Captures one event callback for deterministic event delivery. */
			on(event: string, callback: (...args: unknown[]) => void) {
				handlers.set(event, callback);
				return { event } as EventRef;
			},
			offref: () => undefined,
			read: async () => "plugin bytes",
		} as unknown as Vault;
		const proofs: Promise<boolean>[] = [];
		const observed = vi.fn((_event: unknown, proof?: Promise<boolean>) => {
			proofs.push(proof ?? Promise.resolve(false));
			return Promise.resolve();
		});
		const adapter = new VaultEventAdapter(
			vault,
			{ observe: observed },
			() => undefined,
		);
		const file = Object.assign(new TFile(), { path: "note.md" });

		handlers.get("modify")?.(file);
		await withPluginVaultMutation(
			vault,
			{ type: "modify", path: "note.md" },
			async () => {
				handlers.get("create")?.(file);
				handlers.get("modify")?.(file);
			},
			{ kind: "text", value: "plugin bytes" },
		);
		handlers.get("modify")?.(file);
		await withPluginVaultMutation(
			vault,
			{ type: "modify", path: "no-op.md" },
			async () => undefined,
		);
		handlers.get("modify")?.(Object.assign(new TFile(), { path: "no-op.md" }));
		await expect(
			withPluginVaultMutation(
				vault,
				{ type: "modify", path: "failed.md" },
				async () => {
					throw new Error("failed effect");
				},
			),
		).rejects.toThrow("failed effect");
		handlers.get("modify")?.(Object.assign(new TFile(), { path: "failed.md" }));
		await Promise.all(observed.mock.results.map((result) => result.value));

		expect(await Promise.all(proofs)).toEqual([
			false,
			false,
			true,
			false,
			false,
			false,
		]);
		adapter.dispose();
	});

	it("routes live modify events into publication and removes listeners on disposal", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const removed: EventRef[] = [];
		const textVault = new MemoryVault();
		const eventFiles = new Map<string, TFile>();
		/** Reuses the host file identity for each exact test path. */
		const eventFileForPath = (path: string): TFile => {
			const file = eventFiles.get(path);
			if (file) return file;
			const created = Object.assign(new TFile(), { path });
			eventFiles.set(path, created);
			return created;
		};
		/** Sends one host event through the real adapter callback. */
		const emit = (type: string, path: string) =>
			handlers.get(type)?.(eventFileForPath(path));
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
			read: async (file: TFile) => textVault.files.get(file.path) ?? null,
		} as unknown as Vault;
		const journal = await DeviceJournal.open(new MemoryStorage());
		await journal.resetEpoch(epoch);
		const publication = new PublicationController(
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
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const intervals: number[] = [];
		const timeouts: Array<() => void> = [];
		const lifecycle = new DesktopSyncController({
			cycle: async () => undefined,
			onEvent: (event) => publication.observe(event),
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
		const echoText = "edited from event";
		textVault.files.set("note.md", echoText);
		const echoBytes = new TextEncoder().encode(echoText);
		const echoDigest = await crypto.subtle.digest("SHA-256", echoBytes);
		const echoHash = [...new Uint8Array(echoDigest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		await journal.setExpectedWrite("note.md", echoHash);
		const errors: unknown[] = [];
		const adapter = new VaultEventAdapter(vault, lifecycle, (error) =>
			errors.push(error),
		);

		await withPluginVaultMutation(
			vault,
			{ type: "modify", path: "note.md" },
			async () => emit("modify", "note.md"),
			{ kind: "text", value: "edited from event" },
		);
		await vi.waitFor(() => expect(intervals.at(-1)).toBe(60_000));
		timeouts[0]?.();
		await lifecycle.waitForIdle();
		expect(journal.snapshot().expected_writes).toEqual({});
		expect(journal.snapshot().pending_ops).toHaveLength(0);

		textVault.files.set("note.md", "edited by user");
		emit("modify", "note.md");
		await Promise.resolve();
		await Promise.resolve();
		expect(intervals.at(-1)).toBe(15_000);
		timeouts[1]?.();
		await lifecycle.waitForIdle();

		expect([...handlers.keys()]).toContain("modify");
		expect(errors).toEqual([]);
		expect(journal.snapshot().pending_ops).toHaveLength(1);

		const concurrentPath = "notes/concurrent.md";
		clock.mockReturnValue(301_001);
		textVault.files.set(concurrentPath, "plugin content");
		await withPluginVaultMutation(
			vault,
			{ type: "modify", path: concurrentPath },
			async () => {
				textVault.files.set(concurrentPath, "concurrent user content");
				emit("modify", concurrentPath);
				textVault.files.set(concurrentPath, "plugin content");
				emit("modify", concurrentPath);
			},
			{ kind: "text", value: "plugin content" },
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(intervals.at(-1)).toBe(15_000);
		timeouts.at(-1)?.();
		await lifecycle.waitForIdle();
		expect(
			journal
				.snapshot()
				.pending_ops.filter(
					(operation: PendingOperation) => operation.path === concurrentPath,
				),
		).toHaveLength(1);

		clock.mockReturnValue(602_000);
		const conflictPath = "notes/conflict Test Device.md";
		textVault.files.set(conflictPath, "conflict copy bytes");
		await withPluginVaultMutation(
			vault,
			{ type: "create", path: conflictPath },
			async () => {
				emit("create", conflictPath);
				await Promise.resolve();
			},
			{ kind: "text", value: "conflict copy bytes" },
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(intervals.at(-1)).toBe(60_000);
		timeouts.at(-1)?.();
		await lifecycle.waitForIdle();
		expect(journal.snapshot().pending_ops).toHaveLength(3);

		const restorePath = "notes/restored.md";
		const restoreText = "restored bytes";
		textVault.files.set(restorePath, restoreText);
		const restoreDigest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(restoreText),
		);
		const restoreHash = [...new Uint8Array(restoreDigest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		await journal.setExpectedWrite(restorePath, restoreHash);
		await withPluginVaultMutation(
			vault,
			{ type: "create", path: restorePath },
			async () => {
				emit("create", restorePath);
				await Promise.resolve();
			},
			{ kind: "text", value: restoreText },
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(intervals.at(-1)).toBe(60_000);
		timeouts.at(-1)?.();
		await lifecycle.waitForIdle();
		expect(journal.snapshot().expected_writes).toEqual({});
		expect(journal.snapshot().pending_ops).toHaveLength(3);

		adapter.dispose();
		expect(removed).toHaveLength(4);
		lifecycle.close();
		publication.close();
		clock.mockRestore();
	});
});
