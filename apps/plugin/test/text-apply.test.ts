import {
	type PendingConflictCopy,
	pathKey,
} from "@obsidian-ai-bridge/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { SyncTransport } from "../src/infrastructure/sync-transport";
import { DeviceJournal } from "../src/sync/device-journal";
import { UnsupportedRemoteTextError } from "../src/sync/remote-text";
import {
	type PinnedTextProvider,
	TextApplyEngine,
	type TextApplyOptions,
	type TextVault,
} from "../src/sync/text-apply";

/** Stores device state and note text for isolated apply tests. */
class MemoryStorage {
	state: unknown = null;
	failWriteState = false;
	/** Reads the raw persisted journal document. */
	async readState(): Promise<unknown> {
		return this.state;
	}
	/** Replaces the test journal document with a defensive copy. */
	async writeState(value: unknown): Promise<void> {
		if (this.failWriteState) {
			this.failWriteState = false;
			throw new Error("injected journal write failure");
		}
		this.state = structuredClone(value);
	}
	/** Rejects payload access because these apply tests do not enqueue operations. */
	async readPayload(): Promise<Uint8Array> {
		throw new Error("unused");
	}
	/** Rejects payload writes because these apply tests do not enqueue operations. */
	async writePayload(): Promise<void> {
		throw new Error("unused");
	}
}

/** Emulates exact-string process guards and visible path collisions. */
class MemoryVault implements TextVault {
	files = new Map<string, string>();
	binaryFiles = new Map<string, Uint8Array>();
	sizeOverrides = new Map<string, number>();
	mtimeByPath = new Map<string, number>();
	removedRecovery: string[] = [];
	statCalls = 0;
	binaryTrashes: string[] = [];
	beforeBinaryRead: ((path: string) => void) | null = null;
	beforeSecondStat: (() => void) | null = null;
	beforeProcess: (() => void) | null = null;
	afterBinaryTrash: (() => void) | null = null;
	refuseTrash: ((path: string) => boolean) | null = null;
	failNextBinaryModify = false;
	failBinaryModifyPath: string | null = null;
	/** Reads current text or reports an absent exact path. */
	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}
	/** Lists every visible fake path. */
	async list(): Promise<string[]> {
		return [...this.files.keys(), ...this.binaryFiles.keys()];
	}
	/** Reads raw test bytes without decoding them. */
	async readBinary(path: string): Promise<Uint8Array | null> {
		this.beforeBinaryRead?.(path);
		const binary = this.binaryFiles.get(path);
		if (binary) return binary.slice();
		const text = this.files.get(path);
		return text === undefined ? null : new TextEncoder().encode(text);
	}
	/** Returns controlled host metadata and injects a write before the second stat. */
	async stat(path: string): Promise<{ mtime: number; size: number } | null> {
		this.statCalls += 1;
		if (this.statCalls === 2) this.beforeSecondStat?.();
		const bytes = await this.readBinary(path);
		return bytes
			? {
					mtime: this.mtimeByPath.get(path) ?? 1,
					size: bytes.byteLength,
				}
			: null;
	}
	/** Creates a binary test file only at an absent path. */
	async createBinary(path: string, bytes: Uint8Array): Promise<boolean> {
		if (
			[...this.files.keys(), ...this.binaryFiles.keys()].some(
				(current) => current === path || pathKey(current) === pathKey(path),
			)
		)
			return false;
		this.binaryFiles.set(path, bytes.slice());
		this.mtimeByPath.set(path, Date.now());
		return true;
	}
	/** Removes only a verified recovery file at its hash-addressed path. */
	async removeRecoveryCopy(
		path: string,
		expectedHash: string,
	): Promise<boolean> {
		const bytes = this.binaryFiles.get(path);
		if (
			!path.startsWith(".ai-bridge/pre-apply/") ||
			!bytes ||
			(await hashBytes(bytes)) !== expectedHash
		)
			return false;
		this.binaryFiles.delete(path);
		this.removedRecovery.push(path);
		return true;
	}
	/** Moves exact bytes to an absent binary destination. */
	async renameBinary(
		from: string,
		to: string,
		expected: Uint8Array,
	): Promise<boolean> {
		const bytes = this.binaryFiles.get(from);
		if (
			!bytes ||
			this.binaryFiles.has(to) ||
			(await hashBytes(bytes)) !== (await hashBytes(expected))
		)
			return false;
		this.binaryFiles.set(to, bytes.slice());
		this.binaryFiles.delete(from);
		return true;
	}
	/** Moves exact binary test bytes to the fake trash when they still match. */
	async trashBinary(path: string, expected: Uint8Array): Promise<boolean> {
		this.binaryTrashes.push(path);
		const bytes = this.binaryFiles.get(path);
		const text = this.files.get(path);
		const observed =
			bytes ?? (text === undefined ? null : new TextEncoder().encode(text));
		if (
			!observed ||
			(await hashBytes(observed)) !== (await hashBytes(expected))
		)
			return false;
		this.binaryFiles.delete(path);
		this.files.delete(path);
		this.afterBinaryTrash?.();
		return true;
	}
	/** Replaces exact binary test bytes and confirms the write. */
	async modifyBinary(path: string, bytes: Uint8Array): Promise<boolean> {
		if (this.failNextBinaryModify || this.failBinaryModifyPath === path) {
			this.failNextBinaryModify = false;
			this.failBinaryModifyPath = null;
			return false;
		}
		if (!this.binaryFiles.has(path) && !this.files.has(path)) return false;
		this.files.delete(path);
		this.binaryFiles.set(path, bytes.slice());
		this.mtimeByPath.set(path, Date.now());
		return true;
	}
	/** Returns fixture text size without changing the file. */
	async size(path: string): Promise<number | null> {
		const override = this.sizeOverrides.get(path);
		if (override !== undefined) return override;
		const text = this.files.get(path);
		return text === undefined
			? (this.binaryFiles.get(path)?.byteLength ?? null)
			: new TextEncoder().encode(text).length;
	}
	/** Applies text only when the exact observed value remains unchanged. */
	async process(
		path: string,
		expected: string | null,
		next: string,
	): Promise<boolean> {
		this.beforeProcess?.();
		if ((this.files.get(path) ?? null) !== expected) return false;
		this.files.set(path, next);
		return true;
	}
	/** Creates one absent path without replacing existing bytes. */
	async create(path: string, text: string): Promise<boolean> {
		if (this.files.has(path)) return false;
		this.files.set(path, text);
		return true;
	}
	/** Removes a path to emulate an accepted local-trash operation. */
	async trash(path: string, _expected: string): Promise<boolean> {
		if (this.refuseTrash?.(path)) return false;
		if (!this.files.has(path)) return false;
		this.files.delete(path);
		return true;
	}
	/** Moves one exact file to an absent destination. */
	async rename(from: string, to: string, _expected: string): Promise<boolean> {
		const text = this.files.get(from);
		if (text === undefined || this.files.has(to)) return false;
		this.files.set(to, text);
		this.files.delete(from);
		return true;
	}
}

const epoch = "b".repeat(32);
const change = {
	seq: 1,
	op: "put" as const,
	path: "notes/a.md",
	etag: `"${epoch}.2"`,
	hash: "",
	origin: "remote",
	at: 1,
};

/** Seeds a confirmed base through a validated journal restart. */
async function seedBase(
	path: string,
	hashValue: string,
	storage: MemoryStorage,
	journal: DeviceJournal,
): Promise<DeviceJournal> {
	const state = journal.snapshot();
	state.base[path] = { deleted: false, rev: 1, hash: hashValue };
	journal.close();
	storage.state = state;
	return DeviceJournal.open(storage);
}

/** Checks length and every byte without deep object comparisons of large fixtures. */
function expectExactBytes(
	actual: Uint8Array | undefined,
	expected: Uint8Array,
): void {
	expect(actual?.byteLength).toBe(expected.byteLength);
	expect(actual?.every((byte, index) => byte === expected[index])).toBe(true);
}

