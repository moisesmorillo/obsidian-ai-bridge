import { CoexistenceEffectBlockedError } from "@plugin/sync/coexistence-effect-fence";
import type { DeviceJournal } from "@plugin/sync/device-journal";
import {
	classifyEnrollmentPath,
	DEFAULT_SETTINGS_SYNC_POLICY,
	type SettingsSyncPolicy,
	settingsConflictExtension,
} from "@plugin/sync/enrollment-scope";
import { UnsupportedRemoteTextError } from "@plugin/sync/remote-text";
import {
	type ChangeEntry,
	ChangeEntrySchema,
	type DeviceBaseEntry,
	DevicePayloadHashSchema,
	type DeviceState,
	MAX_PENDING_CONFLICT_COPIES,
	PathSchema,
	type PendingConflictCopy,
	parseETag,
	pathKey,
} from "@vaultwire/protocol";

/** Application-owned guarded text and byte effects without Obsidian SDK types. */
export interface TextVault {
	/** Reads current UTF-8 text, or null when the path is absent. */
	read(path: string): Promise<string | null>;
	/** Reads exact file bytes without text decoding, or null when the path is absent. */
	readBinary?(path: string): Promise<Uint8Array | null>;
	/** Returns mtime and size from the host adapter for a binary race guard. */
	stat?(path: string): Promise<{ mtime: number; size: number } | null>;
	/** Guards byte creation against observed collisions. Settings adapters report races but cannot exclude unobserved writes. */
	createBinary?(
		path: string,
		bytes: Uint8Array,
		onSettingsRace?: (observed: Uint8Array | null) => Promise<void>,
	): Promise<boolean>;
	/** Replaces current bytes after the caller completes its host stat guard. */
	modifyBinary?(
		path: string,
		bytes: Uint8Array,
		expected?: Uint8Array,
		onSettingsRace?: (observed: Uint8Array | null) => Promise<void>,
	): Promise<boolean>;
	/** Moves exact observed binary bytes to Obsidian trash without decoding them. */
	trashBinary?(path: string, expected: Uint8Array): Promise<boolean>;
	/** Removes only a hash-verified file under the pre-apply recovery directory. */
	removeRecoveryCopy?(path: string, expectedHash: string): Promise<boolean>;
	/** Lists current paths so case-folded and Unicode-key collisions stay visible. */
	list(): Promise<string[]>;
	/** Returns true when metadata finds an iCloud placeholder for the exact source path. */
	isUnavailable?(path: string): Promise<boolean>;
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
	/** Calls once for each newly created and byte-verified visible conflict copy. */
	onConflictCopy?(path: string): void;
	/** Clock in Unix milliseconds for synthetic observations and recovery retention checks. */
	now?: () => number;
	/** Rejects a new local write while a coexistence confirmation blocks effects. */
	isEffectBlocked?: () => boolean;
	/** Policy applied before remote bytes can enter local settings paths. */
	settingsPolicy?: SettingsSyncPolicy;
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

/** Reads pinned text or exact bytes and exposes validated current authority after revision pruning. */
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

/** Owns shared text and byte apply policy, durable conflict recovery, and revision completion. */
export class TextApplyEngine {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly deviceName: string;
	private readonly now: () => number;
	private readonly isEffectBlocked: () => boolean;
	/** Policy used to reject disabled settings paths at every apply boundary. */
	private readonly settingsPolicy: SettingsSyncPolicy;
	/** Host notice callback; failures cannot change durable apply effects. */
	private readonly onConflictCopy: ((path: string) => void) | undefined;

	/** Binds journal authority to guarded text and byte effects and a pinned-revision reader. */
	constructor(
		private readonly journal: DeviceJournal,
		private readonly vault: TextVault,
		private readonly pinnedText: PinnedTextProvider,
		options: TextApplyOptions,
	) {
		this.deviceName = options.deviceName.trim();
		this.now = options.now ?? Date.now;
		this.isEffectBlocked = options.isEffectBlocked ?? (() => false);
		this.settingsPolicy =
			options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY;
		this.onConflictCopy = options.onConflictCopy;
		if (!this.deviceName) throw new Error("A friendly device name is required");
	}

