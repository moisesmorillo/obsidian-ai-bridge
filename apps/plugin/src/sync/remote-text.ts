import type { FileHttpFailure } from "@obsidian-ai-bridge/protocol";

/** HTTP response class retained without its exact status number. */
export type HttpStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "other";

/** Response ETag classification that does not retain its value. */
export type ResponseETagClass =
	| "strong"
	| "weak"
	| "missing"
	| "invalid"
	| "unavailable";

/** Error code derived from the canonical HTTP failure schema. */
export type CanonicalSyncErrorKind = FileHttpFailure["body"]["error"];

/** Safe DELETE response metadata without operation or response identity. */
export interface DeleteResponseDiagnostic {
	/** HTTP class, or null when no HTTP response metadata exists. */
	statusClass: HttpStatusClass | null;
	/** Canonical failure kind, or null when the response has no failure body. */
	errorKind: CanonicalSyncErrorKind | null;
	/** Strong, weak, absent, invalid, or unavailable response ETag class. */
	responseETagClass: ResponseETagClass;
}

/** Safe HTTP failure metadata passed from transport to reconciliation policy. */
export class SyncTransportError extends Error {
	/** HTTP response status received by the transport for existing policy checks. */
	readonly status: number;
	/** HTTP class retained for safe diagnostics without its numeric value. */
	readonly statusClass: HttpStatusClass;
	/** Validated protocol error code, when the response body is canonical. */
	readonly code: CanonicalSyncErrorKind | null;
	/** Response ETag class without its raw value. */
	readonly responseETagClass: ResponseETagClass;
	/** Existing canonical path reported by a path collision, when present. */
	readonly existingPath: string | null;
	/** Validated retry delay in seconds, when the failure supports it. */
	readonly retryAfter: string | null;
	/** Stores status class and validated fields without retaining response bodies. */
	constructor(
		status: number,
		code: CanonicalSyncErrorKind | null,
		existingPath: string | null = null,
		retryAfter: string | null = null,
		responseETagClass: ResponseETagClass = "unavailable",
	) {
		super("Sync request failed");
		this.name = "SyncTransportError";
		this.status = status;
		this.statusClass = classifyHttpStatus(status);
		this.code = code;
		this.responseETagClass = responseETagClass;
		this.existingPath = existingPath;
		this.retryAfter = retryAfter;
	}
}

/** Maps one numeric HTTP status to a fixed class without retaining the number. */
export function classifyHttpStatus(status: number): HttpStatusClass {
	if (!Number.isInteger(status) || status < 100 || status >= 600)
		return "other";
	return `${Math.floor(status / 100)}xx` as HttpStatusClass;
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
