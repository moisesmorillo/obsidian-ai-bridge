import type { DevicePrecondition } from "@obsidian-ai-bridge/protocol";
import {
	ChangesPageSchema,
	DevicePayloadHashSchema,
	FileHttpFailureSchema,
	type ManifestPage,
	ManifestPageSchema,
	MutationSuccessSchema,
	parseETag,
	TextReadResponseSchema,
	type VaultReadResult,
	VaultReadResultSchema,
} from "@obsidian-ai-bridge/protocol";
import type { OAuthTransportResponse } from "@plugin/infrastructure/oauth-transport";
import {
	type CanonicalSyncErrorKind,
	classifyHttpStatus,
	type DeleteResponseDiagnostic,
	type ResponseETagClass,
	SyncTransportError,
	UnsupportedRemoteTextError,
} from "@plugin/sync/remote-text";

export { SyncTransportError } from "@plugin/sync/remote-text";

/** Marks a rejected request at the authenticated transport boundary without its cause. */
export class SyncNetworkError extends Error {
	/** Creates a fixed message so host causes cannot cross the plugin boundary. */
	constructor() {
		super("Sync request failed");
		this.name = "SyncNetworkError";
	}
}

/** Authenticated response capability consumed without exposing the session credential. */
export interface SyncResponseSession {
	/** Sends same-origin requests with session-owned authorization. */
	requestResponse(
		path: string,
		options?: {
			method?: string;
			body?: string | ArrayBuffer;
			headers?: Record<string, string>;
		},
	): Promise<OAuthTransportResponse>;
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

/** Exact blob bytes and the server identity validated by response metadata. */
export interface PinnedBlob {
	/** Raw bytes without text decoding or normalization. */
	bytes: Uint8Array;
	/** SHA-256 identity declared by the validated response. */
	hash: string;
	/** Server-authoritative vault epoch. */
	epoch: string;
	/** Server-authoritative file revision. */
	rev: number;
}

/** Maximum number of bytes accepted for one blob response. */
const MAX_BLOB_RESPONSE_BYTES = 25_000_000;

/** Accepts body bytes within the cap and any present canonical length that matches them. */
function readBlobResponseBytes(
	response: OAuthTransportResponse,
): Uint8Array | null {
	if (!response.arrayBuffer) return null;
	const bytes = new Uint8Array(response.arrayBuffer.slice(0));
	if (bytes.byteLength > MAX_BLOB_RESPONSE_BYTES) return null;
	const size = response.headers["content-length"];
	if (size === undefined) return bytes;
	if (!/^(0|[1-9][0-9]*)$/.test(size)) return null;
	const declaredSize = Number(size);
	if (
		!Number.isSafeInteger(declaredSize) ||
		declaredSize > MAX_BLOB_RESPONSE_BYTES ||
		declaredSize !== bytes.byteLength
	)
		return null;
	return bytes;
}

/** Authenticated protocol adapter for bounded metadata, feed, pinned reads, and create-only enrollment. */
export class SyncTransport {
	private readonly origin: string;