	/** Validates and applies one immutable remote entry without discarding newer local bytes. */
	apply(change: ChangeEntry, contentKind?: "text" | "blob"): Promise<void> {
		const parsed = ChangeEntrySchema.parse(structuredClone(change));
		if (this.isSettingsPathDisabled(parsed.path)) return Promise.resolve();
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
		if (this.isSettingsPathDisabled(path)) return Promise.resolve();
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
					at: this.observationTime(),
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

	/** Returns the configured Unix-millisecond clock for synthetic authority observations. */
	observationTime(): number {
		return this.now();
	}

	/** Fences queued work after plugin unload without claiming host effects were canceled. */
	close(): void {
		this.closed = true;
	}

	/** Repeats rebased work and records durable attention for transfer failures. */
	private async applyWithFallback(
		change: ChangeEntry,
		contentKind?: "text" | "blob",
	): Promise<void> {
		let activeChange = change;
		try {
			try {
				await this.applyEntry(change, contentKind);
			} catch (error) {
				if (!(error instanceof PinnedRevisionRebased)) throw error;
				activeChange = error.change;
				await this.applyEntry(activeChange, contentKind);
			}
		} catch (error) {
			await this.recordApplyFailure(activeChange, error);
			throw error;
		}
	}

	/** Clears echo expectations and records attention for failed storage effects. */
	private async recordApplyFailure(
		change: ChangeEntry,
		error: unknown,
	): Promise<void> {
		const transferFailure =
			error instanceof Error &&
			(("code" in error && error.code === "ENOSPC") ||
				[
					"Remote create was not confirmed",
					"Binary create was not confirmed",
					"Binary write was not confirmed",
					"Binary read-back did not match remote bytes",
				].includes(error.message));
		if (!transferFailure) return;
		const state = this.activeJournal.snapshot();
		const revision = parseETag(change.etag).rev;
		if ((state.base[change.path]?.rev ?? 0) >= revision) return;
		const affectedPaths =
			change.op === "rename" ? [change.from_path, change.path] : [change.path];
		for (const path of affectedPaths)
			await this.activeJournal.clearExpectedWrite(path);
		await this.activeJournal.recordAttention(
			change.path,
			"Remote apply failed and needs recovery",
		);
	}

	/** Runs one accepted entry or continues its persisted conflict step. */
	private async applyEntry(
		change: ChangeEntry,
		contentKind?: "text" | "blob",
	): Promise<void> {
		this.assertOpen();
		const affectedPaths =
			change.op === "rename" ? [change.from_path, change.path] : [change.path];
		for (const path of affectedPaths)
			if (await this.vault.isUnavailable?.(path))
				throw new Error("Remote apply is blocked by an unavailable path");
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
			[change.path],
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

	/** Applies pinned content after resolving its kind and preserving exact local bytes. */
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
		const remote = await this.resolvePinnedContent(change);
		if (remote.kind === "text") {
			await this.applyInlineTextAfterBlob(change, base, remote.text);
			return;
		}
		if (remote.kind === "deleted")
			throw new Error("Pinned put revision is deleted");
		const firstStat = await this.vault.stat(change.path);
		this.assertOpen();
		const local = await this.vault.readBinary(change.path);
		this.assertOpen();
		if (local === null) {
			if (firstStat !== null || !this.vault.createBinary)
				throw new Error("Binary create precondition changed");
			const collision = (await this.vault.list()).find(
				(current) =>
					current !== change.path &&
					PathSchema.safeParse(current).success &&
					pathKey(current) === pathKey(change.path),
			);
			this.assertOpen();
			if (collision) {
				await this.startRemoteBlobCollision(change);
				return;
			}
			await this.activeJournal.setExpectedWrite(change.path, change.hash);
			this.assertOpen();
			const createdPath = await this.effect(
				[change.path],
				async () =>
					(await this.vault.createBinary?.(
						change.path,
						remote.bytes,
						(observed) =>
							this.preserveSettingsWriteRace(change, [
								remote.bytes,
								...(observed ? [observed] : []),
							]),
					)) ?? false,
				[{ path: change.path, hash: change.hash }],
			);
			const created = await this.vault.readBinary(change.path);
			this.assertOpen();
			if (
				createdPath &&
				created &&
				(await digestBytes(created)) === change.hash
			) {
				await this.activeJournal.completeApply(change.path, {
					deleted: false,
					rev: identity.rev,
					hash: change.hash,
				});
				return;
			}
			if (created && change.path.startsWith(".obsidian/"))
				await this.preserveSettingsWriteRace(change, [remote.bytes, created]);
			await this.activeJournal.clearExpectedWrite(change.path);
			this.assertOpen();
			const lateCollision = (await this.vault.list()).find(
				(current) =>
					current !== change.path &&
					PathSchema.safeParse(current).success &&
					pathKey(current) === pathKey(change.path),
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
			if (change.path.startsWith(".obsidian/")) {
				await this.preserveSettingsWriteRace(change, [
					local,
					changed,
					remote.bytes,
				]);
				throw new Error("Settings changed during observation");
			}
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
				conflict_copies:
					clean && sameStat(firstStat, secondStat)
						? [recoveryCopy]
						: [localCopy, recoveryCopy],
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
		let copies = blobCopies;
		let observedConflict = copies.find(
			(copy) =>
				copy.purpose === "conflict" &&
				copy.source === change.path &&
				copy.hash === observedHash,
		);
		let observedRecovery = copies.find(
			(copy) =>
				copy.purpose === "pre_apply" &&
				copy.source === change.path &&
				copy.hash === observedHash,
		);
		if (!observedRecovery || (!observedConflict && !clean)) {
			const continued = await this.extendBinaryRecovery(
				change,
				pending,
				copies,
				observed,
				observedHash,
				firstStat,
				secondStat,
			);
			if (!continued) return;
			copies = continued;
			observedConflict = copies.find(
				(copy) =>
					copy.purpose === "conflict" &&
					copy.source === change.path &&
					copy.hash === observedHash,
			);
			observedRecovery = copies.find(
				(copy) =>
					copy.purpose === "pre_apply" &&
					copy.source === change.path &&
					copy.hash === observedHash,
			);
		}
		if (!observedRecovery || (!observedConflict && !clean))
			return this.attend(
				change.path,
				"Binary recovery identity changed before apply completed",
			);
		for (const copy of copies) {
			const saved = await this.vault.readBinary(copy.path);
			this.assertOpen();
			if (!saved || (await digestBytes(saved)) !== copy.hash)
				return this.attend(
					copy.path,
					"Binary recovery bytes are missing or corrupt",
				);
		}
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
		) {
			if (change.path.startsWith(".obsidian/"))
				await this.preserveSettingsWriteRace(change, [
					local,
					observed,
					remote.bytes,
					...(latest ? [latest] : []),
				]);
			throw new Error("Binary changed again during conflict preservation");
		}
		if (!this.vault.modifyBinary)
			throw new Error("Binary write capability is unavailable");
		await this.activeJournal.setExpectedWrite(change.path, change.hash);
		const written = await this.effect(
			[change.path],
			async () =>
				(await this.vault.modifyBinary?.(
					change.path,
					remote.bytes,
					observed,
					(current) =>
						this.preserveSettingsWriteRace(change, [
							observed,
							remote.bytes,
							...(current ? [current] : []),
						]),
				)) ?? false,
			[{ path: change.path, hash: change.hash }],
		);
		if (!written) {
			await this.activeJournal.clearExpectedWrite(change.path);
			throw new Error("Binary write was not confirmed");
		}
		const readBack = await this.vault.readBinary(change.path);
		this.assertOpen();
		if (!readBack || (await digestBytes(readBack)) !== change.hash) {
			if (change.path.startsWith(".obsidian/"))
				await this.preserveSettingsWriteRace(change, [
					observed,
					remote.bytes,
					...(readBack ? [readBack] : []),
				]);
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

	/** Saves every observed settings version outside config before reporting a guarded-write race. */
	private async preserveSettingsWriteRace(
		change: ChangeEntry,
		versions: Uint8Array[],
	): Promise<void> {
		if (!change.path.startsWith(".obsidian/")) return;
		await this.activeJournal.recordAttention(
			change.path,
			"Settings changed during guarded write. Observed versions need review",
		);
		for (const bytes of versions) {
			const hash = await digestBytes(bytes);
			const path = recoveryConflictName(
				change.path,
				this.deviceName,
				parseETag(change.etag).rev,
				change.at,
				hash,
			);
			if (!path)
				throw new Error("Settings conflict path exceeds the path limit");
			const existing = await this.vault.readBinary?.(path);
			this.assertOpen();
			if (existing && (await digestBytes(existing)) === hash) continue;
			const created = await this.effect(
				[path],
				() => this.vault.createBinary?.(path, bytes) ?? Promise.resolve(false),
			);
			const saved = await this.vault.readBinary?.(path);
			if (!created || !saved || (await digestBytes(saved)) !== hash)
				throw new Error("Settings race conflict copy did not verify");
			this.notifyConflictCopy(path);
		}
	}

	/** Preserves local blob bytes for inline authority and resumes existing copy identities without naming them again. */
	private async applyInlineTextAfterBlob(
		change: ChangeEntry & { op: "put" },
		base: DeviceBaseEntry | null,
		remoteText: string,
	): Promise<void> {
		const pending = this.activeJournal.snapshot().pending_apply[0];
		if (pending?.conflict_copies?.some((copy) => copy.kind === "blob")) {
			await this.activeJournal.updateApply({
				...pending,
				content_kind: "text",
			});
			await this.resumePending({ ...pending, content_kind: "text" });
			return;
		}
		const readBinary = this.vault.readBinary;
		const stat = this.vault.stat;
		if (!readBinary || !stat) {
			await this.applyPathChange(change, base, true, "text");
			return;
		}
		const localBytes = await readBinary.call(this.vault, change.path);
		this.assertOpen();
		if (!localBytes) {
			await this.applyPathChange(change, base, true, "text");
			return;
		}
		const remoteBytes = new TextEncoder().encode(remoteText);
		if ((await digestBytes(localBytes)) === (await digestBytes(remoteBytes))) {
			await this.activeJournal.completeApply(change.path, {
				deleted: false,
				rev: parseETag(change.etag).rev,
				hash: change.hash,
			});
			return;
		}
		if (!this.vault.createBinary)
			throw new Error("Binary-to-text recovery capabilities are unavailable");
		const firstStat = await stat.call(this.vault, change.path);
		this.assertOpen();
		const observed = await readBinary.call(this.vault, change.path);
		this.assertOpen();
		const secondStat = await stat.call(this.vault, change.path);
		this.assertOpen();
		if (
			!observed ||
			(await digestBytes(observed)) !== (await digestBytes(localBytes)) ||
			!sameStat(firstStat, secondStat)
		)
			throw new Error("Binary changed before inline-text recovery was named");
		const observedHash = await digestBytes(observed);
		const revision = parseETag(change.etag).rev;
		const conflictCopy: PendingConflictCopy = {
			path: conflictName(change.path, this.deviceName, revision, change.at),
			source: change.path,
			side: "path",
			mode: "local",
			device_name: this.deviceName,
			hash: observedHash,
			kind: "blob",
			purpose: "conflict",
		};
		const recoveryCopy: PendingConflictCopy = {
			...conflictCopy,
			path: `.ai-bridge/pre-apply/${observedHash}`,
			purpose: "pre_apply",
		};
		await this.activeJournal.updateApply({
			change,
			content_kind: "text",
			step: "named",
			conflict_copies: [conflictCopy, recoveryCopy],
		});
		const named = this.activeJournal.snapshot().pending_apply[0];
		if (!named) throw new Error("Inline-text recovery identity was not saved");
		await this.resumePending(named);
	}

	/** Holds remote settings changes while their local category is disabled. */
	private isSettingsPathDisabled(path: string): boolean {
		return (
			path.startsWith(".obsidian/") &&
			classifyEnrollmentPath(path, 0, this.settingsPolicy) === "excluded"
		);
	}

	/** Selects local byte preservation independently of remote kind before guarded put or delete effects. */
	private async applyPathChange(
		change: Extract<ChangeEntry, { op: "put" | "delete" }>,
		base: DeviceBaseEntry | null,
		forceText = false,
		contentKind?: "text" | "blob",
	): Promise<void> {
		const remoteRev = parseETag(change.etag).rev;
		const size = await this.vault.size(change.path);
		this.assertOpen();
		const admission = classifyEnrollmentPath(
			change.path,
			size ?? 0,
			this.settingsPolicy,
		);
		if (admission === "unsupported") {
			await this.attend(
				change.path,
				"Local file exceeds the supported apply size",
			);
			return;
		}
		const preserveLocalBytes = admission === "blob";
		const readRemoteAsBlob =
			contentKind === "blob" ||
			(contentKind === undefined && preserveLocalBytes);
		if (!forceText && readRemoteAsBlob && change.op === "put") {
			await this.applyBlobChange(change as ChangeEntry & { op: "put" }, base);
			return;
		}
		if (
			!forceText &&
			(preserveLocalBytes || contentKind === "blob") &&
			change.op === "delete"
		) {
			await this.applyBlobDelete(
				change as ChangeEntry & { op: "delete" },
				base,
			);
			return;
		}
		if (change.op === "put") {
			let remote: string;
			try {
				remote = await this.fetchText(change.path, change.etag, change.hash);
			} catch (error) {
				if (!(error instanceof UnsupportedRemoteTextError)) throw error;
				await this.applyBlobChange(change as ChangeEntry & { op: "put" }, base);
				return;
			}
			if (!forceText && preserveLocalBytes) {
				await this.applyInlineTextAfterBlob(
					{ ...change, op: "put" },
					base,
					remote,
				);
				return;
			}
			const local = await this.vault.read(change.path);
			this.assertOpen();
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
				await this.effect(
					[change.path],
					() => this.vault.create(change.path, remote),
					[{ path: change.path, hash: change.hash }],
				);
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
				if (createdText !== null) {
					await this.activeJournal.recordAttention(
						change.path,
						"Remote text create was not confirmed; local bytes need review",
					);
					await this.startConflict(change, change.path, createdText);
				} else throw new Error("Remote create was not confirmed");
				return;
			}
			const clean =
				base?.deleted === false && (await digest(local)) === base.hash;
			if (clean) {
				await this.activeJournal.setExpectedWrite(change.path, change.hash);
				const writeConfirmed = await this.effect(
					[change.path],
					() => this.vault.process(change.path, local, remote),
					[{ path: change.path, hash: change.hash }],
				);
				if (writeConfirmed) {
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
		const local = await this.vault.read(change.path);
		this.assertOpen();
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
			!(await this.effect([change.path], () =>
				this.vault.trash(change.path, local),
			)) &&
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

	/**
	 * Validates pinned bytes and kind before effects. Invalid identity or bytes stop the apply.
	 * Newer authority retains visible copy identities, but explicit tombstones release replacement-only plans without removing their stored bytes.
	 */
	private async resolvePinnedContent(
		change: ChangeEntry & { op: "put" | "rename" },
	): Promise<ResolvedPinnedBlob> {
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
		this.assertOpen();
		if (!remote) throw new Error("Kind-aware content reader is unavailable");
		if (
			remote.epoch !== identity.epoch ||
			remote.rev < identity.rev ||
			(remote.rev === identity.rev && remote.hash !== change.hash) ||
			(remote.kind === "blob" &&
				(await digestBytes(remote.bytes)) !== remote.hash) ||
			(remote.kind === "text" && (await digest(remote.text)) !== remote.hash) ||
			(remote.kind === "deleted" &&
				(remote.hash !== "" || remote.text !== null))
		)
			throw new Error("Pinned content identity or bytes are invalid");
		if (remote.kind === "deleted" && change.op === "rename")
			throw new Error("Remote rename destination is deleted");
		if (remote.rev > identity.rev) {
			const pending = this.activeJournal.snapshot().pending_apply[0];
			if (!pending)
				throw new Error("Pinned fallback has no durable apply identity");
			const rebased = ChangeEntrySchema.parse({
				...pending.change,
				...(remote.kind === "deleted" ? { op: "delete" } : {}),
				etag: `"${remote.epoch}.${remote.rev}"`,
				hash: remote.hash,
			});
			const replacementOnly =
				pending.conflict_copies?.length === 1 &&
				pending.conflict_copies[0]?.purpose === "pre_apply";
			await this.activeJournal.rebasePendingApply(
				rebased,
				remote.kind === "deleted" && replacementOnly
					? []
					: pending.conflict_copies,
			);
			throw new PinnedRevisionRebased(rebased);
		}
		return remote;
	}

	/** Preserves pending local rename sides as exact bytes independently of the remote destination kind. */
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
		if (
			sourceClean &&
			sourceHash === change.hash &&
			destinationPending &&
			destination === null
		) {
			const firstStat = await this.vault.stat(change.from_path);
			await this.resolvePinnedContent(change);
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
				[change.from_path, change.path],
				async () =>
					this.vault.renameBinary?.(change.from_path, change.path, sourceNow) ??
					false,
				[{ path: change.path, hash: change.hash }],
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

	/** Completes byte-preserved rename sides with binary effects or atomic inline text effects as their local representation allows. */
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
			? await this.resolvePinnedContent(change)
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
			remote &&
			remote.kind !== "deleted"
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
			let written: boolean;
			if (remote.kind === "text") {
				const destinationSize = await this.vault.size(change.path);
				this.assertOpen();
				if (
					classifyEnrollmentPath(
						change.path,
						destinationSize ?? 0,
						this.settingsPolicy,
					) === "blob"
				) {
					written = await this.replacePreservedBytesWithText(
						change.path,
						change.hash,
						destinationHash as string,
						remote.text,
					);
				} else {
					const expected = await this.vault.read(change.path);
					this.assertOpen();
					if (
						expected === null
							? destinationHash !== null
							: (await digest(expected)) !== destinationHash
					)
						return this.attend(
							change.path,
							"Inline rename destination changed before guarded apply",
						);
					written = await this.applyRemoteText(
						change.path,
						change.hash,
						expected,
						remote.text,
					);
				}
			} else {
				written =
					destination === null
						? await this.effect(
								[change.path],
								async () =>
									this.vault.createBinary?.(
										change.path,
										remote.bytes,
										(observed) =>
											this.preserveSettingsWriteRace(change, [
												remote.bytes,
												...(observed ? [observed] : []),
											]),
									) ?? false,
								[{ path: change.path, hash: change.hash }],
							)
						: this.vault.modifyBinary
							? await this.effect(
									[change.path],
									async () =>
										this.vault.modifyBinary?.(
											change.path,
											remote.bytes,
											destination,
											(observed) =>
												this.preserveSettingsWriteRace(change, [
													destination,
													remote.bytes,
													...(observed ? [observed] : []),
												]),
										) ?? false,
									[{ path: change.path, hash: change.hash }],
								)
							: false;
			}
			const writtenBytes = await this.vault.readBinary(change.path);
			this.assertOpen();
			if (
				!written ||
				!writtenBytes ||
				(await digestBytes(writtenBytes)) !== change.hash
			) {
				await this.activeJournal.clearExpectedWrite(change.path);
				if (change.path.startsWith(".obsidian/") && remote.kind === "blob")
					await this.preserveSettingsWriteRace(change, [
						remote.bytes,
						...(destination ? [destination] : []),
						...(writtenBytes ? [writtenBytes] : []),
					]);
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
			const trashed = await this.effect([change.from_path, change.path], () =>
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

	/** Admits each pending local rename side before remote-kind dispatch and preserves dirty sides before effects. */
	private async applyRename(
		change: Extract<ChangeEntry, { op: "rename" }>,
		state: DeviceState,
	): Promise<void> {
		const fromRev = parseETag(change.from_etag).rev;
		const toIdentity = parseETag(change.etag);
		const sourceBase = state.base[change.from_path];
		const destinationBase = state.base[change.path];
		const staleBases = state.stale_base_paths;
		const sourcePending =
			sourceBase !== undefined &&
			(sourceBase.rev < fromRev || staleBases.includes(change.from_path));
		const destinationPending =
			destinationBase === undefined ||
			destinationBase.rev < toIdentity.rev ||
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
		const sourceSize = sourcePending
			? await this.vault.size(change.from_path)
			: null;
		this.assertOpen();
		const destinationSize = destinationPending
			? await this.vault.size(change.path)
			: null;
		this.assertOpen();
		if (
			(sourcePending &&
				classifyEnrollmentPath(
					change.from_path,
					sourceSize ?? 0,
					this.settingsPolicy,
				) === "blob") ||
			(destinationPending &&
				classifyEnrollmentPath(
					change.path,
					destinationSize ?? 0,
					this.settingsPolicy,
				) === "blob")
		) {
			await this.applyBlobRename(change, state);
			return;
		}
		if (destinationPending && this.pinnedText.readResolvedBlob) {
			const remote = await this.resolvePinnedContent(change);
			if (remote.kind === "blob") {
				await this.applyBlobRename(change, state);
				return;
			}
		}
		const toRev = toIdentity.rev;
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
				const renamedFile = await this.effect(
					[change.from_path, change.path],
					() => this.vault.rename(change.from_path, change.path, source),
					[{ path: change.path, hash: change.hash }],
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
					!(await this.confirmLocalTrash(change.from_path, source, [
						change.from_path,
						change.path,
					]))
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
				if (
					!(await this.confirmLocalTrash(change.from_path, source, [
						change.from_path,
						change.path,
					]))
				) {
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
			if (
				!(await this.confirmLocalTrash(change.from_path, source, [
					change.from_path,
					change.path,
				]))
			) {
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

	/**
	 * Adds a newly observed local blob version to the durable plan without changing earlier copy identities.
	 * Existing copies must verify before the journal re-enters `named`. The new visible and pre-apply copies
	 * are persisted before effects, and a changed stat pair always stops before remote replacement.
	 */
	private async extendBinaryRecovery(
		change: ChangeEntry & { op: "put" },
		pending: DeviceState["pending_apply"][number] | undefined,
		copies: PendingConflictCopy[],
		observed: Uint8Array,
		observedHash: string,
		firstStat: { mtime: number; size: number } | null,
		secondStat: { mtime: number; size: number } | null,
	): Promise<PendingConflictCopy[] | null> {
		const stat = this.vault.stat;
		if (
			!pending ||
			!this.vault.readBinary ||
			!this.vault.createBinary ||
			!stat
		) {
			await this.attend(
				change.path,
				"Binary recovery capability is unavailable",
			);
			return null;
		}
		if ((await digestBytes(observed)) !== observedHash) {
			await this.attend(
				change.path,
				"Observed binary bytes do not match their recovery identity",
			);
			return null;
		}
		for (const copy of copies) {
			if (copy.kind !== "blob") continue;
			const saved = await this.vault.readBinary(copy.path);
			this.assertOpen();
			if (!saved || (await digestBytes(saved)) !== copy.hash) {
				await this.attend(
					copy.path,
					"Binary recovery bytes are missing or corrupt",
				);
				return null;
			}
		}
		const nextCopies = conflictCopiesFor(pending);
		/** Finds whether one saved plan already covers this source hash and copy purpose. */
		const hasLocalVersion = (purpose: PendingConflictCopy["purpose"]) =>
			nextCopies.some(
				(copy) =>
					copy.kind === "blob" &&
					copy.source === change.path &&
					copy.hash === observedHash &&
					copy.purpose === purpose,
			);
		const addConflict = !hasLocalVersion("conflict");
		const addPreApply = !hasLocalVersion("pre_apply");
		if (
			nextCopies.length + Number(addConflict) + Number(addPreApply) >
			MAX_PENDING_CONFLICT_COPIES
		) {
			await this.attend(
				change.path,
				"More local byte versions changed than durable recovery can retain",
			);
			return null;
		}
		if (addConflict) {
			const revision = parseETag(change.etag).rev;
			const conflictPath = recoveryConflictName(
				change.path,
				this.deviceName,
				revision,
				this.now(),
				observedHash,
			);
			if (!conflictPath) {
				await this.attend(
					change.path,
					"No valid recovery-copy path fits the canonical path limit",
				);
				return null;
			}
			nextCopies.push({
				path: conflictPath,
				source: change.path,
				side: "path",
				mode: "local",
				device_name: this.deviceName,
				hash: observedHash,
				kind: "blob",
				purpose: "conflict",
			});
		}
		if (addPreApply)
			nextCopies.push({
				path: `.ai-bridge/pre-apply/${observedHash}`,
				source: change.path,
				side: "path",
				mode: "local",
				device_name: this.deviceName,
				hash: observedHash,
				kind: "blob",
				purpose: "pre_apply",
			});
		await this.activeJournal.rebasePendingApply(change, nextCopies);
		this.assertOpen();
		const named = this.activeJournal.snapshot().pending_apply[0];
		if (!named) throw new Error("Extended binary recovery plan was not saved");
		await this.persistBinaryConflictCopies(named);
		this.assertOpen();
		const copied = this.activeJournal.snapshot().pending_apply[0];
		if (copied?.step !== "copied") return null;
		if (!sameStat(firstStat, secondStat))
			throw new Error(
				"Binary changed during observation; retry after conflict preservation",
			);
		const latest = await this.vault.readBinary(change.path);
		this.assertOpen();
		const beforeWrite = await stat.call(this.vault, change.path);
		this.assertOpen();
		if (
			!latest ||
			(await digestBytes(latest)) !== observedHash ||
			!sameStat(firstStat, beforeWrite)
		)
			throw new Error("Binary changed again during conflict preservation");
		return (
			copied.conflict_copies?.filter(
				(copy): copy is PendingConflictCopy => copy.kind === "blob",
			) ?? []
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
			const created = await this.effect([copy.source, copy.path], () =>
				createBinary.call(this.vault, copy.path, source),
			);
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
			if (created && copy.purpose !== "pre_apply")
				this.notifyConflictCopy(copy.path);
		}
		await this.activeJournal.updateApply({ ...pending, step: "copied" });
		this.assertOpen();
	}

	/**
	 * Resumes a named or copied apply only while its local size remains supported.
	 * Unsupported size records attention and retains pending work without content reads or base advancement.
	 * Confirmed remote effects advance the base and clear pending work; refused or unsafe effects retain pending work.
	 */
	private async resumePending(
		pending: DeviceState["pending_apply"][number],
	): Promise<void> {
		if (this.isSettingsPathDisabled(pending.change.path)) return;
		if (pending.change.op !== "rename") {
			const size = await this.vault.size(pending.change.path);
			this.assertOpen();
			if (
				classifyEnrollmentPath(
					pending.change.path,
					size ?? 0,
					this.settingsPolicy,
				) === "unsupported"
			) {
				await this.attend(
					pending.change.path,
					"Local file exceeds the supported apply size",
				);
				return;
			}
		}
		if (pending.step === "named") {
			const copies = conflictCopiesFor(pending);
			for (const copy of copies) {
				if (copy.kind !== "blob") continue;
				const existingBytes = await this.vault.readBinary?.(copy.path);
				this.assertOpen();
				if (existingBytes && (await digestBytes(existingBytes)) !== copy.hash)
					return this.attend(
						copy.source,
						"Binary recovery copy was edited before apply finished",
					);
				if (!existingBytes && copy.mode === "local") {
					const sourceBytes = await this.vault.readBinary?.(copy.source);
					this.assertOpen();
					if (!sourceBytes || (await digestBytes(sourceBytes)) !== copy.hash)
						return this.attend(
							copy.source,
							"Local binary changed before its recovery copy was saved",
						);
				}
			}
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
								[copy.path],
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
					const created = await this.effect(
						[copy.source, copy.path],
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
					if (created && copy.purpose !== "pre_apply")
						this.notifyConflictCopy(copy.path);
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
				const created = await this.effect([copy.source, copy.path], () =>
					this.vault.create(copy.path, text as string),
				);
				const saved = await this.vault.read(copy.path);
				if (saved === null || (await digest(saved)) !== copy.hash)
					return this.attend(
						copy.path,
						"Conflict copy path contains different bytes",
					);
				if (created && copy.purpose !== "pre_apply")
					this.notifyConflictCopy(copy.path);
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

	/** Verifies byte copies and resolves current content kind before completing an inline replacement or changing its recovery route. */
	private async finishBlobToTextApply(
		pending: DeviceState["pending_apply"][number],
		copies: PendingConflictCopy[],
	): Promise<void> {
		const change = pending.change;
		const currentBytes = await this.vault.readBinary?.(change.path);
		this.assertOpen();
		const currentHash = currentBytes ? await digestBytes(currentBytes) : null;
		const currentPair = currentHash
			? copies.filter(
					(copy) => copy.source === change.path && copy.hash === currentHash,
				)
			: [];
		const conflict = currentPair.find((copy) => copy.purpose === "conflict");
		const recovery = currentPair.find((copy) => copy.purpose === "pre_apply");
		const base = this.activeJournal.snapshot().base[change.path];
		if (
			!recovery ||
			(conflict && conflict.hash !== recovery.hash) ||
			(!conflict && (base?.deleted !== false || base.hash !== recovery.hash))
		)
			return this.attend(
				change.path,
				"Inline-text recovery identity is invalid",
			);
		const verifiedCopies = new Map<string, Uint8Array>();
		for (const copy of copies) {
			const saved = await this.vault.readBinary?.(copy.path);
			this.assertOpen();
			if (!saved || (await digestBytes(saved)) !== copy.hash)
				return this.attend(
					copy.path,
					"Inline-text recovery bytes are missing or corrupt",
				);
			verifiedCopies.set(copy.path, saved);
		}
		for (const copy of copies.filter(
			(candidate) => candidate.purpose === "pre_apply",
		)) {
			const saved = verifiedCopies.get(copy.path);
			const modifyBinary = this.vault.modifyBinary;
			if (!saved || !modifyBinary)
				return this.attend(
					copy.path,
					"Recovery retention clock could not be refreshed",
				);
			const refreshed = await this.effect([copy.path], () =>
				modifyBinary.call(this.vault, copy.path, saved),
			);
			if (!refreshed)
				return this.attend(
					copy.path,
					"Recovery retention clock could not be refreshed",
				);
			const verified = await this.vault.readBinary?.(copy.path);
			this.assertOpen();
			if (!verified || (await digestBytes(verified)) !== copy.hash)
				return this.attend(
					copy.path,
					"Recovery bytes changed during retention refresh",
				);
		}
		let remote: string;
		if (this.pinnedText.readResolvedBlob) {
			if (change.op !== "put")
				throw new Error("Inline recovery needs put authority");
			const resolved = await this.resolvePinnedContent({
				...change,
				op: "put",
			});
			if (resolved.kind !== "text") {
				const rerouted = { ...pending, content_kind: "blob" as const };
				await this.activeJournal.updateApply(rerouted);
				await this.finishCopiedApply(rerouted, this.activeJournal.snapshot());
				return;
			}
			remote = resolved.text;
		} else remote = await this.fetchText(change.path, change.etag, change.hash);
		if (
			!(await this.replacePreservedBytesWithText(
				change.path,
				change.hash,
				recovery.hash,
				remote,
			))
		)
			return;
		if (conflict)
			await this.activeJournal.recordAttention(
				change.path,
				"Local binary bytes were preserved as a conflict copy",
			);
		await this.activeJournal.completeApply(change.path, {
			deleted: false,
			rev: parseETag(change.etag).rev,
			hash: change.hash,
		});
		this.assertOpen();
	}

	/**
	 * Replaces exact preserved bytes with inline text and accepts absence after an earlier confirmed trash.
	 * The caller must verify recovery bytes and any visible conflict copies before this effect.
	 */
	private async replacePreservedBytesWithText(
		path: string,
		remoteHash: string,
		preservedHash: string,
		remote: string,
	): Promise<boolean> {
		const readBinary = this.vault.readBinary;
		if (!readBinary) throw new Error("Binary read capability is unavailable");
		const current = await readBinary.call(this.vault, path);
		this.assertOpen();
		const currentIsRemote =
			current !== null && (await digestBytes(current)) === remoteHash;
		if (
			current &&
			!currentIsRemote &&
			(await digestBytes(current)) !== preservedHash
		) {
			await this.attend(
				path,
				"Local bytes changed after inline-text preservation",
			);
			return false;
		}
		await this.activeJournal.setExpectedWrite(path, remoteHash);
		this.assertOpen();
		if (current && !currentIsRemote) {
			const trashBinary = this.vault.trashBinary;
			if (!trashBinary)
				throw new Error(
					"Binary trash capability is unavailable for text replacement",
				);
			const trashed = await this.effect(
				[path],
				() => trashBinary.call(this.vault, path, current),
				[{ path, hash: remoteHash }],
			);
			this.assertOpen();
			const remaining = await readBinary.call(this.vault, path);
			this.assertOpen();
			if (!trashed || remaining !== null)
				throw new Error(
					"Binary path remained after inline-text replacement trash",
				);
		}
		const existingText = await this.vault.read(path);
		this.assertOpen();
		if (existingText === null) {
			const created = await this.effect(
				[path],
				() => this.vault.create(path, remote),
				[{ path, hash: remoteHash }],
			);
			this.assertOpen();
			if (!created) {
				await this.activeJournal.clearExpectedWrite(path);
				throw new Error("Inline remote text create was not confirmed");
			}
		} else if (existingText !== remote) {
			await this.activeJournal.clearExpectedWrite(path);
			await this.attend(
				path,
				"Unexpected text appeared during blob replacement",
			);
			return false;
		}
		if ((await this.vault.read(path)) !== remote)
			throw new Error("Inline remote text read-back did not match");
		return true;
	}

	/**
	 * Adds byte safeguards to verified local text plans without changing visible paths, sources, hashes, or device names.
	 * The journal returns to named through explicit plan rebasing, never through a backward updateApply transition.
	 */
	private async prepareBlobRecovery(
		pending: DeviceState["pending_apply"][number],
		copies: PendingConflictCopy[],
		state: DeviceState,
	): Promise<void> {
		const change = pending.change;
		if (change.op === "delete")
			throw new Error("Blob replacement needs live authority");
		const readBinary = this.vault.readBinary;
		if (!readBinary)
			throw new Error("Binary recovery capability is unavailable");
		for (const copy of copies) {
			const saved = await readBinary.call(this.vault, copy.path);
			this.assertOpen();
			if (!saved || (await digestBytes(saved)) !== copy.hash)
				return this.attend(
					copy.path,
					"Local recovery bytes changed before blob replacement",
				);
		}
		const current = await readBinary.call(this.vault, change.path);
		this.assertOpen();
		const currentHash = current === null ? null : await digestBytes(current);
		if (
			change.op === "put" &&
			(current === null || currentHash === change.hash)
		) {
			await this.applyBlobChange(
				{ ...change, op: "put" },
				state.base[change.path] ?? null,
			);
			return;
		}
		const plans: PendingConflictCopy[] = copies.map((copy) => ({
			...copy,
			kind: "blob",
			purpose: copy.purpose ?? "conflict",
		}));
		if (currentHash !== null && currentHash !== change.hash) {
			const visible = plans.find(
				(copy) =>
					copy.source === change.path &&
					copy.purpose === "conflict" &&
					copy.hash === currentHash,
			);
			const base = state.base[change.path];
			const cleanRenameDestination =
				change.op === "rename" &&
				base?.deleted === false &&
				base.hash === currentHash;
			if (!visible && !cleanRenameDestination)
				return this.attend(
					change.path,
					"Local bytes changed after text conflict preservation",
				);
			if (
				!plans.some(
					(copy) =>
						copy.source === change.path &&
						copy.purpose === "pre_apply" &&
						copy.hash === currentHash,
				)
			) {
				plans.push({
					path: `.ai-bridge/pre-apply/${currentHash}`,
					source: change.path,
					side: change.op === "rename" ? "rename_destination" : "path",
					mode: "local",
					device_name: visible?.device_name ?? this.deviceName,
					hash: currentHash,
					kind: "blob",
					purpose: "pre_apply",
				});
			}
		}
		await this.activeJournal.rebasePendingApply(change, plans);
		const rebased = this.activeJournal.snapshot().pending_apply[0];
		if (!rebased) throw new Error("Blob recovery plans were not saved");
		const next = { ...rebased, content_kind: "blob" as const };
		await this.activeJournal.updateApply(next);
		await this.resumePending(next);
	}

	/** Selects local recovery authority independently of text or byte copy representation before guarded effects. */
	private async finishCopiedApply(
		pending: DeviceState["pending_apply"][number],
		state: DeviceState,
	): Promise<void> {
		const copies = conflictCopiesFor(pending);
		const change = pending.change;
		const destinationBase = state.base[change.path];
		const destinationPending =
			change.op !== "rename" ||
			destinationBase === undefined ||
			destinationBase.rev < parseETag(change.etag).rev ||
			state.stale_base_paths.includes(change.path);
		let resolved: ResolvedPinnedBlob | undefined;
		if (
			copies.every((copy) => copy.mode === "local") &&
			this.pinnedText.readResolvedBlob &&
			destinationPending &&
			(change.op === "put" || change.op === "rename")
		) {
			resolved =
				change.op === "rename"
					? await this.resolvePinnedContent(change)
					: await this.resolvePinnedContent({ ...change, op: "put" });
			if (
				resolved.kind === "blob" &&
				copies.some((copy) => copy.kind !== "blob")
			) {
				await this.prepareBlobRecovery(pending, copies, state);
				return;
			}
		}
		if (
			copies.some((copy) => copy.kind === "blob") &&
			pending.content_kind === "text" &&
			pending.change.op === "put"
		) {
			const binaryCopies = copies.filter((copy) => copy.kind === "blob");
			if (binaryCopies.length === 0)
				return this.attend(
					pending.change.path,
					"Inline-text replacement has incomplete binary recovery identity",
				);
			await this.finishBlobToTextApply(pending, binaryCopies);
			return;
		}
		if (copies.some((copy) => copy.kind === "blob")) {
			const change = pending.change;
			const binaryCopies = copies.filter((copy) => copy.kind === "blob");
			const verifiedBinaryCopies = new Map<string, Uint8Array>();
			for (const copy of binaryCopies) {
				const bytes = await this.vault.readBinary?.(copy.path);
				this.assertOpen();
				if (!bytes || (await digestBytes(bytes)) !== copy.hash)
					return this.attend(
						copy.path,
						"Binary recovery copy changed during apply",
					);
				verifiedBinaryCopies.set(copy.path, bytes);
			}
			for (const copy of binaryCopies.filter(
				(candidate) => candidate.purpose === "pre_apply",
			)) {
				const bytes = verifiedBinaryCopies.get(copy.path);
				const modifyBinary = this.vault.modifyBinary;
				if (!bytes || !modifyBinary)
					return this.attend(
						copy.path,
						"Recovery retention clock could not be refreshed",
					);
				const refreshed = await this.effect([copy.path], () =>
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
				const readBinary = this.vault.readBinary;
				if (!readBinary)
					return this.attend(
						change.path,
						"Binary read capability is unavailable after conflict preservation",
					);
				const localBytes = await readBinary.call(this.vault, change.path);
				this.assertOpen();
				const localHash = localBytes ? await digestBytes(localBytes) : null;
				const localCopy = binaryCopies.find(
					(copy) => copy.purpose === "conflict" && copy.hash === localHash,
				);
				const local = await readBinary.call(this.vault, change.path);
				this.assertOpen();
				if (
					local &&
					(!localCopy || (await digestBytes(local)) !== localCopy.hash)
				)
					return this.attend(
						change.path,
						"Local binary changed after delete recovery copy",
					);
				if (local) {
					const trashBinary = this.vault.trashBinary;
					if (!trashBinary)
						return this.attend(
							change.path,
							"Binary trash capability is unavailable after conflict preservation",
						);
					const trashed = await this.effect([change.path], () =>
						trashBinary.call(this.vault, change.path, local),
					);
					const remaining = await readBinary.call(this.vault, change.path);
					this.assertOpen();
					if (!trashed || remaining)
						return this.attend(
							change.path,
							"Obsidian trash did not confirm the binary delete",
						);
				}
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
					if (
						!(await this.confirmLocalTrash(change.from_path, source, [
							change.from_path,
							change.path,
						]))
					)
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
		const remote =
			resolved?.kind === "text"
				? resolved.text
				: await this.fetchText(change.path, change.etag, change.hash);
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
					if (
						!(await this.confirmLocalTrash(change.from_path, source, [
							change.from_path,
							change.path,
						]))
					)
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
				? await this.effect([path], () => this.vault.create(path, remote), [
						{ path, hash },
					])
				: await this.effect(
						[path],
						() => this.vault.process(path, expected, remote),
						[{ path, hash }],
					);
		if ((await this.vault.read(path)) === remote) return true;
		if (!applied) await this.activeJournal.clearExpectedWrite(path);
		return false;
	}

	/** Calls the host notice port without allowing presentation errors to affect apply. */
	private notifyConflictCopy(path: string): void {
		try {
			this.onConflictCopy?.(path);
		} catch {
			// Presentation errors do not change durable apply effects.
		}
	}

	/** Confirms an observed local path no longer exists after Obsidian trash. */
	private async confirmLocalTrash(
		path: string,
		expected: string,
		affectedPaths: readonly string[] = [path],
	): Promise<boolean> {
		await this.effect(affectedPaths, () => this.vault.trash(path, expected));
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
					candidate !== path &&
					PathSchema.safeParse(candidate).success &&
					pathKey(candidate) === pathKey(path),
			) ?? null
		);
	}

	/** Checks exact paths and the fence before mutation, then clears unissued write echoes on refusal. */
	private async effect<T>(
		affectedPaths: readonly string[],
		action: () => Promise<T>,
		expectedWritePaths: readonly { path: string; hash: string }[] = [],
	): Promise<T> {
		this.assertOpen();
		/** Clears only echoes for writes that this admission has not started. */
		const clearExpectedWrites = async (): Promise<void> => {
			for (const expected of expectedWritePaths) {
				if (
					this.activeJournal.snapshot().expected_writes[expected.path] ===
					expected.hash
				)
					await this.activeJournal.clearExpectedWrite(expected.path);
			}
		};
		if (this.isEffectBlocked()) {
			await clearExpectedWrites();
			throw new CoexistenceEffectBlockedError();
		}
		const unavailable = await Promise.all(
			affectedPaths.map(
				async (path) => (await this.vault.isUnavailable?.(path)) ?? false,
			),
		);
		const unavailableIndex = unavailable.findIndex(Boolean);
		if (unavailableIndex >= 0) {
			const path = affectedPaths[unavailableIndex];
			if (path) await this.activeJournal.markUnavailable(path);
			await clearExpectedWrites();
			throw new Error("Remote apply is blocked by an unavailable path");
		}
		this.assertOpen();
		if (this.isEffectBlocked()) {
			await clearExpectedWrites();
			throw new CoexistenceEffectBlockedError();
		}
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

/** Builds a visible recovery-copy path distinct from prior conflict identities for one new byte hash. */
function recoveryConflictName(
	path: string,
	deviceName: string,
	rev: number,
	timestamp: number,
	hash: string,
): string | null {
	const original = conflictName(path, deviceName, rev, timestamp);
	const slash = original.lastIndexOf("/");
	const dot = original.lastIndexOf(".");
	const extensionStart = dot > slash ? dot : original.length;
	const directory = original.slice(0, slash + 1);
	const filename = original.slice(slash + 1, extensionStart);
	const extension = original.slice(extensionStart);
	const suffix = ` (recovery ${hash.slice(0, 16)})`;
	const encoder = new TextEncoder();
	const availableStemBytes =
		512 - encoder.encode(directory + suffix + extension).byteLength;
	if (availableStemBytes < 1) return null;
	let stem = filename;
	while (stem && encoder.encode(stem).byteLength > availableStemBytes)
		stem = [...stem].slice(0, -1).join("");
	if (!stem) return null;
	return `${directory}${stem}${suffix}${extension}`;
}

/** Builds the path-bound, revision-stable conflict name used across retries. */
function conflictName(
	path: string,
	deviceName: string,
	rev: number,
	timestamp: number,
): string {
	const isSettingsPath = path.startsWith(".obsidian/");
	const conflictSource = isSettingsPath
		? path.slice(".obsidian/".length).replaceAll("/", " — ")
		: path;
	const slash = conflictSource.lastIndexOf("/");
	const directory = isSettingsPath
		? "AI Bridge settings conflicts/"
		: slash < 0
			? ""
			: conflictSource.slice(0, slash + 1);
	const filename = slash < 0 ? conflictSource : conflictSource.slice(slash + 1);
	const dot = filename.lastIndexOf(".");
	const stem = dot <= 0 ? filename : filename.slice(0, dot);
	const sourceExtension = dot <= 0 ? "" : filename.slice(dot);
	const extension = isSettingsPath
		? settingsConflictExtension(sourceExtension)
		: sourceExtension;
	const time = new Date(timestamp)
		.toISOString()
		.slice(0, 16)
		.replace("T", " ")
		.replace(":", "");
	const safeDeviceName = deviceName.trim().replace(/[\p{Cc}\\/:*?"<>|]/gu, "_");
	return `${directory}${stem} (conflict ${safeDeviceName} ${time} r${rev})${extension}`;
}
