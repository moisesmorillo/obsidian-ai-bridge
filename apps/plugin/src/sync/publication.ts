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
import type { DeviceJournal } from "@plugin/sync/device-journal";
import { classifyEnrollmentPath } from "@plugin/sync/enrollment-scope";
import { SyncTransportError } from "@plugin/sync/remote-text";
import type { TextApplyEngine, TextVault } from "@plugin/sync/text-apply";

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
	/** Sends one immutable text put under its exact create or revision precondition. */
	put(
		path: string,
		text: string,
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
	/** Replays 412 evidence and applies current rename source authority without changing feed cursor identity. */
	recoverPrecondition(operation: PendingOperation): Promise<void>;
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
				if (pendingRenameTargets.has(pathKey(path))) continue;
				const size = await this.vault.size(path);
				this.assertOpen();
				if (size === null) continue;
				const admission = classifyEnrollmentPath(path, size);
				if (admission === "excluded") continue;
				if (admission === "blob") {
					this.assertOpen();
					await this.journal.recordAttention(
						path,
						"Blob synchronization is not available yet",
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
			if (classifyEnrollmentPath(parsed.path, 0) === "excluded") return;
			if (parsed.type === "create" || parsed.type === "modify") {
				const size = await this.vault.size(parsed.path);
				this.assertOpen();
				if (size === null) return;
				const admission = classifyEnrollmentPath(parsed.path, size);
				if (admission === "excluded") return;
				if (admission === "blob") {
					this.assertOpen();
					await this.journal.recordAttention(
						parsed.path,
						"Blob synchronization is not available yet",
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
				const admission = classifyEnrollmentPath(parsed.to, size ?? 0);
				if (admission === "excluded") return;
				if (admission === "blob") {
					this.assertOpen();
					await this.journal.recordAttention(
						parsed.to,
						"Blob synchronization is not available yet",
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
					const destination = await this.vault.read(parsed.to);
					this.assertOpen();
					if (destination !== null) {
						this.assertOpen();
						await this.enqueuePut(parsed.to, destination);
					}
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
				await this.journal.enqueue(
					{ op: "delete", path: parsed.path, precondition },
					new Uint8Array(),
				);
				return;
			}
			if (parsed.type === "rename") {
				this.assertOpen();
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

	/** Sends currently eligible operations in order without waiting through retry delays. */
	flush(): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			const keys = this.journal.snapshot().pending_ops.map((item) => item.key);
			for (const key of keys) {
				const operations = this.journal.snapshot().pending_ops;
				const operation = operations.find((item) => item.key === key);
				if (!operation || operation.state === "resolved") continue;
				if ((operation.retry_at ?? 0) > this.options.now()) continue;
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
				if (!(await this.send(operation))) break;
			}
		});
	}

	/** Stops new event work and blocks later effects after awaits. It cannot cancel an effect already started. */
	close(): void {
		this.closed = true;
	}

	/** Applies current rename source state before settlement. Only receipt-produced state can authorize queued successors. */
	private async send(operation: PendingOperation): Promise<boolean> {
		const saved = await this.journal.prepareSend(
			operation.key,
			operation.precondition,
		);
		this.assertOpen();
		const payload = saved.bytes;
		try {
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
			if (operation.op === "rename") await this.recoverStaleRename(operation);
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
		if (error.status === 401) {
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

	/** Checks queued bytes against current local text and base before first send; sent retries remain untouched. */
	private async refreshQueuedPut(
		operation: Extract<PendingOperation, { op: "put" }>,
	): Promise<"ready" | "skip" | "block"> {
		const saved = await this.journal.readPayload(
			operation.payload_ref,
			operation.payload_hash,
		);
		this.assertOpen();
		const local = await this.vault.read(operation.path);
		this.assertOpen();
		if (local === null) {
			await this.journal.recordQueuedRejected(
				operation,
				"Queued text is absent from the local vault",
			);
			return "block";
		}
		const localBytes = new TextEncoder().encode(local);
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
			"Local text changed after publication was queued",
		);
		this.assertOpen();
		await this.enqueuePut(operation.path, local);
		return "block";
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

	/** Restores the remote source and safely removes or republishes the moved destination. */
	private async recoverStaleRename(
		operation: Extract<PendingOperation, { op: "rename" }>,
	): Promise<void> {
		if (!operation.source_hash || operation.precondition.kind !== "match")
			return;
		const source = this.journal.snapshot().base[operation.path];
		if (!source || source.deleted || source.rev <= operation.precondition.rev)
			return;
		this.assertOpen();
		const destination = await this.vault.read(operation.to);
		this.assertOpen();
		if (destination === null) return;
		if (
			(await digest(new TextEncoder().encode(destination))) ===
			operation.source_hash
		) {
			this.assertOpen();
			await this.vault.trash(operation.to, destination);
			this.assertOpen();
			const remaining = await this.vault.read(operation.to);
			this.assertOpen();
			if (remaining === null) return;
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
	}

	/** Restores missing text at its pinned revision without advancing revision authority. */
	private async restoreMissing(path: string, rev: number): Promise<void> {
		this.assertOpen();
		const state = this.journal.snapshot();
		const base = state.base[path];
		if (!base || base.deleted || !state.epoch || base.rev !== rev) return;
		if ((await this.vault.read(path)) !== null) return;
		this.assertOpen();
		const remote = await this.remote.readAuthority(path, state.epoch, rev);
		this.assertOpen();
		if (remote.deleted || remote.rev !== rev || remote.epoch !== state.epoch)
			throw new Error("Startup restore revision is not authoritative");
		if (!this.journal.matchesBase(path, base, state.epoch)) return;
		this.assertOpen();
		if ((await this.vault.read(path)) !== null) return;
		this.assertOpen();
		await this.journal.setExpectedWrite(path, remote.hash);
		if (this.closed) {
			await this.journal.clearExpectedWrite(path);
			this.assertOpen();
		}
		this.assertOpen();
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

	/** Queues a local edit after a successful rename and drops a redundant exact put. */
	private async reconcileRenameDestination(
		operation: Extract<PendingOperation, { op: "rename" }>,
		remoteHash: string,
	): Promise<void> {
		this.assertOpen();
		const local = await this.vault.read(operation.to);
		this.assertOpen();
		if (local === null) return;
		const localHash = await digest(new TextEncoder().encode(local));
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
			await this.enqueuePut(operation.to, local);
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
