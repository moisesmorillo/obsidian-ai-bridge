import {
	ChangeEntrySchema,
	type CoexistenceConfirmation,
	CoexistenceConfirmationSchema,
	DEVICE_PAYLOAD_DIRECTORY,
	type DeviceBaseEntry,
	DeviceBaseEntrySchema,
	type DevicePrecondition,
	type DeviceState,
	DeviceStateSchema,
	type PendingApply,
	PendingApplySchema,
	type PendingConflictCopy,
	type PendingOperation,
	PendingOperationSchema,
	parseETag,
	pathKey,
} from "@obsidian-ai-bridge/protocol";
import {
	getAttentionKey,
	isInformationalAttention,
} from "@plugin/sync/attention";

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

/** Local mutation intent; the journal owns generated identity, while optional evidence links rename recovery or dependent deletes. */
export type EnqueueInput =
	| { op: "put"; path: string; precondition: DevicePrecondition }
	| {
			op: "delete";
			path: string;
			precondition: DevicePrecondition;
			depends_on?: string;
	  }
	| {
			op: "rename";
			path: string;
			to: string;
			precondition: DevicePrecondition;
			source_hash?: string;
	  };

/** Caller-supplied evidence for an explicit server receipt or rejection. */
export type ResolutionOutcome = { kind: "receipt" } | { kind: "rejection" };

/** Fixed non-secret stage codes for journal persistence and payload verification failures. */
export const DEVICE_JOURNAL_FAILURE_STAGES = [
	"payload_write",
	"payload_read",
	"payload_hash_error",
	"payload_hash_mismatch",
	"state_write",
	"state_readback",
	"state_readback_mismatch",
] as const;

/** Fixed diagnostic stage returned by the local journal. */
export type DeviceJournalFailureStage =
	(typeof DEVICE_JOURNAL_FAILURE_STAGES)[number];

/** Serializes confirmed local transitions and releases only hash-verified durable bytes. */
export class DeviceJournal {
	/** Last validated state whose full document matched storage read-back. */
	private state: DeviceState;
	/** Blocks release after storage failure until a later state write verifies. */
	private attentionReasonValue: string | null = null;
	/** Fixed failure boundary for safe diagnostics; cleared only after verified persistence. */
	private attentionStageValue: DeviceJournalFailureStage | null = null;
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

	/** Reports a fixed failure boundary without exposing storage errors or operation identity. */
	get attentionStage(): DeviceJournalFailureStage | null {
		return this.attentionStageValue;
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
			} catch (error) {
				this.markAttention("payload_write");
				throw error;
			}
			let storedPayload: Uint8Array;
			try {
				storedPayload = await this.storage.readPayload(payloadRef);
			} catch (error) {
				this.markAttention("payload_read");
				throw error;
			}
			let storedHash: string;
			try {
				storedHash = await digest(storedPayload);
			} catch (error) {
				this.markAttention("payload_hash_error");
				throw error;
			}
			if (storedHash !== hash) {
				this.markAttention("payload_hash_mismatch");
				throw new Error("Payload verification failed");
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

	/** Records one validated remote change and optional manifest content kind before effects. */
	async beginApply(
		change: unknown,
		contentKind?: "text" | "blob",
	): Promise<void> {
		const parsedChange = ChangeEntrySchema.parse(change);
		return this.serialize(async () => {
			this.assertOpen();
			const current = this.state.pending_apply[0];
			if (current && current.change.seq !== parsedChange.seq)
				throw new Error("Another remote apply is pending");
			if (current) {
				if (JSON.stringify(current.change) !== JSON.stringify(parsedChange))
					throw new Error("Remote apply identity changed");
				if (contentKind && current.content_kind !== contentKind)
					await this.commit({
						...this.state,
						pending_apply: [{ ...current, content_kind: contentKind }],
					});
				return;
			}
			await this.commit({
				...this.state,
				pending_apply: [
					{
						change: parsedChange,
						step: "prepared",
						...(contentKind ? { content_kind: contentKind } : {}),
					},
				],
			});
		});
	}

	/** Replaces apply authority or copy plans and retains their content-kind recovery route when plans remain. */
	async rebasePendingApply(
		change: DeviceState["pending_apply"][number]["change"],
		conflictCopies?: PendingConflictCopy[],
	): Promise<void> {
		const parsedChange = ChangeEntrySchema.parse(change);
		return this.serialize(async () => {
			this.assertOpen();
			const current = this.state.pending_apply[0];
			if (!current || current.change.seq !== parsedChange.seq)
				throw new Error("Pinned fallback does not match the pending feed row");
			if (
				current.change.path !== parsedChange.path ||
				(current.change.op !== parsedChange.op &&
					!(current.change.op === "put" && parsedChange.op === "delete"))
			)
				throw new Error("Pinned fallback changed the row path or operation");
			const oldEpoch = parseETag(current.change.etag).epoch;
			const newEpoch = parseETag(parsedChange.etag).epoch;
			if (oldEpoch !== newEpoch)
				throw new Error("Pinned fallback changed the vault epoch");
			const rebased: PendingApply =
				conflictCopies === undefined
					? { ...current, change: parsedChange }
					: conflictCopies.length === 0
						? { change: parsedChange, step: "prepared" }
						: {
								change: parsedChange,
								step: "named",
								...(current.content_kind
									? { content_kind: current.content_kind }
									: {}),
								conflict_copies: conflictCopies,
							};
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
				(item) => item.path !== path || item.operation !== undefined,
			);
			await this.commit({
				...this.state,
				attention: [...attention, { path, reason }],
			});
		});
	}

