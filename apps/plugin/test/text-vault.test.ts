import { DeviceJournal } from "@plugin/sync/device-journal";
import { TextApplyEngine } from "@plugin/sync/text-apply";
import { TFile, type Vault } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { ObsidianTextVault } from "../src/infrastructure/text-vault";

/** Provides the exact host methods used by the adapter without a live vault. */
function makeHostVault() {
	const file = Object.assign(new TFile(), { path: "notes/a.md" });
	const contents = new Map([[file.path, "old"]]);
	const process = vi.fn(
		async (_file: TFile, callback: (text: string) => string) => {
			const next = callback(contents.get(file.path) ?? "");
			contents.set(file.path, next);
			return next;
		},
	);
	const create = vi.fn(async (path: string, text: string) => {
		const created = Object.assign(new TFile(), { path });
		files.push(created);
		contents.set(path, text);
		return created;
	});
	const trash = vi.fn(async (target: TFile, _system: boolean) => {
		contents.delete(target.path);
		files.splice(files.indexOf(target), 1);
		return undefined;
	});
	const rename = vi.fn(async (target: TFile, path: string) => {
		files.splice(files.indexOf(target), 1);
		contents.set(path, contents.get(target.path) ?? "");
		contents.delete(target.path);
		target.path = path;
		files.push(target);
	});
	const files = [file];
	const host = {
		getFiles: () => files,
		getAbstractFileByPath: (path: string) =>
			files.find((candidate) => candidate.path === path) ?? null,
		read: async (target: TFile) => contents.get(target.path) ?? "",
		process,
		create,
		trash,
		rename,
		createFolder: async () => undefined,
	};
	return { host, contents, create, process, trash, rename, file };
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
			writeState: async (next) => {
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
