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

	/** Reads exact bytes from a current file without text decoding. */
	async readBinary(path: string): Promise<Uint8Array | null> {
		const file = this.fileAt(path);
		return file ? new Uint8Array(await this.vault.readBinary(file)) : null;
	}

	/** Returns host adapter mtime and size for an exact path, or null when absent. */
	async stat(path: string): Promise<{ mtime: number; size: number } | null> {
		const stat = await this.vault.adapter.stat(path);
		return stat?.type === "file"
			? { mtime: stat.mtime, size: stat.size }
			: null;
	}

	/** Creates exact bytes only when no exact or case-folded path collision exists. */
	async createBinary(path: string, bytes: Uint8Array): Promise<boolean> {
		if (this.fileAt(path) || this.hasPathKeyCollision(path)) return false;
		await this.ensureParent(path);
		const copy = bytes.slice();
		try {
			await this.vault.createBinary(path, copy.buffer as ArrayBuffer);
		} catch {
			return false;
		}
		const created = await this.readBinary(path);
		return created !== null && equalBytes(created, bytes);
	}

	/** Removes only verified recovery bytes from the hash-addressed pre-apply directory. */
	async removeRecoveryCopy(
		path: string,
		expectedHash: string,
	): Promise<boolean> {
		const prefix = ".ai-bridge/pre-apply/";
		if (
			path !== `${prefix}${expectedHash}` ||
			!/^[a-f0-9]{64}$/.test(expectedHash)
		)
			return false;
		const bytes = await this.readBinary(path);
		if (!bytes || (await digestBytes(bytes)) !== expectedHash) return false;
		await this.vault.adapter.remove(path);
		return this.fileAt(path) === null;
	}

	/** Replaces exact file bytes; the application layer owns its pre-write stat guard. */
	async modifyBinary(path: string, bytes: Uint8Array): Promise<boolean> {
		const file = this.fileAt(path);
		if (!file) return false;
		const copy = bytes.slice();
		await this.vault.modifyBinary(file, copy.buffer as ArrayBuffer);
		const written = await this.readBinary(path);
		return written !== null && equalBytes(written, bytes);
	}

	/** Lists current vault file paths for collision checks without changing them. */
	async list(): Promise<string[]> {
		return this.vault.getFiles().map((file) => file.path);
	}

	/** Returns raw file size without decoding content, or null when the path is absent. */
	async size(path: string): Promise<number | null> {
		return this.fileAt(path)?.stat.size ?? null;
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

	/** Moves exact observed binary bytes to Obsidian trash without text decoding. */
	async trashBinary(path: string, expected: Uint8Array): Promise<boolean> {
		const file = this.fileAt(path);
		if (!file) return false;
		const current = await this.readBinary(path);
		if (!current || !equalBytes(current, expected)) return false;
		await this.vault.trash(file, false);
		return this.fileAt(path) !== file;
	}

	/** Moves a text file to local Obsidian trash after a best-effort exact-text recheck. */
	async trash(path: string, expected: string): Promise<boolean> {
		const file = this.fileAt(path);
		if (!file || (await this.vault.read(file)) !== expected) return false;
		await this.vault.trash(file, false);
		return this.fileAt(path) !== file;
	}

	/** Renames exact bytes after source and destination checks without text conversion. */
	async renameBinary(
		from: string,
		to: string,
		expected: Uint8Array,
	): Promise<boolean> {
		const source = this.fileAt(from);
		if (!source || this.fileAt(to) || this.hasPathKeyCollision(to))
			return false;
		const bytes = await this.readBinary(from);
		if (!bytes || !equalBytes(bytes, expected)) return false;
		await this.ensureParent(to);
		await this.vault.rename(source, to);
		const moved = await this.readBinary(to);
		return (
			this.fileAt(from) === null &&
			moved !== null &&
			equalBytes(moved, expected)
		);
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

/** Hashes exact bytes without text conversion. */
async function digestBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Compares bytes by length and value without decoding them. */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	return (
		left.byteLength === right.byteLength &&
		left.every((value, index) => value === right[index])
	);
}
