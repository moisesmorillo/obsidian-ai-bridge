/** Maximum concurrent authoritative read responses in one Worker isolate. */
const READ_SLOT_LIMIT = 4;
let activeReadSlots = 0;

/** Reserve a read slot without queueing and release it once its owner settles. */
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
