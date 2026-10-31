import {
	type ChangeEntry,
	ChangeEntrySchema,
	type DeviceBaseEntry,
	DevicePayloadHashSchema,
	type DeviceState,
	type PendingConflictCopy,
	parseETag,
	pathKey,
} from "@obsidian-ai-bridge/protocol";
import type { DeviceJournal } from "@plugin/sync/device-journal";
import { classifyEnrollmentPath } from "@plugin/sync/enrollment-scope";
import { UnsupportedRemoteTextError } from "@plugin/sync/remote-text";

/** Exact text effects required from a vault without exposing Obsidian SDK types. */
export interface TextVault {
	/** Reads current UTF-8 text, or null when the path is absent. */
	read(path: string): Promise<string | null>;
	/** Reads exact file bytes without text decoding, or null when the path is absent. */
	readBinary?(path: string): Promise<Uint8Array | null>;
	/** Returns mtime and size from the host adapter for a binary race guard. */
	stat?(path: string): Promise<{ mtime: number; size: number } | null>;
	/** Creates exact bytes only when the exact path and path key are absent. */
	createBinary?(path: string, bytes: Uint8Array): Promise<boolean>;
	/** Replaces current bytes after the caller completes its host stat guard. */
	modifyBinary?(path: string, bytes: Uint8Array): Promise<boolean>;
	/** Moves exact observed binary bytes to Obsidian trash without decoding them. */
	trashBinary?(path: string, expected: Uint8Array): Promise<boolean>;
	/** Removes only a hash-verified file under the pre-apply recovery directory. */
	removeRecoveryCopy?(path: string, expectedHash: string): Promise<boolean>;
	/** Lists current paths so case-folded and Unicode-key collisions stay visible. */
	list(): Promise<string[]>;
	/** Returns raw file size without decoding content, or null when the path is absent. */
	size(path: string): Promise<number | null>;
	/** Replaces text only when the exact current value still matches expected. */
	process(
		path: string,
		expected: string | null,
		next: string,
	): Promise<boolean>;
	/** Creates text only at an absent exact path. */
	create(path: string, text: string): Promise<boolean>;
	/** Moves a current file to Obsidian trash without permanent deletion. */
	trash(path: string, expected: string): Promise<boolean>;
	/** Renames without link rewriting when source text and destination absence still hold. */
	rename(from: string, to: string, expected: string): Promise<boolean>;
	/** Renames exact binary bytes only while the destination remains absent. */
	renameBinary?(
		from: string,
		to: string,
		expected: Uint8Array,
	): Promise<boolean>;
}

/** Signals that a pruned revision now uses one validated current row identity. */
class PinnedRevisionRebased extends Error {
	/** Replacement change identity already persisted in the journal. */
	readonly change: ChangeEntry;

	/** Carries the new epoch-bound row into the serialized apply retry. */
	constructor(change: ChangeEntry) {
		super("Pinned revision identity changed");
		this.change = change;
	}
}

/** Names conflict copies with one friendly device name for this engine lifetime. */
export interface TextApplyOptions {
	/** Stable display name stored with conflict recovery metadata. */
	deviceName: string;
	/** Clock in Unix milliseconds for recovery retention checks. */
	now?: () => number;
}

/** Current or pinned remote authority returned for one requested epoch and revision. */
export type ResolvedPinnedText =
	| { deleted?: false; text: string; epoch: string; rev: number; hash: string }
	| { deleted: true; text: null; epoch: string; rev: number; hash: "" };

/** Validated exact or current authority across text, blob, and tombstone kinds. */
export type ResolvedPinnedBlob =
	| {
			kind: "blob";
			bytes: Uint8Array;
			epoch: string;
			rev: number;
			hash: string;
	  }
	| { kind: "text"; text: string; epoch: string; rev: number; hash: string }
	| { kind: "deleted"; text: null; epoch: string; rev: number; hash: "" };

/** Fetches immutable remote text by its exact path and server revision. */
export interface PinnedTextProvider {
	/** Returns text pinned to the exact epoch and revision, or null when unavailable. */
	read(path: string, epoch: string, rev: number): Promise<string | null>;
	/** Returns exact bytes pinned to a validated file identity when the row is a blob. */
	readBlob?(
		path: string,
		epoch: string,
		rev: number,
		hash: string,
	): Promise<{ bytes: Uint8Array; epoch: string; rev: number; hash: string }>;
	/** Returns exact pinned content or current content after revision pruning. */
	readResolvedBlob?(
		path: string,
		epoch: string,
		rev: number,
		hash: string,
	): Promise<ResolvedPinnedBlob>;
	/** Returns validated current live text or tombstone after a pruned revision. */
	readResolved?(
		path: string,
		epoch: string,
		rev: number,
	): Promise<ResolvedPinnedText>;
}

/** Serializes revision-pinned text changes and recovers durable conflict steps. */
export class TextApplyEngine {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly deviceName: string;
	private readonly now: () => number;

	/** Binds journal authority to text effects and a pinned-revision reader. */
	constructor(
		private readonly journal: DeviceJournal,
		private readonly vault: TextVault,
		private readonly pinnedText: PinnedTextProvider,
		options: TextApplyOptions,
	) {
		this.deviceName = options.deviceName.trim();
		this.now = options.now ?? Date.now;
		if (!this.deviceName) throw new Error("A friendly device name is required");
	}

	/** Validates and applies one immutable remote entry without discarding newer local bytes. */
	apply(change: ChangeEntry, contentKind?: "text" | "blob"): Promise<void> {
		const parsed = ChangeEntrySchema.parse(structuredClone(change));
		return this.serialize(async () => {
			await this.pruneRecoveryCopies();
			await this.applyWithFallback(parsed, contentKind);
		});
	}

	/**
	 * Applies current text, blob, or tombstone authority through pinned reads and guarded effects.
	 * It resumes durable work and does not advance the feed cursor.
	 */
	applyCurrent(
		path: string,
		authority:
			| ResolvedPinnedText
			| Extract<ResolvedPinnedBlob, { kind: "blob" }>,
	): Promise<void> {
		const observed = structuredClone(authority);
		return this.serialize(async () => {
			const pending = this.activeJournal.snapshot().pending_apply[0];
			if (pending) await this.applyWithFallback(pending.change);
			const state = this.activeJournal.snapshot();
			if (state.pending_apply.length)
				throw new Error(
					"Current authority apply is blocked by pending recovery",
				);
			if (state.epoch !== observed.epoch)
				throw new Error("Current authority belongs to a different vault epoch");
			const isBlob = "kind" in observed && observed.kind === "blob";
			await this.applyWithFallback(
				ChangeEntrySchema.parse({
					seq: (state.cursor ?? 0) + 1,
					op: "deleted" in observed && observed.deleted ? "delete" : "put",
					path,
					etag: `"${observed.epoch}.${observed.rev}"`,
					hash: observed.hash,
					origin: "current_authority",
					at: 0,
				}),
				isBlob ? "blob" : "text",
			);
			if (this.activeJournal.snapshot().pending_apply.length)
				throw new Error("Current authority apply needs conflict recovery");
		});
	}

	/** Resumes the one verified pending transition after a plugin restart. */
	resume(): Promise<void> {
		return this.serialize(async () => {
			await this.pruneRecoveryCopies();
			const pending = this.activeJournal.snapshot().pending_apply[0];
			if (pending) await this.applyWithFallback(pending.change);
		});
	}

	/** Fences queued work after plugin unload without claiming host effects were canceled. */
	close(): void {
		this.closed = true;
	}

	/** Repeats one accepted entry after the journal commits a pruned-revision replacement. */
	private async applyWithFallback(
		change: ChangeEntry,
		contentKind?: "text" | "blob",
	): Promise<void> {
		try {
			await this.applyEntry(change, contentKind);
		} catch (error) {
			if (!(error instanceof PinnedRevisionRebased)) throw error;
			await this.applyEntry(error.change, contentKind);
		}
	}

	/** Runs one accepted entry or continues its persisted conflict step. */
	private async applyEntry(
		change: ChangeEntry,
		contentKind?: "text" | "blob",
	): Promise<void> {
		this.assertOpen();
		const state = this.activeJournal.snapshot();
		const pending = state.pending_apply[0];
		if (pending && pending.change.seq !== change.seq)
			throw new Error("Another remote apply is pending");
		if (!pending) {
			await this.activeJournal.beginApply(change, contentKind);
			const current = this.activeJournal.snapshot();
			if (await this.ignoreObsolete(change, current)) return;
			if (change.op === "rename") {
				await this.applyRename(change, current);
				return;
			}
			await this.applyPathChange(
				change,
				current.base[change.path] ?? null,
				false,
				current.pending_apply[0]?.content_kind,
			);
			return;
		}
		await this.resumePending(pending);
	}

	/** Ignores an obsolete put/delete after its prepared state exists and before effects. */
	private async ignoreObsolete(
		change: ChangeEntry,
		state: DeviceState,
	): Promise<boolean> {
		if (change.op === "rename") return false;
		const revision = parseETag(change.etag).rev;
		const base = state.base[change.path];
		if (
			!base ||
			revision > base.rev ||
			state.stale_base_paths.includes(change.path)
		)
			return false;
		await this.activeJournal.ignoreApply(change.path, revision);
		return true;
	}

