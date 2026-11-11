import { withPluginVaultMutation } from "@plugin/infrastructure/vault-events";
import { TFile, TFolder } from "@plugin/obsidian-api";
import {
	classifyEnrollmentPath,
	DEFAULT_SETTINGS_SYNC_POLICY,
	hasCanonicalSettingsRoot,
	type SettingsSyncPolicy,
	shouldTraverseSettingsDirectory,
} from "@plugin/sync/enrollment-scope";
import type { TextVault } from "@plugin/sync/text-apply";
import {
	DevicePayloadHashSchema,
	PathSchema,
	pathKey,
} from "@vaultwire/protocol";
import type { Vault } from "obsidian";

/** Confines hidden recovery bytes to one hash-addressed directory outside the Vault index. */
const RECOVERY_DIRECTORY = ".vaultwire/pre-apply";

/** Uses Vault effects for visible files and adapter effects for confined hidden recovery bytes. */
export class ObsidianTextVault implements TextVault {
	/** Binds the host vault and the settings policy used for unindexed config files. */
	constructor(
		private readonly vault: Vault,
		private readonly settingsPolicy: () => SettingsSyncPolicy = () =>
			DEFAULT_SETTINGS_SYNC_POLICY,
	) {}

	/** Reads a Markdown-like text file by exact vault path, or returns null when absent. */
	async read(path: string): Promise<string | null> {
		const file = this.fileAt(path);
		return file ? this.vault.read(file) : null;
	}

	/** Reads exact bytes from a current file without text decoding. */
	async readBinary(path: string): Promise<Uint8Array | null> {
		if (hasCanonicalSettingsRoot(path)) {
			if (!this.isSettingsPath(path)) return null;
			const stat = await this.vault.adapter.stat(path);
			return stat?.type === "file"
				? new Uint8Array(await this.vault.adapter.readBinary(path))
				: null;
		}
		if (hasCanonicalRecoveryRoot(path)) {
			if (
				!isRecoveryPath(path) ||
				(await this.vault.adapter.stat(path))?.type !== "file"
			)
				return null;
			return new Uint8Array(await this.vault.adapter.readBinary(path));
		}
		const file = this.fileAt(path);
		return file ? new Uint8Array(await this.vault.readBinary(file)) : null;
	}

	/** Returns adapter mtime and size for a file. Invalid hidden paths and absent files return null. */
	async stat(path: string): Promise<{ mtime: number; size: number } | null> {
		if (hasCanonicalSettingsRoot(path) && !this.isSettingsPath(path))
			return null;
		if (hasCanonicalRecoveryRoot(path) && !isRecoveryPath(path)) return null;
		const stat = await this.vault.adapter.stat(path);
		return stat?.type === "file"
			? { mtime: stat.mtime, size: stat.size }
			: null;
	}