/** Hashes exact test bytes with Web Crypto. */
async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Hashes UTF-8 test text with the same Web Crypto digest as the engine. */
async function hash(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Builds an apply engine with a stable test device name unless a case overrides it. */
function makeEngine(
	journal: DeviceJournal,
	vault: TextVault,
	pinnedText: PinnedTextProvider,
	options: TextApplyOptions = { deviceName: "Test Device" },
): TextApplyEngine {
	return new TextApplyEngine(journal, vault, pinnedText, options);
}

describe("TextApplyEngine", () => {
	let storage: MemoryStorage;
	let journal: DeviceJournal;
	let vault: MemoryVault;
	let engine: TextApplyEngine;
	const remoteText = "remote bytes";

	beforeEach(async () => {
		storage = new MemoryStorage();
		journal = await DeviceJournal.open(storage);
		vault = new MemoryVault();
		const remoteChange = { ...change, hash: await hash(remoteText) };
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		Object.assign(change, remoteChange);
	});

	it.each(["apply", "named", "copied", "effect"] as const)(
		"applies a clean blob with only pre-apply recovery after %s",
		async (stopAt) => {
			const path = "assets/clean-put.png";
			const local = new Uint8Array([0xff, 0x28, 1]);
			const remote = new Uint8Array([0xfe, 0x28, 2]);
			const localHash = await hashBytes(local);
			const remoteHash = await hashBytes(remote);
			const recoveryPath = `.ai-bridge/pre-apply/${localHash}`;
			const now = Date.now();
			vault.binaryFiles.set(path, local.slice());
			await journal.setBase(path, { deleted: false, rev: 1, hash: localHash });
			const provider: PinnedTextProvider = {
				read: async () => null,
				readBlob: async (_path, requestEpoch, rev) => ({
					bytes: remote.slice(),
					epoch: requestEpoch,
					rev,
					hash: remoteHash,
				}),
			};
			engine = makeEngine(journal, vault, provider, {
				deviceName: "Test Device",
				now: () => now,
			});
			const update = journal.updateApply.bind(journal);
			journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === stopAt)
					throw new Error("stop at clean recovery step");
			};
			const modify = vault.modifyBinary.bind(vault);
			vault.modifyBinary = async (source, bytes) => {
				if (source === path) {
					expect(journal.snapshot().pending_apply[0]?.conflict_copies).toEqual([
						expect.objectContaining({
							path: recoveryPath,
							source: path,
							hash: localHash,
							purpose: "pre_apply",
							kind: "blob",
						}),
					]);
					expect(vault.binaryFiles.get(recoveryPath)).toEqual(local);
					expect(journal.snapshot().base[path]?.rev).toBe(1);
				}
				const result = await modify(source, bytes);
				if (source === path && stopAt === "effect")
					storage.failWriteState = true;
				return result;
			};
			const row = { ...change, path, hash: remoteHash };
			if (stopAt === "apply") await engine.apply(row, "blob");
			else {
				await expect(engine.apply(row, "blob")).rejects.toThrow(
					stopAt === "effect"
						? "injected journal write failure"
						: "stop at clean recovery step",
				);
				expect(journal.snapshot().base[path]?.rev).toBe(1);
				expect(
					journal.snapshot().pending_apply[0]?.conflict_copies,
				).toHaveLength(1);
				if (vault.binaryFiles.has(recoveryPath))
					vault.mtimeByPath.set(recoveryPath, now - 8 * 24 * 60 * 60 * 1000);
				engine.close();
				journal.close();
				journal = await DeviceJournal.open(storage);
				vault.modifyBinary = modify;
				engine = makeEngine(journal, vault, provider, {
					deviceName: "Test Device",
					now: () => now,
				});
				await engine.resume();
			}
			await engine.resume();
			await engine.apply(row, "blob");
			expect(vault.binaryFiles.get(path)).toEqual(remote);
			expect(vault.binaryFiles.get(recoveryPath)).toEqual(local);
			expect(vault.mtimeByPath.get(recoveryPath)).toBeGreaterThanOrEqual(now);
			expect(vault.removedRecovery).not.toContain(recoveryPath);
			expect(
				(await vault.list()).filter((source) => source.includes("conflict")),
			).toEqual([]);
			expect(journal.snapshot().attention).toEqual([]);
			expect(journal.snapshot().base[path]).toEqual({
				deleted: false,
				rev: 2,
				hash: remoteHash,
			});
			expect(journal.snapshot().pending_apply).toEqual([]);
		},
	);

	it.each(
		(["named", "copied"] as const).flatMap((step) =>
			(["text", "blob", "deleted"] as const).map((kind) => ({ step, kind })),
		),
	)(
		"rebases clean $step recovery to current $kind authority without a conflict",
		async ({ step, kind }) => {
			const path = "assets/clean-rebased.png";
			const local = new Uint8Array([0xff, 0x28, 1]);
			const localHash = await hashBytes(local);
			const first = new Uint8Array([2, 3]);
			const firstHash = await hashBytes(first);
			const currentText = "new inline authority";
			const current =
				kind === "text"
					? new TextEncoder().encode(currentText)
					: new Uint8Array([4, 5]);
			const currentHash = kind === "deleted" ? "" : await hashBytes(current);
			let restarted = false;
			vault.binaryFiles.set(path, local.slice());
			await journal.setBase(path, { deleted: false, rev: 1, hash: localHash });
			const provider: PinnedTextProvider = {
				read: async () => null,
				readResolvedBlob: async () =>
					!restarted
						? { kind: "blob", bytes: first, hash: firstHash, epoch, rev: 2 }
						: kind === "deleted"
							? { kind, text: null, hash: "", epoch, rev: 3 }
							: kind === "text"
								? { kind, text: currentText, hash: currentHash, epoch, rev: 3 }
								: { kind, bytes: current, hash: currentHash, epoch, rev: 3 },
			};
			const update = journal.updateApply.bind(journal);
			journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === step)
					throw new Error("stop at clean authority step");
			};
			engine = makeEngine(journal, vault, provider);
			await expect(
				engine.apply({ ...change, path, hash: firstHash }, "blob"),
			).rejects.toThrow("stop at clean authority step");
			expect(journal.snapshot().pending_apply[0]?.conflict_copies).toHaveLength(
				1,
			);
			engine.close();
			journal.close();
			restarted = true;
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(journal, vault, provider);
			await engine.resume();
			await engine.resume();
			expect(
				vault.binaryFiles.get(`.ai-bridge/pre-apply/${localHash}`),
			).toEqual(local);
			expect(
				(await vault.list()).filter((source) => source.includes("conflict")),
			).toEqual([]);
			expect(journal.snapshot().attention).toEqual([]);
			expect(journal.snapshot().pending_apply).toEqual([]);
			if (kind === "deleted") {
				expect(await vault.readBinary(path)).toBeNull();
				expect(journal.snapshot().base[path]).toEqual({
					deleted: true,
					rev: 3,
				});
			} else {
				expect(await vault.readBinary(path)).toEqual(current);
				expect(journal.snapshot().base[path]).toEqual({
					deleted: false,
					rev: 3,
					hash: currentHash,
				});
			}
		},
	);

	it.each(["named", "copied"] as const)(
		"keeps changed local bytes intact during pre-apply-only %s recovery",
		async (step) => {
			const path = "assets/changed-clean-plan.png";
			const preserved = new Uint8Array([1, 2]);
			const edited = new Uint8Array([3, 4]);
			const remote = new Uint8Array([5, 6]);
			const preservedHash = await hashBytes(preserved);
			const remoteHash = await hashBytes(remote);
			const recoveryPath = `.ai-bridge/pre-apply/${preservedHash}`;
			const row = { ...change, path, hash: remoteHash };
			await journal.setBase(path, {
				deleted: false,
				rev: 1,
				hash: preservedHash,
			});
			await journal.beginApply(row, "blob");
			await journal.updateApply({
				change: row,
				content_kind: "blob",
				step: "named",
				conflict_copies: [
					{
						path: recoveryPath,
						source: path,
						side: "path",
						mode: "local",
						hash: preservedHash,
						kind: "blob",
						purpose: "pre_apply",
					},
				],
			});
			const pending = journal.snapshot().pending_apply[0];
			if (!pending) throw new Error("Missing clean recovery plan");
			if (step === "copied") await journal.updateApply({ ...pending, step });
			vault.binaryFiles.set(path, edited.slice());
			vault.binaryFiles.set(recoveryPath, preserved.slice());
			engine = makeEngine(journal, vault, {
				read: async () => null,
				readBlob: async (_path, requestEpoch, rev) => ({
					bytes: remote,
					hash: remoteHash,
					epoch: requestEpoch,
					rev,
				}),
			});
			await engine.resume();
			expect(vault.binaryFiles.get(path)).toEqual(edited);
			expect(vault.binaryFiles.get(recoveryPath)).toEqual(preserved);
			expect(journal.snapshot().base[path]).toEqual({
				deleted: false,
				rev: 1,
				hash: preservedHash,
			});
			expect(journal.snapshot().pending_apply).toHaveLength(1);
			expect(journal.snapshot().attention).toContainEqual(
				expect.objectContaining({
					path,
					reason: "Binary recovery identity changed before apply completed",
				}),
			);
		},
	);

	it("preserves bytes when mtime changes after binary hash verification", async () => {
		const source = new Uint8Array([1, 2, 3]);
		const changed = new Uint8Array([4, 5, 6]);
		const remoteBytes = new Uint8Array([7, 8, 9]);
		const sourceHash = await hashBytes(source);
		const remoteHash = await hashBytes(remoteBytes);
		const blobChange = {
			...change,
			path: "notes/photo.png",
			hash: remoteHash,
		};
		vault.binaryFiles.set(blobChange.path, source.slice());
		vault.beforeSecondStat = () => {
			vault.binaryFiles.set(blobChange.path, changed.slice());
			vault.mtimeByPath.set(blobChange.path, 2);
		};
		journal = await seedBase(blobChange.path, sourceHash, storage, journal);
		engine = makeEngine(journal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(blobChange.path);
			},
			readBlob: async (_path, requestEpoch, rev) => ({
				bytes: remoteBytes.slice(),
				epoch: requestEpoch,
				rev,
				hash: remoteHash,
			}),
		});

		await expect(engine.apply(blobChange)).rejects.toThrow(
			"Binary changed during observation; retry after conflict preservation",
		);

		expect(vault.binaryFiles.get(blobChange.path)).toEqual(changed);
		expect(journal.snapshot().pending_apply[0]?.conflict_copies).toContainEqual(
			expect.objectContaining({
				source: blobChange.path,
				hash: await hashBytes(changed),
				kind: "blob",
				purpose: "conflict",
			}),
		);
		expect(journal.snapshot().base[blobChange.path]).toEqual({
			deleted: false,
			rev: 1,
			hash: sourceHash,
		});

		const conflictPlan = journal
			.snapshot()
			.pending_apply[0]?.conflict_copies?.find(
				(copy: { purpose?: string }) => copy.purpose === "conflict",
			);
		if (!conflictPlan)
			throw new Error("Expected persisted binary conflict identity");
		expect(vault.binaryFiles.get(conflictPlan.path)).toEqual(changed);
		expect(
			vault.binaryFiles.get(`.ai-bridge/pre-apply/${await hashBytes(changed)}`),
		).toEqual(changed);
		journal.close();
		const restartedJournal = await DeviceJournal.open(storage);
		const restartedVault = new MemoryVault();
		for (const [path, bytes] of vault.binaryFiles)
			restartedVault.binaryFiles.set(path, bytes.slice());
		restartedVault.mtimeByPath.set(blobChange.path, 10);
		const restartedEngine = makeEngine(restartedJournal, restartedVault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(blobChange.path);
			},
			readBlob: async (_path, requestEpoch, rev) => ({
				bytes: remoteBytes.slice(),
				epoch: requestEpoch,
				rev,
				hash: remoteHash,
			}),
		});
		await restartedEngine.resume();
		const conflict = [...restartedVault.binaryFiles.entries()].find(
			([path]) =>
				path.includes("(conflict Test Device") && path.endsWith(".png"),
		);
		expect(conflict?.[1]).toEqual(changed);
		expect(
			restartedVault.binaryFiles.get(
				`.ai-bridge/pre-apply/${await hashBytes(changed)}`,
			),
		).toEqual(changed);
		expect(restartedVault.binaryFiles.get(blobChange.path)).toEqual(
			remoteBytes,
		);
		expect(restartedJournal.snapshot().base[blobChange.path]).toEqual({
			deleted: false,
			rev: 2,
			hash: remoteHash,
		});
	});

	it("preserves remote blob bytes as a visible copy after a path-key collision", async () => {
		const path = "assets/photo.png";
		const localPath = "assets/PHOTO.png";
		const local = new Uint8Array([40, 41]);
		const remote = new Uint8Array([42, 43]);
		const remoteHash = await hashBytes(remote);
		vault.binaryFiles.set(localPath, local.slice());
		engine = makeEngine(journal, vault, {
			read: async () => null,
			readBlob: async (_path, requestEpoch, rev) => ({
				bytes: remote.slice(),
				epoch: requestEpoch,
				rev,
				hash: remoteHash,
			}),
		});

		await engine.apply({ ...change, path, hash: remoteHash }, "blob");

		expect(vault.binaryFiles.get(localPath)).toEqual(local);
		const remoteCopies = [...vault.binaryFiles.entries()].filter(
			([copyPath]) => copyPath !== localPath && copyPath !== path,
		);
		expect(remoteCopies).toHaveLength(1);
		expect(remoteCopies[0]?.[1]).toEqual(remote);
		expect(journal.snapshot().attention).toContainEqual(
			expect.objectContaining({ path }),
		);
		expect(journal.snapshot().pending_apply).toEqual([]);
	});

	it("refreshes retention when copied binary work resumes after its copy expires", async () => {
		const now = Date.now();
		const path = "assets/expired-copy.png";
		const local = new Uint8Array([101, 102]);
		const remote = new Uint8Array([103, 104]);
		const localHash = await hashBytes(local);
		const remoteHash = await hashBytes(remote);
		const blobChange = { ...change, path, hash: remoteHash };
		vault.binaryFiles.set(path, local.slice());
		vault.mtimeByPath.set(path, 10);
		await journal.setBase(path, {
			deleted: false,
			rev: 1,
			hash: await hashBytes(new Uint8Array([105, 106])),
		});
		const provider: PinnedTextProvider = {
			read: async () => null,
			readBlob: async (_path, requestEpoch, rev) => ({
				bytes: remote.slice(),
				epoch: requestEpoch,
				rev,
				hash: remoteHash,
			}),
		};
		engine = makeEngine(journal, vault, provider, {
			deviceName: "Test Device",
			now: () => now,
		});
		vault.failBinaryModifyPath = path;

		await expect(engine.apply(blobChange)).rejects.toThrow(
			"Binary write was not confirmed",
		);

		const recoveryPath = `.ai-bridge/pre-apply/${localHash}`;
		expect(journal.snapshot().pending_apply[0]?.step).toBe("copied");
		expect(vault.binaryFiles.get(recoveryPath)).toEqual(local);
		vault.mtimeByPath.set(recoveryPath, now - 8 * 24 * 60 * 60 * 1000);
		engine.close();
		const restartedJournal = await DeviceJournal.open(storage);
		const restartedEngine = makeEngine(restartedJournal, vault, provider, {
			deviceName: "Test Device",
			now: () => now,
		});

		await restartedEngine.resume();
		await restartedEngine.apply(blobChange);

		expect(vault.binaryFiles.get(path)).toEqual(remote);
		expect(vault.binaryFiles.get(recoveryPath)).toEqual(local);
		expect(vault.removedRecovery).not.toContain(recoveryPath);
		expect(restartedJournal.snapshot().pending_apply).toEqual([]);
	});

	it("retains a clean binary rename destination before replacement and restart", async () => {
		const sourcePath = "assets/missing-source.png";
		const destinationPath = "assets/clean-destination.png";
		const previous = new Uint8Array([90, 91]);
		const remote = new Uint8Array([92, 93, 94]);
		const previousHash = await hashBytes(previous);
		const remoteHash = await hashBytes(remote);
		const rename = {
			seq: 2,
			op: "rename" as const,
			path: destinationPath,
			from_path: sourcePath,
			from_etag: `"${epoch}.1"`,
			etag: `"${epoch}.2"`,
			hash: remoteHash,
			origin: "remote",
			at: 2,
		};
		vault.binaryFiles.set(destinationPath, previous.slice());
		vault.mtimeByPath.set(destinationPath, 10);
		await journal.setBase(destinationPath, {
			deleted: false,
			rev: 1,
			hash: previousHash,
		});
		const provider: PinnedTextProvider = {
			read: async () => null,
			readBlob: async (_path, requestEpoch, rev) => ({
				bytes: remote.slice(),
				epoch: requestEpoch,
				rev,
				hash: remoteHash,
			}),
		};
		engine = makeEngine(journal, vault, provider);
		vault.failBinaryModifyPath = destinationPath;

		await expect(engine.apply(rename)).rejects.toThrow(
			"Binary rename destination was not confirmed",
		);

		const preApplyPath = `.ai-bridge/pre-apply/${previousHash}`;
		expect(vault.binaryFiles.get(destinationPath)).toEqual(previous);
		expect(vault.binaryFiles.get(preApplyPath)).toEqual(previous);
		expect(journal.snapshot().pending_apply[0]?.step).toBe("copied");
		engine.close();
		const restartedJournal = await DeviceJournal.open(storage);
		const restartedEngine = makeEngine(restartedJournal, vault, provider);

		await restartedEngine.resume();

		expect(vault.binaryFiles.get(destinationPath)).toEqual(remote);
		expect(vault.binaryFiles.get(preApplyPath)).toEqual(previous);
		expect(restartedJournal.snapshot().pending_apply).toEqual([]);
	});

	it("does not trash a clean binary delete after close during stat", async () => {
		const bytes = new Uint8Array([20, 21]);
		const path = "assets/closed-delete.png";
		const hashValue = await hashBytes(bytes);
		vault.binaryFiles.set(path, bytes.slice());
		vault.mtimeByPath.set(path, 10);
		await journal.setBase(path, { deleted: false, rev: 1, hash: hashValue });
		vault.beforeSecondStat = () => engine.close();

		await expect(
			engine.apply({ ...change, op: "delete", path, hash: "" }, "blob"),
		).rejects.toThrow("Text apply engine is closed");

		expect(vault.binaryTrashes).toEqual([]);
		expect(vault.binaryFiles.get(path)).toEqual(bytes);
	});

	it("does not trash a binary rename source after close during observation", async () => {
		const source = new Uint8Array([30, 31]);
		const destination = new Uint8Array([32, 33]);
		const sourceHash = await hashBytes(source);
		const destinationHash = await hashBytes(destination);
		const rename = {
			seq: 2,
			op: "rename" as const,
			path: "assets/newer-destination.png",
			from_path: "assets/closing-source.png",
			from_etag: `"${epoch}.2"`,
			etag: `"${epoch}.3"`,
			hash: await hashBytes(new Uint8Array([34, 35])),
			origin: "remote",
			at: 3,
		};
		vault.binaryFiles.set(rename.from_path, source.slice());
		vault.binaryFiles.set(rename.path, destination.slice());
		await journal.setBase(rename.from_path, {
			deleted: false,
			rev: 1,
			hash: sourceHash,
		});
		await journal.setBase(rename.path, {
			deleted: false,
			rev: 4,
			hash: destinationHash,
		});
		let sourceReads = 0;
		vault.beforeBinaryRead = (path) => {
			if (path === rename.from_path && ++sourceReads === 2) engine.close();
		};
		engine = makeEngine(journal, vault, {
			read: async () => null,
			readBlob: async (_path, requestEpoch, rev) => ({
				bytes: source.slice(),
				epoch: requestEpoch,
				rev,
				hash: sourceHash,
			}),
		});

		await expect(engine.apply(rename)).rejects.toThrow(
			"Text apply engine is closed",
		);

		expect(vault.binaryTrashes).toEqual([]);
		expect(vault.binaryFiles.get(rename.from_path)).toEqual(source);
	});

	it("resumes a binary delete after trash succeeded before journal completion", async () => {
		const path = "assets/crash-delete.png";
		const previous = new Uint8Array([110, 111]);
		const local = new Uint8Array([112, 113]);
		const previousHash = await hashBytes(previous);
		const localHash = await hashBytes(local);
		vault.binaryFiles.set(path, local.slice());
		await journal.setBase(path, { deleted: false, rev: 1, hash: previousHash });
		engine = makeEngine(journal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(path);
			},
		});
		vault.afterBinaryTrash = () => {
			storage.failWriteState = true;
		};
		const remoteDelete = { ...change, op: "delete" as const, path, hash: "" };

		await expect(engine.apply(remoteDelete, "blob")).rejects.toThrow(
			"injected journal write failure",
		);
		expect(vault.binaryFiles.has(path)).toBe(false);
		expect(journal.snapshot().pending_apply[0]?.step).toBe("copied");
		expect(vault.binaryFiles.get(`.ai-bridge/pre-apply/${localHash}`)).toEqual(
			local,
		);
		engine.close();
		const restartedJournal = await DeviceJournal.open(storage);
		const restartedEngine = makeEngine(restartedJournal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(path);
			},
		});

		await restartedEngine.resume();

		expect(restartedJournal.snapshot().base[path]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(restartedJournal.snapshot().pending_apply).toEqual([]);
		expect(vault.binaryFiles.has(path)).toBe(false);
	});

	it("blocks copied binary delete recovery when different bytes reappear", async () => {
		const path = "assets/recreated-delete.png";
		const previous = new Uint8Array([120, 121]);
		const local = new Uint8Array([122, 123]);
		const recreated = new Uint8Array([124, 125]);
		const previousHash = await hashBytes(previous);
		vault.binaryFiles.set(path, local.slice());
		await journal.setBase(path, { deleted: false, rev: 1, hash: previousHash });
		engine = makeEngine(journal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(path);
			},
		});
		vault.afterBinaryTrash = () => {
			storage.failWriteState = true;
		};
		const remoteDelete = { ...change, op: "delete" as const, path, hash: "" };
		await expect(engine.apply(remoteDelete, "blob")).rejects.toThrow(
			"injected journal write failure",
		);
		vault.binaryFiles.set(path, recreated.slice());
		engine.close();
		const restartedJournal = await DeviceJournal.open(storage);
		const restartedEngine = makeEngine(restartedJournal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(path);
			},
		});

		await restartedEngine.resume();

		expect(vault.binaryFiles.get(path)).toEqual(recreated);
		expect(restartedJournal.snapshot().base[path]).toEqual({
			deleted: false,
			rev: 1,
			hash: previousHash,
		});
		expect(restartedJournal.snapshot().pending_apply).toHaveLength(1);
		expect(restartedJournal.snapshot().attention).toContainEqual(
			expect.objectContaining({ path }),
		);
	});

	it("copies dirty binary bytes before confirming a remote delete", async () => {
		const previous = new Uint8Array([10, 11]);
		const local = new Uint8Array([12, 13]);
		const path = "assets/dirty-delete.png";
		const remoteDelete = {
			...change,
			op: "delete" as const,
			path,
			hash: "",
		};
		const previousHash = await hashBytes(previous);
		const localHash = await hashBytes(local);
		vault.binaryFiles.set(path, local.slice());
		vault.mtimeByPath.set(path, 10);
		await journal.setBase(path, {
			deleted: false,
			rev: 1,
			hash: previousHash,
		});
		engine = makeEngine(journal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(path);
			},
		});

		await engine.apply(remoteDelete, "blob");

		const copies = [...vault.binaryFiles.entries()].filter(([copyPath]) =>
			copyPath.includes("conflict"),
		);
		expect(vault.binaryFiles.has(path)).toBe(false);
		expect(copies).toHaveLength(1);
		expect(copies[0]?.[1]).toEqual(local);
		expect(vault.binaryFiles.get(`.ai-bridge/pre-apply/${localHash}`)).toEqual(
			local,
		);
		expect(journal.snapshot().base[path]).toEqual({ deleted: true, rev: 2 });
	});

	it.each(["feed", "manifest-kind", "current"] as const)(
		"preserves invalid UTF-8 bytes when oversized Markdown changes to inline text through %s",
		async (caller) => {
			const path = "notes/invalid-large.md";
			const localBytes = new Uint8Array(1_000_001).fill(0x61);
			localBytes.set([0xc3, 0x28], 0);
			const remoteText = "new inline markdown";
			const localHash = await hashBytes(localBytes);
			const remoteHash = await hash(remoteText);
			const etag = `"${epoch}.2"`;
			vault.binaryFiles.set(path, localBytes.slice());
			vault.mtimeByPath.set(path, 10);
			const transport = new SyncTransport("https://service.test", {
				requestResponse: async () => ({
					status: 200,
					headers: { etag, "content-type": "application/json" },
					text: JSON.stringify({
						path,
						etag,
						hash: remoteHash,
						size: new TextEncoder().encode(remoteText).byteLength,
						kind: "text",
						deleted: false,
						origin: "remote",
						updated_at: 2,
						content: remoteText,
						offset: 0,
						length: remoteText.length,
						truncated: false,
					}),
				}),
			});
			await journal.resetEpoch(epoch);
			await journal.setCursor(epoch, 0);
			await journal.setBase(path, { deleted: false, rev: 1, hash: localHash });
			vault.read = async (source) => {
				const bytes = vault.binaryFiles.get(source);
				return bytes
					? new TextDecoder().decode(bytes)
					: (vault.files.get(source) ?? null);
			};
			engine = makeEngine(journal, vault, transport);

			if (caller === "current") {
				await engine.applyCurrent(path, {
					text: remoteText,
					epoch,
					rev: 2,
					hash: remoteHash,
				});
			} else {
				await engine.apply(
					{ ...change, path, etag, hash: remoteHash },
					caller === "manifest-kind" ? "text" : undefined,
				);
			}

			const conflict = [...vault.binaryFiles.entries()].find(([copyPath]) =>
				copyPath.includes("(conflict Test Device"),
			);
			expect(conflict).toBeDefined();
			expectExactBytes(conflict?.[1], localBytes);
			expectExactBytes(
				vault.binaryFiles.get(`.ai-bridge/pre-apply/${localHash}`),
				localBytes,
			);
			expect(vault.files.get(path)).toBe(remoteText);
			expect(vault.binaryFiles.has(path)).toBe(false);
			expect(journal.snapshot().base[path]).toEqual({
				deleted: false,
				rev: 2,
				hash: remoteHash,
			});
			expect(journal.snapshot().pending_apply).toEqual([]);
			expect(journal.snapshot().cursor).toBe(0);
		},
	);

	it("uses pinned text kind when an oversized Markdown file shrinks", async () => {
		const path = "notes/large.md";
		const localText = "l".repeat(1_000_001);
		const remoteText = "r".repeat(100_000);
		const remoteHash = await hash(remoteText);
		const etag = `"${epoch}.2"`;
		vault.files.set(path, localText);
		await journal.setBase(path, {
			deleted: false,
			rev: 1,
			hash: await hash(localText),
		});
		const transport = new SyncTransport("https://service.test", {
			requestResponse: async () => ({
				status: 200,
				headers: { etag, "content-type": "application/json" },
				text: JSON.stringify({
					path,
					etag,
					hash: remoteHash,
					size: new TextEncoder().encode(remoteText).byteLength,
					kind: "text",
					deleted: false,
					origin: "remote",
					updated_at: 2,
					content: remoteText,
					offset: 0,
					length: remoteText.length,
					truncated: false,
				}),
			}),
		});
		engine = makeEngine(journal, vault, transport);

		await engine.apply({ ...change, path, etag, hash: remoteHash });

		expect(vault.files.get(path)).toBe(remoteText);
		expect(journal.snapshot().base[path]).toEqual({
			deleted: false,
			rev: 2,
			hash: remoteHash,
		});
	});

	it("uses pinned blob kind when small Markdown grows beyond inline text", async () => {
		const path = "notes/growing.md";
		const localText = "previous small text";
		const remoteBytes = new Uint8Array(1_000_001).fill(0x61);
		const remoteHash = await hashBytes(remoteBytes);
		const etag = `"${epoch}.2"`;
		vault.files.set(path, localText);
		await journal.setBase(path, {
			deleted: false,
			rev: 1,
			hash: await hash(localText),
		});
		const transport = new SyncTransport("https://service.test", {
			requestResponse: async () => ({
				status: 200,
				headers: {
					etag,
					"content-type": "application/octet-stream",
					"content-length": String(remoteBytes.byteLength),
				},
				text: "",
				arrayBuffer: remoteBytes.slice().buffer,
			}),
		});
		engine = makeEngine(journal, vault, transport);

		await engine.apply({ ...change, path, etag, hash: remoteHash });

		expect(vault.binaryFiles.get(path)).toEqual(remoteBytes);
		expect(journal.snapshot().base[path]).toEqual({
			deleted: false,
			rev: 2,
			hash: remoteHash,
		});
	});

	it.each(["source", "destination", "both"] as const)(
		"preserves invalid-byte %s sides before an inline rename and resumes copied work",
		async (side) => {
			const source = "notes/inline-rename-source.md";
			const destination = "notes/inline-rename-destination.md";
			const baseText = "confirmed small text";
			const sourceBytes =
				side === "destination"
					? new TextEncoder().encode("dirty inline source")
					: new Uint8Array(1_000_001).fill(0x61);
			if (side !== "destination") sourceBytes.set([0xff, 0x28]);
			const destinationBytes =
				side === "source"
					? new TextEncoder().encode(baseText)
					: new Uint8Array(1_000_002).fill(0x62);
			if (side !== "source") destinationBytes.set([0xc3, 0x28]);
			const inlineRemote = "pinned inline rename result";
			const remoteHash = await hash(inlineRemote);
			const rename = {
				seq: 5,
				op: "rename" as const,
				path: destination,
				from_path: source,
				from_etag: `"${epoch}.2"`,
				etag: `"${epoch}.3"`,
				hash: remoteHash,
				origin: "remote",
				at: 5,
			};
			await journal.setBase(source, {
				deleted: false,
				rev: 1,
				hash: await hash(baseText),
			});
			await journal.setBase(destination, {
				deleted: false,
				rev: 1,
				hash: await hash(baseText),
			});
			if (side === "destination")
				vault.files.set(source, new TextDecoder().decode(sourceBytes));
			else vault.binaryFiles.set(source, sourceBytes.slice());
			if (side === "source") vault.files.set(destination, baseText);
			else vault.binaryFiles.set(destination, destinationBytes.slice());
			vault.read = async (path) => {
				const bytes = vault.binaryFiles.get(path);
				return bytes
					? new TextDecoder().decode(bytes)
					: (vault.files.get(path) ?? null);
			};
			const transport = new SyncTransport("https://service.test", {
				requestResponse: async () => ({
					status: 200,
					headers: { etag: rename.etag, "content-type": "application/json" },
					text: JSON.stringify({
						path: destination,
						etag: rename.etag,
						hash: remoteHash,
						size: new TextEncoder().encode(inlineRemote).byteLength,
						kind: "text",
						deleted: false,
						origin: "remote",
						updated_at: 5,
						content: inlineRemote,
						offset: 0,
						length: inlineRemote.length,
						truncated: false,
					}),
				}),
			});
			const update = journal.updateApply.bind(journal);
			journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === "copied")
					throw new Error("stop after rename copies");
			};
			engine = makeEngine(journal, vault, transport);
			await expect(engine.apply(rename)).rejects.toThrow(
				"stop after rename copies",
			);
			const copies: PendingConflictCopy[] =
				journal.snapshot().pending_apply[0]?.conflict_copies ?? [];
			const sourceCopy = copies.find((copy) => copy.side === "rename_source");
			expect(sourceCopy).toBeDefined();
			expectExactBytes(
				(await vault.readBinary(sourceCopy?.path ?? "")) ?? undefined,
				sourceBytes,
			);
			if (side !== "source") {
				const destinationCopy = copies.find(
					(copy) =>
						copy.side === "rename_destination" && copy.purpose !== "pre_apply",
				);
				expect(destinationCopy).toBeDefined();
				expectExactBytes(
					(await vault.readBinary(destinationCopy?.path ?? "")) ?? undefined,
					destinationBytes,
				);
			}
			expect(journal.snapshot().base[source]?.rev).toBe(1);
			expect(journal.snapshot().base[destination]?.rev).toBe(1);
			expect(copies.some((copy) => copy.purpose === "pre_apply")).toBe(true);
			for (const copy of copies) {
				if (copy.purpose === "pre_apply") vault.mtimeByPath.set(copy.path, 1);
			}
			journal.close();
			engine.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(journal, vault, transport);
			if (side !== "source") {
				vault.afterBinaryTrash = () => {
					if (vault.binaryTrashes.at(-1) === destination)
						throw new Error("stop after destination trash");
				};
				await expect(engine.resume()).rejects.toThrow(
					"stop after destination trash",
				);
				expect(await vault.readBinary(destination)).toBeNull();
				expect(journal.snapshot().pending_apply[0]?.conflict_copies).toEqual(
					copies,
				);
				vault.afterBinaryTrash = null;
				journal.close();
				engine.close();
				journal = await DeviceJournal.open(storage);
				engine = makeEngine(journal, vault, transport);
			}
			await engine.resume();
			await engine.resume();

			for (const copy of copies) {
				expectExactBytes(
					(await vault.readBinary(copy.path)) ?? undefined,
					copy.side === "rename_source" ? sourceBytes : destinationBytes,
				);
				if (copy.purpose === "pre_apply") {
					expect(vault.mtimeByPath.get(copy.path)).toBeGreaterThan(1);
					expect(vault.removedRecovery).not.toContain(copy.path);
				}
			}
			expectExactBytes(
				(await vault.readBinary(destination)) ?? undefined,
				new TextEncoder().encode(inlineRemote),
			);
			expect(await vault.readBinary(source)).toBeNull();
			expect(journal.snapshot().base[source]).toEqual({
				deleted: true,
				rev: 2,
			});
			expect(journal.snapshot().base[destination]).toEqual({
				deleted: false,
				rev: 3,
				hash: remoteHash,
			});
			expect(journal.snapshot().pending_apply).toEqual([]);
			expect(
				[...vault.binaryFiles.keys(), ...vault.files.keys()].filter((path) =>
					path.includes("conflict"),
				),
			).toHaveLength(side === "source" ? 1 : 2);
		},
	);

	it("does not read a pruned rename destination when only its source is pending", async () => {
		const sourcePath = "notes/source.md";
		const destinationPath = "notes/destination.md";
		const source = "source bytes";
		const sourceHash = await hash(source);
		const destinationHash = await hash("newer destination bytes");
		const rename = {
			seq: 2,
			op: "rename" as const,
			path: destinationPath,
			from_path: sourcePath,
			from_etag: `"${epoch}.2"`,
			etag: `"${epoch}.3"`,
			hash: await hash("renamed bytes"),
			origin: "remote",
			at: 3,
		};
		vault.files.set(sourcePath, source);
		await journal.setBase(sourcePath, {
			deleted: false,
			rev: 1,
			hash: sourceHash,
		});
		await journal.setBase(destinationPath, {
			deleted: false,
			rev: 4,
			hash: destinationHash,
		});
		let transportCalls = 0;
		const transport = new SyncTransport("https://service.test", {
			requestResponse: async () => {
				transportCalls += 1;
				return {
					status: 200,
					headers: {
						etag: `"${epoch}.5"`,
						"content-type": "application/json",
					},
					text: JSON.stringify({
						path: destinationPath,
						etag: `"${epoch}.5"`,
						hash: "",
						kind: "text",
						deleted: true,
						origin: "remote",
						updated_at: 5,
					}),
				};
			},
		});
		engine = makeEngine(journal, vault, transport);

		await engine.apply(rename);

		expect(transportCalls).toBe(0);
		expect(vault.files.has(sourcePath)).toBe(false);
		expect(journal.snapshot().base[sourcePath]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(journal.snapshot().base[destinationPath]).toEqual({
			deleted: false,
			rev: 4,
			hash: destinationHash,
		});
	});

	it("does not read a pruned rename destination when neither side is pending", async () => {
		const sourcePath = "notes/obsolete-source.md";
		const destinationPath = "notes/obsolete-destination.md";
		const destinationHash = await hash("newer destination bytes");
		const rename = {
			seq: 2,
			op: "rename" as const,
			path: destinationPath,
			from_path: sourcePath,
			from_etag: `"${epoch}.2"`,
			etag: `"${epoch}.3"`,
			hash: await hash("renamed bytes"),
			origin: "remote",
			at: 3,
		};
		await journal.setBase(sourcePath, { deleted: true, rev: 3 });
		await journal.setBase(destinationPath, {
			deleted: false,
			rev: 4,
			hash: destinationHash,
		});
		const transport = new SyncTransport("https://service.test", {
			requestResponse: async () => {
				throw new Error("obsolete rename must not read the destination");
			},
		});
		engine = makeEngine(journal, vault, transport);

		await engine.apply(rename);

		expect(journal.snapshot().pending_apply).toEqual([]);
		expect(journal.snapshot().base[destinationPath]).toEqual({
			deleted: false,
			rev: 4,
			hash: destinationHash,
		});
	});

	it("hydrates an absent oversized Markdown rename target from its pinned blob", async () => {
		const path = "notes/new-large.md";
		const bytes = new Uint8Array(1_000_001).fill(0x62);
		const remoteHash = await hashBytes(bytes);
		const etag = `"${epoch}.2"`;
		const rename = {
			seq: 2,
			op: "rename" as const,
			path,
			from_path: "notes/old-large.md",
			from_etag: `"${epoch}.1"`,
			etag,
			hash: remoteHash,
			origin: "remote",
			at: 2,
		};
		const transport = new SyncTransport("https://service.test", {
			requestResponse: async () => ({
				status: 200,
				headers: {
					etag,
					"content-type": "application/octet-stream",
					"content-length": String(bytes.byteLength),
				},
				text: "",
				arrayBuffer: bytes.slice().buffer,
			}),
		});
		engine = makeEngine(journal, vault, transport);

		await engine.apply(rename);

		expect(vault.binaryFiles.get(path)).toEqual(bytes);
		expect(journal.snapshot().base[path]).toEqual({
			deleted: false,
			rev: 2,
			hash: remoteHash,
		});
	});

	it("renames exact binary source bytes without text decoding", async () => {
		const source = new Uint8Array([0, 255, 2]);
		const sourceHash = await hashBytes(source);
		const rename = {
			seq: 2,
			op: "rename" as const,
			path: "assets/renamed.png",
			from_path: "assets/source.png",
			from_etag: `"${epoch}.2"`,
			etag: `"${epoch}.3"`,
			hash: sourceHash,
			origin: "remote",
			at: 3,
		};
		vault.binaryFiles.set(rename.from_path, source.slice());
		vault.mtimeByPath.set(rename.from_path, 10);
		await journal.setBase(rename.from_path, {
			deleted: false,
			rev: 1,
			hash: sourceHash,
		});
		engine = makeEngine(journal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(rename.path);
			},
			readBlob: async (_path, requestEpoch, rev, expectedHash) => ({
				bytes: source.slice(),
				epoch: requestEpoch,
				rev,
				hash: expectedHash,
			}),
		});

		await engine.apply(rename);

		expect(vault.binaryFiles.has(rename.from_path)).toBe(false);
		expect(vault.binaryFiles.get(rename.path)).toEqual(source);
		expect(journal.snapshot().base[rename.from_path]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(journal.snapshot().base[rename.path]).toEqual({
			deleted: false,
			rev: 3,
			hash: sourceHash,
		});
	});

	it("does not replace a newer confirmed binary rename destination", async () => {
		const source = new Uint8Array([41, 42]);
		const destination = new Uint8Array([43, 44]);
		const remote = new Uint8Array([45, 46]);
		const sourceHash = await hashBytes(source);
		const destinationHash = await hashBytes(destination);
		const remoteHash = await hashBytes(remote);
		const rename = {
			seq: 2,
			op: "rename" as const,
			path: "assets/newer-destination.png",
			from_path: "assets/newer-source.png",
			from_etag: `"${epoch}.2"`,
			etag: `"${epoch}.3"`,
			hash: remoteHash,
			origin: "remote",
			at: 3,
		};
		vault.binaryFiles.set(rename.from_path, source.slice());
		vault.binaryFiles.set(rename.path, destination.slice());
		vault.mtimeByPath.set(rename.from_path, 10);
		vault.mtimeByPath.set(rename.path, 11);
		await journal.setBase(rename.from_path, {
			deleted: false,
			rev: 1,
			hash: sourceHash,
		});
		await journal.setBase(rename.path, {
			deleted: false,
			rev: 4,
			hash: destinationHash,
		});
		engine = makeEngine(journal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(rename.path);
			},
			readBlob: async (_path, requestEpoch, rev) => ({
				bytes: remote.slice(),
				epoch: requestEpoch,
				rev,
				hash: remoteHash,
			}),
		});

		await engine.apply(rename);

		expect(vault.binaryFiles.get(rename.path)).toEqual(destination);
		expect(journal.snapshot().base[rename.path]).toEqual({
			deleted: false,
			rev: 4,
			hash: destinationHash,
		});
	});

	it("preserves dirty binary rename bytes and applies the remote source and destination effects", async () => {
		const source = new Uint8Array([41, 42]);
		const remote = new Uint8Array([43, 44]);
		const baseHash = await hashBytes(new Uint8Array([39, 40]));
		const remoteHash = await hashBytes(remote);
		const rename = {
			seq: 2,
			op: "rename" as const,
			path: "assets/dirty-renamed.png",
			from_path: "assets/dirty-source.png",
			from_etag: `"${epoch}.2"`,
			etag: `"${epoch}.3"`,
			hash: remoteHash,
			origin: "remote",
			at: 3,
		};
		vault.binaryFiles.set(rename.from_path, source.slice());
		vault.mtimeByPath.set(rename.from_path, 10);
		await journal.setBase(rename.from_path, {
			deleted: false,
			rev: 1,
			hash: baseHash,
		});
		engine = makeEngine(journal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(rename.path);
			},
			readBlob: async (_path, requestEpoch, rev) => ({
				bytes: remote.slice(),
				epoch: requestEpoch,
				rev,
				hash: remoteHash,
			}),
		});

		await engine.apply(rename);

		expect(vault.binaryFiles.has(rename.from_path)).toBe(false);
		expect(vault.binaryFiles.get(rename.path)).toEqual(remote);
		expect(
			[...vault.binaryFiles.entries()].some(
				([path, bytes]) =>
					path.includes("conflict") &&
					bytes.byteLength === source.byteLength &&
					bytes.every((byte, index) => byte === source[index]),
			),
		).toBe(true);
		expect(journal.snapshot().attention).toContainEqual(
			expect.objectContaining({ path: rename.path }),
		);
	});

	it("rebases a pruned blob to the exact current pinned bytes", async () => {
		const oldBytes = new Uint8Array([31, 32]);
		const currentBytes = new Uint8Array([33, 34]);
		const oldHash = await hashBytes(oldBytes);
		const currentHash = await hashBytes(currentBytes);
		const blobChange = {
			...change,
			path: "notes/rebased.png",
			hash: oldHash,
		};
		const calls: number[] = [];
		vault.createBinary = async (path, bytes) => {
			if (vault.binaryFiles.has(path)) return false;
			vault.binaryFiles.set(path, bytes.slice());
			return true;
		};
		engine = makeEngine(journal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(blobChange.path);
			},
			readResolvedBlob: async (_path, requestEpoch, rev) => {
				calls.push(rev);
				return {
					kind: "blob",
					bytes: currentBytes.slice(),
					epoch: requestEpoch,
					rev: 3,
					hash: currentHash,
				};
			},
		});

		await engine.apply(blobChange);

		expect(calls).toEqual([2, 3]);
		expect(vault.binaryFiles.get(blobChange.path)).toEqual(currentBytes);
		expect(journal.snapshot().base[blobChange.path]).toEqual({
			deleted: false,
			rev: 3,
			hash: currentHash,
		});
	});

	it("reuses copied blob plans when pruning supplies newer inline authority", async () => {
		const path = "notes/copied-kind-change.md";
		const local = new Uint8Array(1_000_001).fill(0x61);
		local.set([0xff, 0x28]);
		const oldRemote = new Uint8Array(1_000_002).fill(0x62);
		const oldHash = await hashBytes(oldRemote);
		const currentText = "current inline bytes";
		const currentHash = await hash(currentText);
		const remoteChange = { ...change, path, hash: oldHash };
		vault.binaryFiles.set(path, local.slice());
		await journal.setBase(path, {
			deleted: false,
			rev: 1,
			hash: await hash("confirmed before local edit"),
		});
		const update = journal.updateApply.bind(journal);
		journal.updateApply = async (pending) => {
			await update(pending);
			if (pending.step === "copied") throw new Error("stop after copied blob");
		};
		engine = makeEngine(journal, vault, {
			read: async () => null,
			readResolvedBlob: async () => ({
				kind: "blob",
				bytes: oldRemote,
				epoch,
				rev: 2,
				hash: oldHash,
			}),
		});
		await expect(engine.apply(remoteChange, "blob")).rejects.toThrow(
			"stop after copied blob",
		);
		const copies = journal.snapshot().pending_apply[0]?.conflict_copies;
		expect(copies).toHaveLength(2);
		for (const copy of copies ?? [])
			expectExactBytes(vault.binaryFiles.get(copy.path), local);
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, {
			read: async () => currentText,
			readResolved: async () => ({
				text: currentText,
				epoch,
				rev: 3,
				hash: currentHash,
			}),
			readResolvedBlob: async () => ({
				kind: "text",
				text: currentText,
				epoch,
				rev: 3,
				hash: currentHash,
			}),
		});

		await engine.resume();
		await engine.resume();

		for (const copy of copies ?? [])
			expectExactBytes(vault.binaryFiles.get(copy.path), local);
		expect(
			[...vault.binaryFiles.keys()].filter((name) => name.includes("conflict")),
		).toHaveLength(1);
		expect(vault.binaryFiles.has(path)).toBe(false);
		expect(vault.files.get(path)).toBe(currentText);
		expect(journal.snapshot().base[path]).toEqual({
			deleted: false,
			rev: 3,
			hash: currentHash,
		});
		expect(journal.snapshot().pending_apply).toEqual([]);
	});

	it("applies current text when a pruned blob path changed content kind", async () => {
		const currentText = "current inline bytes";
		const currentHash = await hash(currentText);
		const blobChange = {
			...change,
			path: "notes/kind-change.png",
			hash: "c".repeat(64),
		};
		engine = makeEngine(journal, vault, {
			read: async (_path, _requestEpoch, rev) =>
				rev === 3 ? currentText : null,
			readResolved: async (_path, requestEpoch, rev) => ({
				deleted: false,
				text: currentText,
				epoch: requestEpoch,
				rev,
				hash: currentHash,
			}),
			readResolvedBlob: async (_path, requestEpoch) => ({
				kind: "text",
				text: currentText,
				epoch: requestEpoch,
				rev: 3,
				hash: currentHash,
			}),
		});

		await engine.apply(blobChange);

		expect(vault.files.get(blobChange.path)).toBe(currentText);
		expect(journal.snapshot().base[blobChange.path]).toEqual({
			deleted: false,
			rev: 3,
			hash: currentHash,
		});
	});

	it("prunes only verified recovery copies older than seven days", async () => {
		const expired = new Uint8Array([11, 12]);
		const recent = new Uint8Array([13, 14]);
		const expiredHash = await hashBytes(expired);
		const recentHash = await hashBytes(recent);
		const expiredPath = `.ai-bridge/pre-apply/${expiredHash}`;
		const recentPath = `.ai-bridge/pre-apply/${recentHash}`;
		vault.binaryFiles.set(expiredPath, expired);
		vault.binaryFiles.set(recentPath, recent);
		vault.mtimeByPath.set(expiredPath, Date.now() - 8 * 24 * 60 * 60 * 1000);
		vault.mtimeByPath.set(recentPath, Date.now() - 6 * 24 * 60 * 60 * 1000);

		await engine.resume();

		expect(vault.binaryFiles.has(expiredPath)).toBe(false);
		expect(vault.binaryFiles.get(recentPath)).toEqual(recent);
		expect(vault.removedRecovery).toEqual([expiredPath]);
	});

	it("protects recovery copies referenced by a pending apply from cleanup", async () => {
		const localBytes = new Uint8Array([21, 22]);
		const remoteBytes = new Uint8Array([23, 24]);
		const localHash = await hashBytes(localBytes);
		const remoteHash = await hashBytes(remoteBytes);
		const path = "notes/pending.png";
		const conflictPath =
			"notes/pending (conflict Test Device 1970-01-01 0000 r2).png";
		const recoveryPath = `.ai-bridge/pre-apply/${localHash}`;
		const blobChange = { ...change, path, hash: remoteHash };
		await journal.beginApply(blobChange);
		await journal.updateApply({
			change: blobChange,
			step: "named",
			conflict_copies: [
				{
					path: conflictPath,
					source: path,
					side: "path",
					mode: "local",
					device_name: "Test Device",
					hash: localHash,
					kind: "blob",
					purpose: "conflict",
				},
				{
					path: recoveryPath,
					source: path,
					side: "path",
					mode: "local",
					device_name: "Test Device",
					hash: localHash,
					kind: "blob",
					purpose: "pre_apply",
				},
			],
		});
		for (const copyPath of [path, conflictPath, recoveryPath]) {
			vault.binaryFiles.set(copyPath, localBytes.slice());
			vault.mtimeByPath.set(copyPath, Date.now() - 8 * 24 * 60 * 60 * 1000);
		}
		vault.mtimeByPath.set(path, 10);
		engine = makeEngine(journal, vault, {
			read: async () => {
				throw new UnsupportedRemoteTextError(path);
			},
			readBlob: async (_path, requestEpoch, rev) => ({
				bytes: remoteBytes.slice(),
				epoch: requestEpoch,
				rev,
				hash: remoteHash,
			}),
		});

		await engine.resume();

		expect(vault.binaryFiles.has(recoveryPath)).toBe(true);
		expect(vault.removedRecovery).not.toContain(recoveryPath);
		expect(vault.mtimeByPath.get(recoveryPath)).toBeGreaterThan(
			Date.now() - 7 * 24 * 60 * 60 * 1000,
		);
		expect(vault.binaryFiles.get(path)).toEqual(remoteBytes);
	});

	it("replaces a pruned revision identity before applying current bytes", async () => {
		const newerText = "current revision bytes";
		const newerHash = await hash(newerText);
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		engine = makeEngine(journal, vault, {
			read: async () => null,
			readResolved: async () => ({
				text: newerText,
				epoch,
				rev: 3,
				hash: newerHash,
			}),
		});
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(newerText);
		expect(journal.snapshot().base[change.path]).toEqual({
			deleted: false,
			rev: 3,
			hash: newerHash,
		});
	});

	it("applies a current tombstone after a pruned put revision", async () => {
		const baseText = "confirmed before prune";
		vault.files.set(change.path, baseText);
		journal = await seedBase(
			change.path,
			await hash(baseText),
			storage,
			journal,
		);
		engine = makeEngine(journal, vault, {
			read: async () => null,
			readResolved: async () => ({
				deleted: true,
				text: null,
				epoch,
				rev: 3,
				hash: "",
			}),
		});

		await engine.apply(change);

		expect(vault.files.has(change.path)).toBe(false);
		expect(journal.snapshot().base[change.path]).toEqual({
			deleted: true,
			rev: 3,
		});
		expect(journal.snapshot().pending_apply).toEqual([]);
	});

	it("rebases a pruned pinned row after a saved conflict name", async () => {
		const oldText = "remote pinned bytes";
		const currentText = "remote current bytes";
		const currentHash = await hash(currentText);
		const localText = "local dirty bytes";
		vault.files.set(change.path, localText);
		journal = await seedBase(
			change.path,
			await hash("previous base"),
			storage,
			journal,
		);
		const updateApply = journal.updateApply.bind(journal);
		journal.updateApply = async (pending) => {
			await updateApply(pending);
			if (pending.step === "named")
				throw new Error("simulated stop after conflict name");
		};
		engine = makeEngine(journal, vault, {
			read: async () => oldText,
			readResolved: async () => ({
				text: oldText,
				epoch,
				rev: 2,
				hash: await hash(oldText),
			}),
		});
		const oldChange = { ...change, hash: await hash(oldText) };
		await expect(engine.apply(oldChange)).rejects.toThrow("simulated stop");
		expect(journal.snapshot().pending_apply[0]?.step).toBe("named");
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, {
			read: async () => null,
			readResolved: async () => ({
				text: currentText,
				epoch,
				rev: 3,
				hash: currentHash,
			}),
		});
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(currentText);
		expect([...vault.files.values()]).toContain(localText);
		expect(journal.snapshot().pending_apply).toEqual([]);
		expect(journal.snapshot().base[change.path]).toEqual({
			deleted: false,
			rev: 3,
			hash: currentHash,
		});
	});

	it("applies pinned text only when current bytes match the confirmed base", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]).toEqual({
			deleted: false,
			rev: 2,
			hash: change.hash,
		});
	});

	it("resumes a copied conflict after a crash before the remote effect", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		const update = journal.updateApply.bind(journal);
		journal.updateApply = async (pending) => {
			await update(pending);
			if (pending.step === "copied")
				throw new Error("simulated crash after copied");
		};
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		vault.beforeProcess = () => {
			vault.files.set(change.path, "user bytes");
			vault.beforeProcess = null;
		};
		await expect(engine.apply(change)).rejects.toThrow(
			"simulated crash after copied",
		);
		expect(journal.snapshot().pending_apply[0]?.step).toBe("copied");
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect([...vault.files.values()]).toContain("user bytes");
		expect(journal.snapshot().pending_apply).toEqual([]);
	});

	it("keeps local bytes when a conflict copy changes during pinned fetch", async () => {
		const localText = "user bytes";
		vault.files.set(change.path, localText);
		engine = makeEngine(journal, vault, {
			read: async () => {
				const copyPath = [...vault.files.keys()].find((path) =>
					path.includes("(conflict "),
				);
				if (copyPath) vault.files.set(copyPath, "edited copy");
				return remoteText;
			},
		});
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(localText);
		expect(journal.snapshot().attention).toContainEqual({
			path: change.path,
			reason: "Conflict copy changed during remote apply",
		});
	});

	it("recovers a confirmed file effect before its base commit", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		journal.completeApply = async () => {
			throw new Error("simulated crash before base commit");
		};
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await expect(engine.apply(change)).rejects.toThrow(
			"simulated crash before base commit",
		);
		expect(vault.files.get(change.path)).toBe(remoteText);
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.resume();
		expect(journal.snapshot().base[change.path]?.rev).toBe(2);
		expect(journal.snapshot().pending_apply).toEqual([]);
	});

	it("does not overwrite an edited conflict copy after restart", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		vault.beforeProcess = () => {
			vault.files.set(change.path, "user bytes");
			vault.beforeProcess = null;
		};
		const create = vault.create.bind(vault);
		vault.create = async (path, text) => {
			await create(path, text);
			throw new Error("simulated crash after conflict create");
		};
		await expect(engine.apply(change)).rejects.toThrow("simulated crash");
		const conflictPath =
			journal.snapshot().pending_apply[0]?.conflict_copies?.[0]?.path;
		expect(conflictPath).toBeDefined();
		vault.files.set(conflictPath as string, "edited copy");
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.resume();
		expect(vault.files.get(conflictPath as string)).toBe("edited copy");
		expect(vault.files.get(change.path)).toBe("user bytes");
		expect(journal.snapshot().attention).toContainEqual({
			path: change.path,
			reason: "Conflict copy was edited before the apply finished",
		});
	});

	it("does not commit stale apply state after lifecycle close during a host effect", async () => {
		let markStarted: (() => void) | undefined;
		let release: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		vault.create = async (path, text) => {
			markStarted?.();
			await gate;
			vault.files.set(path, text);
			return true;
		};
		const applying = engine.apply(change);
		await started;
		engine.close();
		release?.();
		await expect(applying).rejects.toThrow("closed");
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]).toBeUndefined();
		expect(journal.snapshot().pending_apply).toHaveLength(1);
	});

	it("resumes a prepared entry after a restart", async () => {
		await journal.beginApply(change);
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]?.rev).toBe(2);
	});

	it("applies a clean destination-only rename without a conflict copy", async () => {
		const destinationBaseText = "clean destination bytes";
		vault.files.set("notes/b.md", destinationBaseText);
		journal = await seedBase(
			"notes/b.md",
			await hash(destinationBaseText),
			storage,
			journal,
		);
		engine = makeEngine(
			journal,
			vault,
			{ read: async (_path, _epoch, rev) => (rev === 3 ? remoteText : null) },
			{ deviceName: "Moises Mac" },
		);
		await engine.apply({
			...change,
			op: "rename",
			path: "notes/b.md",
			hash: await hash(remoteText),
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		});
		expect(vault.files.get("notes/b.md")).toBe(remoteText);
		expect(
			[...vault.files.keys()].some((path) => path.includes("(conflict ")),
		).toBe(false);
		expect(journal.snapshot().base["notes/b.md"]).toEqual({
			deleted: false,
			rev: 3,
			hash: await hash(remoteText),
		});
	});

	it("does not commit a source tombstone when trash refuses a remote-equal destination rename", async () => {
		vault.files.set("notes/a.md", remoteText);
		vault.files.set("notes/b.md", remoteText);
		journal = await seedBase(
			"notes/a.md",
			await hash(remoteText),
			storage,
			journal,
		);
		vault.refuseTrash = (path) => path === "notes/a.md";
		engine = makeEngine(
			journal,
			vault,
			{ read: async () => remoteText },
			{ deviceName: "Moises Mac" },
		);
		await engine.apply({
			...change,
			op: "rename",
			path: "notes/b.md",
			hash: await hash(remoteText),
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		});
		expect(vault.files.get("notes/a.md")).toBe(remoteText);
		expect(journal.snapshot().base["notes/a.md"]).toEqual({
			deleted: false,
			rev: 1,
			hash: await hash(remoteText),
		});
		expect(journal.snapshot().pending_apply).toHaveLength(1);
		expect(journal.snapshot().attention).toHaveLength(1);
	});

	it("does not commit a source tombstone when trash refuses after a rename destination write", async () => {
		vault.files.set("notes/a.md", remoteText);
		journal = await seedBase(
			"notes/a.md",
			await hash(remoteText),
			storage,
			journal,
		);
		vault.rename = async () => false;
		vault.refuseTrash = (path) => path === "notes/a.md";
		engine = makeEngine(
			journal,
			vault,
			{ read: async () => remoteText },
			{ deviceName: "Moises Mac" },
		);
		await engine.apply({
			...change,
			op: "rename",
			path: "notes/b.md",
			hash: await hash(remoteText),
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		});
		expect(vault.files.get("notes/a.md")).toBe(remoteText);
		expect(vault.files.get("notes/b.md")).toBe(remoteText);
		expect(journal.snapshot().base["notes/a.md"]?.rev).toBe(1);
		expect(journal.snapshot().pending_apply).toHaveLength(1);
		expect(journal.snapshot().attention).toHaveLength(1);
	});

	it("keeps a source visible and pending when trash refuses during rename recovery", async () => {
		const source = "dirty source bytes";
		vault.files.set("notes/a.md", source);
		journal = await seedBase(
			"notes/a.md",
			await hash("older source"),
			storage,
			journal,
		);
		vault.refuseTrash = (path) => path === "notes/a.md";
		engine = makeEngine(
			journal,
			vault,
			{ read: async () => remoteText },
			{ deviceName: "Moises Mac" },
		);
		await engine.apply({
			...change,
			op: "rename",
			path: "notes/b.md",
			hash: await hash(remoteText),
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		});
		expect(vault.files.get("notes/a.md")).toBe(source);
		expect(journal.snapshot().base["notes/a.md"]?.rev).toBe(1);
		expect(journal.snapshot().pending_apply).toHaveLength(1);
		expect(journal.snapshot().attention).toHaveLength(1);
	});

	it("keeps conflict naming metadata stable after restart and engine option changes", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		const update = journal.updateApply.bind(journal);
		journal.updateApply = async (pending) => {
			await update(pending);
			if (pending.step === "named")
				throw new Error("simulated stop after naming");
		};
		engine = makeEngine(
			journal,
			vault,
			{ read: async () => remoteText },
			{ deviceName: "Moises Mac" },
		);
		vault.beforeProcess = () => {
			vault.files.set(change.path, "dirty local bytes");
			vault.beforeProcess = null;
		};
		await expect(engine.apply(change)).rejects.toThrow(
			"simulated stop after naming",
		);
		const pending = journal.snapshot().pending_apply[0];
		expect(pending?.conflict_copies?.[0]?.device_name).toBe("Moises Mac");
		const conflictPath = pending?.conflict_copies?.[0]?.path;
		expect(conflictPath).toContain("(conflict Moises Mac ");
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(
			journal,
			vault,
			{ read: async () => remoteText },
			{ deviceName: "Other Name" },
		);
		await engine.resume();
		expect(
			[...vault.files.keys()].filter((path) => path === conflictPath),
		).toHaveLength(1);
		expect(journal.snapshot().pending_apply).toEqual([]);
	});

	it("fences pinned fetch completion and queued apply work after close", async () => {
		let markStarted: (() => void) | undefined;
		let release: ((text: string) => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const fetch = new Promise<string>((resolve) => {
			release = resolve;
		});
		engine = makeEngine(
			journal,
			vault,
			{
				read: async () => {
					markStarted?.();
					return fetch;
				},
			},
			{ deviceName: "Moises Mac" },
		);
		vault.files.set(change.path, remoteText);
		const first = engine.apply(change);
		await started;
		const second = engine.apply({ ...change, seq: 2, path: "notes/queued.md" });
		engine.close();
		release?.(remoteText);
		await expect(first).rejects.toThrow("closed");
		await expect(second).rejects.toThrow("closed");
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]).toBeUndefined();
		expect(journal.snapshot().pending_apply[0]?.step).toBe("prepared");
		expect(journal.snapshot().base["notes/queued.md"]).toBeUndefined();
	});

	it("keeps a newer rename destination base while applying only the dirty source side", async () => {
		const oldHash = await hash("base source");
		vault.files.set("notes/a.md", "edited source");
		journal = await seedBase("notes/a.md", oldHash, storage, journal);
		const state = journal.snapshot();
		state.base["notes/b.md"] = {
			deleted: false,
			rev: 5,
			hash: await hash("newer destination"),
		};
		storage.state = state;
		journal = await DeviceJournal.open(storage);
		const rename = {
			...change,
			op: "rename" as const,
			path: "notes/b.md",
			hash: await hash("renamed remote"),
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		};
		vault.files.set(rename.path, "newer destination");
		engine = makeEngine(journal, vault, { read: async () => null });
		await engine.apply(rename);
		expect(vault.files.get("notes/b.md")).toBe("newer destination");
		expect(vault.files.has("notes/a.md")).toBe(false);
		expect(journal.snapshot().base["notes/a.md"]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(journal.snapshot().base["notes/b.md"]?.rev).toBe(5);
	});

	it.each([
		{ op: "delete", step: "named" },
		{ op: "delete", step: "copied" },
		{ op: "rename", step: "named" },
		{ op: "rename", step: "copied" },
	] as const)(
		"recovers a local $op conflict at persisted $step after restart",
		async ({ op, step }) => {
			const source = "dirty local source";
			vault.files.set("notes/a.md", source);
			journal = await seedBase(
				"notes/a.md",
				await hash("old source"),
				storage,
				journal,
			);
			const update = journal.updateApply.bind(journal);
			journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === step) throw new Error(`stopped at ${step}`);
			};
			engine = makeEngine(
				journal,
				vault,
				{ read: async () => remoteText },
				{ deviceName: "Moises Mac" },
			);
			const changeToApply =
				op === "delete"
					? { ...change, op: "delete" as const, hash: "" }
					: {
							...change,
							op: "rename" as const,
							path: "notes/b.md",
							from_path: "notes/a.md",
							from_etag: `"${epoch}.2"`,
						};
			await expect(engine.apply(changeToApply)).rejects.toThrow(
				`stopped at ${step}`,
			);
			expect(journal.snapshot().pending_apply[0]?.step).toBe(step);
			journal.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await engine.resume();
			expect(journal.snapshot().pending_apply).toEqual([]);
			if (op === "delete") {
				expect(journal.snapshot().base["notes/a.md"]).toEqual({
					deleted: true,
					rev: 2,
				});
			} else {
				expect(journal.snapshot().base["notes/a.md"]).toEqual({
					deleted: true,
					rev: 2,
				});
				expect(journal.snapshot().base["notes/b.md"]).toEqual({
					deleted: false,
					rev: 2,
					hash: await hash(remoteText),
				});
			}
		},
	);

	it.each(["named", "copied"] as const)(
		"recovers a persisted remote %s conflict step after restart",
		async (step) => {
			const collidingPath = "notes/CAFÉ.md";
			vault.files.set(collidingPath, "local collision bytes");
			const update = journal.updateApply.bind(journal);
			journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === step) throw new Error(`stopped at ${step}`);
			};
			engine = makeEngine(
				journal,
				vault,
				{ read: async () => remoteText },
				{ deviceName: "Moises Mac" },
			);
			await expect(
				engine.apply({ ...change, path: "notes/café.md" }),
			).rejects.toThrow(`stopped at ${step}`);
			const pending = journal.snapshot().pending_apply[0];
			expect(pending?.step).toBe(step);
			expect(pending?.conflict_copies?.[0]?.device_name).toBe("Moises Mac");
			const conflictPath = pending?.conflict_copies?.[0]?.path;
			expect(conflictPath).toContain("(conflict Moises Mac ");
			journal.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(
				journal,
				vault,
				{ read: async () => remoteText },
				{ deviceName: "Other Name" },
			);
			await engine.resume();
			expect(vault.files.get(conflictPath as string)).toBe(remoteText);
			expect(journal.snapshot().pending_apply).toEqual([]);
			expect(journal.snapshot().base["notes/café.md"]?.rev).toBe(2);
		},
	);

	it.each([false, true])(
		"rebases an unsaved or verified remote conflict copy after pruning (saved=%s)",
		async (saved) => {
			const collidingPath = "notes/CAFÉ.md";
			const applyPath = "notes/café.md";
			const currentText = "new current remote bytes";
			vault.files.set(collidingPath, "local collision bytes");
			const update = journal.updateApply.bind(journal);
			journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === "named") throw new Error("stopped at named");
			};
			engine = makeEngine(
				journal,
				vault,
				{ read: async () => remoteText },
				{ deviceName: "Test Device" },
			);
			await expect(
				engine.apply({ ...change, path: applyPath }),
			).rejects.toThrow("stopped at named");
			const oldCopy = journal.snapshot().pending_apply[0]?.conflict_copies?.[0];
			expect(oldCopy?.mode).toBe("remote");
			if (saved && oldCopy) vault.files.set(oldCopy.path, remoteText);
			journal.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(journal, vault, {
				read: async () => null,
				readResolved: async () => ({
					text: currentText,
					epoch,
					rev: 3,
					hash: await hash(currentText),
				}),
			});

			await engine.resume();

			expect(vault.files.get(collidingPath)).toBe("local collision bytes");
			if (saved) expect(vault.files.get(oldCopy?.path ?? "")).toBe(remoteText);
			const visibleRemote = [...vault.files.entries()].filter(
				([path]) => path.includes("(conflict ") && path !== oldCopy?.path,
			);
			expect(visibleRemote).toHaveLength(1);
			expect(visibleRemote[0]?.[1]).toBe(currentText);
			expect(journal.snapshot().pending_apply).toEqual([]);
			expect(journal.snapshot().base[applyPath]).toEqual({
				deleted: false,
				rev: 3,
				hash: await hash(currentText),
			});
		},
	);

	it.each([false, true])(
		"applies a pruned current tombstone around a remote conflict plan (saved=%s)",
		async (saved) => {
			const collidingPath = "notes/CAFÉ.md";
			const applyPath = "notes/café.md";
			vault.files.set(collidingPath, "local collision bytes");
			const update = journal.updateApply.bind(journal);
			journal.updateApply = async (pending) => {
				await update(pending);
				if (pending.step === "named") throw new Error("stopped at named");
			};
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await expect(
				engine.apply({ ...change, path: applyPath }),
			).rejects.toThrow("stopped at named");
			const oldCopy = journal.snapshot().pending_apply[0]?.conflict_copies?.[0];
			if (saved && oldCopy) vault.files.set(oldCopy.path, remoteText);
			journal.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(journal, vault, {
				read: async () => null,
				readResolved: async () => ({
					deleted: true,
					text: null,
					epoch,
					rev: 3,
					hash: "",
				}),
			});

			await engine.resume();

			expect(vault.files.get(collidingPath)).toBe("local collision bytes");
			if (saved) expect(vault.files.get(oldCopy?.path ?? "")).toBe(remoteText);
			expect(journal.snapshot().base[applyPath]).toEqual({
				deleted: true,
				rev: 3,
			});
			expect(journal.snapshot().pending_apply).toEqual([]);
		},
	);

	it("preserves a case-folded path collision and stores pinned remote text as a conflict copy", async () => {
		const collidingPath = "notes/CAFÉ.md";
		vault.files.set(collidingPath, "local collision bytes");
		await engine.apply({ ...change, path: "notes/café.md" });
		expect(vault.files.get(collidingPath)).toBe("local collision bytes");
		const copies = [...vault.files.entries()].filter(([path]) =>
			path.includes("(conflict "),
		);
		expect(copies).toHaveLength(1);
		expect(copies[0]?.[1]).toBe(remoteText);
		expect(journal.snapshot().attention).toContainEqual({
			path: "notes/café.md",
			reason:
				"Remote path collides with a local case-folded or Unicode-equivalent path",
		});
	});

	it("preserves text that races an absent-path create", async () => {
		const create = vault.create.bind(vault);
		let raced = false;
		vault.create = async (path, text) => {
			if (!raced && path === change.path) {
				raced = true;
				vault.files.set(path, "raced local text");
				return false;
			}
			return create(path, text);
		};
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect([...vault.files.values()]).toContain("raced local text");
		expect(
			[...vault.files.keys()].filter((path) => path.includes("(conflict ")),
		).toHaveLength(1);
	});

	it("updates the base for identical bytes without a conflict copy", async () => {
		vault.files.set(change.path, remoteText);
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect(journal.snapshot().base[change.path]).toEqual({
			deleted: false,
			rev: 2,
			hash: change.hash,
		});
		expect(vault.files.size).toBe(1);
	});

	it.each(["put", "delete"] as const)(
		"rechecks an obsolete %s after a crash before ignore",
		async (op) => {
			const newerText = "revision three bytes";
			vault.files.set(change.path, newerText);
			journal = await seedBase(
				change.path,
				await hash(newerText),
				storage,
				journal,
			);
			const state = journal.snapshot();
			state.base[change.path] = {
				deleted: false,
				rev: 3,
				hash: await hash(newerText),
			};
			journal.close();
			storage.state = state;
			journal = await DeviceJournal.open(storage);
			const ignore = journal.ignoreApply.bind(journal);
			journal.ignoreApply = async (..._args) => {
				throw new Error("simulated crash before ignore");
			};
			const obsolete = {
				...change,
				op,
				hash: op === "put" ? change.hash : "",
			};
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await expect(engine.apply(obsolete)).rejects.toThrow(
				"simulated crash before ignore",
			);
			expect(journal.snapshot().pending_apply[0]?.step).toBe("prepared");
			journal.ignoreApply = ignore;
			journal.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await engine.resume();
			expect(vault.files.get(change.path)).toBe(newerText);
			expect(journal.snapshot().base[change.path]).toEqual({
				deleted: false,
				rev: 3,
				hash: await hash(newerText),
			});
			expect(journal.snapshot().pending_apply).toEqual([]);
		},
	);

	it("keeps changed bytes visible when a copied delete resumes", async () => {
		const original = "dirty before delete";
		const changed = "edited after copied";
		vault.files.set(change.path, original);
		journal = await seedBase(
			change.path,
			await hash("older base"),
			storage,
			journal,
		);
		const update = journal.updateApply.bind(journal);
		journal.updateApply = async (pending) => {
			await update(pending);
			if (pending.step === "copied") throw new Error("crash after copied");
		};
		engine = makeEngine(journal, vault, { read: async () => null });
		await expect(
			engine.apply({ ...change, op: "delete", hash: "" }),
		).rejects.toThrow("crash after copied");
		vault.files.set(change.path, changed);
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, { read: async () => null });
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(changed);
		expect(
			[...vault.files.entries()].some(
				([path, text]) => path.includes("(conflict ") && text === original,
			),
		).toBe(true);
		expect(journal.snapshot().base[change.path]?.rev).toBe(1);
		expect(journal.snapshot().pending_apply).toHaveLength(1);
		expect(journal.snapshot().attention).toContainEqual({
			path: change.path,
			reason: "Local text changed after its conflict copy was saved",
		});
	});

	it("keeps recreated bytes visible after trash and before delete base commit", async () => {
		const original = "dirty before delete";
		const recreated = "recreated after trash";
		vault.files.set(change.path, original);
		journal = await seedBase(
			change.path,
			await hash("older base"),
			storage,
			journal,
		);
		journal.completeApply = async () => {
			throw new Error("crash after trash before base commit");
		};
		engine = makeEngine(journal, vault, { read: async () => null });
		await expect(
			engine.apply({ ...change, op: "delete", hash: "" }),
		).rejects.toThrow("crash after trash before base commit");
		expect(vault.files.has(change.path)).toBe(false);
		vault.files.set(change.path, recreated);
		journal.close();
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, { read: async () => null });
		await engine.resume();
		expect(vault.files.get(change.path)).toBe(recreated);
		expect(
			[...vault.files.entries()].some(
				([path, text]) => path.includes("(conflict ") && text === original,
			),
		).toBe(true);
		expect(journal.snapshot().base[change.path]?.rev).toBe(1);
		expect(journal.snapshot().pending_apply).toHaveLength(1);
		expect(journal.snapshot().attention).toContainEqual({
			path: change.path,
			reason: "Local text changed after its conflict copy was saved",
		});
	});

	it("preserves distinct dirty rename sides and applies the pinned destination", async () => {
		const sourceText = "dirty source bytes";
		const destinationText = "dirty destination bytes";
		const sourcePath = "notes/a.md";
		const destinationPath = "notes/b.md";
		vault.files.set(sourcePath, sourceText);
		vault.files.set(destinationPath, destinationText);
		journal = await seedBase(
			sourcePath,
			await hash("source base"),
			storage,
			journal,
		);
		const state = journal.snapshot();
		state.base[destinationPath] = {
			deleted: false,
			rev: 1,
			hash: await hash("destination base"),
		};
		journal.close();
		storage.state = state;
		journal = await DeviceJournal.open(storage);
		const rename = {
			...change,
			op: "rename" as const,
			path: destinationPath,
			hash: await hash(remoteText),
			etag: `"${epoch}.3"`,
			from_path: sourcePath,
			from_etag: `"${epoch}.2"`,
		};
		engine = makeEngine(journal, vault, { read: async () => remoteText });
		await engine.apply(rename);
		const conflictFiles = [...vault.files.entries()].filter(([path]) =>
			path.includes("(conflict "),
		);
		expect(conflictFiles).toHaveLength(2);
		expect(conflictFiles.map(([, text]) => text).sort()).toEqual(
			[sourceText, destinationText].sort(),
		);
		expect(vault.files.get(destinationPath)).toBe(remoteText);
		expect(vault.files.has(sourcePath)).toBe(false);
		expect(journal.snapshot().base[sourcePath]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(journal.snapshot().base[destinationPath]).toEqual({
			deleted: false,
			rev: 3,
			hash: await hash(remoteText),
		});
	});

	it.each(["named", "source_copy", "destination_copy", "copied"] as const)(
		"resumes dual-dirty rename after the %s boundary",
		async (boundary) => {
			const sourceText = "dirty source bytes";
			const destinationText = "dirty destination bytes";
			const sourcePath = "notes/a.md";
			const destinationPath = "notes/b.md";
			vault.files.set(sourcePath, sourceText);
			vault.files.set(destinationPath, destinationText);
			journal = await seedBase(
				sourcePath,
				await hash("source base"),
				storage,
				journal,
			);
			const state = journal.snapshot();
			state.base[destinationPath] = {
				deleted: false,
				rev: 1,
				hash: await hash("destination base"),
			};
			journal.close();
			storage.state = state;
			journal = await DeviceJournal.open(storage);
			const rename = {
				...change,
				op: "rename" as const,
				path: destinationPath,
				hash: await hash(remoteText),
				etag: `"${epoch}.3"`,
				from_path: sourcePath,
				from_etag: `"${epoch}.2"`,
			};
			if (boundary === "named" || boundary === "copied") {
				const update = journal.updateApply.bind(journal);
				journal.updateApply = async (pending) => {
					await update(pending);
					if (pending.step === boundary)
						throw new Error(`stopped at ${boundary}`);
				};
			}
			const create = vault.create.bind(vault);
			let copiesCreated = 0;
			vault.create = async (path, text) => {
				const result = await create(path, text);
				if (result && path.includes("(conflict ")) {
					copiesCreated += 1;
					if (
						(boundary === "source_copy" && copiesCreated === 1) ||
						(boundary === "destination_copy" && copiesCreated === 2)
					)
						throw new Error(`stopped at ${boundary}`);
				}
				return result;
			};
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await expect(engine.apply(rename)).rejects.toThrow(
				`stopped at ${boundary}`,
			);
			const pending = journal.snapshot().pending_apply[0];
			expect(pending?.conflict_copies).toHaveLength(2);
			expect(pending?.conflict_copies?.[0]?.side).toBe("rename_source");
			expect(pending?.conflict_copies?.[1]?.side).toBe("rename_destination");
			expect(pending?.conflict_copies?.[0]?.source).toBe(sourcePath);
			expect(pending?.conflict_copies?.[1]?.source).toBe(destinationPath);
			journal.close();
			journal = await DeviceJournal.open(storage);
			engine = makeEngine(journal, vault, { read: async () => remoteText });
			await engine.resume();
			expect(vault.files.get(destinationPath)).toBe(remoteText);
			expect(vault.files.has(sourcePath)).toBe(false);
			expect(
				[...vault.files.values()].filter(
					(text) => text === sourceText || text === destinationText,
				),
			).toHaveLength(2);
			expect(journal.snapshot().pending_apply).toEqual([]);
		},
	);

	it("ignores an obsolete put revision without changing local bytes", async () => {
		vault.files.set(change.path, "newer local bytes");
		journal = await seedBase(
			change.path,
			await hash("newer local bytes"),
			storage,
			journal,
		);
		const state = journal.snapshot();
		state.base[change.path] = {
			deleted: false,
			rev: 3,
			hash: await hash("newer local bytes"),
		};
		journal.close();
		storage.state = state;
		journal = await DeviceJournal.open(storage);
		engine = makeEngine(journal, vault, {
			read: async () => remoteText,
		});
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe("newer local bytes");
		expect(journal.snapshot().base[change.path]?.rev).toBe(3);
	});

	it("trashes an explicit remote delete", async () => {
		const local = "base bytes";
		vault.files.set(change.path, local);
		journal = await seedBase(change.path, await hash(local), storage, journal);
		engine = makeEngine(journal, vault, { read: async () => null });
		await engine.apply({
			...change,
			op: "delete",
			hash: "",
			etag: `"${epoch}.2"`,
		});
		expect(vault.files.has(change.path)).toBe(false);
		expect(journal.snapshot().base[change.path]).toEqual({
			deleted: true,
			rev: 2,
		});
	});

	it("moves a clean rename source and commits both bases", async () => {
		const local = "renamed text";
		const remoteHash = await hash(local);
		vault.files.set("notes/a.md", local);
		journal = await seedBase("notes/a.md", remoteHash, storage, journal);
		engine = makeEngine(journal, vault, { read: async () => local });
		await engine.apply({
			...change,
			op: "rename",
			path: "notes/b.md",
			hash: remoteHash,
			etag: `"${epoch}.3"`,
			from_path: "notes/a.md",
			from_etag: `"${epoch}.2"`,
		});
		expect(vault.files.get("notes/a.md")).toBeUndefined();
		expect(vault.files.get("notes/b.md")).toBe(local);
		expect(journal.snapshot().base["notes/a.md"]).toEqual({
			deleted: true,
			rev: 2,
		});
		expect(journal.snapshot().base["notes/b.md"]).toEqual({
			deleted: false,
			rev: 3,
			hash: remoteHash,
		});
	});

	it("preserves bytes changed before the atomic process callback", async () => {
		vault.files.set(change.path, "base bytes");
		journal = await seedBase(
			change.path,
			await hash("base bytes"),
			storage,
			journal,
		);
		engine = makeEngine(journal, vault, {
			read: async (_path, _epoch, rev) => (rev === 2 ? remoteText : null),
		});
		vault.beforeProcess = () => {
			vault.files.set(change.path, "user bytes");
			vault.beforeProcess = null;
		};
		await engine.apply(change);
		expect(vault.files.get(change.path)).toBe(remoteText);
		expect([...vault.files.values()]).toContain("user bytes");
		expect(
			[...vault.files.keys()].filter((path) => path.includes("(conflict ")),
		).toHaveLength(1);
	});
});