	/** Removes only expired, verified recovery files that no pending apply needs. */
	private async pruneRecoveryCopies(): Promise<void> {
		if (
			!this.vault.stat ||
			!this.vault.readBinary ||
			!this.vault.removeRecoveryCopy
		)
			return;
		const protectedPaths = new Set(
			this.activeJournal
				.snapshot()
				.pending_apply.flatMap(
					(pending) =>
						pending.conflict_copies
							?.filter((copy) => copy.purpose === "pre_apply")
							.map((copy) => copy.path) ?? [],
				),
		);
		const cutoff = this.now() - 7 * 24 * 60 * 60 * 1000;
		const paths = await this.vault.list();
		this.assertOpen();
		for (const path of paths) {
			const prefix = ".ai-bridge/pre-apply/";
			if (!path.startsWith(prefix) || protectedPaths.has(path)) continue;
			const hash = path.slice(prefix.length);
			if (!DevicePayloadHashSchema.safeParse(hash).success) continue;
			const stat = await this.vault.stat(path);
			this.assertOpen();
			if (!stat || stat.mtime > cutoff) continue;
			const bytes = await this.vault.readBinary(path);
			this.assertOpen();
			if (
				!bytes ||
				bytes.byteLength !== stat.size ||
				(await digestBytes(bytes)) !== hash
			)
				continue;
			this.assertOpen();
			await this.vault.removeRecoveryCopy(path, hash);
			this.assertOpen();
		}
	}

	/** Applies a blob tombstone after exact-byte checks and required conflict copies. */
	private async applyBlobDelete(
		change: ChangeEntry & { op: "delete" },
		base: DeviceBaseEntry | null,
	): Promise<void> {
		if (!this.vault.readBinary || !this.vault.stat) {
			await this.attend(
				change.path,
				"Binary delete capabilities are unavailable",
			);
			return;
		}
		const firstStat = await this.vault.stat(change.path);
		this.assertOpen();
		const local = await this.vault.readBinary(change.path);
		this.assertOpen();
		if (!local) {
			await this.activeJournal.completeApply(change.path, {
				deleted: true,
				rev: parseETag(change.etag).rev,
			});
			return;
		}
		const localHash = await digestBytes(local);
		const clean = base?.deleted === false && localHash === base.hash;
		const secondStat = await this.vault.stat(change.path);
		this.assertOpen();
		let observed = local;
		if (!sameStat(firstStat, secondStat)) {
			const changed = await this.vault.readBinary(change.path);
			this.assertOpen();
			if (!changed)
				throw new Error("Changed binary disappeared during delete apply");
			observed = changed;
		}
		const observedHash = await digestBytes(observed);
		if (!clean || !sameStat(firstStat, secondStat)) {
			const pending = this.activeJournal.snapshot().pending_apply[0];
			if (!pending)
				throw new Error("Binary delete has no durable apply identity");
			if (!pending.conflict_copies) {
				if (!this.vault.createBinary)
					throw new Error("Binary delete recovery capability is unavailable");
				const revision = parseETag(change.etag).rev;
				const conflictPath = conflictName(
					change.path,
					this.deviceName,
					revision,
					change.at,
				);
				const common: PendingConflictCopy = {
					path: conflictPath,
					source: change.path,
					side: "path",
					mode: "local",
					device_name: this.deviceName,
					hash: observedHash,
					kind: "blob",
					purpose: "conflict",
				};
				await this.activeJournal.updateApply({
					change,
					content_kind: "blob",
					step: "named",
					conflict_copies: [
						common,
						{
							...common,
							path: `.ai-bridge/pre-apply/${observedHash}`,
							purpose: "pre_apply",
						},
					],
				});
				if (!sameStat(firstStat, secondStat)) {
					const named = this.activeJournal.snapshot().pending_apply[0];
					if (named) await this.persistBinaryConflictCopies(named);
					throw new Error(
						"Binary changed during observation; retry after conflict preservation",
					);
				}
				const saved = this.activeJournal.snapshot().pending_apply[0];
				if (saved) await this.resumePending(saved);
				return;
			}
			const copy = pending.conflict_copies.find(
				(candidate) =>
					candidate.kind === "blob" && candidate.purpose === "conflict",
			);
			if (!copy || copy.hash !== observedHash)
				return this.attend(
					change.path,
					"Local binary changed after delete recovery was named",
				);
			await this.activeJournal.recordAttention(
				change.path,
				"Local binary bytes were preserved as a conflict copy",
			);
			await this.activeJournal.completeApply(change.path, {
				deleted: true,
				rev: parseETag(change.etag).rev,
			});
			return;
		}
		const beforeTrash = await this.vault.readBinary(change.path);
		this.assertOpen();
		const beforeTrashStat = await this.vault.stat(change.path);
		this.assertOpen();
		if (
			!beforeTrash ||
			(await digestBytes(beforeTrash)) !== localHash ||
			!sameStat(firstStat, beforeTrashStat)
		)
			throw new Error("Binary changed before remote delete");
		if (!this.vault.trashBinary)
			throw new Error("Binary trash capability is unavailable");
		const trashed = await this.effect(
			() =>
				this.vault.trashBinary?.(change.path, beforeTrash) ??
				Promise.resolve(false),
		);
		if (!trashed)
			throw new Error("Obsidian trash did not confirm the binary delete");
		const remaining = await this.vault.readBinary(change.path);
		this.assertOpen();
		if (remaining) throw new Error("Binary file remains after remote delete");
		await this.activeJournal.completeApply(change.path, {
			deleted: true,
			rev: parseETag(change.etag).rev,
		});
	}

