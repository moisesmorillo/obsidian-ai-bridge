import {
	DEVICE_PAYLOAD_DIRECTORY,
	type DevicePrecondition,
	type DeviceState,
	DeviceStateSchema,
	type PendingOperation,
	PendingOperationSchema,
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
