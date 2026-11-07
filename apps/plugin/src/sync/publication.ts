import type {
	DeviceBaseEntry,
	DevicePrecondition,
	PendingOperation,
} from "@obsidian-ai-bridge/protocol";
import {
	DevicePayloadHashSchema,
	PathSchema,
	parseETag,
	pathKey,
} from "@obsidian-ai-bridge/protocol";
import { CoexistenceEffectBlockedError } from "@plugin/sync/coexistence-effect-fence";
import type { DeviceJournal } from "@plugin/sync/device-journal";
import {
	classifyEnrollmentPath,
	DEFAULT_SETTINGS_SYNC_POLICY,
	type SettingsSyncPolicy,
} from "@plugin/sync/enrollment-scope";
import {
	type DeleteResponseDiagnostic,
	SyncTransportError,
	UnsupportedRemoteTextError,
} from "@plugin/sync/remote-text";
import type {
	ResolvedPinnedBlob,
	TextApplyEngine,
	TextVault,
} from "@plugin/sync/text-apply";

/** Validated text authority returned for a pinned or current server read. */
export type PublicationRead =
	| { deleted: false; text: string; epoch: string; rev: number; hash: string }
	| { deleted: true; text: null; epoch: string; rev: number; hash: "" };

/** Authenticated mutation and revision reads used by local text publication. */
export interface PublicationRemote {
	/** Reads exact remote revision bytes and metadata, or a validated tombstone. */
	readAuthority(
		path: string,
		epoch: string,
		rev: number,
	): Promise<PublicationRead>;
	/** Reads current path identity, including its authoritative tombstone revision. */
	readCurrentAuthority(path: string): Promise<PublicationRead>;
	/** Reads a pinned binary revision or current file kind after revision pruning. */
	readBlobAuthority?(
		path: string,
		epoch: string,
		rev: number,
		hash: string,
	): Promise<ResolvedPinnedBlob>;
	/** Sends one immutable text put under its exact create or revision precondition. */
	put(
		path: string,
		text: string,
		precondition: DevicePrecondition,
		key: string,
		epoch: string,
	): Promise<PublicationReceipt>;
	/** Sends one conditional PUT with exact immutable bytes. The Worker owns authorize, upload, and commit. */
	putBlob?(
		path: string,
		bytes: Uint8Array,
		hash: string,
		precondition: DevicePrecondition,
		key: string,
		epoch: string,
	): Promise<PublicationReceipt>;
	/** Sends one immutable delete under its exact observed source revision. */
	delete(
		path: string,
		precondition: DevicePrecondition,
		key: string,
	): Promise<PublicationReceipt>;
	/** Sends one immutable rename under its exact observed source revision. */
	rename(
		path: string,
		to: string,
		precondition: DevicePrecondition,
		key: string,
	): Promise<PublicationReceipt>;
}

/** Validated metadata from one successful mutation response. */
export interface PublicationReceipt {
	status: number;
	path: string;
	etag: string;
	seq: number;
	size: number;
	hash: string;
	deleted: boolean;
}

/** Live vault operation supplied by an explicit event adapter, never inferred at startup. */
export type PublicationEvent =
	| { type: "create" | "modify"; path: string }
	| { type: "delete"; path: string }
	| { type: "rename"; path: string; to: string };

/** Shared apply ownership, deterministic time, and conflict recovery for one controller lifetime. */
export interface PublicationOptions {
	/** Shares guarded local apply with reconciliation. Current observations never become receipt authority. */
	applyEngine: TextApplyEngine;
	/** Returns current Unix milliseconds for retry and UUID creation decisions. */
	now(): number;
	/** Rejects new publication or apply effects while owner intent remains unresolved. */
	isEffectBlocked?: () => boolean;
	/** Captures only safe DELETE response classes, or clears the previous attempt. */
	onDeleteResponseDiagnostic?(
		diagnostic: DeleteResponseDiagnostic | null,
	): void;
	/** Replays feed rows and persists accepted cursors. A direct rename-source read does not advance the cursor. */
	recoverPrecondition(operation: PendingOperation): Promise<void>;
	/** One device-local category policy shared by every admission site. */
	settingsPolicy?: SettingsSyncPolicy;
}

/** Serializes startup detection, live event admission, immutable sends, and safe restore. */
export class PublicationController {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;

	/** Binds shared journal, apply-capable vault, remote authority, and deterministic time. */
	constructor(
		private readonly journal: DeviceJournal,
		private readonly vault: TextVault,
		private readonly remote: PublicationRemote,
		private readonly options: PublicationOptions,
	) {}