	/** Applies pinned blob bytes after preserving changed local bytes and rechecking host metadata. */
	private async applyBlobChange(
		change: ChangeEntry & { op: "put" },
		base: DeviceBaseEntry | null,
	): Promise<void> {
		if (
			(!this.pinnedText.readBlob && !this.pinnedText.readResolvedBlob) ||
			!this.vault.readBinary ||
			!this.vault.stat
		)
			throw new Error("Binary apply capabilities are unavailable");
		const identity = parseETag(change.etag);
		const remote = this.pinnedText.readResolvedBlob
			? await this.pinnedText.readResolvedBlob(
					change.path,
					identity.epoch,
					identity.rev,
					change.hash,
				)
			: this.pinnedText.readBlob
				? {
						kind: "blob" as const,
						...(await this.pinnedText.readBlob(
							change.path,
							identity.epoch,
							identity.rev,
							change.hash,
						)),
					}
				: (() => {
						throw new Error("Binary apply reader is unavailable");
					})();
		this.assertOpen();
		if (remote.epoch !== identity.epoch)
			throw new Error("Pinned blob identity changed its vault epoch");
		if (remote.kind === "text") {
			if ((await digest(remote.text)) !== remote.hash)
				throw new Error("Pinned text bytes do not match their declared hash");
			if (remote.rev === identity.rev) {
				if (remote.hash !== change.hash)
					throw new Error("Pinned text hash does not match the feed entry");
				await this.applyPathChange(change, base, true);
				return;
			}
		}
		if (remote.kind !== "blob") {
			if (remote.rev <= identity.rev)
				throw new Error("Pinned content did not advance its authority");
			const pending = this.activeJournal.snapshot().pending_apply[0];
			if (!pending)
				throw new Error("Pruned blob fallback has no durable apply identity");
			const rebased: ChangeEntry =
				remote.kind === "deleted"
					? {
							...pending.change,
							op: "delete",
							etag: `"${remote.epoch}.${remote.rev}"`,
							hash: "",
						}
					: {
							...pending.change,
							op: "put",
							etag: `"${remote.epoch}.${remote.rev}"`,
							hash: remote.hash,
						};
			if (remote.kind === "text") {
				await this.activeJournal.rebasePendingApply(rebased, []);
				await this.applyPathChange(
					rebased as ChangeEntry & { op: "put" },
					base,
					true,
				);
				return;
			}
			await this.activeJournal.rebasePendingApply(rebased);
			throw new PinnedRevisionRebased(rebased);
		}
		if ((await digestBytes(remote.bytes)) !== remote.hash)
			throw new Error("Pinned blob bytes do not match their declared hash");
		if (
			remote.rev < identity.rev ||
			(remote.rev === identity.rev && remote.hash !== change.hash)
		)
			throw new Error("Blob fallback is not newer than its pinned authority");
		if (remote.rev !== identity.rev || remote.hash !== change.hash) {
			const pending = this.activeJournal.snapshot().pending_apply[0];
			if (!pending)
				throw new Error("Pruned blob fallback has no durable apply identity");
			const rebased = {
				...pending.change,
				op: "put" as const,
				etag: `"${remote.epoch}.${remote.rev}"`,
				hash: remote.hash,
			};
			await this.activeJournal.rebasePendingApply(
				rebased,
				pending.conflict_copies,
			);
			throw new PinnedRevisionRebased(rebased);
		}
		const firstStat = await this.vault.stat(change.path);
		this.assertOpen();
		const local = await this.vault.readBinary(change.path);
		this.assertOpen();
		if (local === null) {
			if (firstStat !== null || !this.vault.createBinary)
				throw new Error("Binary create precondition changed");
			const collision = (await this.vault.list()).find(
				(current) =>
					current !== change.path && pathKey(current) === pathKey(change.path),
			);
			this.assertOpen();
			if (collision) {
				await this.startRemoteBlobCollision(change);
				return;
			}
			await this.activeJournal.setExpectedWrite(change.path, change.hash);
			this.assertOpen();
			const createdPath = await this.effect(
				async () =>
					(await this.vault.createBinary?.(change.path, remote.bytes)) ?? false,
			);
			const created = await this.vault.readBinary(change.path);
			this.assertOpen();
			if (created && (await digestBytes(created)) === change.hash) {
				await this.activeJournal.completeApply(change.path, {
					deleted: false,
					rev: identity.rev,
					hash: change.hash,
				});
				return;
			}
			await this.activeJournal.clearExpectedWrite(change.path);
			this.assertOpen();
			const lateCollision = (await this.vault.list()).find(
				(current) =>
					current !== change.path && pathKey(current) === pathKey(change.path),
			);
			this.assertOpen();
			if (!createdPath && lateCollision) {
				await this.startRemoteBlobCollision(change);
				return;
			}
			throw new Error("Binary create was not confirmed");
		}
		const localHash = await digestBytes(local);
		if (localHash === change.hash) {
			await this.activeJournal.completeApply(change.path, {
				deleted: false,
				rev: identity.rev,
				hash: change.hash,
			});
			return;
		}
		const clean = base?.deleted === false && localHash === base.hash;
		const secondStat = await this.vault.stat(change.path);
		this.assertOpen();
		let observed = local;
		if (!sameStat(firstStat, secondStat)) {
			const changed = await this.vault.readBinary(change.path);
			this.assertOpen();
			if (!changed) throw new Error("Changed binary disappeared during apply");
			observed = changed;
		}
		const observedHash = await digestBytes(observed);
		const pending = this.activeJournal.snapshot().pending_apply[0];
		const blobCopies = pending?.conflict_copies?.filter(
			(copy) => copy.kind === "blob",
		);
		if (!blobCopies) {
			if (!pending || !this.vault.createBinary)
				throw new Error("Binary conflict recovery capability is unavailable");
			const conflictPath = conflictName(
				change.path,
				this.deviceName,
				identity.rev,
				change.at,
			);
			const recoveryPath = `.ai-bridge/pre-apply/${observedHash}`;
			const localCopy: PendingConflictCopy = {
				path: conflictPath,
				source: change.path,
				side: "path",
				mode: "local",
				device_name: this.deviceName,
				hash: observedHash,
				kind: "blob",
				purpose: "conflict",
			};
			const recoveryCopy: PendingConflictCopy = {
				...localCopy,
				path: recoveryPath,
				purpose: "pre_apply",
			};
			await this.activeJournal.updateApply({
				change,
				content_kind: "blob",
				step: "named",
				conflict_copies: [localCopy, recoveryCopy],
			});
			if (!sameStat(firstStat, secondStat)) {
				const named = this.activeJournal.snapshot().pending_apply[0];
				if (named) await this.persistBinaryConflictCopies(named);
				throw new Error(
					"Binary changed during observation; retry after conflict preservation",
				);
			}
			const saved = this.activeJournal.snapshot().pending_apply[0];
			if (saved) await this.resumePending(saved);
			return;
		}
		const conflictCopy = blobCopies.find((copy) => copy.purpose === "conflict");
		const recoveryCopy = blobCopies.find(
			(copy) => copy.purpose === "pre_apply",
		);
		if (
			!conflictCopy ||
			!recoveryCopy ||
			conflictCopy.hash !== observedHash ||
			recoveryCopy.hash !== observedHash ||
			conflictCopy.source !== change.path
		)
			return this.attend(
				change.path,
				"Binary recovery identity changed before apply completed",
			);
		const conflictBytes = await this.vault.readBinary(conflictCopy.path);
		const recoveryBytes = await this.vault.readBinary(recoveryCopy.path);
		if (
			!conflictBytes ||
			!recoveryBytes ||
			(await digestBytes(conflictBytes)) !== observedHash ||
			(await digestBytes(recoveryBytes)) !== observedHash
		)
			return this.attend(
				change.path,
				"Binary recovery bytes are missing or corrupt",
			);
		if (!sameStat(firstStat, secondStat))
			throw new Error(
				"Binary changed during observation; retry after conflict preservation",
			);
		const beforeWrite = await this.vault.stat(change.path);
		this.assertOpen();
		const latest = await this.vault.readBinary(change.path);
		this.assertOpen();
		if (
			!latest ||
			(await digestBytes(latest)) !== observedHash ||
			!sameStat(beforeWrite, await this.vault.stat(change.path))
		)
			throw new Error("Binary changed again during conflict preservation");
		if (!this.vault.modifyBinary)
			throw new Error("Binary write capability is unavailable");
		await this.activeJournal.setExpectedWrite(change.path, change.hash);
		const written = await this.effect(
			async () =>
				(await this.vault.modifyBinary?.(change.path, remote.bytes)) ?? false,
		);
		if (!written) {
			await this.activeJournal.clearExpectedWrite(change.path);
			throw new Error("Binary write was not confirmed");
		}
		const readBack = await this.vault.readBinary(change.path);
		this.assertOpen();
		if (!readBack || (await digestBytes(readBack)) !== change.hash) {
			await this.activeJournal.clearExpectedWrite(change.path);
			throw new Error("Binary read-back did not match remote bytes");
		}
		await this.activeJournal.completeApply(change.path, {
			deleted: false,
			rev: identity.rev,
			hash: change.hash,
		});
		if (!clean)
			await this.activeJournal.recordAttention(
				change.path,
				"Local binary bytes were preserved as a conflict copy",
			);
	}

	/** Applies one put or delete after exact observed bytes and durable conflict checks. */
	private async applyPathChange(
		change: Extract<ChangeEntry, { op: "put" | "delete" }>,
		base: DeviceBaseEntry | null,
		forceText = false,
		contentKind?: "text" | "blob",
	): Promise<void> {
		const remoteRev = parseETag(change.etag).rev;
		const size = await this.vault.size(change.path);
		this.assertOpen();
		const admission = classifyEnrollmentPath(change.path, size ?? 0);
		const isBlob =
			contentKind === undefined ? admission === "blob" : contentKind === "blob";
		if (!forceText && isBlob && change.op === "put") {
			await this.applyBlobChange(change as ChangeEntry & { op: "put" }, base);
			return;
		}
		if (!forceText && isBlob && change.op === "delete") {
			await this.applyBlobDelete(
				change as ChangeEntry & { op: "delete" },
				base,
			);
			return;
		}
		const local = await this.vault.read(change.path);
		this.assertOpen();
		if (change.op === "put") {
			let remote: string;
			try {
				remote = await this.fetchText(change.path, change.etag, change.hash);
			} catch (error) {
				if (!(error instanceof UnsupportedRemoteTextError)) throw error;
				await this.applyBlobChange(change as ChangeEntry & { op: "put" }, base);
				return;
			}
			if (local === remote) {
				await this.activeJournal.completeApply(change.path, {
					deleted: false,
					rev: remoteRev,
					hash: change.hash,
				});
				return;
			}
			if (local === null) {
				const collision = await this.pathCollision(change.path);
				if (collision) {
					await this.startRemoteCollision(change, remote);
					return;
				}
				await this.activeJournal.setExpectedWrite(change.path, change.hash);
				await this.effect(() => this.vault.create(change.path, remote));
				const createdText = await this.vault.read(change.path);
				if (createdText === remote) {
					await this.activeJournal.completeApply(change.path, {
						deleted: false,
						rev: remoteRev,
						hash: change.hash,
					});
					return;
				}
				await this.activeJournal.clearExpectedWrite(change.path);
				if (createdText !== null)
					await this.startConflict(change, change.path, createdText);
				else throw new Error("Remote create was not confirmed");
				return;
			}
			const clean =
				base?.deleted === false && (await digest(local)) === base.hash;
			if (clean) {
				await this.activeJournal.setExpectedWrite(change.path, change.hash);
				if (
					await this.effect(() =>
						this.vault.process(change.path, local, remote),
					)
				) {
					await this.activeJournal.completeApply(change.path, {
						deleted: false,
						rev: remoteRev,
						hash: change.hash,
					});
					return;
				}
				await this.activeJournal.clearExpectedWrite(change.path);
			}
			const current = await this.vault.read(change.path);
			if (current === null)
				throw new Error("Local text changed to absent during remote apply");
			await this.startConflict(change, change.path, current);
			return;
		}
		if (local === null) {
			await this.activeJournal.completeApply(change.path, {
				deleted: true,
				rev: remoteRev,
			});
			return;
		}
		const clean =
			base?.deleted === false && (await digest(local)) === base.hash;
		if (!clean) {
			await this.startConflict(change, change.path, local);
			return;
		}
		if (
			!(await this.effect(() => this.vault.trash(change.path, local))) &&
			(await this.vault.read(change.path)) !== null
		)
			throw new Error("Obsidian trash did not confirm the remote delete");
		await this.activeJournal.completeApply(change.path, {
			deleted: true,
			rev: remoteRev,
		});
	}

