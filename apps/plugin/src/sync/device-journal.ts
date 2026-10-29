import {
	ChangeEntrySchema,
	DEVICE_PAYLOAD_DIRECTORY,
	type DeviceBaseEntry,
	DeviceBaseEntrySchema,
	type DevicePrecondition,
	type DeviceState,
	DeviceStateSchema,
	type PendingApply,
	PendingApplySchema,
	type PendingOperation,
	PendingOperationSchema,
	parseETag,
	pathKey,
} from "@obsidian-ai-bridge/protocol";

/** User-safe attention text used when local journal storage cannot be verified. */
export const DEVICE_JOURNAL_ATTENTION_REASON =
	"Device journal storage needs attention";

/** Minimal device-local persistence needed by the journal. */
export interface DeviceJournalStorage {
	/** Reads the persisted document without coercion or repair. */
	readState(): Promise<unknown>;
	/** Replaces the full persisted document; callers verify it with read-back. */
	writeState(state: DeviceState): Promise<void>;
	/** Reads raw payload bytes from the exact supplied relative reference. */
	readPayload(path: string): Promise<Uint8Array>;
	/** Writes immutable payload bytes without replacing conflicting content. */
	writePayload(path: string, bytes: Uint8Array): Promise<void>;
}

/** Input for one local mutation; generated metadata and payload authority stay journal-owned. */
export type EnqueueInput =
	| { op: "put"; path: string; precondition: DevicePrecondition }
	| { op: "delete"; path: string; precondition: DevicePrecondition }
	| {
			op: "rename";
			path: string;
			to: string;
			precondition: DevicePrecondition;
	  };

/** Caller-supplied evidence for an explicit server receipt or rejection. */
export type ResolutionOutcome = { kind: "receipt" } | { kind: "rejection" };

/** Serializes confirmed local transitions and releases only hash-verified durable bytes. */
export class DeviceJournal {
	/** Last validated state whose full document matched storage read-back. */
	private state: DeviceState;
	/** Blocks release after storage failure until a later state write verifies. */
	private attentionReasonValue: string | null = null;
	/** Fences asynchronous work from releasing after this lifecycle closes. */
	private closed = false;
	/** Serializes transitions for this journal lifetime. */
	private tail: Promise<void> = Promise.resolve();

	/** Binds one storage port to the validated in-memory authority for this lifetime. */
	private constructor(
		private readonly storage: DeviceJournalStorage,
		state: DeviceState,
	) {
		this.state = state;
	}

	/** Reports a blocking local persistence or payload-integrity failure until a verified write succeeds. */
	get attentionReason(): string | null {
		return this.attentionReasonValue;
	}

	/** Validates existing state or persists one new device identity before returning. */
	static async open(storage: DeviceJournalStorage): Promise<DeviceJournal> {
		const existing = await storage.readState();
		if (existing !== null && existing !== undefined) {
			const parsed = DeviceStateSchema.parse(existing);
			await persistVerified(storage, parsed);
			return new DeviceJournal(storage, parsed);
		}
		const state = DeviceStateSchema.parse({
			version: 1,
			device_id: createUuidV7(),
			pending_ops: [],
		});
		await persistVerified(storage, state);
		return new DeviceJournal(storage, state);
	}

	/** Persists payload bytes before enqueue and coalesces only a same-type queued operation without later dependents. */
	async enqueue(
		input: EnqueueInput,
		bytes: Uint8Array,
	): Promise<PendingOperation> {
		const capturedInput = structuredClone(input);
		const capturedBytes = bytes.slice();
		return this.serialize(async () => {
			this.assertOpen();
			const inputPathKey = pathKey(capturedInput.path);
			const key = createUuidV7();
			const payloadRef = `${DEVICE_PAYLOAD_DIRECTORY}${key}`;
			const payload = capturedBytes;
			const hash = await digest(payload);
			this.assertOpen();
			try {
				await this.storage.writePayload(payloadRef, payload);
				if ((await digest(await this.storage.readPayload(payloadRef))) !== hash)
					throw new Error("Payload verification failed");
			} catch (error) {
				this.attentionReasonValue = DEVICE_JOURNAL_ATTENTION_REASON;
				throw error;
			}
			this.assertOpen();
			const replaceIndex = this.state.pending_ops.findIndex(
				(operation, index, operations) =>
					operation.state === "queued" &&
					operation.op === capturedInput.op &&
					pathKey(operation.path) === inputPathKey &&
					!operations
						.slice(index + 1)
						.some(
							(later) =>
								later.state !== "resolved" &&
								operationsConflict(operation, later),
						),
			);
			const nextOps = this.state.pending_ops.filter(
				(_operation, index) => index !== replaceIndex,
			);
			const operation = PendingOperationSchema.parse({
				...capturedInput,
				key,
				payload_hash: hash,
				payload_ref: payloadRef,
				created_at: Date.now(),
				attempts: 0,
				state: "queued",
			});
			await this.commit({
				...this.state,
				pending_ops: [...nextOps, operation],
			});
			return cloneOperation(operation);
		});
	}

