import {
	type ChangeEntry,
	ChangeEntrySchema,
	type DeviceBaseEntry,
	DevicePayloadHashSchema,
	type DeviceState,
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

/** Names conflict copies with one friendly device name for this engine lifetime. */
export interface TextApplyOptions {
	/** Stable display name stored with conflict recovery metadata. */
	deviceName: string;
}

/** Fetches immutable remote text by its exact path and server revision. */
export interface PinnedTextProvider {
	/** Returns text pinned to the exact epoch and revision, or null when unavailable. */
	read(path: string, epoch: string, rev: number): Promise<string | null>;
}

/** Serializes revision-pinned text changes and recovers durable conflict steps. */
export class TextApplyEngine {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;
	private readonly deviceName: string;

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
		return this.serialize(() => this.applyEntry(parsed));
	}

	/** Resumes the one verified pending transition after a plugin restart. */
	resume(): Promise<void> {
		return this.serialize(async () => {
			const pending = this.activeJournal.snapshot().pending_apply[0];
			if (pending) await this.applyEntry(pending.change);
		});
	}

	/** Fences queued work after plugin unload without claiming host effects were canceled. */
	close(): void {
		this.closed = true;
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
			const base =
				state.base[change.op === "rename" ? change.path : change.path];
			const revision = parseETag(change.etag).rev;
			if (change.op !== "rename" && base && revision <= base.rev) {
				await this.activeJournal.ignoreApply(change.path, revision);
				return;
			}
			if (change.op === "rename") {
				await this.applyRename(change, state);
				return;
			}
			await this.applyPathChange(change, base ?? null);
			return;
		}
		await this.resumePending(pending, state);
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
		const sourcePending = sourceBase !== undefined && sourceBase.rev < fromRev;
		const destinationPending =
			destinationBase === undefined || destinationBase.rev < toRev;
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
			await this.startConflict(change, change.from_path, source);
			return;
		}
		if (!destinationPending) {
			if (sourcePending) {
				if (
					source !== null &&
					!(await this.confirmRenameSourceTrash(change.from_path, source))
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
				if (!(await this.confirmRenameSourceTrash(change.from_path, source))) {
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
			if (!(await this.confirmRenameSourceTrash(change.from_path, source))) {
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
		state: DeviceState,
	): Promise<void> {
		if (
			pending.step === "named" &&
			pending.conflict_path &&
			pending.conflict_source &&
			pending.conflict_mode &&
			pending.conflict_hash
		) {
			const current = await this.vault.read(pending.conflict_path);
			if (pending.conflict_mode === "remote") {
				if (current === null) {
					const remote = await this.fetchText(
						pending.change.path,
						pending.change.etag,
						pending.conflict_hash,
					);
					if (
						!(await this.effect(() =>
							this.vault.create(pending.conflict_path as string, remote),
						)) &&
						(await this.vault.read(pending.conflict_path)) !== remote
					)
						return this.attend(
							pending.change.path,
							"Remote collision copy path contains different bytes",
						);
				} else if ((await digest(current)) !== pending.conflict_hash) {
					return this.attend(
						pending.change.path,
						"Remote collision copy was edited before the apply finished",
					);
				}
				const saved = await this.vault.read(pending.conflict_path);
				if (saved === null || (await digest(saved)) !== pending.conflict_hash)
					return this.attend(
						pending.change.path,
						"Remote collision copy did not verify",
					);
				await this.activeJournal.updateApply({ ...pending, step: "copied" });
			} else {
				if (current === null) {
					const original = await this.vault.read(pending.conflict_source);
					if (
						original === null ||
						(await digest(original)) !== pending.conflict_hash
					)
						return this.attend(
							pending.change.path,
							"Local text changed before its conflict copy was saved",
						);
					if (
						!(await this.effect(() =>
							this.vault.create(pending.conflict_path as string, original),
						)) &&
						(await this.vault.read(pending.conflict_path)) !== original
					)
						return this.attend(
							pending.change.path,
							"Conflict copy path contains different bytes",
						);
				} else if ((await digest(current)) !== pending.conflict_hash) {
					return this.attend(
						pending.change.path,
						"Conflict copy was edited before the apply finished",
					);
				}
				await this.activeJournal.updateApply({ ...pending, step: "copied" });
			}
		}
		const updated = this.activeJournal.snapshot().pending_apply[0];
		if (updated?.step === "copied") {
			const conflict = updated.conflict_path
				? await this.vault.read(updated.conflict_path)
				: null;
			if (
				conflict === null ||
				(await digest(conflict)) !== updated.conflict_hash
			)
				return this.attend(
					updated.change.path,
					"Conflict copy changed during remote apply",
				);
			if (updated.conflict_mode === "remote") {
				await this.activeJournal.recordAttention(
					updated.change.path,
					"Remote path collides with a local case-folded or Unicode-equivalent path",
				);
				await this.activeJournal.completeApply(updated.change.path, {
					deleted: false,
					rev: parseETag(updated.change.etag).rev,
					hash: updated.conflict_hash as string,
				});
				return;
			}
			const change = updated.change;
			if (change.op === "delete") {
				const current = await this.vault.read(change.path);
				if (
					current !== null &&
					!(await this.effect(() => this.vault.trash(change.path, current)))
				)
					return this.attend(
						change.path,
						"Obsidian trash did not confirm the remote delete",
					);
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
					sourceBase !== undefined && sourceBase.rev < fromRev;
				const destinationBase = state.base[change.path];
				const destinationPending =
					destinationBase === undefined ||
					destinationBase.rev < parseETag(change.etag).rev;
				if (!destinationPending) {
					const source = sourcePending
						? await this.vault.read(change.from_path)
						: null;
					if (source !== null) {
						const sourceHash = await digest(source);
						const sourceWasCopied =
							updated.conflict_source === change.from_path &&
							sourceHash === updated.conflict_hash;
						const sourceIsClean =
							sourceBase?.deleted === false && sourceHash === sourceBase.hash;
						if (!sourceWasCopied && !sourceIsClean)
							return this.attend(
								change.from_path,
								"Rename source changed after its recovery copy was saved",
							);
						if (
							!(await this.confirmRenameSourceTrash(change.from_path, source))
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
			const remote = await this.fetchText(
				change.path,
				change.etag,
				change.hash,
			);
			const current = await this.vault.read(change.path);
			const currentBase = state.base[change.path];
			const renameDestinationClean =
				change.op === "rename" &&
				current !== null &&
				currentBase?.deleted === false &&
				(await digest(current)) === currentBase.hash;
			if (
				current !== null &&
				current !== remote &&
				(await digest(current)) !== updated.conflict_hash &&
				!renameDestinationClean
			) {
				return this.attend(
					change.path,
					"Local text changed after its conflict copy was saved",
				);
			}
			const destinationConfirmed =
				change.op === "rename"
					? await this.applyRemoteText(
							change.path,
							change.hash,
							current,
							remote,
						)
					: await this.applyRemoteText(
							change.path,
							change.hash,
							current,
							remote,
						);
			if (!destinationConfirmed)
				return this.attend(
					change.path,
					"Remote text was not confirmed after conflict copy",
				);
			if (change.op === "rename") {
				const fromRev = parseETag(change.from_etag).rev;
				const sourceBase = state.base[change.from_path];
				const sourcePending =
					sourceBase !== undefined && sourceBase.rev < fromRev;
				if (sourcePending) {
					const source = await this.vault.read(change.from_path);
					if (source !== null) {
						const sourceHash = await digest(source);
						const sourceWasCopied =
							updated.conflict_source === change.from_path &&
							sourceHash === updated.conflict_hash;
						const sourceIsClean =
							sourceBase?.deleted === false && sourceHash === sourceBase.hash;
						if (!sourceWasCopied && !sourceIsClean)
							return this.attend(
								change.from_path,
								"Rename source changed after its recovery copy was saved",
							);
						if (
							!(await this.confirmRenameSourceTrash(change.from_path, source))
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
			} else {
				await this.activeJournal.completeApply(change.path, {
					deleted: false,
					rev: parseETag(change.etag).rev,
					hash: change.hash,
				});
			}
			return;
		}
		if (updated?.step === "prepared") {
			const change = updated.change;
			if (change.op === "rename") await this.applyRename(change, state);
			else await this.applyPathChange(change, state.base[change.path] ?? null);
		}
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

	/** Confirms the observed rename source no longer exists after local trash. */
	private async confirmRenameSourceTrash(
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
			conflict_path: conflictPath,
			conflict_source: change.path,
			conflict_mode: "remote",
			conflict_device_name: this.deviceName,
			conflict_hash: conflictHash,
		});
		await this.resumePending(
			this.activeJournal.snapshot()
				.pending_apply[0] as DeviceState["pending_apply"][number],
			this.activeJournal.snapshot(),
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
		const conflictHash = await digest(text);
		const rev = parseETag(change.etag).rev;
		const conflictPath = conflictName(
			sourcePath,
			this.deviceName,
			rev,
			change.at,
		);
		await this.activeJournal.updateApply({
			change,
			step: "named",
			conflict_path: conflictPath,
			conflict_source: sourcePath,
			conflict_mode: "local",
			conflict_device_name: this.deviceName,
			conflict_hash: conflictHash,
		});
		await this.resumePending(
			this.activeJournal.snapshot()
				.pending_apply[0] as DeviceState["pending_apply"][number],
			this.activeJournal.snapshot(),
		);
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
