import type { MeasurementResponse } from "@obsidian-ai-bridge/protocol";

/** Maximum concurrent authoritative read responses in one Worker isolate. */
export const READ_SLOT_LIMIT = 4;
/** Maximum time one read lease can retain local capacity, in milliseconds. */
export const READ_SLOT_HOLD_DEADLINE_MS = 60_000;
let activeReadSlots = 0;
/** Incomplete response leases that reached their deadline in this isolate. */
let expiredReadSlots = 0;
/** Opaque process-local identifier used only in owner observations, created on first use. */
let isolateId: string | undefined;

/**
 * Return the isolate identifier, creating it inside request context.
 * Workers reject random value generation in the module global scope, so the first
 * observation request creates the identifier instead of the module evaluation.
 */
function currentIsolateId(): string {
	if (isolateId === undefined) isolateId = crypto.randomUUID();
	return isolateId;
}

/** Callable local release handle with a fixed acquisition deadline. */
export interface ReadSlotLease {
	/** Release local capacity once without clearing the response deadline. */
	(): void;
	/** True after the fixed deadline, including when source completion freed capacity first. */
	readonly expired: boolean;
	/** Resolves at the fixed acquisition deadline. */
	readonly expiration: Promise<void>;
	/** Stop deadline observation after the response completed before expiry. */
	complete(): void;
	/** Subscribe to deadline expiry, with immediate notification if already expired. */
	onExpire(listener: () => void): () => void;
}

/** Value completed while the read lease remained within its deadline. */
export interface ReadSlotWorkResult<T> {
	/** Completed work owns this value. */
	kind: "completed";
	value: T;
}

/** Work that outlives its lease deadline no longer owns a response. */
export interface ReadSlotExpiredResult {
	kind: "expired";
}

/** Per-isolate capacity observation from the canonical owner response contract. */
export type ReadSlotCapacitySnapshot = NonNullable<
	MeasurementResponse["worker_isolate"]
>;

/** Race preparation work against the acquisition deadline without cancelling native work. */
export async function waitForReadSlotWork<T>(
	lease: ReadSlotLease,
	work: Promise<T>,
): Promise<ReadSlotWorkResult<T> | ReadSlotExpiredResult> {
	if (lease.expired) return { kind: "expired" };
	return Promise.race([
		work.then((value) => ({ kind: "completed" as const, value })),
		lease.expiration.then(() => ({ kind: "expired" as const })),
	]);
}

/** Return an isolate-local capacity snapshot without durable or client aggregation. */
export function readSlotCapacitySnapshot(): ReadSlotCapacitySnapshot {
	return {
		isolate_id: currentIsolateId(),
		active_slots: activeReadSlots,
		available_slots: READ_SLOT_LIMIT - activeReadSlots,
		limit: READ_SLOT_LIMIT,
		expired_count: expiredReadSlots,
		deadline_ms: READ_SLOT_HOLD_DEADLINE_MS,
	};
}

/** Reserve one isolate read slot without queueing, then release it after work or expiry. */
export function tryAcquireReadSlot(): ReadSlotLease | undefined {
	if (activeReadSlots >= READ_SLOT_LIMIT) return undefined;
	activeReadSlots += 1;
	let released = false;
	let expired = false;
	let completed = false;
	let signalExpiration!: () => void;
	const expiration = new Promise<void>((resolve) => {
		signalExpiration = resolve;
	});
	const listeners = new Set<() => void>();
	/** Free one local slot at most once while leaving response expiry active. */
	const release = (() => {
		if (released) return;
		released = true;
		activeReadSlots -= 1;
	}) as ReadSlotLease;
	Object.defineProperties(release, {
		expired: { get: () => expired },
		expiration: { value: expiration },
	});
	release.complete = () => {
		if (completed) return;
		completed = true;
		clearTimeout(timer);
		listeners.clear();
	};
	release.onExpire = (listener) => {
		if (expired) {
			listener();
			return () => {};
		}
		if (completed) return () => {};
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const timer = setTimeout(() => {
		if (completed) return;
		expired = true;
		signalExpiration();
		expiredReadSlots += 1;
		if (!released) release();
		for (const listener of listeners) listener();
		listeners.clear();
	}, READ_SLOT_HOLD_DEADLINE_MS);
	return release;
}
