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

/** Exact text effects required from a vault without exposing Obsidian SDK types. */
export interface TextVault {
	/** Reads current UTF-8 text, or null when the path is absent. */
	read(path: string): Promise<string | null>;
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
	/** Renames without link rewriting when source bytes and destination absence still hold. */
	rename(from: string, to: string, expected: string): Promise<boolean>;
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
}

/** Fetches immutable remote text by its exact path and server revision. */
export interface PinnedTextProvider {
	/** Returns text pinned to the exact epoch and revision, or null when unavailable. */
	read(path: string, epoch: string, rev: number): Promise<string | null>;
	/** Reads pinned text with identity replacement when a pruned revision falls back to current. */
	readResolved?(
		path: string,
		epoch: string,
		rev: number,
	): Promise<{ text: string; epoch: string; rev: number; hash: string }>;
}

/** Serializes revision-pinned text changes and recovers durable conflict steps. */
export class TextApplyEngine {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly deviceName: string;
	private readonly prefetched = new Map<
		string,
		{ text: string; epoch: string; rev: number; hash: string }
	>();

	/** Binds journal authority to text effects and a pinned-revision reader. */
	constructor(
		private readonly journal: DeviceJournal,
		private readonly vault: TextVault,
		private readonly pinnedText: PinnedTextProvider,
		options: TextApplyOptions,
	) {
		this.deviceName = options.deviceName.trim();
		if (!this.deviceName) throw new Error("A friendly device name is required");
	}

	/** Validates and applies one immutable remote entry without discarding newer local bytes. */
	apply(change: ChangeEntry): Promise<void> {
		const parsed = ChangeEntrySchema.parse(structuredClone(change));
		const key = `${parsed.path}\\0${parsed.etag}\\0${parsed.hash}`;
		return this.serialize(async () => {
			try {
				await this.applyWithFallback(parsed);
			} finally {
				this.prefetched.delete(key);
			}
		});
	}

	/** Resumes the one verified pending transition after a plugin restart. */
	resume(): Promise<void> {
		return this.serialize(async () => {
			const pending = this.activeJournal.snapshot().pending_apply[0];
			if (pending) await this.applyWithFallback(pending.change);
		});
	}

	/** Reads and validates remote content before an apply can inspect local bytes. */
	async preflight(change: ChangeEntry): Promise<void> {
		const parsed = ChangeEntrySchema.parse(change);
		if (parsed.op === "delete") return;
		this.assertOpen();
		const { epoch, rev } = parseETag(parsed.etag);
		let resolved: { text: string; epoch: string; rev: number; hash: string };
		if (this.pinnedText.readResolved) {
			resolved = await this.pinnedText.readResolved(parsed.path, epoch, rev);
		} else {
			const text = await this.pinnedText.read(parsed.path, epoch, rev);
			if (text === null) throw new Error("Pinned remote text is unavailable");
			resolved = { text, epoch, rev, hash: await digest(text) };
		}
		this.assertOpen();
		if (
			resolved.epoch !== epoch ||
			(await digest(resolved.text)) !== resolved.hash ||
			(resolved.rev === rev && resolved.hash !== parsed.hash)
		)
			throw new Error("Pinned remote text metadata is invalid");
		this.prefetched.set(
			`${parsed.path}\\0${parsed.etag}\\0${parsed.hash}`,
			resolved,
		);
	}

	/** Fences queued work after plugin unload without claiming host effects were canceled. */
	close(): void {
		this.closed = true;
	}

	/** Repeats one accepted entry after the journal commits a pruned-revision replacement. */
	private async applyWithFallback(change: ChangeEntry): Promise<void> {
		try {
			await this.applyEntry(change);
		} catch (error) {
			if (!(error instanceof PinnedRevisionRebased)) throw error;
			await this.applyEntry(error.change);
		}
	}

	/** Runs one accepted entry or continues its persisted conflict step. */
	private async applyEntry(change: ChangeEntry): Promise<void> {
		this.assertOpen();
		const state = this.activeJournal.snapshot();
		const pending = state.pending_apply[0];
		if (pending && pending.change.seq !== change.seq)
			throw new Error("Another remote apply is pending");
		if (!pending) {
			await this.activeJournal.beginApply(change);
			const current = this.activeJournal.snapshot();
			if (await this.ignoreObsolete(change, current)) return;
			if (change.op === "rename") {
				await this.applyRename(change, current);
				return;
			}
			await this.applyPathChange(change, current.base[change.path] ?? null);
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

	/** Applies one put or delete after exact observed bytes and durable conflict checks. */
	private async applyPathChange(
		change: Extract<ChangeEntry, { op: "put" | "delete" }>,
		base: DeviceBaseEntry | null,
	): Promise<void> {
		const remoteRev = parseETag(change.etag).rev;
		const local = await this.vault.read(change.path);
		this.assertOpen();
		if (change.op === "put") {
			const remote = await this.fetchText(
				change.path,
				change.etag,
				change.hash,
			);
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

	/** Saves a dirty source before completing the destination side of a remote rename. */
	private async applyRename(
		change: Extract<ChangeEntry, { op: "rename" }>,
		state: DeviceState,
	): Promise<void> {
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

	/** Continues a durable conflict copy before retrying the same pinned remote effect. */
	private async resumePending(
		pending: DeviceState["pending_apply"][number],
	): Promise<void> {
		if (pending.step === "named") {
			const copies = conflictCopiesFor(pending);
			for (const copy of copies) {
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
				await this.applyPathChange(change, current.base[change.path] ?? null);
		}
	}

	/** Completes verified conflict copies before it commits the pinned remote effect. */
	private async finishCopiedApply(
		pending: DeviceState["pending_apply"][number],
		state: DeviceState,
	): Promise<void> {
		const copies = conflictCopiesFor(pending);
		for (const copy of copies) {
			if (!(await this.conflictCopyIsVerified(copy)))
				return this.attend(
					copy.path,
					"Conflict copy changed during remote apply",
				);
		}
		const remoteCopy = copies.find((copy) => copy.mode === "remote");
		if (remoteCopy) {
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
		const prefetchedKey = `${path}\\0${etag}\\0${expectedHash}`;
		const prefetched = this.prefetched.get(prefetchedKey);
		this.prefetched.delete(prefetchedKey);
		if (prefetched) {
			if (prefetched.epoch !== epoch)
				throw new Error("Pinned remote text epoch mismatch");
			if (prefetched.rev !== rev) {
				const pending = this.activeJournal.snapshot().pending_apply[0];
				if (!pending)
					throw new Error("Pinned fallback has no durable apply identity");
				const rebased = {
					...pending.change,
					etag: `"${epoch}.${prefetched.rev}"`,
					hash: prefetched.hash,
				};
				await this.activeJournal.rebasePendingApply(rebased);
				throw new PinnedRevisionRebased(rebased);
			}
			if (prefetched.hash !== expectedHash)
				throw new Error("Pinned remote text hash mismatch");
			return prefetched.text;
		}
		if (this.pinnedText.readResolved) {
			const result = await this.pinnedText.readResolved(path, epoch, rev);
			this.assertOpen();
			if (result.epoch !== epoch || (await digest(result.text)) !== result.hash)
				throw new Error("Current fallback text metadata is invalid");
			if (result.rev !== rev) {
				const pending = this.activeJournal.snapshot().pending_apply[0];
				if (!pending)
					throw new Error("Pinned fallback has no durable apply identity");
				const rebased = {
					...pending.change,
					etag: `"${epoch}.${result.rev}"`,
					hash: result.hash,
				};
				await this.activeJournal.rebasePendingApply(rebased);
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
