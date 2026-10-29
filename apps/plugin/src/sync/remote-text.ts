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
