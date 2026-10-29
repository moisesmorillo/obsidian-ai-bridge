import { pathKey } from "@obsidian-ai-bridge/protocol";
import type { TextVault } from "@plugin/sync/text-apply";
import { TFile, type Vault } from "obsidian";

/** Uses Obsidian Vault effects while rechecking exact observed text before mutation. */
export class ObsidianTextVault implements TextVault {
	/** Binds the host vault whose text effects this adapter guards. */
	constructor(private readonly vault: Vault) {}

	/** Reads a Markdown-like text file by exact vault path, or returns null when absent. */
	async read(path: string): Promise<string | null> {
		const file = this.fileAt(path);
		return file ? this.vault.read(file) : null;
	}

	/** Lists current vault file paths for collision checks without changing them. */
	async list(): Promise<string[]> {
		return this.vault.getFiles().map((file) => file.path);
	}

	/** Uses Vault.process so its callback compares the exact observed text atomically. */
	async process(
		path: string,
		expected: string | null,
		next: string,
	): Promise<boolean> {
		const file = this.fileAt(path);
		if (!file || expected === null) return false;
		let applied = false;
		await this.vault.process(file, (current) => {
			if (current !== expected) return current;
			applied = true;
			return next;
		});
		return applied;
	}

	/** Creates a text file only when no exact or case-folded path-key collision exists. */
	async create(path: string, text: string): Promise<boolean> {
		if (this.fileAt(path) || this.hasPathKeyCollision(path)) return false;
		await this.ensureParent(path);
		try {
			await this.vault.create(path, text);
		} catch {
			return false;
		}
		return (await this.read(path)) === text;
	}

	/** Moves a text file to local Obsidian trash after a best-effort exact-text recheck. */
	async trash(path: string, expected: string): Promise<boolean> {
		const file = this.fileAt(path);
		if (!file || (await this.vault.read(file)) !== expected) return false;
		await this.vault.trash(file, false);
		return this.fileAt(path) !== file;
	}

	/** Renames without link rewriting after source and destination checks. */
	async rename(from: string, to: string, expected: string): Promise<boolean> {
		const source = this.fileAt(from);
		if (!source || this.fileAt(to) || this.hasPathKeyCollision(to))
			return false;
		if ((await this.vault.read(source)) !== expected) return false;
		await this.ensureParent(to);
		await this.vault.rename(source, to);
		return this.fileAt(to) === source && this.fileAt(from) === null;
	}

	/** Returns only a real Obsidian text file at one exact path. */
	private fileAt(path: string): TFile | null {
		const file = this.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	/** Detects a differently spelled path with the same Obsidian sync identity. */
	private hasPathKeyCollision(path: string): boolean {
		const key = pathKey(path);
		return this.vault
			.getFiles()
			.some((file) => file.path !== path && pathKey(file.path) === key);
	}

	/** Creates missing parent folders without replacing an existing folder. */
	private async ensureParent(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash < 0) return;
		const parts = path.slice(0, slash).split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (this.vault.getAbstractFileByPath(current)) continue;
			try {
				await this.vault.createFolder(current);
			} catch {
				if (!this.vault.getAbstractFileByPath(current))
					throw new Error("Could not create parent folder");
			}
		}
	}
}
