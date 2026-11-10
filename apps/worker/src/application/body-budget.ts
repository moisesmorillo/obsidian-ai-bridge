import {
	type AdmissionByteReservation,
	REST_BODY_BYTE_ALLOWANCE,
	tryReserveAdmissionBytes,
} from "@worker/application/admission-budget";
import { sweepExpiredReadSlots } from "@worker/application/read-budget";

/** Maximum concurrent body-bearing operations in one Worker isolate. */
const BODY_SLOT_LIMIT = 8;
let activeBodySlots = 0;

/**
 * Reserve body count and weighted bytes before body demand.
 * Operation cleanup and response production must settle before owned reservations release.
 * An inherited MCP reservation covers nested bytes. Its envelope owner retains release authority.
 * Admission first sweeps read leases, so stalled MCP envelopes past their reclaim grace release
 * shared bytes before this request competes for them.
 */
export function tryAcquireBodySlot(
	responseProduction?: Promise<void>,
	byteAllowance = REST_BODY_BYTE_ALLOWANCE,
	inheritedReservation?: AdmissionByteReservation,
): (() => void) | undefined {
	sweepExpiredReadSlots();
	let responseDone = responseProduction === undefined;
	let operationDone = false;
	let released = false;
	let acquired = false;
	let byteReservation = inheritedReservation;
	let ownsByteReservation = false;
	/** Return capacity once both owners settle, without double release. */
	function releaseIfDone() {
		if (!acquired || released || !operationDone || !responseDone) return;
		released = true;
		activeBodySlots -= 1;
		if (ownsByteReservation) byteReservation?.release();
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
		operationDone = true;
		releaseIfDone();
	};
}
