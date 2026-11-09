import { tryAcquireReadSlot } from "@worker/application/read-budget";

/** Reserve a fixture-owned REST read whose source ends when the test releases it. */
export function acquireTestReadSlot(): (() => void) | undefined {
	const lease = tryAcquireReadSlot();
	if (!lease) return undefined;
	return () => {
		lease();
		lease.complete();
	};
}