	/** Records one validated remote change before any filesystem effect can start. */
	async beginApply(change: unknown): Promise<void> {
		const parsedChange = ChangeEntrySchema.parse(change);
		return this.serialize(async () => {
			this.assertOpen();
			const current = this.state.pending_apply[0];
			if (current && current.change.seq !== parsedChange.seq)
				throw new Error("Another remote apply is pending");
			if (current) {
				if (JSON.stringify(current.change) !== JSON.stringify(parsedChange))
					throw new Error("Remote apply identity changed");
				return;
			}
			await this.commit({
				...this.state,
				pending_apply: [{ change: parsedChange, step: "prepared" }],
			});
		});
	}

	/** Replaces a pruned pinned row before effects while retaining verified local conflict identities. */
	async rebasePendingApply(
		change: DeviceState["pending_apply"][number]["change"],
	): Promise<void> {
		const parsedChange = ChangeEntrySchema.parse(change);
		return this.serialize(async () => {
			this.assertOpen();
			const current = this.state.pending_apply[0];
			if (!current || current.change.seq !== parsedChange.seq)
				throw new Error("Pinned fallback does not match the pending feed row");
			if (
				current.change.path !== parsedChange.path ||
				current.change.op !== parsedChange.op
			)
				throw new Error("Pinned fallback changed the row path or operation");
			const oldEpoch = parseETag(current.change.etag).epoch;
			const newEpoch = parseETag(parsedChange.etag).epoch;
			if (oldEpoch !== newEpoch)
				throw new Error("Pinned fallback changed the vault epoch");
			const rebased: PendingApply = { ...current, change: parsedChange };
			await this.commit({ ...this.state, pending_apply: [rebased] });
		});
	}

	/** Persists conflict identity and step before the next guarded vault effect. */
	async updateApply(pending: PendingApply): Promise<void> {
		const parsed = PendingApplySchema.parse(pending);
		return this.serialize(async () => {
			this.assertOpen();
			const current = this.state.pending_apply[0];
			if (
				!current ||
				JSON.stringify(current.change) !== JSON.stringify(parsed.change)
			)
				throw new Error("Remote apply identity changed");
			const transitionAllowed =
				(current.step === "prepared" &&
					(parsed.step === "prepared" || parsed.step === "named")) ||
				(current.step === "named" &&
					(parsed.step === "named" || parsed.step === "copied")) ||
				(current.step === "copied" && parsed.step === "copied");
			if (!transitionAllowed)
				throw new Error(
					"Remote apply step cannot move backward or skip a step",
				);
			if (
				(current.conflict_path !== undefined ||
					current.conflict_copies !== undefined) &&
				(JSON.stringify(current.conflict_path) !==
					JSON.stringify(parsed.conflict_path) ||
					JSON.stringify(current.conflict_copies) !==
						JSON.stringify(parsed.conflict_copies) ||
					JSON.stringify(current.conflict_source) !==
						JSON.stringify(parsed.conflict_source) ||
					JSON.stringify(current.conflict_mode) !==
						JSON.stringify(parsed.conflict_mode) ||
					JSON.stringify(current.conflict_device_name) !==
						JSON.stringify(parsed.conflict_device_name) ||
					JSON.stringify(current.conflict_hash) !==
						JSON.stringify(parsed.conflict_hash))
			)
				throw new Error("Conflict copy identity is immutable");
			await this.commit({ ...this.state, pending_apply: [parsed] });
		});
	}

	/** Records one confirmed base without allowing an older observed revision to replace it. */
	async setBase(path: string, base: DeviceBaseEntry): Promise<void> {
		const parsed = DeviceBaseEntrySchema.parse(base);
		return this.serialize(async () => {
			this.assertOpen();
			const previous = this.state.base[path];
			if (
				previous &&
				parsed.rev < previous.rev &&
				!this.state.stale_base_paths.includes(path)
			)
				throw new Error("Confirmed base revision cannot regress");
			await this.commit({
				...this.state,
				base: { ...this.state.base, [path]: parsed },
				stale_base_paths: this.state.stale_base_paths.filter(
					(item) => item !== path,
				),
			});
		});
	}

