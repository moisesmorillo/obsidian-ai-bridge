import type { MeasurementResponse } from "@vaultwire/protocol";

/** Maximum concurrent authoritative REST read responses in one Worker isolate. */
export const REST_READ_SLOT_LIMIT = 4;
/** Maximum concurrent MCP read responses in one Worker isolate. */
export const MCP_READ_SLOT_LIMIT = 8;
/** Aggregate REST and MCP read capacity reported by isolate measurements. */
export const READ_SLOT_LIMIT = REST_READ_SLOT_LIMIT + MCP_READ_SLOT_LIMIT;
/** Maximum logical lease duration, in milliseconds, regardless of timer delivery. */
export const READ_SLOT_HOLD_DEADLINE_MS = 60_000;
const activeLeases = new Map<number, ReadSlotLeaseState>();
let nextLeaseId = 0;
let expiredReadSlots = 0;
/** Opaque process-local identifier used only in owner observations, created on first use. */
let isolateId: string | undefined;

/** Pool whose capacity an acquisition reserves. */
export type ReadSlotClass = "rest" | "mcp";

/** Mutable lease state retained only while its deadline can affect admission. */
interface ReadSlotLeaseState {
	leaseClass: ReadSlotClass;
	expiresAt: number;
	released: boolean;
	expire: () => void;
}

/** Return the isolate identifier, creating it inside request context. */
function currentIsolateId(): string {
	if (isolateId === undefined) isolateId = crypto.randomUUID();
	return isolateId;
}

/** Callable local release handle with a fixed acquisition deadline. */
export interface ReadSlotLease {
	/** Release local capacity once without clearing response expiry. */
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

/** Work that completed while its read lease remained within its deadline. */
export interface ReadSlotWorkResult<T> {
	/** Completed work owns this value. */
	kind: "completed";
	value: T;
}

/** Work that outlived its lease deadline and cannot publish a response. */
export interface ReadSlotExpiredResult {
	kind: "expired";
}

/** Per-isolate capacity observation from the canonical owner response contract. */
export type ReadSlotCapacitySnapshot = NonNullable<
	MeasurementResponse["worker_isolate"]
>;

/** Expire overdue leases before admission or observation, even if timers did not run. */
function sweepExpiredReadSlots(now = Date.now()): void {
	for (const lease of activeLeases.values())
		if (now >= lease.expiresAt) lease.expire();
}

/** Race preparation work against lease expiry without claiming native work stopped. */
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

/** Return an isolate-local aggregate snapshot after recovering overdue leases. */
export function readSlotCapacitySnapshot(): ReadSlotCapacitySnapshot {
	sweepExpiredReadSlots();
	const activeSlots = [...activeLeases.values()].filter(
		(lease) => !lease.released,
	).length;
	return {
		isolate_id: currentIsolateId(),
		active_slots: activeSlots,
		available_slots: READ_SLOT_LIMIT - activeSlots,
		limit: READ_SLOT_LIMIT,
		expired_count: expiredReadSlots,
		deadline_ms: READ_SLOT_HOLD_DEADLINE_MS,
	};
}

/** Reserve a REST or MCP read slot without queueing. */
export function tryAcquireReadSlot(
	leaseClass: ReadSlotClass = "rest",
): ReadSlotLease | undefined {
	sweepExpiredReadSlots();
	const classLimit =
		leaseClass === "mcp" ? MCP_READ_SLOT_LIMIT : REST_READ_SLOT_LIMIT;
	const activeClass = [...activeLeases.values()].filter(
		(lease) => lease.leaseClass === leaseClass && !lease.released,
	).length;
	if (activeClass >= classLimit) return undefined;
	const id = ++nextLeaseId;
	let released = false;
	let expired = false;
	let completed = false;
	let signalExpiration!: () => void;
	const expiration = new Promise<void>((resolve) => {
		signalExpiration = resolve;
	});
	const listeners = new Set<() => void>();
	/** Free this lease's capacity once without changing its expiry outcome. */
	const release = (() => {
		if (released) return;
		released = true;
		const state = activeLeases.get(id);
		if (state) state.released = true;
	}) as ReadSlotLease;
	/** Mark the lease expired, free logical capacity, and notify every listener. */
	const expire = () => {
		if (completed || expired) return;
		expired = true;
		clearTimeout(timer);
		signalExpiration();
		expiredReadSlots += 1;
		release();
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// Listener faults cannot prevent other expiry listeners from running.
			}
		}
		listeners.clear();
	};
	Object.defineProperties(release, {
		expired: { get: () => expired },
		expiration: { value: expiration },
	});
	release.complete = () => {
		if (completed) return;
		completed = true;
		clearTimeout(timer);
		activeLeases.delete(id);
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
	const expiresAt = Date.now() + READ_SLOT_HOLD_DEADLINE_MS;
	const timer = setTimeout(expire, READ_SLOT_HOLD_DEADLINE_MS);
	activeLeases.set(id, { leaseClass, expiresAt, released, expire });
	return release;
}
