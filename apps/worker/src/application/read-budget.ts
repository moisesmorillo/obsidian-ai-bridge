/** Maximum concurrent authoritative read responses in one Worker isolate. */
const READ_SLOT_LIMIT = 4;
let activeReadSlots = 0;

/** Reserve one isolate read slot without queueing, then release it after started source work and cancellation settle. */
export function tryAcquireReadSlot(): (() => void) | undefined {
	if (activeReadSlots >= READ_SLOT_LIMIT) return undefined;
	activeReadSlots += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeReadSlots -= 1;
	};
}
