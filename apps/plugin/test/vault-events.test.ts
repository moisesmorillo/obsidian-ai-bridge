import type { DevicePrecondition } from "@obsidian-ai-bridge/protocol";
import type { EventRef, Vault } from "obsidian";
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
		} as unknown as Vault;
		const firstOrigins: Array<string | undefined> = [];
		const secondOrigins: Array<string | undefined> = [];
		const first = new VaultEventAdapter(
			vault,
			{ observe: async (_event, origin) => void firstOrigins.push(origin) },
			() => undefined,
		);
		const second = new VaultEventAdapter(
			vault,
			{ observe: async (_event, origin) => void secondOrigins.push(origin) },
			() => undefined,
		);

		await withPluginVaultMutation(
			vault,
			{ type: "modify", path: "shared.md" },
			async () => {
				for (const callback of handlers.get("modify") ?? [])
					callback({ path: "shared.md" });
			},
		);
		await Promise.resolve();

		expect(firstOrigins).toEqual(["plugin"]);
		expect(secondOrigins).toEqual(["plugin"]);
		first.dispose();
		second.dispose();
	});

	it("labels only matching plugin events and keeps direct events local", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const vault = {
			/** Captures one event callback for deterministic event delivery. */
			on(event: string, callback: (...args: unknown[]) => void) {
				handlers.set(event, callback);
				return { event } as EventRef;
			},
			offref: () => undefined,
		} as unknown as Vault;
		const observed = vi.fn(
			async (_event: unknown, _origin?: "local" | "plugin") => undefined,
		);
		const adapter = new VaultEventAdapter(
			vault,
			{ observe: observed },
			() => undefined,
		);

		handlers.get("modify")?.({ path: "note.md" });
		await withPluginVaultMutation(
			vault,
			{ type: "modify", path: "note.md" },
			async () => {
				handlers.get("create")?.({ path: "note.md" });
				handlers.get("modify")?.({ path: "note.md" });
				handlers.get("modify")?.({ path: "note.md" });
			},
		);
		await withPluginVaultMutation(
			vault,
			{ type: "modify", path: "no-op.md" },
			async () => undefined,
		);
		handlers.get("modify")?.({ path: "no-op.md" });
		await expect(
			withPluginVaultMutation(
				vault,
				{ type: "modify", path: "failed.md" },
				async () => {
					throw new Error("failed effect");
				},
			),
		).rejects.toThrow("failed effect");
		handlers.get("modify")?.({ path: "failed.md" });
		await Promise.resolve();

		expect(observed.mock.calls.map((call) => call[1])).toEqual([
			undefined,
			undefined,
			"plugin",
			"plugin",
			undefined,
			undefined,
		]);
		adapter.dispose();
	});

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
		const echoBytes = new TextEncoder().encode("edited from event");
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
			async () => handlers.get("modify")?.({ path: "note.md" }),
		);
		expect(intervals.at(-1)).toBe(60_000);
		timeouts[0]?.();
		await lifecycle.waitForIdle();
		expect(journal.snapshot().expected_writes).toEqual({});
		expect(journal.snapshot().pending_ops).toHaveLength(0);

		textVault.files.set("note.md", "edited by user");
		handlers.get("modify")?.({ path: "note.md" });
		await Promise.resolve();
		expect(intervals.at(-1)).toBe(15_000);
		timeouts[1]?.();
		await lifecycle.waitForIdle();

		expect([...handlers.keys()]).toContain("modify");
		expect(errors).toEqual([]);
		expect(journal.snapshot().pending_ops).toHaveLength(1);

		const concurrentPath = "notes/concurrent.md";
		textVault.files.set(concurrentPath, "plugin content");
		await withPluginVaultMutation(
			vault,
			{ type: "modify", path: concurrentPath },
			async () => {
				handlers.get("modify")?.({ path: concurrentPath });
				textVault.files.set(concurrentPath, "concurrent user content");
				handlers.get("modify")?.({ path: concurrentPath });
			},
		);
		await Promise.resolve();
		expect(intervals.at(-1)).toBe(15_000);
		timeouts.at(-1)?.();
		await lifecycle.waitForIdle();
		expect(
			journal
				.snapshot()
				.pending_ops.filter((operation) => operation.path === concurrentPath),
		).toHaveLength(1);

		clock.mockReturnValue(301_001);
		const conflictPath = "notes/conflict Test Device.md";
		textVault.files.set(conflictPath, "conflict copy bytes");
		await withPluginVaultMutation(
			vault,
			{ type: "create", path: conflictPath },
			async () => handlers.get("create")?.({ path: conflictPath }),
		);
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
			async () => handlers.get("create")?.({ path: restorePath }),
		);
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
