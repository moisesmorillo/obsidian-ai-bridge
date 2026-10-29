import {
	ChangesPageSchema,
	DevicePayloadHashSchema,
	FileHttpFailureSchema,
	type ManifestPage,
	ManifestPageSchema,
	parseETag,
	type VaultReadResult,
	VaultReadResultSchema,
} from "@obsidian-ai-bridge/protocol";
import type { OAuthTransportResponse } from "@plugin/infrastructure/oauth-transport";

/** Authenticated response capability consumed without exposing the session credential. */
export interface SyncResponseSession {
	/** Sends same-origin requests with session-owned authorization. */
	requestResponse(
		path: string,
		options?: {
			method?: string;
			body?: string;
			headers?: Record<string, string>;
		},
	): Promise<OAuthTransportResponse>;
}

/** Safe protocol error retaining only validated HTTP status and error code. */
export class SyncTransportError extends Error {
	/** The HTTP status received from the service. */
	readonly status: number;
	/** Validated protocol error code, when the body matches the canonical shape. */
	readonly code: string | null;

	/** Creates a safe diagnostic without retaining response text or headers. */
	constructor(status: number, code: string | null) {
		super("Sync request failed");
		this.name = "SyncTransportError";
		this.status = status;
		this.code = code;
	}
}

/** Exact pinned text and the validated authority identity returned by its response. */
export interface PinnedText {
	/** Exact UTF-8-decoded response text, including BOM and line endings. */
	text: string;
	/** Epoch that authorizes the returned revision. */
	epoch: string;
	/** Numeric revision parsed from the canonical ETag. */
	rev: number;
}

/** Authenticated protocol adapter for bounded metadata, feed, pinned reads, and create-only enrollment. */
export class SyncTransport {
	private readonly origin: string;

	/** Validates the service origin and binds it to one credential-owning session. */
	constructor(
		serviceOrigin: string,
		private readonly session: SyncResponseSession,
	) {
		const url = new URL(serviceOrigin);
		if (url.protocol !== "https:" || url.origin !== serviceOrigin)
			throw new Error("Service URL must be a canonical HTTPS origin");
		this.origin = url.origin;
	}

	/** Reads and validates the vault epoch and captured head. */
	async vault(): Promise<VaultReadResult> {
		const response = await this.request("/v1/vault");
		return VaultReadResultSchema.parse(parseJson(response.text));
	}

	/** Reads one manifest page without changing its captured epoch or head. */
	async manifest(pageToken: string | null): Promise<ManifestPage> {
		const query =
			pageToken === null ? "" : `?page=${encodeURIComponent(pageToken)}`;
		const response = await this.request(`/v1/manifest${query}`);
		return ManifestPageSchema.parse(parseJson(response.text));
	}

	/** Reads one epoch-bound feed page from the first unapplied sequence. */
	async changes(
		epoch: string,
		since: number,
	): Promise<ReturnType<typeof ChangesPageSchema.parse>> {
		const query = new URLSearchParams({ epoch, since: String(since) });
		const response = await this.request(`/v1/changes?${query}`);
		return ChangesPageSchema.parse(parseJson(response.text));
	}

	/** Reads one exact historical revision and validates its response epoch and ETag. */
	async readPinned(
		path: string,
		epoch: string,
		rev: number,
	): Promise<PinnedText> {
		const encodedPath = encodePath(path);
		const query = new URLSearchParams({ rev: String(rev) });
		const response = await this.request(`/v1/files/${encodedPath}?${query}`, {
			headers: { "x-vault-epoch": epoch },
		});
		const etag = response.headers.etag;
		const responseEpoch = response.headers["x-vault-epoch"];
		if (!etag || responseEpoch !== epoch)
			throw new Error("Pinned text metadata is invalid");
		const identity = parseETag(etag);
		if (identity.epoch !== epoch || identity.rev !== rev)
			throw new Error("Pinned text revision does not match its request");
		return { text: response.text, epoch, rev };
	}

	/** Reads pinned text or replaces a pruned row with validated current revision metadata. */
	async readResolved(
		path: string,
		epoch: string,
		rev: number,
	): Promise<{ text: string; epoch: string; rev: number; hash: string }> {
		try {
			const pinned = await this.readPinned(path, epoch, rev);
			return { ...pinned, hash: await hashText(pinned.text) };
		} catch (error) {
			if (
				!(error instanceof SyncTransportError) ||
				error.code !== "revision_pruned"
			)
				throw error;
		}
		const current = await this.readCurrent(path);
		if (current.epoch !== epoch)
			throw new Error("Current fallback changed the vault epoch");
		const identity = parseETag(current.etag);
		return {
			text: current.text,
			epoch: current.epoch,
			rev: identity.rev,
			hash: await hashText(current.text),
		};
	}

	/** Implements the text apply port while keeping revision fallback identity available. */
	async read(path: string, epoch: string, rev: number): Promise<string | null> {
		return (await this.readPinned(path, epoch, rev)).text;
	}

	/** Reads current remote metadata and exact text after a pinned revision was pruned. */
	async readCurrent(
		path: string,
	): Promise<{ text: string; etag: string; epoch: string }> {
		const response = await this.request(`/v1/files/${encodePath(path)}`);
		const etag = response.headers.etag;
		const epoch = response.headers["x-vault-epoch"];
		if (!etag || !epoch || parseETag(etag).epoch !== epoch)
			throw new Error("Current text metadata is invalid");
		return { text: response.text, etag, epoch };
	}

	/** Publishes one immutable local text file only when the remote path remains absent. */
	async createText(
		path: string,
		text: string,
		epoch: string,
		key: string,
	): Promise<OAuthTransportResponse> {
		return this.request(`/v1/files/${encodePath(path)}`, {
			method: "PUT",
			body: text,
			headers: {
				"if-none-match": "*",
				"x-vault-epoch": epoch,
				"idempotency-key": key,
			},
		});
	}

	/** Sends one path under the validated service origin and classifies failures safely. */
	private async request(
		path: string,
		options: {
			method?: string;
			body?: string;
			headers?: Record<string, string>;
		} = {},
	): Promise<OAuthTransportResponse> {
		const response = await this.session.requestResponse(
			`${this.origin}${path}`,
			options,
		);
		if (response.status < 200 || response.status >= 300) {
			let code: string | null = null;
			try {
				const body = parseJson(response.text);
				const failure = FileHttpFailureSchema.parse({
					status: response.status,
					body,
				});
				code = failure.body.error;
			} catch {
				code = null;
			}
			throw new SyncTransportError(response.status, code);
		}
		return response;
	}
}

/** Encodes each canonical path component without changing its slash boundaries. */
function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

/** JSON-compatible values accepted before a canonical protocol schema validates metadata. */
type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

/** Hashes exact UTF-8 response text for pinned identity verification. */
async function hashText(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return DevicePayloadHashSchema.parse(
		[...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join(""),
	);
}

/** Parses metadata JSON without copying parse errors or untrusted content into errors. */
function parseJson(text: string): JsonValue {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		throw new Error("Sync response is not valid JSON");
	}
}
