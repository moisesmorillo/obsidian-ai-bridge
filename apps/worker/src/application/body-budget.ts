/** Maximum active body-bearing operations shared by callers in this isolate. */
const BODY_SLOT_LIMIT = 4;
let activeBodySlots = 0;

/** Reserves one shared body-work slot without waiting, or returns undefined at capacity. */
export function tryAcquireBodySlot(): (() => void) | undefined {
	if (activeBodySlots >= BODY_SLOT_LIMIT) return undefined;
	activeBodySlots += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeBodySlots -= 1;
	};
}