	/** Saves colliding pinned blob bytes as a durable visible remote conflict copy. */
	private async startRemoteBlobCollision(
		change: ChangeEntry & { op: "put" },
	): Promise<void> {
		const identity = parseETag(change.etag);
		const copy: PendingConflictCopy = {
			path: conflictName(change.path, this.deviceName, identity.rev, change.at),
			source: change.path,
			side: "path",
			mode: "remote",
			hash: change.hash,
			kind: "blob",
			purpose: "conflict",
		};
		await this.activeJournal.updateApply({
			change,
			content_kind: "blob",
			step: "named",
			conflict_copies: [copy],
		});
		this.assertOpen();
		const pending = this.activeJournal.snapshot().pending_apply[0];
		if (!pending)
			throw new Error("Remote binary collision has no durable apply identity");
		await this.resumePending(pending);
	}

	/** Reads and rebases exact binary rename authority after revision pruning. */
	private async readRenameBlob(
		change: Extract<ChangeEntry, { op: "rename" }>,
	): Promise<{ bytes: Uint8Array; hash: string; epoch: string; rev: number }> {
		const identity = parseETag(change.etag);
		const remote = this.pinnedText.readResolvedBlob
			? await this.pinnedText.readResolvedBlob(
					change.path,
					identity.epoch,
					identity.rev,
					change.hash,
				)
			: this.pinnedText.readBlob
				? {
						kind: "blob" as const,
						...(await this.pinnedText.readBlob(
							change.path,
							identity.epoch,
							identity.rev,
							change.hash,
						)),
					}
				: null;
		if (remote?.kind !== "blob")
			throw new Error(
				"Binary rename fallback changed the destination content kind",
			);
		if (
			remote.epoch !== identity.epoch ||
			remote.rev < identity.rev ||
			(remote.rev === identity.rev && remote.hash !== change.hash) ||
			(await digestBytes(remote.bytes)) !== remote.hash
		)
			throw new Error("Pinned binary rename identity is invalid");
		if (remote.rev > identity.rev || remote.hash !== change.hash) {
			const pending = this.activeJournal.snapshot().pending_apply[0];
			if (!pending)
				throw new Error("Binary rename has no durable apply identity");
			const rebased = {
				...pending.change,
				etag: `"${remote.epoch}.${remote.rev}"`,
				hash: remote.hash,
			};
			await this.activeJournal.rebasePendingApply(
				rebased,
				pending.conflict_copies,
			);
			throw new PinnedRevisionRebased(rebased);
		}
		return remote;
	}

	/** Moves or preserves exact binary rename sides without decoding file bytes. */
	private async applyBlobRename(
		change: Extract<ChangeEntry, { op: "rename" }>,
		state: DeviceState,
	): Promise<void> {
		if (
			!this.vault.readBinary ||
			!this.vault.stat ||
			(!this.pinnedText.readBlob && !this.pinnedText.readResolvedBlob)
		) {
			await this.attend(
				change.path,
				"Binary rename capabilities are unavailable",
			);
			return;
		}
		const fromRev = parseETag(change.from_etag).rev;
		const toIdentity = parseETag(change.etag);
		const sourceBase = state.base[change.from_path];
		const destinationBase = state.base[change.path];
		const sourcePending =
			sourceBase !== undefined &&
			(sourceBase.rev < fromRev ||
				state.stale_base_paths.includes(change.from_path));
		const destinationPending =
			destinationBase === undefined ||
			destinationBase.rev < toIdentity.rev ||
			state.stale_base_paths.includes(change.path);
		if (!sourcePending && !destinationPending) {
			await this.activeJournal.completeRenameApply(
				change.from_path,
				null,
				change.path,
				null,
			);
			return;
		}
		const source = sourcePending
			? await this.vault.readBinary(change.from_path)
			: null;
		const destination = destinationPending
			? await this.vault.readBinary(change.path)
			: null;
		const sourceHash = source ? await digestBytes(source) : null;
		const destinationHash = destination ? await digestBytes(destination) : null;
		const sourceClean =
			source !== null &&
			sourceBase?.deleted === false &&
			sourceHash === sourceBase.hash;
		const destinationClean =
			destination !== null &&
			destinationBase?.deleted === false &&
			destinationHash === destinationBase.hash;
		if (sourceClean && destinationPending && destination === null) {
			const firstStat = await this.vault.stat(change.from_path);
			await this.readRenameBlob(change);
			const sourceNow = await this.vault.readBinary(change.from_path);
			if (
				!sourceNow ||
				(await digestBytes(sourceNow)) !== sourceHash ||
				!sameStat(firstStat, await this.vault.stat(change.from_path))
			)
				throw new Error("Binary rename source changed before move");
			if (!this.vault.renameBinary)
				throw new Error("Binary rename effect is unavailable");
			await this.activeJournal.setExpectedWrite(change.path, change.hash);
			const moved = await this.effect(
				async () =>
					this.vault.renameBinary?.(change.from_path, change.path, sourceNow) ??
					false,
			);
			const renamed = await this.vault.readBinary(change.path);
			this.assertOpen();
			if (moved && renamed && (await digestBytes(renamed)) === change.hash) {
				await this.activeJournal.completeRenameApply(
					change.from_path,
					{ deleted: true, rev: fromRev },
					change.path,
					{ deleted: false, rev: toIdentity.rev, hash: change.hash },
				);
				return;
			}
			await this.activeJournal.clearExpectedWrite(change.path);
		}
		const pending = this.activeJournal.snapshot().pending_apply[0];
		if (!pending)
			throw new Error("Binary rename has no durable apply identity");
		if (pending.conflict_copies) {
			await this.finishBinaryRename(change, state, pending.conflict_copies);
			return;
		}
		const conflictCopies: PendingConflictCopy[] = [];
		if (sourcePending && source && !sourceClean) {
			conflictCopies.push({
				path: conflictName(
					change.from_path,
					this.deviceName,
					fromRev,
					change.at,
				),
				source: change.from_path,
				side: "rename_source",
				mode: "local",
				device_name: this.deviceName,
				hash: sourceHash as string,
				kind: "blob",
				purpose: "conflict",
			});
		}
		if (
			destinationPending &&
			destination &&
			!destinationClean &&
			destinationHash !== change.hash
		) {
			conflictCopies.push({
				path: conflictName(
					change.path,
					this.deviceName,
					toIdentity.rev,
					change.at,
				),
				source: change.path,
				side: "rename_destination",
				mode: "local",
				device_name: this.deviceName,
				hash: destinationHash as string,
				kind: "blob",
				purpose: "conflict",
			});
		}
		if (destinationPending && destination && destinationHash !== change.hash) {
			const preApplyHash = destinationHash as string;
			conflictCopies.push({
				path: `.ai-bridge/pre-apply/${preApplyHash}`,
				source: change.path,
				side: "rename_destination",
				mode: "local",
				device_name: this.deviceName,
				hash: preApplyHash,
				kind: "blob",
				purpose: "pre_apply",
			});
		}
		if (conflictCopies.length) {
			await this.activeJournal.updateApply({
				change,
				content_kind: "blob",
				step: "named",
				conflict_copies: conflictCopies,
			});
			const saved = this.activeJournal.snapshot().pending_apply[0];
			if (saved) await this.resumePending(saved);
			return;
		}
		await this.finishBinaryRename(change, state, []);
	}

