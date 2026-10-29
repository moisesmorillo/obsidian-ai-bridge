/** Safe HTTP failure metadata passed from transport to reconciliation policy. */
export class SyncTransportError extends Error {
	/** HTTP response status received by the transport. */
	readonly status: number;
	/** Validated protocol error code, when the response body is canonical. */
	readonly code: string | null;
	/** Existing canonical path reported by a path collision, when present. */
	readonly existingPath: string | null;
	/** Validated retry delay in seconds, when the failure supports it. */
	readonly retryAfter: string | null;

	/** Stores status and validated optional fields without retaining response bodies. */
	constructor(
		status: number,
		code: string | null,
		existingPath: string | null = null,
		retryAfter: string | null = null,
	) {
		super("Sync request failed");
		this.name = "SyncTransportError";
		this.status = status;
		this.code = code;
		this.existingPath = existingPath;
		this.retryAfter = retryAfter;
	}
}

/** Signals that an authoritative file response contains blob bytes, not inline text. */
export class UnsupportedRemoteTextError extends Error {
	/** The exact path whose remote revision is not inline text. */
	readonly path: string;

	/** Creates a path-only failure without retaining remote response bytes. */
	constructor(path: string) {
		super("Remote file is not inline text");
		this.name = "UnsupportedRemoteTextError";
		this.path = path;
	}
}
