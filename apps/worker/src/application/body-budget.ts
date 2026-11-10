import {
	type AdmissionByteReservation,
	REST_BODY_BYTE_ALLOWANCE,
	tryReserveAdmissionBytes,
} from "@worker/application/admission-budget";
import { sweepExpiredReadSlots } from "@worker/application/read-budget";

/** Maximum concurrent body-bearing operations in one Worker isolate. */
const BODY_SLOT_LIMIT = 8;
/**
 * Response-production deadline, in milliseconds, after the operation finishes. The mutation response
 * pump aborts its writer at this deadline, so a client that stops reading gets an error.
 */
export const BODY_RESPONSE_DEADLINE_MS = 60_000;
/**
 * Grace, in milliseconds after the response deadline, before a body slot whose response production
 * never settled releases its count and byte reservation once. Same pattern as the read reclaim grace
 * of OAB-58: it bounds how long stalled cleanup can hold the shared pool.
 */
export const BODY_RESPONSE_RECLAIM_GRACE_MS = 60_000;
let activeBodySlots = 0;
/** Body slots that reached their reclaim deadline with response production unsettled. */
let reclaimedUnsettledBodySlots = 0;
/** Slots whose operation finished while response production continues, keyed by slot id. */
const respondingSlots = new Map<number, RespondingBodySlot>();
let nextBodySlotId = 0;

/** A body slot in its response-production phase. */
interface RespondingBodySlot {
	/** Reclaim deadline: operation end plus deadline plus grace, in Unix milliseconds. */
	reclaimAt: number;
	/** Release the slot count and owned bytes once and count the reclaim. */
	reclaim: () => void;
}

/** Process-local body slot observation for tests and evidence. Not part of the owner measurement contract. */
export interface BodySlotSnapshot {
	/** Body slots still counted against the isolate limit. */
	active_slots: number;
	/** Slots whose operation finished and whose response production has not settled. */
	responding_slots: number;
	/** Slots released by the reclaim deadline with response production still unsettled. */
	reclaimed_unsettled_count: number;
}

/**
 * Reclaim body slots whose response production outlived the deadline plus grace. Needs no timer:
 * body admission, MCP admission, and the snapshot run it first, so it also works when timers stop.
 */
export function sweepExpiredBodySlots(now = Date.now()): void {
	for (const slot of respondingSlots.values())
		if (now >= slot.reclaimAt) slot.reclaim();
}

/** Return the body slot snapshot after the reclaim sweep. */
export function bodySlotSnapshot(): BodySlotSnapshot {
	sweepExpiredBodySlots();
	return {
		active_slots: activeBodySlots,
		responding_slots: respondingSlots.size,
		reclaimed_unsettled_count: reclaimedUnsettledBodySlots,
	};
}

/**
 * Reserve body count and weighted bytes before body demand.
 * Operation cleanup and response production must settle before owned reservations release.
 * The request-processing phase has no deadline here. Once the operation finishes, response
 * production has BODY_RESPONSE_DEADLINE_MS plus BODY_RESPONSE_RECLAIM_GRACE_MS. After that the slot
 * releases its count and owned bytes once, counted as reclaimed unsettled. A later settlement releases
 * nothing a second time.
 * An inherited MCP reservation covers nested bytes. Its envelope owner retains release authority.
 * Admission first sweeps read leases and body slots, so stalled MCP envelopes and stalled mutation
 * responses past their reclaim grace release shared bytes before this request competes for them.
 */
export function tryAcquireBodySlot(
	responseProduction?: Promise<void>,
	byteAllowance = REST_BODY_BYTE_ALLOWANCE,
	inheritedReservation?: AdmissionByteReservation,
): (() => void) | undefined {
	sweepExpiredReadSlots();
	sweepExpiredBodySlots();
	const id = nextBodySlotId++;
	let responseDone = responseProduction === undefined;
	let operationDone = false;
	let released = false;
	let acquired = false;
	let byteReservation = inheritedReservation;
	let ownsByteReservation = false;
	/** Return the count and owned bytes once, by settlement or by reclaim. */
	function releaseCapacity(): void {
		released = true;
		respondingSlots.delete(id);
		activeBodySlots -= 1;
		if (ownsByteReservation) byteReservation?.release();
	}
	/** Return capacity once both owners settle, without double release. */
	function releaseIfDone() {
		if (!acquired || released || !operationDone || !responseDone) return;
		releaseCapacity();
	}
	/** Observe either response outcome without propagating its failure. */
	function responseSettled() {
		responseDone = true;
		releaseIfDone();
	}
	void responseProduction?.then(responseSettled, responseSettled);
	if (activeBodySlots >= BODY_SLOT_LIMIT) return undefined;
	if (!byteReservation) {
		byteReservation = tryReserveAdmissionBytes("rest_body", byteAllowance);
		if (!byteReservation) return undefined;
		ownsByteReservation = true;
	}
	activeBodySlots += 1;
	acquired = true;
	return () => {
		if (operationDone) return;
		operationDone = true;
		releaseIfDone();
		if (released) return;
		respondingSlots.set(id, {
			reclaimAt:
				Date.now() + BODY_RESPONSE_DEADLINE_MS + BODY_RESPONSE_RECLAIM_GRACE_MS,
			reclaim: () => {
				if (released) return;
				releaseCapacity();
				reclaimedUnsettledBodySlots += 1;
			},
		});
	};
}