	/** Completes a binary rename after all dirty local sides have visible copies. */
	private async finishBinaryRename(
		change: Extract<ChangeEntry, { op: "rename" }>,
		state: DeviceState,
		copies: PendingConflictCopy[],
	): Promise<void> {
		if (
			(!this.pinnedText.readBlob && !this.pinnedText.readResolvedBlob) ||
			!this.vault.readBinary ||
			!this.vault.stat
		)
			throw new Error("Binary rename capabilities are unavailable");
		const fromRev = parseETag(change.from_etag).rev;
		const toIdentity = parseETag(change.etag);
		for (const copy of copies) {
			const saved = await this.vault.readBinary?.(copy.path);
			this.assertOpen();
			if (!saved || (await digestBytes(saved)) !== copy.hash)
				return this.attend(
					copy.path,
					"Binary rename conflict copy changed before apply",
				);
		}
		const sourceBase = state.base[change.from_path];
		const destinationBase = state.base[change.path];
		const sourcePending =
			sourceBase !== undefined &&
			(sourceBase.rev < fromRev ||
				state.stale_base_paths.includes(change.from_path));
		const destinationPending =
			destinationBase === undefined ||
			destinationBase.rev < toIdentity.rev ||
			state.stale_base_paths.includes(change.path);
		const remote = destinationPending
			? await this.readRenameBlob(change)
			: null;
		this.assertOpen();
		const source = await this.vault.readBinary(change.from_path);
		this.assertOpen();
		const destination = await this.vault.readBinary(change.path);
		this.assertOpen();
		const sourceHash = source ? await digestBytes(source) : null;
		const destinationHash = destination ? await digestBytes(destination) : null;
		const destinationClean =
			destination !== null &&
			destinationBase?.deleted === false &&
			destinationHash === destinationBase.hash;
		const destinationCopy = copies.find(
			(copy) =>
				copy.side === "rename_destination" && copy.purpose === "conflict",
		);
		const destinationCopied = destinationCopy?.hash === destinationHash;
		const destinationChanged =
			destinationPending &&
			destination !== null &&
			destinationHash !== change.hash &&
			!destinationClean;
		if (destinationChanged && !destinationCopied)
			return this.attend(
				change.path,
				"Binary rename destination changed after conflict preservation",
			);
		if (
			destinationPending &&
			(!destinationChanged || destinationCopied) &&
			destinationHash !== change.hash &&
			remote
		) {
			const beforeStat = await this.vault.stat(change.path);
			this.assertOpen();
			const current = await this.vault.readBinary(change.path);
			this.assertOpen();
			const afterStat = await this.vault.stat(change.path);
			this.assertOpen();
			if (
				(destination === null && current !== null) ||
				(destination !== null &&
					(!current || (await digestBytes(current)) !== destinationHash)) ||
				!sameStat(beforeStat, afterStat)
			)
				throw new Error("Binary rename destination changed before apply");
			const preApplyCopy = copies.find(
				(copy) =>
					copy.side === "rename_destination" && copy.purpose === "pre_apply",
			);
			if (destination !== null && destinationHash !== change.hash) {
				if (!preApplyCopy || preApplyCopy.hash !== destinationHash)
					return this.attend(
						change.path,
						"Binary rename destination has no verified pre-apply copy",
					);
				const recovery = await this.vault.readBinary(preApplyCopy.path);
				this.assertOpen();
				if (!recovery || (await digestBytes(recovery)) !== destinationHash)
					return this.attend(
						preApplyCopy.path,
						"Binary rename pre-apply copy changed before replacement",
					);
			}
			await this.activeJournal.setExpectedWrite(change.path, change.hash);
			this.assertOpen();
			const written =
				destination === null
					? await this.effect(
							async () =>
								this.vault.createBinary?.(change.path, remote.bytes) ?? false,
						)
					: this.vault.modifyBinary
						? await this.effect(
								async () =>
									this.vault.modifyBinary?.(change.path, remote.bytes) ?? false,
							)
						: false;
			const writtenBytes = await this.vault.readBinary(change.path);
			this.assertOpen();
			if (
				!written ||
				!writtenBytes ||
				(await digestBytes(writtenBytes)) !== change.hash
			) {
				await this.activeJournal.clearExpectedWrite(change.path);
				throw new Error("Binary rename destination was not confirmed");
			}
		}
		const sourceClean =
			source !== null &&
			sourceBase?.deleted === false &&
			sourceHash === sourceBase.hash;
		const sourceCopy = copies.find(
			(copy) => copy.side === "rename_source" && copy.purpose === "conflict",
		);
		const sourceCopied = sourceCopy?.hash === sourceHash;
		if (sourcePending && source && !sourceClean && !sourceCopied)
			return this.attend(
				change.from_path,
				"Binary rename source changed after conflict preservation",
			);
		if (sourcePending && source && (sourceClean || sourceCopied)) {
			if (sourceCopied && sourceCopy) {
				const saved = await this.vault.readBinary(sourceCopy.path);
				this.assertOpen();
				if (!saved || (await digestBytes(saved)) !== sourceCopy.hash)
					return this.attend(
						change.from_path,
						"Binary rename source conflict copy changed before trash",
					);
			}
			const trashBinary = this.vault.trashBinary;
			if (!trashBinary)
				throw new Error("Binary rename source trash is unavailable");
			const trashed = await this.effect(() =>
				trashBinary.call(this.vault, change.from_path, source),
			);
			const remainingSource = await this.vault.readBinary(change.from_path);
			this.assertOpen();
			if (!trashed || remainingSource)
				throw new Error("Binary rename source was not moved to Obsidian trash");
		}
		if (destinationChanged || (sourcePending && !sourceClean))
			await this.activeJournal.recordAttention(
				change.path,
				"Local binary rename sides remain visible as conflict copies",
			);
		await this.activeJournal.completeRenameApply(
			change.from_path,
			sourcePending ? { deleted: true, rev: fromRev } : null,
			change.path,
			destinationPending
				? { deleted: false, rev: toIdentity.rev, hash: change.hash }
				: null,
		);
	}

	/** Saves a dirty source before completing the destination side of a remote rename. */
	private async applyRename(
		change: Extract<ChangeEntry, { op: "rename" }>,
		state: DeviceState,
	): Promise<void> {
		if (this.pinnedText.readResolvedBlob) {
			const identity = parseETag(change.etag);
			const remote = await this.pinnedText.readResolvedBlob(
				change.path,
				identity.epoch,
				identity.rev,
				change.hash,
			);
			this.assertOpen();
			if (remote.kind === "blob") {
				await this.applyBlobRename(change, state);
				return;
			}
			if (remote.kind === "deleted")
				throw new Error("Remote rename destination is deleted");
			if ((await digest(remote.text)) !== remote.hash)
				throw new Error("Pinned rename text hash is invalid");
			if (remote.rev > identity.rev) {
				const pending = this.activeJournal.snapshot().pending_apply[0];
				if (!pending)
					throw new Error("Pruned text rename has no durable apply identity");
				const rebased = {
					...pending.change,
					etag: `"${remote.epoch}.${remote.rev}"`,
					hash: remote.hash,
				};
				await this.activeJournal.rebasePendingApply(
					rebased,
					pending.conflict_copies,
				);
				throw new PinnedRevisionRebased(rebased);
			}
			if (remote.rev !== identity.rev || remote.hash !== change.hash)
				throw new Error("Pinned rename text identity is invalid");
		} else {
			const sourceSize = await this.vault.size(change.from_path);
			const destinationSize = await this.vault.size(change.path);
			if (
				classifyEnrollmentPath(change.from_path, sourceSize ?? 0) === "blob" ||
				classifyEnrollmentPath(change.path, destinationSize ?? 0) === "blob"
			) {
				await this.applyBlobRename(change, state);
				return;
			}
		}
		const fromRev = parseETag(change.from_etag).rev;
		const toRev = parseETag(change.etag).rev;
		const sourceBase = state.base[change.from_path];
		const destinationBase = state.base[change.path];
		const staleBases = state.stale_base_paths;
		const sourcePending =
			sourceBase !== undefined &&
			(sourceBase.rev < fromRev || staleBases.includes(change.from_path));
		const destinationPending =
			destinationBase === undefined ||
			destinationBase.rev < toRev ||
			staleBases.includes(change.path);
		if (!sourcePending && !destinationPending) {
			await this.activeJournal.completeRenameApply(
				change.from_path,
				null,
				change.path,
				null,
			);
			return;
		}
		const source = sourcePending
			? await this.vault.read(change.from_path)
			: null;
		const destination = destinationPending
			? await this.vault.read(change.path)
			: null;
		const sourceClean =
			source !== null &&
			sourceBase?.deleted === false &&
			(await digest(source)) === sourceBase.hash;
		const destinationBaseClean =
			destination !== null &&
			destinationBase?.deleted === false &&
			(await digest(destination)) === destinationBase.hash;
		if (
			sourcePending &&
			sourceClean &&
			destinationPending &&
			destination === null
		) {
			if (source !== null) {
				await this.activeJournal.setExpectedWrite(change.path, change.hash);
				const renamedFile = await this.effect(() =>
					this.vault.rename(change.from_path, change.path, source),
				);
				if (renamedFile) {
					const renamed = await this.vault.read(change.path);
					if (renamed !== null && (await digest(renamed)) === change.hash) {
						await this.activeJournal.completeRenameApply(
							change.from_path,
							{ deleted: true, rev: fromRev },
							change.path,
							{ deleted: false, rev: toRev, hash: change.hash },
						);
						return;
					}
					if (renamed !== null) {
						await this.startConflict(change, change.path, renamed);
						return;
					}
				}
				await this.activeJournal.clearExpectedWrite(change.path);
			}
		}
		if (sourcePending && source !== null && !sourceClean) {
			const conflictCopies: Array<{
				source: string;
				text: string;
				side: PendingConflictCopy["side"];
			}> = [
				{
					source: change.from_path,
					text: source,
					side: "rename_source" as const,
				},
			];
			if (
				destinationPending &&
				destination !== null &&
				!destinationBaseClean &&
				(await digest(destination)) !== change.hash
			) {
				conflictCopies.push({
					source: change.path,
					text: destination,
					side: "rename_destination" as const,
				});
			}
			await this.startConflictCopies(change, conflictCopies);
			const pending = this.activeJournal.snapshot().pending_apply[0];
			if (pending) await this.resumePending(pending);
			return;
		}
		if (!destinationPending) {
			if (sourcePending) {
				if (
					source !== null &&
					!(await this.confirmLocalTrash(change.from_path, source))
				) {
					await this.attend(
						change.from_path,
						"Obsidian trash did not confirm the rename source",
					);
					return;
				}
				await this.activeJournal.completeRenameApply(
					change.from_path,
					{ deleted: true, rev: fromRev },
					change.path,
					null,
				);
			}
			return;
		}
		const remote = await this.fetchText(change.path, change.etag, change.hash);
		const current = await this.vault.read(change.path);
		if (current === remote) {
			if (sourcePending && source !== null) {
				if (!(await this.confirmLocalTrash(change.from_path, source))) {
					await this.attend(
						change.from_path,
						"Obsidian trash did not confirm the rename source",
					);
					return;
				}
			}
			await this.activeJournal.completeRenameApply(
				change.from_path,
				sourcePending ? { deleted: true, rev: fromRev } : null,
				change.path,
				{ deleted: false, rev: toRev, hash: change.hash },
			);
			return;
		}
		const destinationClean =
			current !== null &&
			destinationBase?.deleted === false &&
			(await digest(current)) === destinationBase.hash;
		if (current !== null && !destinationClean) {
			await this.startConflict(change, change.path, current);
			return;
		}
		const destinationApplied = await this.applyRemoteText(
			change.path,
			change.hash,
			current,
			remote,
		);
		if (!destinationApplied) {
			const latest = await this.vault.read(change.path);
			if (latest !== null) {
				await this.startConflict(change, change.path, latest);
				return;
			}
			throw new Error("Remote rename destination was not confirmed");
		}
		if (sourcePending && source !== null) {
			if (!(await this.confirmLocalTrash(change.from_path, source))) {
				await this.attend(
					change.from_path,
					"Obsidian trash did not confirm the rename source",
				);
				return;
			}
		}
		await this.activeJournal.completeRenameApply(
			change.from_path,
			sourcePending ? { deleted: true, rev: fromRev } : null,
			change.path,
			{ deleted: false, rev: toRev, hash: change.hash },
		);
	}

