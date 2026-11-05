/** Signals that a new effect lost admission to an unresolved owner decision. */
export class CoexistenceEffectBlockedError extends Error {
	/** Identifies a fence rejection without exposing host or operation data. */
	constructor() {
		super("Coexistence effect admission is blocked");
		this.name = "CoexistenceEffectBlockedError";
	}
}

/** Prevents new publication and apply effects while owner intent is unresolved. */
export class CoexistenceEffectFence {
	/** Counts captures that have not yet reported a durable outcome. */
	private activeCaptures = 0;
	/** Keeps admission closed after capture persistence fails during this lifetime. */
	private failedCapture = false;

	/** Reads canonical pending confirmation state after journal transitions. */
	constructor(private readonly hasPendingConfirmations: () => boolean) {}

	/** Reports whether a capture, failed capture, or durable confirmation blocks effects. */
	isBlocked(): boolean {
		return (
			this.failedCapture ||
			this.activeCaptures > 0 ||
			this.hasPendingConfirmations()
		);
	}

	/** Closes admission before capture awaits. A failed durable capture keeps the gate closed. */
	beginCapture(): (persisted: boolean) => void {
		this.activeCaptures += 1;
		let released = false;
		return (persisted) => {
			if (released) return;
			released = true;
			this.activeCaptures -= 1;
			if (!persisted) this.failedCapture = true;
		};
	}
}
