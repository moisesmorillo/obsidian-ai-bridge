import type {
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
import type { TextVault } from "@plugin/sync/text-apply";

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

/** Deterministic time and bounded backoff policy for one controller lifetime. */
export interface PublicationOptions {
	/** Returns current Unix milliseconds for retry and UUID creation decisions. */
	now(): number;
	/** Replays remote changes through the shared text apply engine after a 412. */
	recoverPrecondition(): Promise<void>;
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
				if (size === null) continue;
				const admission = classifyEnrollmentPath(path, size);
				if (admission === "excluded") continue;
				if (admission === "blob") {
					await this.journal.recordAttention(
						path,
						"Blob synchronization is not available yet",
					);
					continue;
				}
				const text = await this.vault.read(path);
				if (text === null) continue;
				const bytes = new TextEncoder().encode(text);
				if (bytes.byteLength > 1_000_000) {
					await this.journal.recordAttention(
						path,
						"Inline text exceeds the publication size limit",
					);
					continue;
				}
				const hash = await digest(bytes);
				const base = state.base[path];
				if (base?.deleted === false && base.hash === hash) continue;
				if (base && !state.epoch) {
					await this.journal.recordAttention(
						path,
						"Confirmed base has no vault epoch",
					);
					continue;
				}
				if (await this.hasPendingPut(path, hash)) continue;
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
				if (current.some((item) => pathKey(item) === pathKey(path))) continue;
				await this.restoreMissing(path, base.rev);
			}
		});
	}

	/** Admits only explicit in-scope live create, modify, delete, and rename events. */
	observe(event: PublicationEvent): Promise<void> {
		const parsed = validateEvent(event);
		return this.serialize(async () => {
			this.assertOpen();
			if (classifyEnrollmentPath(parsed.path, 0) === "excluded") return;
			if (parsed.type === "create" || parsed.type === "modify") {
				const size = await this.vault.size(parsed.path);
				if (size === null) return;
				const admission = classifyEnrollmentPath(parsed.path, size);
				if (admission === "excluded") return;
				if (admission === "blob") {
					await this.journal.recordAttention(
						parsed.path,
						"Blob synchronization is not available yet",
					);
					return;
				}
				const expected = this.journal.snapshot().expected_writes[parsed.path];
				const text = await this.vault.read(parsed.path);
				if (text === null) return;
				const hash = await digest(new TextEncoder().encode(text));
				if (expected === hash) {
					await this.journal.consumeExpectedWrite(parsed.path, hash);
					return;
				}
				await this.enqueuePut(parsed.path, text);
				return;
			}
			if (parsed.type === "rename") {
				const size = await this.vault.size(parsed.to);
				const admission = classifyEnrollmentPath(parsed.to, size ?? 0);
				if (admission === "excluded") return;
				if (admission === "blob") {
					await this.journal.recordAttention(
						parsed.to,
						"Blob synchronization is not available yet",
					);
					return;
				}
			}
			const state = this.journal.snapshot();
			const base = state.base[parsed.path];
			if (!base || base.deleted || !state.epoch) return;
			const precondition = {
				kind: "match" as const,
				epoch: state.epoch,
				rev: base.rev,
			};
			if (parsed.type === "delete") {
				await this.journal.enqueue(
					{ op: "delete", path: parsed.path, precondition },
					new Uint8Array(),
				);
				return;
			}
			if (parsed.type === "rename") {
				await this.journal.enqueue(
					{ op: "rename", path: parsed.path, to: parsed.to, precondition },
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
				if (!(await this.send(operation))) break;
			}
		});
	}

	/** Fences event admission and prevents late responses from changing durable state. */
	close(): void {
		this.closed = true;
	}

	/** Sends immutable bytes once and commits only the authoritative receipt metadata. */
	private async send(operation: PendingOperation): Promise<boolean> {
		const precondition =
			operation.state === "sent"
				? operation.precondition
				: this.currentPrecondition(operation);
		const saved = await this.journal.prepareSend(operation.key, precondition);
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
				const source = await this.remote.readCurrentAuthority(
					saved.operation.path,
				);
				this.assertOpen();
				if (!source.deleted || source.epoch !== identity.epoch)
					throw new Error("Rename source tombstone is not authoritative");
				await this.setBaseIfNewer(saved.operation.path, {
					deleted: true,
					rev: source.rev,
				});
			}
			if (saved.operation.op !== "delete") {
				const hash = DevicePayloadHashSchema.parse(receipt.hash);
				await this.setBaseIfNewer(receipt.path, {
					deleted: false,
					rev: identity.rev,
					hash,
				});
			} else {
				await this.setBaseIfNewer(saved.operation.path, {
					deleted: true,
					rev: identity.rev,
				});
			}
			if (saved.operation.op === "rename")
				await this.reconcileRenameDestination(saved.operation, receipt.hash);
			this.assertOpen();
			await this.journal.resolve(saved.operation.key, { kind: "receipt" });
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
			await this.options.recoverPrecondition();
			this.assertOpen();
			const reason =
				operation.op === "delete"
					? "Offline delete was cancelled by a newer remote change"
					: operation.op === "rename"
						? "Offline rename was resolved against newer remote state"
						: "Local text met newer remote content";
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

	/** Restores missing text at its pinned revision without advancing revision authority. */
	private async restoreMissing(path: string, rev: number): Promise<void> {
		const state = this.journal.snapshot();
		const base = state.base[path];
		if (!base || base.deleted || !state.epoch || base.rev !== rev) return;
		if ((await this.vault.read(path)) !== null) return;
		const remote = await this.remote.readAuthority(path, state.epoch, rev);
		this.assertOpen();
		if (remote.deleted || remote.rev !== rev || remote.epoch !== state.epoch)
			throw new Error("Startup restore revision is not authoritative");
		await this.journal.setExpectedWrite(path, remote.hash);
		if (!(await this.vault.create(path, remote.text))) {
			await this.journal.clearExpectedWrite(path);
			return;
		}
		if ((await this.vault.read(path)) !== remote.text) {
			await this.journal.clearExpectedWrite(path);
			throw new Error("Startup restore bytes were not confirmed");
		}
	}

	/** Replaces only unsent work with the newest current local bytes and exact base. */
	private async enqueuePut(path: string, text: string): Promise<void> {
		const bytes = new TextEncoder().encode(text);
		if (bytes.byteLength > 1_000_000) {
			await this.journal.recordAttention(
				path,
				"Inline text exceeds the publication size limit",
			);
			return;
		}
		const state = this.journal.snapshot();
		const base = state.base[path];
		if (base?.deleted === false && base.hash === (await digest(bytes))) return;
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
		const local = await this.vault.read(operation.to);
		if (local === null) return;
		const localHash = await digest(new TextEncoder().encode(local));
		const queuedPuts = this.journal
			.snapshot()
			.pending_ops.filter(
				(item) =>
					item.op === "put" &&
					item.path === operation.to &&
					item.state === "queued",
			);
		if (localHash === remoteHash) {
			for (const queued of queuedPuts)
				await this.journal.discardQueued(queued.key);
			return;
		}
		if (!(await this.hasPendingPut(operation.to, localHash)))
			await this.enqueuePut(operation.to, local);
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

	/** Chooses exact original operation evidence for sent work or current base for queued work. */
	private currentPrecondition(operation: PendingOperation): DevicePrecondition {
		const state = this.journal.snapshot();
		if (operation.state === "sent") return operation.precondition;
		const base = state.base[operation.path];
		if (!base || !state.epoch) return { kind: "absent" };
		return { kind: "match", epoch: state.epoch, rev: base.rev };
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
			const saved = await this.journal.readPayload(
				operation.payload_ref,
				operation.payload_hash,
			);
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