	/** Validates the service origin and binds it to one credential-owning session. */
	constructor(
		serviceOrigin: string,
		private readonly session: SyncResponseSession,
		private readonly onRevoked?: () => void,
		private readonly onDeleteResponseDiagnostic?: (
			diagnostic: DeleteResponseDiagnostic,
		) => void,
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

	/** Reads one exact binary revision and verifies size, hash, epoch, and ETag. */
	async readPinnedBlob(
		path: string,
		epoch: string,
		rev: number,
		expectedHash: string,
	): Promise<PinnedBlob> {
		const response = await this.request(
			`/v1/files/${encodePath(path)}?${new URLSearchParams({ rev: String(rev) })}`,
			{ headers: { "x-vault-epoch": epoch } },
		);
		const etag = response.headers.etag;
		const identity = etag ? parseETag(etag) : null;
		const hash = DevicePayloadHashSchema.parse(expectedHash);
		const bytes = readBlobResponseBytes(response);
		if (
			response.headers["content-type"]
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase() !== "application/octet-stream" ||
			!identity ||
			identity.epoch !== epoch ||
			identity.rev !== rev ||
			!bytes ||
			(await hashBytes(bytes)) !== hash
		)
			throw new Error("Pinned blob response metadata is invalid");
		return { bytes, hash, epoch, rev };
	}

	/** Implements the apply port for exact, digest-checked blob reads. */
	async readBlob(path: string, epoch: string, rev: number, hash: string) {
		return this.readPinnedBlob(path, epoch, rev, hash);
	}

	/** Resolves exact pinned content or newer current authority after pruning. */
	async readResolvedBlob(
		path: string,
		epoch: string,
		rev: number,
		expectedHash: string,
	): Promise<
		| {
				kind: "blob";
				bytes: Uint8Array;
				hash: string;
				epoch: string;
				rev: number;
		  }
		| { kind: "text"; text: string; hash: string; epoch: string; rev: number }
		| { kind: "deleted"; text: null; hash: ""; epoch: string; rev: number }
	> {
		let pinned: OAuthTransportResponse | null = null;
		try {
			const query = new URLSearchParams({ rev: String(rev) });
			pinned = await this.request(`/v1/files/${encodePath(path)}?${query}`, {
				headers: { "x-vault-epoch": epoch },
			});
		} catch (error) {
			if (
				!(error instanceof SyncTransportError) ||
				error.code !== "revision_pruned"
			)
				throw error;
		}
		if (pinned) {
			const pinnedETag = pinned.headers.etag;
			const pinnedIdentity = pinnedETag ? parseETag(pinnedETag) : null;
			const pinnedType = pinned.headers["content-type"]
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase();
			if (
				!pinnedIdentity ||
				pinnedIdentity.epoch !== epoch ||
				pinnedIdentity.rev !== rev
			)
				throw new Error("Pinned content identity is invalid");
			if (pinnedType === "application/octet-stream") {
				const bytes = readBlobResponseBytes(pinned);
				const hash = DevicePayloadHashSchema.parse(expectedHash);
				if (!bytes || (await hashBytes(bytes)) !== hash)
					throw new Error("Pinned blob response metadata is invalid");
				return { kind: "blob", bytes, hash, epoch, rev };
			}
			const body = TextReadResponseSchema.parse(parseJson(pinned.text));
			if (
				body.path !== path ||
				body.etag !== pinnedETag ||
				body.offset !== 0 ||
				body.truncated
			)
				throw new Error("Pinned text response metadata is invalid");
			if (body.deleted) {
				if (body.content !== null || body.length !== 0 || body.hash !== "")
					throw new Error("Pinned text tombstone metadata is invalid");
				return { kind: "deleted", text: null, hash: "", epoch, rev };
			}
			if (
				body.content === null ||
				body.length !== body.content.length ||
				body.size !== new TextEncoder().encode(body.content).byteLength ||
				(await hashText(body.content)) !== body.hash ||
				body.hash !== expectedHash
			)
				throw new Error("Pinned text response metadata is invalid");
			return { kind: "text", text: body.content, hash: body.hash, epoch, rev };
		}
		const response = await this.request(`/v1/files/${encodePath(path)}`);
		const responseEpoch = response.headers["x-vault-epoch"];
		const etag = response.headers.etag;
		const identity = etag ? parseETag(etag) : null;
		if (
			(responseEpoch !== undefined && responseEpoch !== epoch) ||
			!identity ||
			identity.epoch !== epoch
		)
			throw new Error("Current blob fallback identity is invalid");
		/** Rejects fallback authority older than the requested revision or divergent at equal revision. */
		const assertFallbackRevision = (currentRev: number, hash: string) => {
			if (currentRev < rev || (currentRev === rev && hash !== expectedHash))
				throw new Error(
					"Current blob fallback revision is not newer authority",
				);
		};
		const contentType = response.headers["content-type"]
			?.split(";", 1)[0]
			?.trim()
			.toLowerCase();
		if (contentType === "application/octet-stream") {
			const bytes = readBlobResponseBytes(response);
			if (!bytes) throw new Error("Current blob fallback size is invalid");
			const hash = await hashBytes(bytes);
			assertFallbackRevision(identity.rev, hash);
			return {
				kind: "blob",
				bytes,
				hash,
				epoch,
				rev: identity.rev,
			};
		}
		const body = TextReadResponseSchema.parse(parseJson(response.text));
		if (
			body.path !== path ||
			body.etag !== etag ||
			body.offset !== 0 ||
			body.truncated
		)
			throw new Error("Current blob fallback text metadata is invalid");
		if (body.deleted) {
			if (
				body.content !== null ||
				body.length !== 0 ||
				body.hash !== "" ||
				body.size !== 0
			)
				throw new Error("Current blob fallback tombstone is invalid");
			assertFallbackRevision(identity.rev, "");
			return {
				kind: "deleted",
				text: null,
				hash: "",
				epoch,
				rev: identity.rev,
			};
		}
		if (
			body.content === null ||
			body.length !== body.content.length ||
			body.size !== new TextEncoder().encode(body.content).byteLength ||
			(await hashText(body.content)) !== body.hash
		)
			throw new Error("Current blob fallback text metadata is invalid");
		assertFallbackRevision(identity.rev, body.hash);
		return {
			kind: "text",
			text: body.content,
			hash: body.hash,
			epoch,
			rev: identity.rev,
		};
	}

	/** Resolves pinned binary authority and current text or blob fallback for restore. */
	async readBlobAuthority(
		path: string,
		epoch: string,
		rev: number,
		hash: string,
	) {
		return this.readResolvedBlob(path, epoch, rev, hash);
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
		if (
			response.headers["content-type"]
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase() === "application/octet-stream"
		)
			throw new UnsupportedRemoteTextError(path);
		const etag = response.headers.etag;
		if (!etag) throw new Error("Pinned text metadata is invalid");
		const body = TextReadResponseSchema.parse(parseJson(response.text));
		const identity = parseETag(etag);
		const bodyIdentity = parseETag(body.etag);
		if (
			body.path !== path ||
			body.etag !== etag ||
			bodyIdentity.epoch !== epoch ||
			bodyIdentity.rev !== rev ||
			identity.epoch !== epoch ||
			identity.rev !== rev ||
			body.deleted ||
			body.content === null ||
			body.offset !== 0 ||
			body.truncated ||
			body.length !== body.content.length
		)
			throw new Error("Pinned text revision does not match its request");
		return { text: body.content, epoch, rev };
	}

	/** Reads pinned text or returns validated current live text or tombstone after pruning. */
	async readResolved(
		path: string,
		epoch: string,
		rev: number,
	): Promise<
		| { deleted: false; text: string; epoch: string; rev: number; hash: string }
		| { deleted: true; text: null; epoch: string; rev: number; hash: "" }
	> {
		try {
			const pinned = await this.readPinned(path, epoch, rev);
			return { ...pinned, deleted: false, hash: await hashText(pinned.text) };
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
		if (current.deleted)
			return {
				deleted: true,
				text: null,
				epoch: current.epoch,
				rev: identity.rev,
				hash: "",
			};
		return {
			deleted: false,
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

	/** Returns authoritative pinned or current text metadata for publication recovery. */
	async readAuthority(path: string, epoch: string, rev: number) {
		return this.readResolved(path, epoch, rev);
	}

	/** Hashes the current path response and returns its server-owned tombstone revision. */
	async readCurrentAuthority(path: string) {
		const current = await this.readCurrent(path);
		const identity = parseETag(current.etag);
		return current.deleted
			? {
					deleted: true as const,
					text: null,
					epoch: current.epoch,
					rev: identity.rev,
					hash: "" as const,
				}
			: {
					deleted: false as const,
					text: current.text,
					epoch: current.epoch,
					rev: identity.rev,
					hash: await hashText(current.text),
				};
	}

	/** Reads current exact blob bytes and validates their identity and size. */
	async readCurrentBlobAuthority(path: string) {
		const response = await this.request(`/v1/files/${encodePath(path)}`);
		if (
			response.headers["content-type"]
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase() !== "application/octet-stream"
		)
			throw new UnsupportedRemoteTextError(path);
		const etag = response.headers.etag;
		const identity = etag ? parseETag(etag) : null;
		const bytes = readBlobResponseBytes(response);
		if (!identity || !bytes)
			throw new Error("Current blob authority metadata is invalid");
		const hash = await hashBytes(bytes);
		return {
			kind: "blob" as const,
			bytes,
			epoch: identity.epoch,
			rev: identity.rev,
			hash,
		};
	}

	/** Reads current live text or tombstone with its validated epoch and revision. */
	async readCurrent(
		path: string,
	): Promise<
		| { deleted: false; text: string; etag: string; epoch: string }
		| { deleted: true; text: null; etag: string; epoch: string }
	> {
		const response = await this.request(`/v1/files/${encodePath(path)}`);
		if (
			response.headers["content-type"]
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase() === "application/octet-stream"
		)
			throw new UnsupportedRemoteTextError(path);
		const etag = response.headers.etag;
		if (!etag) throw new Error("Current text metadata is invalid");
		const body = TextReadResponseSchema.parse(parseJson(response.text));
		const identity = parseETag(etag);
		if (
			body.path !== path ||
			body.etag !== etag ||
			body.offset !== 0 ||
			body.truncated ||
			(body.deleted
				? body.content !== null || body.length !== 0
				: body.content === null || body.length !== body.content.length)
		)
			throw new Error("Current text metadata is invalid");
		if (body.deleted) {
			if (body.hash !== "" || body.size !== 0)
				throw new Error("Current text metadata is invalid");
			return { deleted: true, text: null, etag, epoch: identity.epoch };
		}
		if (
			body.content === null ||
			body.size !== new TextEncoder().encode(body.content).byteLength ||
			(await hashText(body.content)) !== body.hash
		)
			throw new Error("Current text metadata is invalid");
		return { deleted: false, text: body.content, etag, epoch: identity.epoch };
	}

	/** Publishes exact immutable bytes with the Worker blob integrity declarations. */
	async putBlob(
		path: string,
		bytes: Uint8Array,
		hash: string,
		precondition: DevicePrecondition,
		key: string,
		epoch: string,
	) {
		if (
			bytes.byteLength > 25_000_000 ||
			!DevicePayloadHashSchema.safeParse(hash).success ||
			(await hashBytes(bytes)) !== hash
		)
			throw new Error("Blob payload identity is invalid");
		const headers = mutationHeaders(precondition, key, epoch);
		headers["x-content-sha256"] = hash;
		headers["x-content-size"] = String(bytes.byteLength);
		return this.readMutation(
			await this.request(`/v1/files/${encodePath(path)}`, {
				method: "PUT",
				body: bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				) as ArrayBuffer,
				headers,
			}),
		);
	}

	/** Publishes one immutable text file under its exact create or revision precondition. */
	async put(
		path: string,
		text: string,
		precondition: DevicePrecondition,
		key: string,
		epoch: string,
	) {
		const headers = mutationHeaders(precondition, key, epoch);
		return this.readMutation(
			await this.request(`/v1/files/${encodePath(path)}`, {
				method: "PUT",
				body: text,
				headers,
			}),
		);
	}

	/** Publishes one event-authorized delete under its exact observed source revision. */
	async delete(path: string, precondition: DevicePrecondition, key: string) {
		if (precondition.kind !== "match")
			throw new Error("Delete needs an observed source revision");
		let response: OAuthTransportResponse;
		try {
			response = await this.request(`/v1/files/${encodePath(path)}`, {
				method: "DELETE",
				headers: {
					"if-match": `"${precondition.epoch}.${precondition.rev}"`,
					"x-vault-epoch": precondition.epoch,
					"idempotency-key": key,
				},
			});
		} catch (error) {
			this.onDeleteResponseDiagnostic?.(
				error instanceof SyncTransportError
					? {
							statusClass: error.statusClass,
							errorKind: error.code,
							responseETagClass: error.responseETagClass,
						}
					: {
							statusClass: null,
							errorKind: null,
							responseETagClass: "unavailable",
						},
			);
			throw error;
		}
		this.onDeleteResponseDiagnostic?.({
			statusClass: classifyHttpStatus(response.status),
			errorKind: null,
			responseETagClass: classifyResponseETag(response.headers.etag),
		});
		return this.readMutation(response);
	}

	/** Publishes one event-authorized rename under its exact observed source revision. */
	async rename(
		path: string,
		to: string,
		precondition: DevicePrecondition,
		key: string,
	) {
		if (precondition.kind !== "match")
			throw new Error("Rename needs an observed source revision");
		return this.readMutation(
			await this.request(`/v1/files/${encodePath(path)}:rename`, {
				method: "POST",
				body: JSON.stringify({ to }),
				headers: {
					"if-match": `"${precondition.epoch}.${precondition.rev}"`,
					"x-vault-epoch": precondition.epoch,
					"idempotency-key": key,
					"content-type": "application/json",
				},
			}),
		);
	}

	/** Parses mutation body and header into one validated receipt authority. */
	private readMutation(response: OAuthTransportResponse) {
		const receipt = MutationSuccessSchema.parse(parseJson(response.text));
		const header = response.headers.etag;
		if (
			(response.status !== 200 && response.status !== 201) ||
			!header ||
			header !== receipt.etag
		)
			throw new Error("Mutation response ETag is invalid");
		return {
			status: response.status,
			path: receipt.path,
			etag: receipt.etag,
			seq: receipt.seq,
			size: receipt.size,
			hash: receipt.hash,
			deleted: receipt.deleted,
		};
	}

	/** Publishes exact bytes only when the remote path remains absent. */
	async createBlob(
		path: string,
		bytes: Uint8Array,
		hash: string,
		epoch: string,
		key: string,
	): Promise<ReturnType<SyncTransport["readMutation"]>> {
		if (
			bytes.byteLength > 25_000_000 ||
			!DevicePayloadHashSchema.safeParse(hash).success ||
			(await hashBytes(bytes)) !== hash
		)
			throw new Error("Blob payload identity is invalid");
		return this.readMutation(
			await this.request(`/v1/files/${encodePath(path)}`, {
				method: "PUT",
				body: bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				) as ArrayBuffer,
				headers: {
					"if-none-match": "*",
					"x-vault-epoch": epoch,
					"idempotency-key": key,
					"x-content-sha256": hash,
					"x-content-size": String(bytes.byteLength),
				},
			}),
		);
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
			body?: string | ArrayBuffer;
			headers?: Record<string, string>;
		} = {},
	): Promise<OAuthTransportResponse> {
		let response: OAuthTransportResponse;
		try {
			response = await this.session.requestResponse(
				`${this.origin}${path}`,
				options,
			);
		} catch {
			throw new SyncNetworkError();
		}
		if (response.status < 200 || response.status >= 300) {
			let code: CanonicalSyncErrorKind | null = null;
			let existingPath: string | null = null;
			let retryAfter: string | null = null;
			try {
				const body = parseJson(response.text);
				const retryHeader = response.headers["retry-after"];
				const failure = FileHttpFailureSchema.parse({
					status: response.status,
					body,
					...(retryHeader === undefined
						? {}
						: { headers: { "Retry-After": retryHeader } }),
				});
				code = failure.body.error;
				existingPath = failure.body.existing_path ?? null;
				retryAfter = failure.headers?.["Retry-After"] ?? null;
			} catch {
				code = null;
			}
			if (response.status === 401 && code === "revoked") this.onRevoked?.();
			throw new SyncTransportError(
				response.status,
				code,
				existingPath,
				retryAfter,
				classifyResponseETag(response.headers.etag),
			);
		}
		return response;
	}
}

/** Classifies one response ETag without retaining or exposing its value. */
function classifyResponseETag(value: string | undefined): ResponseETagClass {
	if (value === undefined) return "missing";
	if (value.startsWith("W/")) return "weak";
	try {
		parseETag(value);
		return "strong";
	} catch {
		return "invalid";
	}
}

/** Binds each mutation to its exact observed precondition and current vault epoch. */
function mutationHeaders(
	precondition: DevicePrecondition,
	key: string,
	epoch: string,
): Record<string, string> {
	return precondition.kind === "absent"
		? {
				"if-none-match": "*",
				"x-vault-epoch": epoch,
				"idempotency-key": key,
			}
		: {
				"if-match": `"${precondition.epoch}.${precondition.rev}"`,
				"x-vault-epoch": precondition.epoch,
				"idempotency-key": key,
			};
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
	return hashBytes(new TextEncoder().encode(text));
}

/** Hashes an exact byte sequence without text decoding or normalization. */
async function hashBytes(bytes: Uint8Array): Promise<string> {
	const copy = bytes.slice();
	const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
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