	/** Guards settings creation with stat and hash checks, not atomic exclusion. Reports observed races before failure. */
	async createBinary(
		path: string,
		bytes: Uint8Array,
		onSettingsRace?: (observed: Uint8Array | null) => Promise<void>,
	): Promise<boolean> {
		if (hasCanonicalSettingsRoot(path)) {
			if (!this.isSettingsPath(path)) return false;
			if (await this.vault.adapter.stat(path)) {
				await onSettingsRace?.(await this.readBinary(path));
				return false;
			}
			const key = pathKey(path);
			if (
				(await this.listSettingsPaths()).some(
					(current) =>
						current !== path &&
						PathSchema.safeParse(current).success &&
						pathKey(current) === key,
				)
			)
				return false;
			await this.ensureAdapterParent(path);
			if (await this.vault.adapter.stat(path)) {
				await onSettingsRace?.(await this.readBinary(path));
				return false;
			}
			try {
				await withPluginVaultMutation(
					this.vault,
					{ type: "create", path },
					() =>
						this.vault.adapter.writeBinary(
							path,
							bytes.slice().buffer as ArrayBuffer,
						),
					{ kind: "binary", value: bytes },
				);
			} catch {
				await onSettingsRace?.(await this.readBinary(path));
				return false;
			}
			const created = await this.readBinary(path);
			if (
				!created ||
				(await digestBytes(created)) !== (await digestBytes(bytes))
			) {
				await onSettingsRace?.(created);
				return false;
			}
			return true;
		}
		if (hasCanonicalRecoveryRoot(path))
			return this.writeRecoveryCopy(path, bytes, false);
		if (this.fileAt(path) || this.hasPathKeyCollision(path)) return false;
		await this.ensureParent(path);
		const copy = bytes.slice();
		try {
			await withPluginVaultMutation(
				this.vault,
				{ type: "create", path },
				() => this.vault.createBinary(path, copy.buffer as ArrayBuffer),
				{ kind: "binary", value: bytes },
			);
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
		if (recoveryPayloadHash(path) !== expectedHash) return false;
		const bytes = await this.readBinary(path);
		if (!bytes || (await digestBytes(bytes)) !== expectedHash) return false;
		await this.vault.adapter.remove(path);
		return (await this.vault.adapter.stat(path)) === null;
	}

	/** Checks observed settings bytes before replacement, then hashes read-back bytes. Unobserved adapter races remain possible. */
	async modifyBinary(
		path: string,
		bytes: Uint8Array,
		expected?: Uint8Array,
		onSettingsRace?: (observed: Uint8Array | null) => Promise<void>,
	): Promise<boolean> {
		if (hasCanonicalSettingsRoot(path)) {
			if (!this.isSettingsPath(path)) return false;
			if ((await this.vault.adapter.stat(path))?.type !== "file") {
				await onSettingsRace?.(await this.readBinary(path));
				return false;
			}
			const previous = await this.readBinary(path);
			if (!previous || (expected && !equalBytes(previous, expected))) {
				await onSettingsRace?.(previous);
				return false;
			}
			const beforeWrite = await this.vault.adapter.stat(path);
			const latest = await this.readBinary(path);
			if (
				beforeWrite?.type !== "file" ||
				!latest ||
				!equalBytes(latest, expected ?? previous)
			) {
				await onSettingsRace?.(latest);
				return false;
			}
			try {
				await withPluginVaultMutation(
					this.vault,
					{ type: "modify", path },
					() =>
						this.vault.adapter.writeBinary(
							path,
							bytes.slice().buffer as ArrayBuffer,
						),
					{ kind: "binary", value: bytes },
				);
			} catch {
				await onSettingsRace?.(await this.readBinary(path));
				return false;
			}
			const written = await this.readBinary(path);
			if (
				!written ||
				(await digestBytes(written)) !== (await digestBytes(bytes))
			) {
				await onSettingsRace?.(written);
				return false;
			}
			return true;
		}
		if (hasCanonicalRecoveryRoot(path))
			return this.writeRecoveryCopy(path, bytes, true);
		const file = this.fileAt(path);
		if (!file) return false;
		const copy = bytes.slice();
		await withPluginVaultMutation(
			this.vault,
			{ type: "modify", path },
			() => this.vault.modifyBinary(file, copy.buffer as ArrayBuffer),
			{ kind: "binary", value: bytes },
		);
		const written = await this.readBinary(path);
		return written !== null && equalBytes(written, bytes);
	}

	/** Lists indexed files and confined hidden recovery files so engine cleanup can inspect their retention times. */
	async list(): Promise<string[]> {
		const visible = this.vault.getFiles().map((file) => file.path);
		const settingsFiles = await this.listSettingsFiles();
		const recoveryFiles = await this.listRecoveryFiles();
		return [...new Set([...visible, ...settingsFiles, ...recoveryFiles])];
	}

	/** Finds exact iCloud placeholder metadata without reading placeholder bytes. */
	async isUnavailable(path: string): Promise<boolean> {
		if (await this.isPlaceholderPath(path)) return true;
		const slash = path.lastIndexOf("/");
		const directory = slash < 0 ? "" : `${path.slice(0, slash + 1)}`;
		const name = path.slice(slash + 1);
		return (
			(await this.isPlaceholderPath(`${path}.icloud`)) ||
			(await this.isPlaceholderPath(`${directory}.${name}.icloud`))
		);
	}

	/** Returns raw file size without decoding content, or null when the path is absent. */
	async size(path: string): Promise<number | null> {
		if (hasCanonicalSettingsRoot(path)) {
			if (!this.isSettingsPath(path)) return null;
			const stat = await this.vault.adapter.stat(path);
			return stat?.type === "file" ? stat.size : null;
		}
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
		await withPluginVaultMutation(
			this.vault,
			{ type: "modify", path },
			() =>
				this.vault.process(file, (current) => {
					if (current !== expected) return current;
					applied = true;
					return next;
				}),
			{ kind: "text", value: next },
			() => applied,
		);
		return applied;
	}

	/** Creates a text file only when no exact or case-folded path-key collision exists. */
	async create(path: string, text: string): Promise<boolean> {
		if (this.fileAt(path) || this.hasPathKeyCollision(path)) return false;
		await this.ensureParent(path);
		try {
			await withPluginVaultMutation(
				this.vault,
				{ type: "create", path },
				() => this.vault.create(path, text),
				{ kind: "text", value: text },
			);
		} catch {
			return false;
		}
		return (await this.read(path)) === text;
	}

	/** Moves exact observed binary bytes to Obsidian trash without text decoding. */
	async trashBinary(path: string, expected: Uint8Array): Promise<boolean> {
		if (hasCanonicalSettingsRoot(path)) {
			if (!this.isSettingsPath(path)) return false;
			const adapter = this.vault.adapter;
			const observed = await adapter.stat(path);
			if (observed?.type !== "file") return false;
			const current = await this.readBinary(path);
			if (!current || !equalBytes(current, expected)) return false;
			const beforeTrash = await adapter.stat(path);
			if (
				beforeTrash?.type !== "file" ||
				beforeTrash.mtime !== observed.mtime ||
				beforeTrash.size !== observed.size
			)
				return false;
			const latest = await this.readBinary(path);
			if (!latest || !equalBytes(latest, expected)) return false;
			await withPluginVaultMutation(this.vault, { type: "delete", path }, () =>
				adapter.trashLocal(path),
			);
			return (await adapter.stat(path)) === null;
		}
		const file = this.fileAt(path);
		if (!file) return false;
		const current = await this.readBinary(path);
		if (!current || !equalBytes(current, expected)) return false;
		await withPluginVaultMutation(
			this.vault,
			{ type: "delete", path },
			() => this.vault.trash(file, false),
			undefined,
			() => this.fileAt(path) !== file,
			file,
		);
		return this.fileAt(path) !== file;
	}

	/** Moves a text file to local Obsidian trash after a best-effort exact-text recheck. */
	async trash(path: string, expected: string): Promise<boolean> {
		const file = this.fileAt(path);
		if (!file || (await this.vault.read(file)) !== expected) return false;
		await withPluginVaultMutation(
			this.vault,
			{ type: "delete", path },
			() => this.vault.trash(file, false),
			undefined,
			() => this.fileAt(path) !== file,
			file,
		);
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
		await withPluginVaultMutation(
			this.vault,
			{ type: "rename", path: from, to },
			() => this.vault.rename(source, to),
			{ kind: "binary", value: expected },
			() => this.fileAt(from) === null && source.path === to,
			source,
		);
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
		await withPluginVaultMutation(
			this.vault,
			{ type: "rename", path: from, to },
			() => this.vault.rename(source, to),
			{ kind: "text", value: expected },
			() => this.fileAt(from) === null && this.fileAt(to) === source,
			source,
		);
		return this.fileAt(to) === source && this.fileAt(from) === null;
	}

	/** Creates or refreshes confined recovery bytes. Observed hash or byte mismatches stop the write. The engine owns effect admission. */
	private async writeRecoveryCopy(
		path: string,
		bytes: Uint8Array,
		refresh: boolean,
	): Promise<boolean> {
		const recoveryHash = recoveryPayloadHash(path);
		if (!recoveryHash || (await digestBytes(bytes)) !== recoveryHash)
			return false;
		const adapter = this.vault.adapter;
		const existingStat = await adapter.stat(path);
		if (existingStat) {
			if (existingStat.type !== "file") return false;
			const existing = await this.readBinary(path);
			if (!existing || !equalBytes(existing, bytes)) return false;
			if (!refresh) return true;
		} else {
			if (refresh) return false;
			const root = path.slice(0, path.indexOf("/"));
			const recoveryDirectory = path.slice(0, path.lastIndexOf("/"));
			for (const directory of [root, recoveryDirectory]) {
				const stat = await adapter.stat(directory);
				if (stat?.type === "folder") continue;
				if (stat) return false;
				try {
					await adapter.mkdir(directory);
				} catch {
					if ((await adapter.stat(directory))?.type !== "folder") return false;
				}
			}
		}
		const beforeWrite = await this.readBinary(path);
		if (beforeWrite && !equalBytes(beforeWrite, bytes)) return false;
		if (!refresh && beforeWrite) return true;
		if (refresh && !beforeWrite) return false;
		try {
			await adapter.writeBinary(path, bytes.slice().buffer as ArrayBuffer);
		} catch {
			return false;
		}
		const written = await this.readBinary(path);
		return written !== null && equalBytes(written, bytes);
	}

	/** Lists direct hash-addressed files under each canonical recovery directory while retaining path spelling. */
	private async listRecoveryFiles(): Promise<string[]> {
		const rootFolders = (await this.vault.adapter.list("")).folders.filter(
			(path) =>
				PathSchema.safeParse(path).success && pathKey(path) === ".vaultwire",
		);
		const recoveryDirectories: string[] = [];
		for (const root of rootFolders) {
			if ((await this.vault.adapter.stat(root))?.type !== "folder") continue;
			const folders = (await this.vault.adapter.list(root)).folders;
			recoveryDirectories.push(
				...folders.filter(
					(path) =>
						PathSchema.safeParse(path).success &&
						pathKey(path) === pathKey(`${root}/pre-apply`),
				),
			);
		}
		const files: string[] = [];
		for (const directory of recoveryDirectories) {
			if ((await this.vault.adapter.stat(directory))?.type !== "folder")
				continue;
			const listing = await this.vault.adapter.list(directory);
			files.push(...listing.files.filter(isRecoveryPath));
		}
		return files;
	}

	/** Lists exact selected settings files through the adapter because the Vault index omits them. */
	private async listSettingsFiles(): Promise<string[]> {
		if (!this.settingsPolicy().enabled) return [];
		return (await this.listSettingsPaths()).filter((path) =>
			this.isSettingsPath(path),
		);
	}

	/** Discovers canonical settings roots, retains their spelling, and traverses only policy-admitted directories. */
	private async listSettingsPaths(): Promise<string[]> {
		const policy = this.settingsPolicy();
		const rootFolders = (await this.vault.adapter.list("")).folders.filter(
			(path) =>
				PathSchema.safeParse(path).success &&
				pathKey(path) === ".obsidian" &&
				shouldTraverseSettingsDirectory(path, policy),
		);
		const pending: string[] = [];
		for (const root of rootFolders) {
			if ((await this.vault.adapter.stat(root))?.type === "folder")
				pending.push(root);
		}
		const files: string[] = [];
		while (pending.length > 0) {
			const directory = pending.pop();
			if (!directory) continue;
			const listing = await this.vault.adapter.list(directory);
			files.push(
				...listing.files.filter((path) => PathSchema.safeParse(path).success),
			);
			pending.push(
				...listing.folders.filter((path) =>
					shouldTraverseSettingsDirectory(path, policy),
				),
			);
		}
		return files;
	}

	/** Returns whether the canonical policy admits this settings path. */
	private isSettingsPath(path: string): boolean {
		return classifyEnrollmentPath(path, 0, this.settingsPolicy()) === "blob";
	}

	/** Creates missing adapter folders in order without replacing any existing entry. */
	private async ensureAdapterParent(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash < 0) return;
		const parts = path.slice(0, slash).split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const stat = await this.vault.adapter.stat(current);
			if (stat?.type === "folder") continue;
			if (stat) throw new Error("Settings parent path is not a folder");
			await this.vault.adapter.mkdir(current);
		}
	}

	/** Returns only a real Obsidian file at one exact indexed path. */
	private fileAt(path: string): TFile | null {
		const file = this.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	/** Checks placeholder identity only through adapter metadata. */
	private async isPlaceholderPath(path: string): Promise<boolean> {
		return (
			path.endsWith(".icloud") &&
			(await this.vault.adapter.stat(path))?.type === "file"
		);
	}

	/** Detects a differently spelled path with the same Obsidian sync identity. */
	private hasPathKeyCollision(path: string): boolean {
		const key = pathKey(path);
		return this.vault
			.getFiles()
			.some(
				(file) =>
					file.path !== path &&
					PathSchema.safeParse(file.path).success &&
					pathKey(file.path) === key,
			);
	}

	/**
	 * Removes ancestor folders of a vacated path while each one is empty on disk.
	 *
	 * Walks upward from the direct parent. It stops at the vault root, at a folder
	 * outside the Obsidian index (such as `.obsidian/`), and at the first folder whose
	 * disk listing holds any file or subfolder, hidden entries included. Each removal
	 * is non-recursive, so a file that appears after the check makes the host refuse.
	 * Folders have no sync identity, so this effect never changes the journal.
	 */
	async pruneEmptyParents(path: string): Promise<void> {
		let slash = path.lastIndexOf("/");
		while (slash > 0) {
			const folderPath = path.slice(0, slash);
			const folder = this.vault.getAbstractFileByPath(folderPath);
			if (!(folder instanceof TFolder) || folder.children.length > 0) return;
			const listed = await this.vault.adapter.list(folderPath);
			if (listed.files.length > 0 || listed.folders.length > 0) return;
			await withPluginVaultMutation(
				this.vault,
				{ type: "delete", path: folderPath },
				() => this.vault.delete(folder, false),
				undefined,
				() => this.vault.getAbstractFileByPath(folderPath) !== folder,
				folder,
			);
			if (this.vault.getAbstractFileByPath(folderPath) === folder) return;
			slash = folderPath.lastIndexOf("/");
		}
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

/** Checks only validated paths for canonical hidden recovery-root identity. */
function hasCanonicalRecoveryRoot(path: string): boolean {
	const root = path.split("/")[0];
	if (!root) return false;
	const rootProbe = `${root}/path`;
	return (
		PathSchema.safeParse(rootProbe).success &&
		pathKey(rootProbe).startsWith(".vaultwire/")
	);
}

/** Returns the exact hash only for a direct child of the canonical recovery directory. */
function recoveryPayloadHash(path: string): string | null {
	if (!PathSchema.safeParse(path).success) return null;
	const segments = path.split("/");
	if (
		segments.length !== 3 ||
		pathKey(segments.slice(0, 2).join("/")) !== pathKey(RECOVERY_DIRECTORY)
	)
		return null;
	const payloadHash = segments[2];
	return DevicePayloadHashSchema.safeParse(payloadHash).success
		? payloadHash
		: null;
}

/** Accepts only one direct child with a canonical SHA-256 payload hash. */
function isRecoveryPath(path: string): boolean {
	return recoveryPayloadHash(path) !== null;
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
