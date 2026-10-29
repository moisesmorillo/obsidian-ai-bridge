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

	it("creates and renames text without link rewriting", async () => {
		const fake = makeHostVault();
		const vault = new ObsidianTextVault(fake.host as unknown as Vault);
		expect(await vault.create("notes/b.md", "new note")).toBe(true);
		expect(fake.create).toHaveBeenCalledWith("notes/b.md", "new note");
		expect(await vault.rename("notes/a.md", "notes/c.md", "old")).toBe(true);
		expect(fake.rename).toHaveBeenCalledWith(fake.file, "notes/c.md");
	});
});