	/** Compares in-scope local hashes with confirmed bases and queues ordinary puts. */
	scan(): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			if (this.isEffectBlocked()) return;
			const state = this.journal.snapshot();
			const localPaths = await this.vault.list();
			this.assertOpen();
			const canonicalLocalPaths = new Set(localPaths.map(pathKey));
			const pendingRenameTargets = new Set(
				state.pending_ops
					.filter((operation) => operation.op === "rename")
					.map((operation) => pathKey(operation.to)),
			);
			for (const path of localPaths) {
				this.assertOpen();
				if (this.isEffectBlocked()) return;
				if (pendingRenameTargets.has(pathKey(path))) continue;
				if (await this.vault.isUnavailable?.(path)) {
					await this.journal.markUnavailable(path);
					continue;
				}
				if (state.unavailable_paths.includes(path))
					await this.journal.clearUnavailable(path);
				const size = await this.vault.size(path);
				this.assertOpen();
				if (size === null) continue;
				const admission = classifyEnrollmentPath(
					path,
					size,
					this.options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY,
				);
				if (admission === "excluded") continue;
				if (admission === "unsupported") {
					await this.journal.recordAttention(
						path,
						"File exceeds the 25 MB sync limit",
					);
					continue;
				}
				if (admission === "blob") {
					const bytes = await this.vault.readBinary?.(path);
					this.assertOpen();
					if (!bytes) continue;
					const hash = await digest(bytes);
					this.assertOpen();
					const base = state.base[path];
					if (base?.deleted === false && base.hash === hash) continue;
					if (await this.hasPendingPut(path, hash)) continue;
					if (this.isEffectBlocked()) return;
					await this.journal.enqueue(
						{
							op: "put",
							path,
							precondition: base
								? { kind: "match", epoch: state.epoch ?? "", rev: base.rev }
								: { kind: "absent" },
						},
						bytes,
					);
					continue;
				}
				this.assertOpen();
				const text = await this.vault.read(path);
				this.assertOpen();
				if (text === null) continue;
				const bytes = new TextEncoder().encode(text);
				if (bytes.byteLength > 1_000_000) {
					this.assertOpen();
					await this.journal.recordAttention(
						path,
						"Inline text exceeds the publication size limit",
					);
					continue;
				}
				const hash = await digest(bytes);
				this.assertOpen();
				const base = state.base[path];
				if (base?.deleted === false && base.hash === hash) continue;
				if (base && !state.epoch) {
					this.assertOpen();
					await this.journal.recordAttention(
						path,
						"Confirmed base has no vault epoch",
					);
					continue;
				}
				if (await this.hasPendingPut(path, hash)) continue;
				this.assertOpen();
				if (this.isEffectBlocked()) return;
				await this.journal.enqueue(
					{
						op: "put",
						path,
						precondition: base
							? { kind: "match", epoch: state.epoch ?? "", rev: base.rev }
							: { kind: "absent" },
					},
					bytes,
				);
			}
			for (const [path, base] of Object.entries(state.base)) {
				if (this.isEffectBlocked()) return;
				if (
					classifyEnrollmentPath(
						path,
						0,
						this.options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY,
					) === "excluded"
				)
					continue;
				if (base.deleted || canonicalLocalPaths.has(pathKey(path))) continue;
				if (
					state.pending_ops.some(
						(operation) =>
							(operation.op === "delete" || operation.op === "rename") &&
							pathKey(operation.path) === pathKey(path),
					)
				)
					continue;
				const current = await this.vault.list();
				this.assertOpen();
				if (current.some((item) => pathKey(item) === pathKey(path))) continue;
				if (await this.vault.isUnavailable?.(path)) {
					await this.journal.markUnavailable(path);
					continue;
				}
				if (state.unavailable_paths.includes(path))
					await this.journal.clearUnavailable(path);
				if (this.isEffectBlocked()) return;
				await this.restoreMissing(path, base.rev);
			}
		});
	}

	/** Admits only explicit in-scope live create, modify, delete, and rename events. */
	observe(event: PublicationEvent): Promise<void> {
		const parsed = validateEvent(event);
		const eventState = this.journal.snapshot();
		const observedBase = eventState.base[parsed.path];
		const observedEpoch = eventState.epoch;
		return this.serialize(async () => {
			this.assertOpen();
			if (this.isEffectBlocked()) return;
			if (
				classifyEnrollmentPath(
					parsed.path,
					0,
					this.options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY,
				) === "excluded"
			)
				return;
			if (parsed.type === "create" || parsed.type === "modify") {
				const size = await this.vault.size(parsed.path);
				this.assertOpen();
				if (size === null) return;
				const admission = classifyEnrollmentPath(
					parsed.path,
					size,
					this.options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY,
				);
				if (admission === "excluded") return;
				if (admission === "unsupported") {
					await this.journal.recordAttention(
						parsed.path,
						"File exceeds the 25 MB sync limit",
					);
					return;
				}
				if (admission === "blob") {
					const expected = this.journal.snapshot().expected_writes[parsed.path];
					const bytes = await this.vault.readBinary?.(parsed.path);
					this.assertOpen();
					if (!bytes) return;
					const hash = await digest(bytes);
					this.assertOpen();
					if (expected === hash) {
						const consumed = await this.journal.consumeExpectedWrite(
							parsed.path,
							hash,
						);
						this.assertOpen();
						if (consumed) return;
					}
					const current = this.journal.snapshot();
					const base = current.base[parsed.path];
					if (base?.deleted === false && base.hash === hash) return;
					if (this.isEffectBlocked()) return;
					await this.journal.enqueue(
						{
							op: "put",
							path: parsed.path,
							precondition: base
								? { kind: "match", epoch: current.epoch ?? "", rev: base.rev }
								: { kind: "absent" },
						},
						bytes,
					);
					return;
				}
				const expected = this.journal.snapshot().expected_writes[parsed.path];
				const text = await this.vault.read(parsed.path);
				this.assertOpen();
				if (text === null) return;
				const hash = await digest(new TextEncoder().encode(text));
				this.assertOpen();
				if (expected === hash) {
					this.assertOpen();
					await this.journal.consumeExpectedWrite(parsed.path, hash);
					return;
				}
				this.assertOpen();
				await this.enqueuePut(parsed.path, text);
				return;
			}
			if (parsed.type === "rename") {
				const size = await this.vault.size(parsed.to);
				this.assertOpen();
				const admission = classifyEnrollmentPath(
					parsed.to,
					size ?? 0,
					this.options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY,
				);
				if (admission === "excluded") return;
				if (admission === "unsupported") {
					await this.journal.recordAttention(
						parsed.to,
						"File exceeds the 25 MB sync limit",
					);
					return;
				}
			}
			const state = this.journal.snapshot();
			const base = state.base[parsed.path];
			const sourceText = await this.vault.read(parsed.path);
			this.assertOpen();
			const staleEvent =
				!this.journal.matchesBase(parsed.path, observedBase, observedEpoch) ||
				sourceText !== null;
			if (staleEvent) {
				if (parsed.type === "rename") {
					const destination = await this.readRenameDestination(parsed.to);
					if (destination !== null)
						await this.enqueueBinaryPut(parsed.to, destination);
				} else {
					await this.journal.recordAttention(
						parsed.path,
						"Live delete was superseded by newer local or remote state",
					);
				}
				return;
			}
			if (parsed.type === "delete" && (!base || base.deleted)) {
				const pending = state.pending_ops.filter(
					(item) => item.op === "put" && item.path === parsed.path,
				);
				const sentCreate = pending.find(
					(item) =>
						item.state === "sent" && item.precondition.kind === "absent",
				);
				for (const item of pending)
					if (item.state === "queued") {
						this.assertOpen();
						await this.journal.discardQueued(item.key);
					}
				if (sentCreate && state.epoch) {
					this.assertOpen();
					if (this.isEffectBlocked()) return;
					await this.journal.enqueue(
						{
							op: "delete",
							path: parsed.path,
							precondition: { kind: "absent" },
							depends_on: sentCreate.key,
						},
						new Uint8Array(),
					);
				}
				return;
			}
			if (!base || base.deleted || !state.epoch) return;
			const precondition = {
				kind: "match" as const,
				epoch: state.epoch,
				rev: base.rev,
			};
			if (parsed.type === "delete") {
				this.assertOpen();
				if (this.isEffectBlocked()) return;
				await this.journal.enqueue(
					{ op: "delete", path: parsed.path, precondition },
					new Uint8Array(),
				);
				return;
			}
			if (parsed.type === "rename") {
				this.assertOpen();
				if (this.isEffectBlocked()) return;
				await this.journal.enqueue(
					{
						op: "rename",
						path: parsed.path,
						to: parsed.to,
						precondition,
						source_hash: base.hash,
					},
					new Uint8Array(),
				);
			}
		});
	}

	/** Sends eligible operations without retry waits. Hydration recovery can restrict dispatch to immutable sent work. */
	flush(options: { sentOnly?: boolean } = {}): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			if (this.isEffectBlocked()) return;
			const keys = this.journal.snapshot().pending_ops.map((item) => item.key);
			for (const key of keys) {
				if (this.isEffectBlocked()) return;
				const operations = this.journal.snapshot().pending_ops;
				const operation = operations.find((item) => item.key === key);
				if (!operation || operation.state === "resolved") continue;
				if (options.sentOnly && operation.state !== "sent") continue;
				const affected =
					operation.op === "rename"
						? [operation.path, operation.to]
						: [operation.path];
				let unavailable = false;
				for (const path of affected)
					if (await this.vault.isUnavailable?.(path)) {
						await this.journal.markUnavailable(path);
						unavailable = true;
					}
				if (unavailable || this.isEffectBlocked()) break;
				if ((operation.retry_at ?? 0) > this.options.now()) continue;
				if (
					operation.state === "queued" &&
					this.hasDisabledSettingsPath(operation)
				)
					continue;
				const index = operations.findIndex((item) => item.key === key);
				if (
					operations
						.slice(0, index)
						.some((previous) => operationsOverlap(previous, operation))
				)
					continue;
				this.assertOpen();
				if (operation.state === "queued" && operation.op === "put") {
					const admission = await this.refreshQueuedPut(operation);
					this.assertOpen();
					if (admission === "skip") continue;
					if (admission === "block") break;
				}
				if (
					operation.state === "queued" &&
					operation.op === "delete" &&
					!operation.depends_on &&
					!this.hasLiveBase(operation.path)
				) {
					this.assertOpen();
					await this.journal.recordQueuedRejected(
						operation,
						"Delete has no confirmed live source revision",
					);
					break;
				}
				if (this.isEffectBlocked() || !(await this.send(operation))) break;
			}
		});
	}

	/** Holds an unsent settings mutation until its category is enabled again. */
	private hasDisabledSettingsPath(operation: PendingOperation): boolean {
		const policy = this.options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY;
		return [
			operation.path,
			...(operation.op === "rename" ? [operation.to] : []),
		].some(
			(path) =>
				path.startsWith(".obsidian/") &&
				classifyEnrollmentPath(path, 0, policy) === "excluded",
		);
	}

	/** Stops new event work and blocks later effects after awaits. It cannot cancel an effect already started. */
	close(): void {
		this.closed = true;
	}

	/** Applies current rename source state before settlement. Only receipt-produced state can authorize queued successors. */
	private async send(operation: PendingOperation): Promise<boolean> {
		if (this.isEffectBlocked()) return false;
		if (operation.op === "delete")
			this.options.onDeleteResponseDiagnostic?.(null);
		const saved = await this.journal.prepareSend(
			operation.key,
			operation.precondition,
		);
		this.assertOpen();
		const payload = saved.bytes;
		try {
			if (this.isEffectBlocked()) return false;
			const epoch = this.journal.snapshot().epoch;
			if (!epoch) throw new Error("Publication needs a confirmed vault epoch");
			const receipt = await this.dispatch(saved.operation, payload, epoch);
			this.assertOpen();
			const identity = parseETag(receipt.etag);
			if (
				(receipt.status !== 200 && receipt.status !== 201) ||
				receipt.path !==
					(saved.operation.op === "rename"
						? saved.operation.to
						: saved.operation.path) ||
				identity.epoch !== this.journal.snapshot().epoch ||
				!Number.isSafeInteger(receipt.size) ||
				receipt.size < 0 ||
				!Number.isSafeInteger(receipt.seq) ||
				receipt.seq <= 0 ||
				(saved.operation.op === "delete"
					? !receipt.deleted || receipt.hash !== "" || receipt.size !== 0
					: receipt.deleted || !/^[0-9a-f]{64}$/.test(receipt.hash)) ||
				(saved.operation.op === "put" &&
					(receipt.hash !== saved.operation.payload_hash ||
						receipt.size !== payload.byteLength))
			)
				throw new Error("Mutation receipt identity is invalid");
			if (saved.operation.op === "rename") {
				if (this.isEffectBlocked()) return false;
				this.assertOpen();
				const source = await this.remote.readCurrentAuthority(
					saved.operation.path,
				);
				this.assertOpen();
				if (source.epoch !== identity.epoch)
					throw new Error("Rename source belongs to a different vault epoch");
				await this.options.applyEngine.applyCurrent(
					saved.operation.path,
					source,
				);
				this.assertOpen();
			}
			const receiptBase: DeviceBaseEntry = receipt.deleted
				? { deleted: true, rev: identity.rev }
				: {
						deleted: false,
						rev: identity.rev,
						hash: DevicePayloadHashSchema.parse(receipt.hash),
					};
			await this.setBaseIfNewer(receipt.path, receiptBase);
			this.assertOpen();
			if (saved.operation.op === "rename")
				await this.reconcileRenameDestination(saved.operation, receipt.hash);
			this.assertOpen();
			await this.journal.resolve(
				saved.operation.key,
				{ kind: "receipt" },
				receiptBase,
			);
			return true;
		} catch (error) {
			this.assertOpen();
			if (error instanceof CoexistenceEffectBlockedError) return false;
			return this.handleFailure(saved.operation, error);
		}
	}

	/** Resolves each operation through its corresponding authenticated mutation. */
	private async dispatch(
		operation: PendingOperation,
		bytes: Uint8Array,
		epoch: string,
	): Promise<PublicationReceipt> {
		if (operation.op === "put") {
			const policy =
				this.options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY;
			const currentAdmission = classifyEnrollmentPath(
				operation.path,
				bytes.byteLength,
				policy,
			);
			const sentSettingsAdmission =
				operation.state === "sent"
					? classifyEnrollmentPath(operation.path, bytes.byteLength, {
							enabled: true,
							appearance: true,
							core: true,
							communityPlugins: true,
						})
					: "excluded";
			if (currentAdmission === "blob" || sentSettingsAdmission === "blob") {
				if (!this.remote.putBlob)
					throw new Error(
						"Blob publication is not supported by this transport",
					);
				return this.remote.putBlob(
					operation.path,
					bytes,
					operation.payload_hash,
					operation.precondition,
					operation.key,
					epoch,
				);
			}
			const text = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: true,
			}).decode(bytes);
			return this.remote.put(
				operation.path,
				text,
				operation.precondition,
				operation.key,
				epoch,
			);
		}
		if (operation.op === "delete")
			return this.remote.delete(
				operation.path,
				operation.precondition,
				operation.key,
			);
		return this.remote.rename(
			operation.path,
			operation.to,
			operation.precondition,
			operation.key,
		);
	}

	/** Classifies conflicts, terminal rejection, and retry without changing sent identity. */
	private async handleFailure(
		operation: PendingOperation,
		error: unknown,
	): Promise<boolean> {
		if (!(error instanceof SyncTransportError)) {
			await this.scheduleRetry(operation.key, 0);
			return true;
		}
		if (error.status === 412) {
			await this.options.recoverPrecondition(operation);
			this.assertOpen();
			if (operation.op === "rename") {
				try {
					if (!(await this.recoverStaleRename(operation))) return false;
				} catch (recoveryError) {
					if (recoveryError instanceof CoexistenceEffectBlockedError)
						return false;
					throw recoveryError;
				}
			}
			const reason =
				operation.op === "delete"
					? "Offline delete was cancelled by a newer remote change"
					: operation.op === "rename"
						? "Offline rename was resolved against newer remote state"
						: "Local text met newer remote content";
			this.assertOpen();
			await this.journal.recordRejected(operation, reason);
			return true;
		}
		if (error.status === 401 && error.code === "revoked") {
			await this.journal.recordAttention(
				operation.path,
				"Device authorization was revoked",
			);
			return false;
		}
		if (
			error.code === "path_collision" ||
			error.code === "text_too_large" ||
			error.code === "blob_too_large" ||
			error.code === "operation_expired" ||
			error.code === "idempotency_mismatch" ||
			error.status === 401 ||
			error.status === 403 ||
			error.status === 413
		) {
			await this.journal.recordRejected(
				operation,
				error.code ?? `HTTP ${error.status}`,
				error.existingPath ?? operation.path,
			);
			return true;
		}
		await this.scheduleRetry(
			operation.key,
			error.retryAfter ? Number(error.retryAfter) : 0,
		);
		return true;
	}

	/** Checks queued bytes against current local bytes and base before first send; sent retries remain untouched. */
	private async refreshQueuedPut(
		operation: Extract<PendingOperation, { op: "put" }>,
	): Promise<"ready" | "skip" | "block"> {
		const saved = await this.journal.readPayload(
			operation.payload_ref,
			operation.payload_hash,
		);
		this.assertOpen();
		const currentSize = await this.vault.size(operation.path);
		this.assertOpen();
		const admission =
			currentSize === null
				? "text"
				: classifyEnrollmentPath(
						operation.path,
						currentSize,
						this.options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY,
					);
		if (admission === "unsupported") {
			await this.journal.recordAttention(
				operation.path,
				"File exceeds the 25 MB sync limit",
			);
			return "block";
		}
		const isBlob = admission === "blob";
		let localBytes: Uint8Array | null = null;
		if (currentSize !== null) {
			const readBinary = this.vault.readBinary;
			if (!readBinary) {
				await this.journal.recordQueuedRejected(
					operation,
					"Exact local bytes are unavailable for queued publication",
				);
				return "block";
			}
			localBytes = await readBinary.call(this.vault, operation.path);
			this.assertOpen();
		}
		if (
			localBytes &&
			currentSize !== null &&
			localBytes.byteLength !== currentSize
		) {
			await this.journal.recordQueuedRejected(
				operation,
				"Local file changed while publication was queued",
			);
			return "block";
		}
		if (localBytes && !isBlob) {
			try {
				new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
					localBytes,
				);
			} catch {
				await this.journal.recordQueuedRejected(
					operation,
					"Current inline file is not valid UTF-8",
				);
				return "block";
			}
		}
		if (localBytes === null || localBytes === undefined) {
			// Discard this queued PUT only after a confirmed tombstone and visible bytes make it redundant.
			const state = this.journal.snapshot();
			const base = state.base[operation.path];
			if (
				!isBlob &&
				state.epoch !== undefined &&
				base?.deleted === true &&
				!state.stale_base_paths.includes(operation.path)
			) {
				const visible = await this.hasVisiblePayload(operation.path, saved);
				this.assertOpen();
				if (
					visible &&
					this.journal.matchesBase(operation.path, base, state.epoch)
				) {
					await this.journal.discardQueued(operation.key);
					return "skip";
				}
			}
			await this.journal.recordQueuedRejected(
				operation,
				"Queued file is absent from the local vault",
			);
			return "block";
		}
		const localHash = await digest(localBytes);
		const base = this.journal.snapshot().base[operation.path];
		if (base?.deleted === false && base.hash === localHash) {
			if (operation.payload_hash !== localHash) {
				const visible = await this.hasVisiblePayload(operation.path, saved);
				this.assertOpen();
				if (!visible) {
					this.assertOpen();
					await this.journal.recordQueuedRejected(
						operation,
						"Queued bytes need a visible recovery copy",
					);
					return "block";
				}
			}
			this.assertOpen();
			await this.journal.discardQueued(operation.key);
			return "skip";
		}
		if (operation.payload_hash === localHash) return "ready";
		this.assertOpen();
		await this.journal.recordQueuedRejected(
			operation,
			"Local file changed after publication was queued",
		);
		this.assertOpen();
		const state = this.journal.snapshot();
		const currentBase = state.base[operation.path];
		if (currentBase && !state.epoch) {
			await this.journal.recordAttention(
				operation.path,
				"Confirmed base has no vault epoch",
			);
			return "block";
		}
		await this.journal.enqueue(
			{
				op: "put",
				path: operation.path,
				precondition:
					currentBase && state.epoch
						? { kind: "match", epoch: state.epoch, rev: currentBase.rev }
						: { kind: "absent" },
			},
			localBytes,
		);
		return "block";
	}

	/** Reads exact in-scope text bytes or null for an absent path. */
	private async readTextBytes(path: string): Promise<Uint8Array | null> {
		const text = await this.vault.read(path);
		return text === null ? null : new TextEncoder().encode(text);
	}

	/** Confirms one stale payload remains visible before the journal releases its reference. */
	private async hasVisiblePayload(
		sourcePath: string,
		bytes: Uint8Array,
	): Promise<boolean> {
		const expectedHash = await digest(bytes);
		this.assertOpen();
		const paths = await this.vault.list();
		this.assertOpen();
		for (const path of paths) {
			if (path === sourcePath) continue;
			this.assertOpen();
			const text = await this.vault.read(path);
			this.assertOpen();
			if (
				text !== null &&
				(await digest(new TextEncoder().encode(text))) === expectedHash
			)
				return true;
		}
		return false;
	}

	/** Checks whether one path has a confirmed live revision for a conditional mutation. */
	private hasLiveBase(path: string): boolean {
		return this.journal.snapshot().base[path]?.deleted === false;
	}

	/** Restores the remote source and checks admission before stale-destination trash. */
	private async recoverStaleRename(
		operation: Extract<PendingOperation, { op: "rename" }>,
	): Promise<boolean> {
		if (!operation.source_hash || operation.precondition.kind !== "match")
			return true;
		const source = this.journal.snapshot().base[operation.path];
		if (!source || source.deleted || source.rev <= operation.precondition.rev)
			return true;
		this.assertOpen();
		const destinationBytes = await this.vault.readBinary?.(operation.to);
		this.assertOpen();
		if (destinationBytes) {
			const observedHash = await digest(destinationBytes);
			this.assertOpen();
			if (observedHash === operation.source_hash) {
				const current = await this.vault.readBinary?.(operation.to);
				this.assertOpen();
				if (!current) return true;
				const currentHash = await digest(current);
				this.assertOpen();
				if (currentHash === operation.source_hash) {
					const trashBinary = this.vault.trashBinary;
					if (trashBinary) {
						if (!(await this.admitLocalEffect(operation.to))) return false;
						await trashBinary.call(this.vault, operation.to, current);
						this.assertOpen();
						const remaining = await this.vault.readBinary?.(operation.to);
						this.assertOpen();
						if (!remaining) return true;
					}
				}
			}
			const remaining = await this.vault.readBinary?.(operation.to);
			this.assertOpen();
			if (remaining) await this.enqueueBinaryPut(operation.to, remaining);
			return true;
		}
		const destination = await this.vault.read(operation.to);
		this.assertOpen();
		if (destination === null) return true;
		if (
			(await digest(new TextEncoder().encode(destination))) ===
			operation.source_hash
		) {
			if (!(await this.admitLocalEffect(operation.to))) return false;
			await this.vault.trash(operation.to, destination);
			this.assertOpen();
			const remaining = await this.vault.read(operation.to);
			this.assertOpen();
			if (remaining === null) return true;
			if (
				(await digest(new TextEncoder().encode(remaining))) ===
				operation.source_hash
			)
				throw new Error("Clean stale rename destination remains in the vault");
		}
		this.assertOpen();
		const latest = await this.vault.read(operation.to);
		this.assertOpen();
		if (latest !== null) {
			this.assertOpen();
			await this.enqueuePut(operation.to, latest);
		}
		return true;
	}

	/** Restores missing text at its pinned revision after final fence and path checks. */
	private async restoreMissing(path: string, rev: number): Promise<void> {
		this.assertOpen();
		const state = this.journal.snapshot();
		const base = state.base[path];
		if (!base || base.deleted || !state.epoch || base.rev !== rev) return;
		if ((await this.vault.size(path)) !== null) return;
		this.assertOpen();
		let remote: PublicationRead;
		try {
			remote = await this.remote.readAuthority(path, state.epoch, rev);
		} catch (error) {
			if (!(error instanceof UnsupportedRemoteTextError)) throw error;
			await this.restoreMissingBlob(path, state.epoch, base);
			return;
		}
		this.assertOpen();
		if (remote.deleted || remote.rev !== rev || remote.epoch !== state.epoch)
			throw new Error("Startup restore revision is not authoritative");
		if (!this.journal.matchesBase(path, base, state.epoch)) return;
		this.assertOpen();
		if ((await this.vault.size(path)) !== null) return;
		this.assertOpen();
		await this.journal.setExpectedWrite(path, remote.hash);
		if (this.closed) {
			await this.journal.clearExpectedWrite(path);
			this.assertOpen();
		}
		if (!(await this.admitLocalEffect(path, { path, hash: remote.hash })))
			return;
		const created = await this.vault.create(path, remote.text);
		if (this.closed) {
			await this.journal.clearExpectedWrite(path);
			this.assertOpen();
		}
		if (!created) {
			await this.journal.clearExpectedWrite(path);
			return;
		}
		this.assertOpen();
		const written = await this.vault.read(path);
		if (this.closed) {
			await this.journal.clearExpectedWrite(path);
			this.assertOpen();
		}
		if (written !== remote.text) {
			await this.journal.clearExpectedWrite(path);
			throw new Error("Startup restore bytes were not confirmed");
		}
		await this.journal.clearExpectedWrite(path);
	}

	/** Restores missing content from validated pinned or current authority. */
	private async restoreMissingBlob(
		path: string,
		epoch: string,
		base: Extract<DeviceBaseEntry, { deleted: false }>,
	): Promise<void> {
		if (this.isEffectBlocked()) return;
		if (!this.remote.readBlobAuthority) return;
		const current = await this.remote.readBlobAuthority(
			path,
			epoch,
			base.rev,
			base.hash,
		);
		this.assertOpen();
		if (current.epoch !== epoch || current.rev < base.rev)
			throw new Error("Binary startup restore authority is stale");
		if (current.kind === "deleted") return;
		const expectedHash = current.hash;
		if (
			current.kind === "blob" &&
			(await digest(current.bytes)) !== expectedHash
		)
			throw new Error("Binary startup restore bytes do not match their hash");
		if (
			current.kind === "text" &&
			(await digest(new TextEncoder().encode(current.text))) !== expectedHash
		)
			throw new Error("Text startup restore bytes do not match their hash");
		if (!this.journal.matchesBase(path, base, epoch)) return;
		if ((await this.vault.size(path)) !== null) return;
		this.assertOpen();
		if (this.isEffectBlocked()) return;
		await this.journal.setExpectedWrite(path, expectedHash);
		if (this.closed) {
			await this.journal.clearExpectedWrite(path);
			this.assertOpen();
		}
		this.assertOpen();
		if (!(await this.admitLocalEffect(path, { path, hash: expectedHash })))
			return;
		let created = false;
		if (current.kind === "blob") {
			const createBinary = this.vault.createBinary;
			if (!createBinary) {
				await this.journal.clearExpectedWrite(path);
				return;
			}
			created = await createBinary.call(this.vault, path, current.bytes);
		} else {
			created = await this.vault.create(path, current.text);
		}
		if (this.closed) {
			await this.journal.clearExpectedWrite(path);
			this.assertOpen();
		}
		if (!created) {
			await this.journal.clearExpectedWrite(path);
			return;
		}
		this.assertOpen();
		const written =
			current.kind === "blob"
				? await this.vault.readBinary?.(path)
				: await this.vault.read(path);
		if (this.closed) {
			await this.journal.clearExpectedWrite(path);
			this.assertOpen();
		}
		this.assertOpen();
		const actualHash =
			written instanceof Uint8Array
				? await digest(written)
				: written === null
					? ""
					: await digest(new TextEncoder().encode(written));
		if (actualHash !== expectedHash) {
			await this.journal.clearExpectedWrite(path);
			throw new Error("Startup restore bytes were not confirmed");
		}
		if (current.rev > base.rev) {
			await this.journal.setBase(path, {
				deleted: false,
				rev: current.rev,
				hash: current.hash,
			});
			this.assertOpen();
		}
		await this.journal.clearExpectedWrite(path);
	}

	/** Queues exact moved binary bytes under the latest confirmed destination base. */
	private async enqueueBinaryPut(
		path: string,
		bytes: Uint8Array,
	): Promise<void> {
		this.assertOpen();
		const admission = classifyEnrollmentPath(
			path,
			bytes.byteLength,
			this.options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY,
		);
		if (admission === "unsupported") {
			await this.journal.recordAttention(
				path,
				"File exceeds the 25 MB sync limit",
			);
			return;
		}
		const hash = await digest(bytes);
		this.assertOpen();
		const state = this.journal.snapshot();
		const base = state.base[path];
		if (base?.deleted === false && base.hash === hash) return;
		if (base && !state.epoch) {
			await this.journal.recordAttention(
				path,
				"Confirmed base has no vault epoch",
			);
			return;
		}
		if (await this.hasPendingPut(path, hash)) return;
		this.assertOpen();
		if (this.isEffectBlocked()) return;
		await this.journal.enqueue(
			{
				op: "put",
				path,
				precondition:
					base && state.epoch
						? { kind: "match", epoch: state.epoch, rev: base.rev }
						: { kind: "absent" },
			},
			bytes,
		);
	}

	/** Replaces only unsent work with the newest current local bytes and exact base. */
	private async enqueuePut(path: string, text: string): Promise<void> {
		const bytes = new TextEncoder().encode(text);
		if (bytes.byteLength > 1_000_000) {
			this.assertOpen();
			await this.journal.recordAttention(
				path,
				"Inline text exceeds the publication size limit",
			);
			return;
		}
		const state = this.journal.snapshot();
		const base = state.base[path];
		const hash = await digest(bytes);
		this.assertOpen();
		if (this.isEffectBlocked()) return;
		if (base?.deleted === false && base.hash === hash) return;
		if (base && !state.epoch) {
			await this.journal.recordAttention(
				path,
				"Confirmed base has no vault epoch",
			);
			return;
		}
		await this.journal.enqueue(
			{
				op: "put",
				path,
				precondition:
					base && state.epoch
						? { kind: "match", epoch: state.epoch, rev: base.rev }
						: { kind: "absent" },
			},
			bytes,
		);
	}

	/** Selects the reader from current destination admission, never from saved payload size or receipt kind. */
	private async readRenameDestination(
		path: string,
	): Promise<Uint8Array | null> {
		const size = await this.vault.size(path);
		this.assertOpen();
		if (size === null) return null;
		const admission = classifyEnrollmentPath(
			path,
			size,
			this.options.settingsPolicy ?? DEFAULT_SETTINGS_SYNC_POLICY,
		);
		if (admission === "excluded") return null;
		if (admission === "unsupported") {
			await this.journal.recordAttention(
				path,
				"File exceeds the 25 MB sync limit",
			);
			return null;
		}
		const bytes =
			admission === "blob"
				? await this.vault.readBinary?.(path)
				: await this.readTextBytes(path);
		this.assertOpen();
		return bytes ?? null;
	}

	/** Queues exact current bytes after a successful rename and drops a redundant exact put. */
	private async reconcileRenameDestination(
		operation: Extract<PendingOperation, { op: "rename" }>,
		remoteHash: string,
	): Promise<void> {
		this.assertOpen();
		const local = await this.readRenameDestination(operation.to);
		if (local === null) return;
		const localHash = await digest(local);
		this.assertOpen();
		const queuedPuts = this.journal
			.snapshot()
			.pending_ops.filter(
				(item) =>
					item.op === "put" &&
					item.path === operation.to &&
					item.state === "queued",
			);
		if (localHash === remoteHash) {
			for (const queued of queuedPuts) {
				this.assertOpen();
				await this.journal.discardQueued(queued.key);
			}
			return;
		}
		this.assertOpen();
		if (!(await this.hasPendingPut(operation.to, localHash))) {
			this.assertOpen();
			await this.enqueueBinaryPut(operation.to, local);
		}
	}

	/** Keeps a newer feed base when a delayed receipt confirms an older sent revision. */
	private async setBaseIfNewer(
		path: string,
		base:
			| { deleted: true; rev: number }
			| { deleted: false; rev: number; hash: string },
	): Promise<void> {
		const current = this.journal.snapshot().base[path];
		if (current && current.rev > base.rev) return;
		if (
			current &&
			current.rev === base.rev &&
			JSON.stringify(current) !== JSON.stringify(base)
		)
			throw new Error("Receipt conflicts with the confirmed base identity");
		await this.journal.setBase(path, base);
	}

	/** Persists bounded exponential retry and honors Retry-After up to five minutes. */
	private async scheduleRetry(
		key: string,
		retryAfterSeconds: number,
	): Promise<void> {
		const operation = this.journal
			.snapshot()
			.pending_ops.find((item) => item.key === key);
		const attempts = operation?.attempts ?? 0;
		const delay = Math.min(
			300_000,
			Math.max(2_000 * 2 ** attempts, retryAfterSeconds * 1_000),
		);
		await this.journal.defer(key, this.options.now() + delay);
	}

	/** Avoids duplicate admission when a queued or sent put already owns these exact bytes. */
	private async hasPendingPut(path: string, hash: string): Promise<boolean> {
		for (const operation of this.journal.snapshot().pending_ops) {
			if (operation.op !== "put" || operation.path !== path) continue;
			this.assertOpen();
			const saved = await this.journal.readPayload(
				operation.payload_ref,
				operation.payload_hash,
			);
			this.assertOpen();
			if ((await digest(saved)) === hash) return true;
		}
		return false;
	}

	/** Serializes controller effects and leaves later calls usable after rejection. */
	private async serialize<T>(action: () => Promise<T>): Promise<T> {
		const result = this.tail.then(action);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Reads coexistence authority before admitting another effect. */
	private isEffectBlocked(): boolean {
		return this.options.isEffectBlocked?.() ?? false;
	}

	/** Checks the shared fence and exact path before one local mutation. */
	private async admitLocalEffect(
		path: string,
		expectedWrite?: { path: string; hash: string },
	): Promise<boolean> {
		this.assertOpen();
		/** Clears the pending echo when admission does not start the expected write. */
		const clearExpectedWrite = async (): Promise<void> => {
			if (
				expectedWrite &&
				this.journal.snapshot().expected_writes[expectedWrite.path] ===
					expectedWrite.hash
			)
				await this.journal.clearExpectedWrite(expectedWrite.path);
		};
		if (this.isEffectBlocked()) {
			await clearExpectedWrite();
			return false;
		}
		if (await this.vault.isUnavailable?.(path)) {
			await this.journal.markUnavailable(path);
			await clearExpectedWrite();
			return false;
		}
		this.assertOpen();
		if (this.isEffectBlocked()) {
			await clearExpectedWrite();
			return false;
		}
		return true;
	}

	/** Rejects work after close, including late asynchronous continuations. */
	private assertOpen(): void {
		if (this.closed) throw new Error("Publication controller is closed");
	}
}

/** Checks overlap across path identity for ordered put, delete, and rename operations. */
function operationsOverlap(
	left: PendingOperation,
	right: PendingOperation,
): boolean {
	const leftPaths = left.op === "rename" ? [left.path, left.to] : [left.path];
	const rightPaths =
		right.op === "rename" ? [right.path, right.to] : [right.path];
	const rightKeys = rightPaths.map(pathKey);
	return leftPaths.some((path) => rightKeys.includes(pathKey(path)));
}

/** Validates and canonicalizes one application event before queue admission. */
function validateEvent(event: PublicationEvent): PublicationEvent {
	const path = PathSchema.parse(event.path);
	if (event.type === "rename") {
		const to = PathSchema.parse(event.to);
		if (path === to) throw new Error("Rename paths must differ");
		return { type: "rename", path, to };
	}
	return { type: event.type, path };
}

/** Returns the exact payload digest used by journal and server mutation contracts. */
async function digest(bytes: Uint8Array): Promise<string> {
	const result = await crypto.subtle.digest(
		"SHA-256",
		bytes.slice().buffer as ArrayBuffer,
	);
	return [...new Uint8Array(result)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
