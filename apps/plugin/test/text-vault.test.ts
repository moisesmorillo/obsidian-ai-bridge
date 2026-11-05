import type { DeviceState } from "@obsidian-ai-bridge/protocol";
import { DeviceJournal } from "@plugin/sync/device-journal";
import { TextApplyEngine } from "@plugin/sync/text-apply";
import { type EventRef, TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ObsidianTextVault } from "../src/infrastructure/text-vault";
import { VaultEventAdapter } from "../src/infrastructure/vault-events";
import { DesktopSyncController } from "../src/sync/desktop-sync";

/** Provides the exact host methods used by the adapter without a live vault. */
function makeHostVault() {
	const file = Object.assign(new TFile(), { path: "notes/a.md" });
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
		async (_file: TFile, callback: (text: string) => string) => {
			const current = contents.get(file.path) ?? "";
			const next = callback(current);
			contents.set(file.path, next);
			if (next !== current) emit("modify", file);
			return next;
		},
	);
	const create = vi.fn(async (path: string, text: string) => {
		const created = Object.assign(new TFile(), { path });
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

/** Computes the canonical hash-addressed recovery identity from exact fixture bytes. */
async function recoveryHash(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

describe("ObsidianTextVault", () => {
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