	/** Saves and verifies every named binary copy before recording the copied step. */
	private async persistBinaryConflictCopies(
		pending: DeviceState["pending_apply"][number],
	): Promise<void> {
		for (const copy of conflictCopiesFor(pending).filter(
			(candidate) => candidate.kind === "blob",
		)) {
			this.assertOpen();
			const readBinary = this.vault.readBinary;
			const createBinary = this.vault.createBinary;
			if (!readBinary || !createBinary) {
				await this.attend(
					copy.source,
					"Binary recovery capability is unavailable",
				);
				return;
			}
			const existing = await readBinary.call(this.vault, copy.path);
			this.assertOpen();
			if (existing) {
				if ((await digestBytes(existing)) !== copy.hash) {
					await this.attend(
						copy.source,
						"Binary recovery copy was edited before apply finished",
					);
					return;
				}
				continue;
			}
			const source = await readBinary.call(this.vault, copy.source);
			this.assertOpen();
			if (!source || (await digestBytes(source)) !== copy.hash) {
				await this.attend(
					copy.source,
					"Local binary changed before its recovery copy was saved",
				);
				return;
			}
			await this.effect(() => createBinary.call(this.vault, copy.path, source));
			this.assertOpen();
			const saved = await readBinary.call(this.vault, copy.path);
			this.assertOpen();
			if (!saved || (await digestBytes(saved)) !== copy.hash) {
				await this.attend(
					copy.path,
					"Binary recovery path contains different bytes",
				);
				return;
			}
		}
		await this.activeJournal.updateApply({ ...pending, step: "copied" });
		this.assertOpen();
	}

	/** Continues a durable conflict copy before retrying the same pinned remote effect. */
	private async resumePending(
		pending: DeviceState["pending_apply"][number],
	): Promise<void> {
		if (pending.step === "named") {
			const copies = conflictCopiesFor(pending);
			for (const copy of copies) {
				if (copy.kind === "blob") {
					if (!this.vault.readBinary || !this.vault.createBinary)
						return this.attend(
							copy.source,
							"Binary recovery capability is unavailable",
						);
					const existingBytes = await this.vault.readBinary(copy.path);
					if (existingBytes) {
						if ((await digestBytes(existingBytes)) !== copy.hash)
							return this.attend(
								copy.source,
								"Binary recovery copy was edited before apply finished",
							);
						if (copy.purpose === "pre_apply") {
							if (!this.vault.modifyBinary)
								return this.attend(
									copy.path,
									"Recovery retention clock could not be refreshed",
								);
							const refreshed = await this.effect(
								async () =>
									(await this.vault.modifyBinary?.(copy.path, existingBytes)) ??
									false,
							);
							if (!refreshed)
								return this.attend(
									copy.path,
									"Recovery retention clock could not be refreshed",
								);
						}
						continue;
					}
					let sourceBytes: Uint8Array;
					if (copy.mode === "remote") {
						const identity = parseETag(pending.change.etag);
						const remote = this.pinnedText.readResolvedBlob
							? await this.pinnedText.readResolvedBlob(
									pending.change.path,
									identity.epoch,
									identity.rev,
									copy.hash,
								)
							: this.pinnedText.readBlob
								? {
										kind: "blob" as const,
										...(await this.pinnedText.readBlob(
											pending.change.path,
											identity.epoch,
											identity.rev,
											copy.hash,
										)),
									}
								: null;
						if (
							remote?.kind !== "blob" ||
							remote.epoch !== identity.epoch ||
							remote.rev !== identity.rev ||
							remote.hash !== copy.hash ||
							(await digestBytes(remote.bytes)) !== copy.hash
						)
							return this.attend(
								copy.source,
								"Pinned remote binary conflict changed before it was saved",
							);
						sourceBytes = remote.bytes;
					} else {
						const localBytes = await this.vault.readBinary(copy.source);
						if (!localBytes || (await digestBytes(localBytes)) !== copy.hash)
							return this.attend(
								copy.source,
								"Local binary changed before its recovery copy was saved",
							);
						sourceBytes = localBytes;
					}
					this.assertOpen();
					await this.effect(
						async () =>
							this.vault.createBinary?.(copy.path, sourceBytes) ?? false,
					);
					const savedBytes = await this.vault.readBinary(copy.path);
					this.assertOpen();
					if (!savedBytes || (await digestBytes(savedBytes)) !== copy.hash)
						return this.attend(
							copy.path,
							"Binary recovery path contains different bytes",
						);
					continue;
				}
				const existing = await this.vault.read(copy.path);
				if (existing !== null) {
					if ((await digest(existing)) !== copy.hash)
						return this.attend(
							copy.source,
							"Conflict copy was edited before the apply finished",
						);
					continue;
				}
				let text: string | null;
				if (copy.mode === "remote") {
					text = await this.fetchText(
						pending.change.path,
						pending.change.etag,
						copy.hash,
					);
				} else {
					text = await this.vault.read(copy.source);
					if (text === null || (await digest(text)) !== copy.hash)
						return this.attend(
							copy.source,
							"Local text changed before its conflict copy was saved",
						);
				}
				await this.effect(() => this.vault.create(copy.path, text as string));
				const saved = await this.vault.read(copy.path);
				if (saved === null || (await digest(saved)) !== copy.hash)
					return this.attend(
						copy.path,
						"Conflict copy path contains different bytes",
					);
			}
			await this.activeJournal.updateApply({ ...pending, step: "copied" });
		}
		const updated = this.activeJournal.snapshot().pending_apply[0];
		if (updated?.step === "copied") {
			await this.finishCopiedApply(updated, this.activeJournal.snapshot());
			return;
		}
		if (updated?.step === "prepared") {
			const current = this.activeJournal.snapshot();
			const change = updated.change;
			if (await this.ignoreObsolete(change, current)) return;
			if (change.op === "rename") await this.applyRename(change, current);
			else
				await this.applyPathChange(
					change,
					current.base[change.path] ?? null,
					false,
					updated.content_kind,
				);
		}
	}

