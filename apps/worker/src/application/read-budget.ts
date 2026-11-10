import type { MeasurementResponse } from "@vaultwire/protocol";
import {
	type AdmissionByteReservation,
	LOCAL_ADMISSION_RETRY_SECONDS,
	REST_READ_BYTE_ALLOWANCE,
	tryReserveAdmissionBytes,
} from "@worker/application/admission-budget";

/** Maximum concurrent authoritative REST read responses in one Worker isolate. */
export const REST_READ_SLOT_LIMIT = 4;
/** Maximum concurrent MCP read responses in one Worker isolate. */
export const MCP_READ_SLOT_LIMIT = 8;
/** Aggregate REST and MCP read capacity reported by isolate measurements. */
export const READ_SLOT_LIMIT = REST_READ_SLOT_LIMIT + MCP_READ_SLOT_LIMIT;
/** Maximum logical lease duration, in milliseconds, regardless of timer delivery. */
export const READ_SLOT_HOLD_DEADLINE_MS = 60_000;
/**
 * Grace, in milliseconds after the logical hold deadline, that unsettled response work keeps its
 * physical byte reservation. At the end of the grace the reservation is reclaimed once, even when
 * late source work or cancellation never settles, so stalled reads cannot fill the REST pool for the
 * isolate lifetime. Owner decision D1 of OAB-58.
 */
export const READ_SLOT_RECLAIM_GRACE_MS = 60_000;
const activeLeases = new Map<number, ReadSlotLeaseState>();
/** Leases whose physical work has not completed or been reclaimed, keyed by lease id. */
const heldLeases = new Map<number, HeldReadSlotState>();
let nextLeaseId = 0;
let expiredReadSlots = 0;
/** Expired leases whose byte reservation was reclaimed before their work settled. */
let reclaimedUnsettledReadSlots = 0;
/** Opaque process-local identifier used only in owner observations, created on first use. */
let isolateId: string | undefined;

/** Pool whose capacity an acquisition reserves. */
export type ReadSlotClass = "rest" | "mcp";

/** Logical lease state retained until response completion or absolute expiry. */
interface ReadSlotLeaseState {
	leaseClass: ReadSlotClass;
	expiresAt: number;
	released: boolean;
	expire: () => void;
}

/** Physical ownership retained from acquisition until completion or reclaim. */
interface HeldReadSlotState {
	leaseClass: ReadSlotClass;
	/** Acquisition time, in Unix milliseconds. */
	acquiredAt: number;
	/** Physical reclaim deadline: the logical deadline plus the reclaim grace, in Unix milliseconds. */
	reclaimAt: number;
	/** Release the byte reservation of unsettled work once and count the reclaim. */
	reclaim: () => void;
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
	/** True when an unfinished lease reaches its deadline. Reading this property recovers overdue leases. */
	readonly expired: boolean;
	/** Resolves at the fixed acquisition deadline. */
	readonly expiration: Promise<void>;
	/** Stop deadline observation and release bytes after response work ends. */
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

/**
 * Expire overdue leases and reclaim the bytes of work still unsettled at its reclaim deadline,
 * before admission or observation, even if timers did not run. Reclaim needs no timer because every
 * admission and measurement runs this sweep first.
 */
export function sweepExpiredReadSlots(now = Date.now()): void {
	for (const lease of activeLeases.values())
		if (now >= lease.expiresAt) lease.expire();
	for (const held of heldLeases.values())
		if (now >= held.reclaimAt) held.reclaim();
}

/**
 * Race preparation against absolute expiry. Late work keeps its bytes until discard cleanup settles.
 * The discard callback owns returned sources and must not publish a late response.
 */
export async function waitForReadSlotWork<T>(
	lease: ReadSlotLease,
	work: Promise<T>,
	discard?: (value: T) => Promise<void>,
): Promise<ReadSlotWorkResult<T> | ReadSlotExpiredResult> {
	const result = lease.expired
		? { kind: "expired" as const }
		: await Promise.race([
				work.then((value) =>
					lease.expired
						? { kind: "expired" as const }
						: { kind: "completed" as const, value },
				),
				lease.expiration.then(() => ({ kind: "expired" as const })),
			]);
	if (result.kind === "expired")
		void work
			.then(discard, () => {})
			.finally(() => lease.complete())
			.catch(() => {});
	return result;
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
		reclaimed_unsettled_count: reclaimedUnsettledReadSlots,
	};
}

/**
 * Return the earliest expiry of a full logical pool, rounded and clamped in seconds.
 * Other refusals use the local fallback because physical completion has no estimate.
 */
export function readSlotRetryAfterSeconds(leaseClass: ReadSlotClass): number {
	const now = Date.now();
	sweepExpiredReadSlots(now);
	const leases = [...activeLeases.values()].filter(
		(lease) => lease.leaseClass === leaseClass && !lease.released,
	);
	const limit =
		leaseClass === "mcp" ? MCP_READ_SLOT_LIMIT : REST_READ_SLOT_LIMIT;
	if (leases.length < limit) return LOCAL_ADMISSION_RETRY_SECONDS;
	const expiresAt = Math.min(...leases.map((lease) => lease.expiresAt));
	return Math.max(
		LOCAL_ADMISSION_RETRY_SECONDS,
		Math.min(
			READ_SLOT_HOLD_DEADLINE_MS / 1_000,
			Math.ceil((expiresAt - now) / 1_000),
		),
	);
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
	const byteReservation: AdmissionByteReservation | undefined =
		leaseClass === "rest"
			? tryReserveAdmissionBytes("rest_read", REST_READ_BYTE_ALLOWANCE)
			: undefined;
	if (leaseClass === "rest" && !byteReservation) return undefined;
	const id = ++nextLeaseId;
	let released = false;
	let expired = false;
	let completed = false;
	let reclaimed = false;
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
		activeLeases.delete(id);
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
		expired: {
			get: () => {
				sweepExpiredReadSlots();
				return expired;
			},
		},
		expiration: { value: expiration },
	});
	release.complete = () => {
		if (completed) return;
		sweepExpiredReadSlots();
		completed = true;
		clearTimeout(timer);
		activeLeases.delete(id);
		heldLeases.delete(id);
		// A reclaimed reservation was already released; the handle is idempotent.
		if (!reclaimed) byteReservation?.release();
		listeners.clear();
	};
	/** Reclaim the physical reservation of unsettled work once at its reclaim deadline. */
	const reclaim = () => {
		if (completed || reclaimed) return;
		// An unexpired lease is still within its logical hold; expire it before reclaiming bytes.
		expire();
		reclaimed = true;
		heldLeases.delete(id);
		byteReservation?.release();
		reclaimedUnsettledReadSlots += 1;
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
	const acquiredAt = Date.now();
	const expiresAt = acquiredAt + READ_SLOT_HOLD_DEADLINE_MS;
	const timer = setTimeout(expire, READ_SLOT_HOLD_DEADLINE_MS);
	activeLeases.set(id, { leaseClass, expiresAt, released, expire });
	heldLeases.set(id, {
		leaseClass,
		acquiredAt,
		reclaimAt: expiresAt + READ_SLOT_RECLAIM_GRACE_MS,
		reclaim,
	});
	return release;
}
