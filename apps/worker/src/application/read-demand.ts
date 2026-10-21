/** A local demand checkpoint stopped work after abort. No protocol failure is added. */
export class ReadAborted extends Error {
	/** Distinguish a known demand stop from an unknown authority or storage fault. */
	constructor() {
		super("Read demand stopped after abort");
	}
}

/** Stop new read demand after abort without cancelling or releasing already started work. */
export function assertReadDemand(signal?: AbortSignal): void {
	if (signal?.aborted) throw new ReadAborted();
}