	/** Removes only the current attention item that matches this stable identity. */
	async dismissAttention(key: string): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			const index = this.state.attention.findIndex(
				(item) => getAttentionKey(item) === key,
			);
			if (index === -1) return;
			const attention = [...this.state.attention];
			attention.splice(index, 1);
			await this.commit({ ...this.state, attention });
		});
	}

	/** Removes only entries whose exact reason is informational, preserving owner-action items. */
	async dismissInformationalAttention(): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			const attention = this.state.attention.filter(
				(item) => !isInformationalAttention(item),
			);
			if (attention.length === this.state.attention.length) return;
			await this.commit({ ...this.state, attention });
		});
	}

	/** Clears an unsupported remote apply and records attention without claiming a base. */
	async skipApplyForAttention(
		path: string,
		sequence: number,
		reason: string,
	): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			const pending = this.state.pending_apply[0];
			if (
				pending &&
				(pending.change.path !== path || pending.change.seq !== sequence)
			)
				throw new Error("Remote apply identity changed");
			const attention = this.state.attention.filter(
				(item) => item.path !== path || item.operation !== undefined,
			);
			const expected_writes = { ...this.state.expected_writes };
			delete expected_writes[path];
			await this.commit({
				...this.state,
				pending_apply: [],
				expected_writes,
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
			} catch (error) {
				this.markAttention("payload_read");
				throw error;
			}
			let payloadHash: string;
			try {
				payloadHash = await digest(bytes);
			} catch (error) {
				this.markAttention("payload_hash_error");
				throw error;
			}
			if (payloadHash !== candidate.payload_hash) {
				this.markAttention("payload_hash_mismatch");
				throw new Error("Payload verification failed");
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

	/** Reads one operation payload only after verifying its immutable SHA-256 identity. */
	async readPayload(
		reference: string,
		expectedHash: string,
	): Promise<Uint8Array> {
		let bytes: Uint8Array;
		try {
			bytes = await this.storage.readPayload(reference);
		} catch (error) {
			this.markAttention("payload_read");
			throw error;
		}
		let actualHash: string;
		try {
			actualHash = await digest(bytes);
		} catch (error) {
			this.markAttention("payload_hash_error");
			throw error;
		}
		if (actualHash !== expectedHash) {
			this.markAttention("payload_hash_mismatch");
			throw new Error("Payload verification failed");
		}
		return bytes.slice();
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

	/** Saves device-local Pause state only while its lifecycle and generation remain current. */
	async setSyncPaused(
		paused: boolean,
		isCurrent: () => boolean = () => true,
	): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			if (!isCurrent()) throw new Error("Pause update is stale");
			await this.commit(
				DeviceStateSchema.parse({ ...this.state, sync_paused: paused }),
			);
		});
	}

	/** Resolves sent work with its receipt-produced base. Rename receipts authorize only destination successors, never source successors. */
	async resolve(
		key: string,
		outcome: ResolutionOutcome,
		receiptBase?: DeviceBaseEntry,
	): Promise<void> {
		await this.serialize(async () => {
			this.assertOpen();
			const index = this.state.pending_ops.findIndex(
				(item) => item.key === key && item.state === "sent",
			);
			const operation = this.state.pending_ops[index];
			if (!operation) throw new Error("Only a sent operation can resolve");
			const receiptPath =
				operation.op === "rename" ? operation.to : operation.path;
			const successorBase = receiptBase
				? DeviceBaseEntrySchema.parse(receiptBase)
				: undefined;
			const dependentDeletes = this.state.pending_ops.filter(
				(item) => item.op === "delete" && item.depends_on === key,
			);
			const rejectedDeletes =
				outcome.kind === "rejection" ? dependentDeletes : [];
			const staleDeletes =
				outcome.kind === "receipt"
					? dependentDeletes.filter((item) => {
							const currentBase = this.state.base[item.path];
							return (
								item.path !== receiptPath ||
								!successorBase ||
								!currentBase ||
								!sameBaseEntry(currentBase, successorBase)
							);
						})
					: [];
			const blocked = [...rejectedDeletes, ...staleDeletes];
			const attention = [
				...this.state.attention.filter(
					(item) =>
						item.operation?.key !== key &&
						!blocked.some((operation) => item.operation?.key === operation.key),
				),
				...(outcome.kind === "rejection"
					? [
							{
								path: operation.path,
								reason: "Rejected operation retained for recovery",
								operation,
							},
						]
					: []),
				...rejectedDeletes.map((item) => ({
					path: item.path,
					reason: "Delete intent was blocked by its rejected create",
					operation: item,
				})),
				...staleDeletes.map((item) => ({
					path: item.path,
					reason: "Delete intent no longer matches its create receipt",
					operation: item,
				})),
			];
			const pending_ops = this.state.pending_ops.flatMap((item, itemIndex) => {
				if (
					item.key === key ||
					blocked.some((candidate) => candidate.key === item.key)
				)
					return [];
				if (
					outcome.kind !== "receipt" ||
					item.state !== "queued" ||
					itemIndex <= index ||
					!operationsConflict(operation, item)
				)
					return [item];
				if (item.path !== receiptPath || !successorBase || !this.state.epoch)
					return [item];
				const canRebase =
					item.precondition.kind === "absent" ||
					(item.precondition.epoch === this.state.epoch &&
						item.precondition.rev < successorBase.rev);
				const precondition = canRebase
					? {
							kind: "match" as const,
							epoch: this.state.epoch,
							rev: successorBase.rev,
						}
					: item.precondition;
				if (item.op !== "delete" || item.depends_on !== key)
					return canRebase ? [{ ...item, precondition }] : [item];
				const { depends_on: _dependency, ...resolved } = item;
				return [{ ...resolved, precondition }];
			});
			await this.commit({ ...this.state, pending_ops, attention });
		});
	}

	/** Drops one unsent queue reference after confirmed remote state makes its bytes redundant. */
	async discardQueued(key: string): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			if (
				!this.state.pending_ops.some(
					(item) => item.key === key && item.state === "queued",
				)
			)
				throw new Error("Only a queued operation can be discarded");
			await this.commit({
				...this.state,
				pending_ops: this.state.pending_ops.filter((item) => item.key !== key),
			});
		});
	}

	/** Retains a queued intent in attention when its live local evidence no longer matches. */
	async recordQueuedRejected(
		operation: PendingOperation,
		reason: string,
	): Promise<void> {
		const parsed = PendingOperationSchema.parse(operation);
		await this.serialize(async () => {
			this.assertOpen();
			const queued = this.state.pending_ops.find(
				(item) => item.key === parsed.key && item.state === "queued",
			);
			if (!queued || JSON.stringify(queued) !== JSON.stringify(parsed))
				throw new Error("Queued operation identity changed");
			const attention = this.state.attention.filter(
				(item) => item.operation?.key !== parsed.key,
			);
			await this.commit({
				...this.state,
				pending_ops: this.state.pending_ops.filter(
					(item) => item.key !== parsed.key,
				),
				attention: [
					...attention,
					{ path: parsed.path, reason, operation: parsed },
				],
			});
		});
	}

	/** Persists a bounded retry deadline and attempt count without changing sent request identity. */
	async defer(key: string, retryAt: number): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			const operation = this.state.pending_ops.find(
				(item) => item.key === key && item.state === "sent",
			);
			if (!operation) throw new Error("Only a sent operation can defer");
			await this.commit({
				...this.state,
				pending_ops: this.state.pending_ops.map((item) =>
					item.key === key
						? { ...item, attempts: item.attempts + 1, retry_at: retryAt }
						: item,
				),
			});
		});
	}

	/** Retains rejected sent evidence and moves dependent deletes to attention until recovery completes. */
	async recordRejected(
		operation: PendingOperation,
		reason: string,
		attentionPath = operation.path,
	): Promise<void> {
		const parsed = PendingOperationSchema.parse(operation);
		await this.serialize(async () => {
			this.assertOpen();
			const sent = this.state.pending_ops.find(
				(item) => item.key === parsed.key && item.state === "sent",
			);
			if (!sent || JSON.stringify(sent) !== JSON.stringify(parsed))
				throw new Error("Rejected operation identity changed");
			const blocked = this.state.pending_ops.filter(
				(item) => item.op === "delete" && item.depends_on === parsed.key,
			);
			const attention = this.state.attention.filter(
				(item) =>
					item.operation?.key !== parsed.key &&
					!blocked.some((operation) => item.operation?.key === operation.key),
			);
			await this.commit({
				...this.state,
				pending_ops: this.state.pending_ops.filter(
					(item) =>
						item.key !== parsed.key &&
						!blocked.some((operation) => item.key === operation.key),
				),
				attention: [
					...attention,
					{ path: attentionPath, reason, operation: parsed },
					...blocked.map((operation) => ({
						path: operation.path,
						reason: "Delete intent was blocked by its rejected create",
						operation,
					})),
				],
			});
		});
	}

	/** Captures current authority or keeps an event visible without stale-base authority. */
	async captureCoexistenceEvent(
		event:
			| { type: "delete"; path: string }
			| { type: "rename"; path: string; to: string },
		at: number,
	): Promise<CoexistenceConfirmation> {
		return this.serialize(async () => {
			this.assertOpen();
			const staleBase = this.state.stale_base_paths.includes(event.path);
			const observed = {
				id: createUuidV7(),
				kind: event.type,
				path: event.path,
				observed_epoch: staleBase ? null : (this.state.epoch ?? null),
				observed_base: staleBase ? null : (this.state.base[event.path] ?? null),
				at,
				...(staleBase
					? {
							stale_reason:
								"The source base is stale after a vault epoch change.",
						}
					: {}),
			};
			const item = CoexistenceConfirmationSchema.parse(
				event.type === "rename" ? { ...observed, to: event.to } : observed,
			);
			await this.commit({
				...this.state,
				coexistence_confirmations: [
					...this.state.coexistence_confirmations,
					item,
				],
			});
			return item;
		});
	}

	/** Adds one unavailable path without changing the last observed remote revision. */
	async markUnavailable(path: string): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			if (this.state.unavailable_paths.includes(path)) return;
			await this.commit({
				...this.state,
				unavailable_paths: [...this.state.unavailable_paths, path],
			});
		});
	}

	/** Clears local placeholder protection only after metadata confirms availability. */
	async clearUnavailable(path: string): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			await this.commit({
				...this.state,
				unavailable_paths: this.state.unavailable_paths.filter(
					(item) => item !== path,
				),
			});
		});
	}

	/** Persists one captured destructive event before any publication or apply effects. */
	async saveCoexistenceConfirmation(
		confirmation: CoexistenceConfirmation,
	): Promise<void> {
		const item = CoexistenceConfirmationSchema.parse(confirmation);
		return this.serialize(async () => {
			this.assertOpen();
			if (this.state.coexistence_confirmations.some(({ id }) => id === item.id))
				return;
			await this.commit({
				...this.state,
				coexistence_confirmations: [
					...this.state.coexistence_confirmations,
					item,
				],
			});
		});
	}

	/** Keeps stale intent visible with a fixed owner-safe reason until the owner clears it. */
	async markCoexistenceStale(id: string, reason: string): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			await this.commit({
				...this.state,
				coexistence_confirmations: this.state.coexistence_confirmations.map(
					(item) => (item.id === id ? { ...item, stale_reason: reason } : item),
				),
			});
		});
	}

	/** Clears one owner decision without changing placeholder protection or remote authority. */
	async clearCoexistenceConfirmation(id: string): Promise<void> {
		return this.serialize(async () => {
			this.assertOpen();
			await this.commit({
				...this.state,
				coexistence_confirmations: this.state.coexistence_confirmations.filter(
					(item) => item.id !== id,
				),
			});
		});
	}

	/** Moves only current, non-stale confirmation authority into the durable outgoing queue. */
	async confirmCoexistence(id: string): Promise<PendingOperation | null> {
		return this.serialize(async () => {
			this.assertOpen();
			const confirmation = this.state.coexistence_confirmations.find(
				(item) => item.id === id,
			);
			if (!confirmation) return null;
			const base = confirmation.observed_base;
			if (confirmation.stale_reason) return null;
			if (
				this.state.stale_base_paths.includes(confirmation.path) &&
				confirmation.observed_epoch === this.state.epoch
			) {
				await this.commit({
					...this.state,
					coexistence_confirmations: this.state.coexistence_confirmations.map(
						(item) =>
							item.id === id
								? {
										...item,
										stale_reason:
											"The source base is stale after a vault epoch change.",
									}
								: item,
					),
				});
				return null;
			}
			if (!base || base.deleted || !confirmation.observed_epoch) {
				await this.commit({
					...this.state,
					coexistence_confirmations: this.state.coexistence_confirmations.map(
						(item) =>
							item.id === id
								? {
										...item,
										stale_reason: "No live source revision was observed.",
									}
								: item,
					),
				});
				return null;
			}
			if (
				this.state.epoch !== confirmation.observed_epoch ||
				!sameBaseEntry(this.state.base[confirmation.path], base)
			) {
				await this.commit({
					...this.state,
					coexistence_confirmations: this.state.coexistence_confirmations.map(
						(item) =>
							item.id === id
								? {
										...item,
										stale_reason: "The observed source revision changed.",
									}
								: item,
					),
				});
				return null;
			}
			const key = createUuidV7();
			const payloadRef = `${DEVICE_PAYLOAD_DIRECTORY}${key}`;
			const payload = new Uint8Array();
			const hash = await digest(payload);
			await this.storage.writePayload(payloadRef, payload);
			const stored = await this.storage.readPayload(payloadRef);
			if ((await digest(stored)) !== hash)
				throw new Error("Payload verification failed");
			const common = {
				key,
				payload_hash: hash,
				payload_ref: payloadRef,
				created_at: Date.now(),
				attempts: 0,
				state: "queued" as const,
			};
			const operation = PendingOperationSchema.parse(
				confirmation.kind === "delete"
					? {
							...common,
							op: "delete",
							path: confirmation.path,
							precondition: {
								kind: "match",
								epoch: confirmation.observed_epoch,
								rev: base.rev,
							},
						}
					: {
							...common,
							op: "rename",
							path: confirmation.path,
							to: confirmation.to,
							precondition: {
								kind: "match",
								epoch: confirmation.observed_epoch,
								rev: base.rev,
							},
							source_hash: base.hash,
						},
			);
			this.assertOpen();
			await this.commit({
				...this.state,
				pending_ops: [...this.state.pending_ops, operation],
				coexistence_confirmations: this.state.coexistence_confirmations.filter(
					(item) => item.id !== id,
				),
			});
			return cloneOperation(operation);
		});
	}

	/** Returns an isolated copy of the last confirmed validated state. */
	snapshot(): DeviceState {
		return DeviceStateSchema.parse(structuredClone(this.state));
	}

	/** Checks whether captured event authority still matches this path and epoch. */
	matchesBase(
		path: string,
		base: DeviceBaseEntry | undefined,
		epoch: string | undefined,
	): boolean {
		return (
			this.state.epoch === epoch && sameBaseEntry(this.state.base[path], base)
		);
	}

	/** Blocks actions immediately without deleting any confirmed state or payload. */
	close(): void {
		this.closed = true;
	}

	/** Publishes a candidate in memory only after whole-document read-back validation. */
	private async commit(candidate: DeviceState): Promise<void> {
		const parsed = DeviceStateSchema.parse(candidate);
		try {
			await persistVerified(this.storage, parsed, (stage) => {
				this.attentionStageValue = stage;
			});
			this.state = parsed;
			this.attentionReasonValue = null;
			this.attentionStageValue = null;
		} catch (error) {
			this.attentionReasonValue = DEVICE_JOURNAL_ATTENTION_REASON;
			throw error;
		}
	}

	/** Keeps the existing blocking warning and records only a fixed diagnostic code. */
	private markAttention(stage: DeviceJournalFailureStage): void {
		this.attentionReasonValue = DEVICE_JOURNAL_ATTENTION_REASON;
		this.attentionStageValue = stage;
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

/** Writes a complete state document and lets active journals classify write and read-back failures. */
async function persistVerified(
	storage: DeviceJournalStorage,
	state: DeviceState,
	onFailure?: (stage: DeviceJournalFailureStage) => void,
): Promise<void> {
	try {
		await storage.writeState(state);
	} catch (error) {
		onFailure?.("state_write");
		throw error;
	}
	let readBack: DeviceState;
	try {
		readBack = DeviceStateSchema.parse(await storage.readState());
	} catch (error) {
		onFailure?.("state_readback");
		throw error;
	}
	if (JSON.stringify(readBack) !== JSON.stringify(state)) {
		onFailure?.("state_readback_mismatch");
		throw new Error("Device state write did not verify");
	}
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

/** Compares confirmed base evidence by revision and content, including absence. */
function sameBaseEntry(
	left: DeviceBaseEntry | undefined,
	right: DeviceBaseEntry | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.deleted === right.deleted &&
		left.rev === right.rev &&
		(left.deleted || (!right.deleted && left.hash === right.hash))
	);
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
