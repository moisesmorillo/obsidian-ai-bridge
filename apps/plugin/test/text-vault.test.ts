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

describe("ObsidianTextVault", () => {
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
		const file = Object.assign(new TFile(), { path });
		let current = bytes.slice();
		const remove = vi.fn(async () => {
			current = new Uint8Array();
		});
		const host = {
			getFiles: () => (current.byteLength ? [file] : []),
			getAbstractFileByPath: (candidate: string) =>
				candidate === path && current.byteLength ? file : null,
			readBinary: async () => current.slice().buffer,
			adapter: {
				stat: async () => ({
					type: "file",
					mtime: 1,
					size: current.byteLength,
				}),
				remove,
			},
		};
		const adapter = new ObsidianTextVault(host as unknown as Vault);

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