	/** Completes verified conflict copies before it commits the pinned remote effect. */
	private async finishCopiedApply(
		pending: DeviceState["pending_apply"][number],
		state: DeviceState,
	): Promise<void> {
		const copies = conflictCopiesFor(pending);
		if (copies.some((copy) => copy.kind === "blob")) {
			const change = pending.change;
			const binaryCopies = copies.filter((copy) => copy.kind === "blob");
			for (const copy of binaryCopies) {
				const bytes = await this.vault.readBinary?.(copy.path);
				this.assertOpen();
				if (!bytes || (await digestBytes(bytes)) !== copy.hash)
					return this.attend(
						copy.path,
						"Binary recovery copy changed during apply",
					);
				if (copy.purpose === "pre_apply") {
					const modifyBinary = this.vault.modifyBinary;
					if (!modifyBinary)
						return this.attend(
							copy.path,
							"Recovery retention clock could not be refreshed",
						);
					const refreshed = await this.effect(() =>
						modifyBinary.call(this.vault, copy.path, bytes),
					);
					if (!refreshed)
						return this.attend(
							copy.path,
							"Recovery retention clock could not be refreshed",
						);
					const saved = await this.vault.readBinary?.(copy.path);
					this.assertOpen();
					if (!saved || (await digestBytes(saved)) !== copy.hash)
						return this.attend(
							copy.path,
							"Recovery copy changed while its retention clock refreshed",
						);
				}
			}
			const remoteCopy = binaryCopies.find((copy) => copy.mode === "remote");
			if (remoteCopy && change.op === "put") {
				await this.activeJournal.recordAttention(
					change.path,
					"Remote binary path collides with a local case-folded or Unicode-equivalent path",
				);
				await this.activeJournal.completeApply(change.path, {
					deleted: false,
					rev: parseETag(change.etag).rev,
					hash: change.hash,
				});
				return;
			}
			if (change.op === "rename") {
				await this.finishBinaryRename(change, state, binaryCopies);
				return;
			}
			if (change.op === "delete") {
				const localCopy = binaryCopies.find(
					(copy) => copy.purpose === "conflict",
				);
				const local = await this.vault.readBinary?.(change.path);
				if (
					!localCopy ||
					!local ||
					(await digestBytes(local)) !== localCopy.hash
				)
					return this.attend(
						change.path,
						"Local binary changed after delete recovery copy",
					);
				const readBinary = this.vault.readBinary;
				const trashBinary = this.vault.trashBinary;
				if (!readBinary || !trashBinary)
					return this.attend(
						change.path,
						"Binary trash capability is unavailable after conflict preservation",
					);
				const trashed = await this.effect(() =>
					trashBinary.call(this.vault, change.path, local),
				);
				const remaining = await readBinary.call(this.vault, change.path);
				if (!trashed || remaining)
					return this.attend(
						change.path,
						"Obsidian trash did not confirm the binary delete",
					);
				await this.activeJournal.recordAttention(
					change.path,
					"Local binary bytes were preserved as a conflict copy",
				);
				await this.activeJournal.completeApply(change.path, {
					deleted: true,
					rev: parseETag(change.etag).rev,
				});
				return;
			}
			if (change.op !== "put")
				return this.attend(
					change.path,
					"Binary recovery cannot complete this entry",
				);
			await this.applyBlobChange(
				change as ChangeEntry & { op: "put" },
				state.base[change.path] ?? null,
			);
			return;
		}
		for (const copy of copies) {
			if (!(await this.conflictCopyIsVerified(copy)))
				return this.attend(
					copy.path,
					"Conflict copy changed during remote apply",
				);
		}
		const remoteCopy = copies.find((copy) => copy.mode === "remote");
		if (remoteCopy) {
			await this.fetchText(
				pending.change.path,
				pending.change.etag,
				pending.change.hash,
			);
			await this.activeJournal.recordAttention(
				pending.change.path,
				"Remote path collides with a local case-folded or Unicode-equivalent path",
			);
			await this.activeJournal.completeApply(pending.change.path, {
				deleted: false,
				rev: parseETag(pending.change.etag).rev,
				hash: pending.change.hash,
			});
			return;
		}
		const change = pending.change;
		if (change.op === "delete") {
			const current = await this.vault.read(change.path);
			if (current !== null) {
				const copy = copies.find(
					(candidate) =>
						candidate.mode === "local" && candidate.source === change.path,
				);
				if (!copy || (await digest(current)) !== copy.hash)
					return this.attend(
						change.path,
						"Local text changed after its conflict copy was saved",
					);
				if (!(await this.conflictCopyIsVerified(copy)))
					return this.attend(
						change.path,
						"Conflict copy changed during remote apply",
					);
				if (!(await this.confirmLocalTrash(change.path, current)))
					return this.attend(
						change.path,
						"Obsidian trash did not confirm the remote delete",
					);
			}
			await this.activeJournal.completeApply(change.path, {
				deleted: true,
				rev: parseETag(change.etag).rev,
			});
			return;
		}
		if (change.op === "rename") {
			const fromRev = parseETag(change.from_etag).rev;
			const sourceBase = state.base[change.from_path];
			const sourcePending =
				sourceBase !== undefined &&
				(sourceBase.rev < fromRev ||
					state.stale_base_paths.includes(change.from_path));
			const destinationBase = state.base[change.path];
			const destinationPending =
				destinationBase === undefined ||
				destinationBase.rev < parseETag(change.etag).rev ||
				state.stale_base_paths.includes(change.path);
			if (!destinationPending) {
				const source = sourcePending
					? await this.vault.read(change.from_path)
					: null;
				if (source !== null) {
					const copy = copies.find(
						(candidate) =>
							candidate.mode === "local" &&
							candidate.source === change.from_path,
					);
					const sourceHash = await digest(source);
					const clean =
						sourceBase?.deleted === false && sourceHash === sourceBase.hash;
					const copied = copy !== undefined && sourceHash === copy.hash;
					if (!clean && !copied)
						return this.attend(
							change.from_path,
							"Rename source changed after its recovery copy was saved",
						);
					if (copied && copy && !(await this.conflictCopyIsVerified(copy)))
						return this.attend(
							change.from_path,
							"Conflict copy changed during remote apply",
						);
					if (!(await this.confirmLocalTrash(change.from_path, source)))
						return this.attend(
							change.from_path,
							"Obsidian trash did not confirm the rename source",
						);
				}
				await this.activeJournal.completeRenameApply(
					change.from_path,
					sourcePending ? { deleted: true, rev: fromRev } : null,
					change.path,
					null,
				);
				return;
			}
		}
		const remote = await this.fetchText(change.path, change.etag, change.hash);
		const destination = await this.vault.read(change.path);
		if (destination !== null && destination !== remote) {
			const copy = copies.find(
				(candidate) =>
					candidate.mode === "local" && candidate.source === change.path,
			);
			const destinationBase = state.base[change.path];
			const clean =
				destinationBase?.deleted === false &&
				(await digest(destination)) === destinationBase.hash;
			const copied =
				copy !== undefined && (await digest(destination)) === copy.hash;
			if (!clean && !copied)
				return this.attend(
					change.path,
					"Local text changed after its conflict copy was saved",
				);
			if (copied && copy && !(await this.conflictCopyIsVerified(copy)))
				return this.attend(
					change.path,
					"Conflict copy changed during remote apply",
				);
		}
		if (
			!(await this.applyRemoteText(
				change.path,
				change.hash,
				destination,
				remote,
			))
		)
			return this.attend(
				change.path,
				"Remote text was not confirmed after conflict copy",
			);
		if (change.op === "rename") {
			const fromRev = parseETag(change.from_etag).rev;
			const sourceBase = state.base[change.from_path];
			const sourcePending =
				sourceBase !== undefined &&
				(sourceBase.rev < fromRev ||
					state.stale_base_paths.includes(change.from_path));
			if (sourcePending) {
				const source = await this.vault.read(change.from_path);
				if (source !== null) {
					const copy = copies.find(
						(candidate) =>
							candidate.mode === "local" &&
							candidate.source === change.from_path,
					);
					const sourceHash = await digest(source);
					const clean =
						sourceBase.deleted === false && sourceHash === sourceBase.hash;
					const copied = copy !== undefined && sourceHash === copy.hash;
					if (!clean && !copied)
						return this.attend(
							change.from_path,
							"Rename source changed after its recovery copy was saved",
						);
					if (copied && copy && !(await this.conflictCopyIsVerified(copy)))
						return this.attend(
							change.from_path,
							"Conflict copy changed during remote apply",
						);
					if (!(await this.confirmLocalTrash(change.from_path, source)))
						return this.attend(
							change.from_path,
							"Obsidian trash did not confirm the rename source",
						);
				}
			}
			await this.activeJournal.completeRenameApply(
				change.from_path,
				sourcePending ? { deleted: true, rev: fromRev } : null,
				change.path,
				{
					deleted: false,
					rev: parseETag(change.etag).rev,
					hash: change.hash,
				},
			);
			return;
		}
		await this.activeJournal.completeApply(change.path, {
			deleted: false,
			rev: parseETag(change.etag).rev,
			hash: change.hash,
		});
	}

	/** Rechecks one local recovery file against its durable hash before a destructive effect. */
	private async conflictCopyIsVerified(
		copy: PendingConflictCopy,
	): Promise<boolean> {
		const text = await this.vault.read(copy.path);
		return text !== null && (await digest(text)) === copy.hash;
	}

	/** Applies pinned text with an exact path guard and confirms the stored bytes. */
	private async applyRemoteText(
		path: string,
		hash: string,
		expected: string | null,
		remote: string,
	): Promise<boolean> {
		await this.activeJournal.setExpectedWrite(path, hash);
		const applied =
			expected === null
				? await this.effect(() => this.vault.create(path, remote))
				: await this.effect(() => this.vault.process(path, expected, remote));
		if ((await this.vault.read(path)) === remote) return true;
		if (!applied) await this.activeJournal.clearExpectedWrite(path);
		return false;
	}

	/** Confirms an observed local path no longer exists after Obsidian trash. */
	private async confirmLocalTrash(
		path: string,
		expected: string,
	): Promise<boolean> {
		await this.effect(() => this.vault.trash(path, expected));
		return (await this.vault.read(path)) === null;
	}