	/** Persists one epoch-bound feed position without allowing cursor regression. */
	async setCursor(epoch: string, cursor: number): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			if (this.state.epoch !== epoch) throw new Error("Cursor epoch is stale");
			if (this.state.cursor !== null && cursor < this.state.cursor)
				throw new Error("Feed cursor cannot regress");
			await this.commit({ ...this.state, cursor });
		});
	}

	/** Changes epoch and invalidates old conditional work while preserving hashes and payloads. */
	async resetEpoch(epoch: string): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			if (this.state.epoch === epoch) return;
			const previousEpoch = this.state.epoch;
			const hasUnboundOperations = this.state.pending_ops.length > 0;
			const operations =
				previousEpoch || hasUnboundOperations ? this.state.pending_ops : [];
			const attention = this.state.attention;
			await this.commit({
				...this.state,
				epoch,
				cursor: null,
				reconciliation: null,
				pending_apply: [],
				expected_writes: {},
				pending_ops: operations.length > 0 ? [] : this.state.pending_ops,
				stale_base_paths:
					previousEpoch || Object.keys(this.state.base).length > 0
						? [
								...new Set([
									...this.state.stale_base_paths,
									...Object.keys(this.state.base),
								]),
							]
						: this.state.stale_base_paths,
				attention: [
					...attention,
					...operations.map((operation) => ({
						path: operation.path,
						reason: "Operation belongs to an old vault epoch",
						operation,
					})),
				],
			});
		});
	}

	/** Saves one validated page boundary before a reconciliation worker advances. */
	async setReconciliationCheckpoint(
		checkpoint: DeviceState["reconciliation"],
	): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			if (checkpoint && checkpoint.epoch !== this.state.epoch)
				throw new Error("Reconciliation checkpoint epoch is stale");
			await this.commit({ ...this.state, reconciliation: checkpoint });
		});
	}

	/** Persists one expected exact content hash without advancing confirmed base. */
	async setExpectedWrite(path: string, hash: string): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			await this.commit({
				...this.state,
				expected_writes: { ...this.state.expected_writes, [path]: hash },
			});
		});
	}

	/** Removes an expected echo after its guarded vault effect refuses to write. */
	async clearExpectedWrite(path: string): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			if (this.state.expected_writes[path] === undefined) return;
			const expected_writes = { ...this.state.expected_writes };
			delete expected_writes[path];
			await this.commit({ ...this.state, expected_writes });
		});
	}

	/** Consumes only an exact expected hash and persists its removal as a separate transition. */
	async consumeExpectedWrite(path: string, hash: string): Promise<boolean> {
		return this.serialize(async () => {
			this.assertOpen();
			if (this.state.expected_writes[path] !== hash) return false;
			const expected_writes = { ...this.state.expected_writes };
			delete expected_writes[path];
			await this.commit({ ...this.state, expected_writes });
			return true;
		});
	}

	/** Commits confirmed rename sides atomically and rejects base revision repeats or regression. */
	async completeRenameApply(
		fromPath: string,
		fromBase: DeviceBaseEntry | null,
		toPath: string,
		toBase: DeviceBaseEntry | null,
	): Promise<void> {
		const source =
			fromBase === null ? null : DeviceBaseEntrySchema.parse(fromBase);
		const destination =
			toBase === null ? null : DeviceBaseEntrySchema.parse(toBase);
		return this.serialize(async () => {
			this.assertOpen();
			const pending = this.state.pending_apply[0];
			if (pending?.change.op !== "rename")
				throw new Error("No remote rename is pending");
			if (
				pending.change.from_path !== fromPath ||
				pending.change.path !== toPath
			)
				throw new Error("Remote rename identity changed");
			const expectedFromRev = parseETag(pending.change.from_etag).rev;
			const expectedToRev = parseETag(pending.change.etag).rev;
			if (
				(source !== null &&
					(!source.deleted ||
						source.rev !== expectedFromRev ||
						(source.rev <= (this.state.base[fromPath]?.rev ?? 0) &&
							!this.state.stale_base_paths.includes(fromPath)))) ||
				(destination !== null &&
					(destination.deleted ||
						destination.rev !== expectedToRev ||
						destination.hash !== pending.change.hash ||
						(destination.rev <= (this.state.base[toPath]?.rev ?? 0) &&
							!this.state.stale_base_paths.includes(toPath))))
			)
				throw new Error(
					"Confirmed rename base does not match its remote revisions",
				);
			const expected_writes = { ...this.state.expected_writes };
			delete expected_writes[fromPath];
			delete expected_writes[toPath];
			await this.commit({
				...this.state,
				base: {
					...this.state.base,
					...(source ? { [fromPath]: source } : {}),
					...(destination ? { [toPath]: destination } : {}),
				},
				stale_base_paths: this.state.stale_base_paths.filter(
					(path) => path !== fromPath && path !== toPath,
				),
				pending_apply: [],
				expected_writes,
			});
		});
	}

	/** Clears an obsolete feed entry while preserving every newer confirmed base. */
	async ignoreApply(path: string, revision: number): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			const pending = this.state.pending_apply[0];
			if (!pending || pending.change.path !== path)
				throw new Error("Remote apply identity changed");
			if ((this.state.base[path]?.rev ?? 0) < revision)
				throw new Error("Remote apply is not obsolete");
			const expected_writes = { ...this.state.expected_writes };
			delete expected_writes[path];
			await this.commit({
				...this.state,
				pending_apply: [],
				expected_writes,
			});
		});
	}

	/** Persists a path-specific blocker without changing base or pending operation bytes. */
	async recordAttention(path: string, reason: string): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			const attention = this.state.attention.filter(
				(item) => item.path !== path,
			);
			await this.commit({
				...this.state,
				attention: [...attention, { path, reason }],
			});
		});
	}

	/** Commits a strictly newer confirmed revision and clears its durable apply marker. */
	async completeApply(path: string, base: DeviceBaseEntry): Promise<void> {
		const parsed = DeviceBaseEntrySchema.parse(base);
		return this.serialize(async () => {
			this.assertOpen();
			const pending = this.state.pending_apply[0];
			if (
				!pending ||
				pending.change.op === "rename" ||
				pending.change.path !== path
			)
				throw new Error("Remote apply identity changed");
			const revision = parseETag(pending.change.etag).rev;
			if (parsed.rev !== revision)
				throw new Error(
					"Confirmed base revision does not match the remote entry",
				);
			if (
				parsed.rev <= (this.state.base[path]?.rev ?? 0) &&
				!this.state.stale_base_paths.includes(path)
			)
				throw new Error("Confirmed base revision cannot regress or repeat");
			if (
				(pending.change.op === "delete" && !parsed.deleted) ||
				(pending.change.op === "put" &&
					(parsed.deleted || parsed.hash !== pending.change.hash))
			)
				throw new Error(
					"Confirmed base content does not match the remote entry",
				);
			const nextBase = { ...this.state.base, [path]: parsed };
			const expected_writes = { ...this.state.expected_writes };
			delete expected_writes[path];
			await this.commit({
				...this.state,
				base: nextBase,
				stale_base_paths: this.state.stale_base_paths.filter(
					(item) => item !== path,
				),
				pending_apply: [],
				expected_writes,
			});
		});
	}

	/** Requires earlier overlapping operations to resolve before confirming and releasing immutable retry bytes. */
	async prepareSend(
		key: string,
		precondition: PendingOperation["precondition"],
	): Promise<{ operation: PendingOperation; bytes: Uint8Array }> {
		const capturedPrecondition = structuredClone(precondition);
		return this.serialize(async () => {
			this.assertOpen();
			const currentIndex = this.state.pending_ops.findIndex(
				(item) => item.key === key,
			);
			const current = this.state.pending_ops[currentIndex];
			if (!current) throw new Error("Unknown operation");
			if (current.state === "resolved")
				throw new Error("Resolved operations cannot be sent");
			const predecessor = this.state.pending_ops
				.slice(0, currentIndex)
				.some(
					(item) =>
						item.state !== "resolved" && operationsConflict(item, current),
				);
			if (predecessor) throw new Error("A predecessor is unresolved");
			if (this.attentionReasonValue !== null)
				throw new Error(this.attentionReasonValue);
			const candidate =
				current.state === "sent"
					? current
					: PendingOperationSchema.parse({
							...current,
							state: "sent",
							precondition: capturedPrecondition,
						});
			if (
				current.state === "sent" &&
				!samePrecondition(current.precondition, capturedPrecondition)
			)
				throw new Error("Sent precondition is immutable");
			let bytes: Uint8Array;
			try {
				bytes = await this.storage.readPayload(candidate.payload_ref);
				if ((await digest(bytes)) !== candidate.payload_hash)
					throw new Error("Payload verification failed");
			} catch (error) {
				this.attentionReasonValue = DEVICE_JOURNAL_ATTENTION_REASON;
				throw error;
			}
			this.assertOpen();
			if (current.state !== "sent")
				await this.commit({
					...this.state,
					pending_ops: this.state.pending_ops.map((item) =>
						item.key === key ? candidate : item,
					),
				});
			this.assertOpen();
			return { operation: cloneOperation(candidate), bytes: bytes.slice() };
		});
	}

	/** Stores identity only when its session predicate still holds at queued commit admission. */
	async setClientId(
		clientId: string,
		isCurrent: () => boolean = () => true,
	): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			if (!isCurrent()) throw new Error("Client identity update is stale");
			const next = DeviceStateSchema.parse({
				...this.state,
				client_id: clientId,
			});
			await this.commit(next);
		});
	}

	/** Removes an operation only after explicit receipt or rejection evidence persists. */
	async resolve(key: string, _outcome: ResolutionOutcome): Promise<void> {
		await this.serialize(async () => {
			this.assertOpen();
			if (
				!this.state.pending_ops.some(
					(item) => item.key === key && item.state === "sent",
				)
			)
				throw new Error("Only a sent operation can resolve");
			await this.commit({
				...this.state,
				pending_ops: this.state.pending_ops.filter((item) => item.key !== key),
			});
		});
	}

	/** Returns an isolated copy of the last confirmed validated state. */
	snapshot(): DeviceState {
		return DeviceStateSchema.parse(structuredClone(this.state));
	}

	/** Blocks actions immediately without deleting any confirmed state or payload. */
	close(): void {
		this.closed = true;
	}

	/** Publishes a candidate in memory only after whole-document read-back validation. */
	private async commit(candidate: DeviceState): Promise<void> {
		const parsed = DeviceStateSchema.parse(candidate);
		try {
			await persistVerified(this.storage, parsed);
			this.state = parsed;
			this.attentionReasonValue = null;
		} catch (error) {
			this.attentionReasonValue = DEVICE_JOURNAL_ATTENTION_REASON;
			throw error;
		}
	}

	/** Orders all state transitions and keeps the queue usable after an action rejects. */
	private async serialize<T>(action: () => Promise<T>): Promise<T> {
		const result = this.tail.then(action);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Rejects new transitions after unload, including work that resumes from an await. */
	private assertOpen(): void {
		if (this.closed) throw new Error("Device journal is closed");
	}
}

