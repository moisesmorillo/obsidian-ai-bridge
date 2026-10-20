/** Maximum body and response lifetimes shared by callers in this isolate. */
const BODY_SLOT_LIMIT = 4;
let activeBodySlots = 0;

/**
 * Reserves capacity without waiting. Operation cleanup and optional response production must both settle before reuse.
 * The returned operation completion callback is idempotent. Supplied rejection is observed immediately, even at capacity.
 */
export function tryAcquireBodySlot(
	responseProduction?: Promise<void>,
): (() => void) | undefined {
	let responseDone = responseProduction === undefined;
	let operationDone = false;
	let released = false;
	let acquired = false;
	/** Return capacity once both owners settle, without double release. */
	function releaseIfDone() {
		if (!acquired || released || !operationDone || !responseDone) return;
		released = true;
		activeBodySlots -= 1;
	}
	/** Observe either response outcome without propagating its failure. */
	function responseSettled() {
		responseDone = true;
		releaseIfDone();
	}
	void responseProduction?.then(responseSettled, responseSettled);
	if (activeBodySlots >= BODY_SLOT_LIMIT) return undefined;
	activeBodySlots += 1;
	acquired = true;
	return () => {
		operationDone = true;
		releaseIfDone();
	};
}