	/** Records pinned remote bytes under a deterministic name when a local path key collides. */
	private async startRemoteCollision(
		change: ChangeEntry,
		remoteText: string,
	): Promise<void> {
		const conflictHash = await digest(remoteText);
		const conflictPath = conflictName(
			change.path,
			this.deviceName,
			parseETag(change.etag).rev,
			change.at,
		);
		await this.activeJournal.updateApply({
			change,
			step: "named",
			conflict_copies: [
				{
					path: conflictPath,
					source: change.path,
					side: "path",
					mode: "remote",
					device_name: this.deviceName,
					hash: conflictHash,
				},
			],
		});
		await this.resumePending(
			this.activeJournal.snapshot()
				.pending_apply[0] as DeviceState["pending_apply"][number],
		);
	}

	/** Records the local bytes and deterministic copy path before creating a conflict file. */
	private async startConflict(
		change: ChangeEntry,
		sourcePath: string,
		text: string | null,
	): Promise<void> {
		if (text === null)
			return this.attend(
				sourcePath,
				"Local text disappeared before conflict preservation",
			);
		const side =
			change.op !== "rename"
				? "path"
				: sourcePath === change.from_path
					? "rename_source"
					: "rename_destination";
		await this.startConflictCopies(change, [
			{ source: sourcePath, text, side },
		]);
		await this.resumePending(
			this.activeJournal.snapshot()
				.pending_apply[0] as DeviceState["pending_apply"][number],
		);
	}

	/** Persists every affected side before it creates any conflict copy. */
	private async startConflictCopies(
		change: ChangeEntry,
		candidates: Array<{
			source: string;
			text: string;
			side: PendingConflictCopy["side"];
		}>,
	): Promise<void> {
		const rev = parseETag(change.etag).rev;
		const conflictCopies: PendingConflictCopy[] = [];
		for (const candidate of candidates) {
			conflictCopies.push({
				path: conflictName(candidate.source, this.deviceName, rev, change.at),
				source: candidate.source,
				side: candidate.side,
				mode: "local",
				device_name: this.deviceName,
				hash: await digest(candidate.text),
			});
		}
		await this.activeJournal.updateApply({
			change,
			step: "named",
			conflict_copies: conflictCopies,
		});
	}

	/** Stores a durable blocker and leaves all current files and base revisions intact. */
	private async attend(path: string, reason: string): Promise<void> {
		const state = this.activeJournal.snapshot();
		await this.activeJournal.recordAttention(path, reason);
		if (state.pending_apply.length) return;
	}

	/** Fetches only the requested revision and checks its canonical SHA-256 before use. */
	private async fetchText(
		path: string,
		etag: string,
		expectedHash: string,
	): Promise<string> {
		const { epoch, rev } = parseETag(etag);
		if (this.pinnedText.readResolved) {
			const result = await this.pinnedText.readResolved(path, epoch, rev);
			this.assertOpen();
			if (
				result.epoch !== epoch ||
				(result.deleted === true
					? result.hash !== "" || result.text !== null
					: result.text === null || (await digest(result.text)) !== result.hash)
			)
				throw new Error("Current fallback text metadata is invalid");
			if (result.rev !== rev || result.deleted === true) {
				const pending = this.activeJournal.snapshot().pending_apply[0];
				if (!pending)
					throw new Error("Pinned fallback has no durable apply identity");
				if (result.deleted === true && pending.change.op !== "put")
					throw new Error(
						"Current tombstone cannot replace this remote operation",
					);
				const rebased: ChangeEntry =
					result.deleted === true
						? {
								...pending.change,
								op: "delete",
								etag: `"${epoch}.${result.rev}"`,
								hash: "",
							}
						: {
								...pending.change,
								etag: `"${epoch}.${result.rev}"`,
								hash: result.hash,
							};
				const copies =
					pending.step === "prepared"
						? undefined
						: await this.rebaseConflictCopies(pending, result);
				await this.activeJournal.rebasePendingApply(rebased, copies);
				throw new PinnedRevisionRebased(rebased);
			}
			if (result.hash !== expectedHash)
				throw new Error("Pinned remote text hash mismatch");
			return result.text;
		}
		const text = await this.pinnedText.read(path, epoch, rev);
		this.assertOpen();
		if (text === null) throw new Error("Pinned remote text is unavailable");
		if ((await digest(text)) !== expectedHash)
			throw new Error("Pinned remote text hash mismatch");
		this.assertOpen();
		return text;
	}

	/** Keeps verified copies and replaces only unsaved remote-copy plans after fallback. */
	private async rebaseConflictCopies(
		pending: DeviceState["pending_apply"][number],
		resolved: ResolvedPinnedText,
	): Promise<PendingConflictCopy[]> {
		const next: PendingConflictCopy[] = [];
		const copies = conflictCopiesFor(pending);
		const hasRemotePlan = copies.some((copy) => copy.mode === "remote");
		let hasCurrentRemote = false;
		for (const copy of copies) {
			if (copy.mode === "local") {
				next.push(copy);
				continue;
			}
			const saved = await this.vault.read(copy.path);
			this.assertOpen();
			if (saved !== null) {
				if ((await digest(saved)) !== copy.hash)
					throw new Error("Conflict copy changed before revision rebase");
				if (resolved.deleted !== true) {
					next.push({ ...copy, verified: true });
					hasCurrentRemote ||= copy.hash === resolved.hash;
				} else {
					next.push({ ...copy, mode: "local", verified: undefined });
				}
			}
		}
		if (hasRemotePlan && resolved.deleted !== true && !hasCurrentRemote) {
			const side =
				pending.change.op === "rename" ? "rename_destination" : "path";
			next.push({
				path: conflictName(
					pending.change.path,
					this.deviceName,
					resolved.rev,
					pending.change.at,
				),
				source: pending.change.path,
				side,
				mode: "remote",
				device_name: this.deviceName,
				hash: resolved.hash,
			});
		}
		return next;
	}

	/** Finds a different exact path with the same canonical case-folded path key. */
	private async pathCollision(path: string): Promise<string | null> {
		return (
			(await this.vault.list()).find(
				(candidate) =>
					candidate !== path && pathKey(candidate) === pathKey(path),
			) ?? null
		);
	}

	/** Starts one host mutation only while active and fences its stale completion. */
	private async effect<T>(action: () => Promise<T>): Promise<T> {
		this.assertOpen();
		const result = await action();
		this.assertOpen();
		return result;
	}

	/** Adds lifecycle serialization and keeps later jobs usable after one rejection. */
	private serialize(action: () => Promise<void>): Promise<void> {
		const result = this.tail.then(async () => {
			this.assertOpen();
			await action();
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Provides the journal only while this engine can start a durable transition. */
	private get activeJournal(): DeviceJournal {
		this.assertOpen();
		return this.journal;
	}

	/** Rejects queued work after unload without assuming Obsidian canceled an effect. */
	private assertOpen(): void {
		if (this.closed) throw new Error("Text apply engine is closed");
	}
}

/** Compares nullable host file metadata used to detect a binary race. */
function sameStat(
	left: { mtime: number; size: number } | null,
	right: { mtime: number; size: number } | null,
): boolean {
	return left?.mtime === right?.mtime && left?.size === right?.size;
}

/** Hashes exact bytes with Web Crypto for blob identity and recovery verification. */
async function digestBytes(bytes: Uint8Array): Promise<string> {
	const copy = bytes.slice();
	const hash = await crypto.subtle.digest("SHA-256", copy.buffer);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Hashes UTF-8 text with Web Crypto for revision and conflict-copy verification. */
async function digest(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return DevicePayloadHashSchema.parse(
		[...new Uint8Array(hash)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join(""),
	);
}

/** Reads new per-side conflict state or adapts one validated legacy conflict record. */
function conflictCopiesFor(
	pending: DeviceState["pending_apply"][number],
): PendingConflictCopy[] {
	if (pending.conflict_copies) return pending.conflict_copies;
	if (
		pending.conflict_path === undefined ||
		pending.conflict_source === undefined ||
		pending.conflict_mode === undefined ||
		pending.conflict_hash === undefined
	)
		return [];
	const side =
		pending.change.op !== "rename"
			? "path"
			: pending.conflict_source === pending.change.from_path
				? "rename_source"
				: "rename_destination";
	return [
		{
			path: pending.conflict_path,
			source: pending.conflict_source,
			side,
			mode: pending.conflict_mode,
			...(pending.conflict_device_name
				? { device_name: pending.conflict_device_name }
				: {}),
			hash: pending.conflict_hash,
		},
	];
}

/** Builds the path-bound, revision-stable conflict name used across retries. */
function conflictName(
	path: string,
	deviceName: string,
	rev: number,
	timestamp: number,
): string {
	const slash = path.lastIndexOf("/");
	const directory = slash < 0 ? "" : path.slice(0, slash + 1);
	const filename = slash < 0 ? path : path.slice(slash + 1);
	const dot = filename.lastIndexOf(".");
	const stem = dot <= 0 ? filename : filename.slice(0, dot);
	const extension = dot <= 0 ? "" : filename.slice(dot);
	const time = new Date(timestamp)
		.toISOString()
		.slice(0, 16)
		.replace("T", " ")
		.replace(":", "");
	const safeDeviceName = deviceName.trim().replace(/[\p{Cc}\\/:*?"<>|]/gu, "_");
	return `${directory}${stem} (conflict ${safeDeviceName} ${time} r${rev})${extension}`;
}