/** Writes one complete state document and rejects dropped, altered, or unreadable writes. */
async function persistVerified(
	storage: DeviceJournalStorage,
	state: DeviceState,
): Promise<void> {
	await storage.writeState(state);
	const readBack = DeviceStateSchema.parse(await storage.readState());
	if (JSON.stringify(readBack) !== JSON.stringify(state))
		throw new Error("Device state write did not verify");
}

/** Checks source and rename-destination overlap by canonical lowercased NFC path identity. */
function operationsConflict(
	left: PendingOperation,
	right: PendingOperation,
): boolean {
	const leftPaths = left.op === "rename" ? [left.path, left.to] : [left.path];
	const rightPaths =
		right.op === "rename" ? [right.path, right.to] : [right.path];
	const leftKeys = leftPaths.map(pathKey);
	const rightKeys = rightPaths.map(pathKey);
	return leftKeys.some((leftKey) => rightKeys.includes(leftKey));
}

/** Compares precondition evidence by meaning, independent of object property order. */
function samePrecondition(
	left: DevicePrecondition,
	right: DevicePrecondition,
): boolean {
	return (
		left.kind === right.kind &&
		(left.kind === "absent" ||
			(right.kind === "match" &&
				left.epoch === right.epoch &&
				left.rev === right.rev))
	);
}

/** Produces RFC 9562 UUIDv7 values from the current millisecond and Web Crypto randomness. */
function createUuidV7(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let timestamp = Date.now();
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = timestamp & 0xff;
		timestamp = Math.floor(timestamp / 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Hashes raw operation bytes using the host's Web Crypto implementation. */
async function digest(bytes: Uint8Array): Promise<string> {
	const stableBytes = bytes.slice();
	const hash = await crypto.subtle.digest(
		"SHA-256",
		stableBytes.buffer as ArrayBuffer,
	);
	return [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Copies validated operation data so callers cannot mutate journal authority. */
function cloneOperation(operation: PendingOperation): PendingOperation {
	return PendingOperationSchema.parse(structuredClone(operation));
}
