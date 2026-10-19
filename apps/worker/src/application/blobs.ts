import type {
	AuthorizationContext,
	BlobDeclaration,
	BlobMetadata,
	FileFailure,
	IdempotencyKey,
	TextMutationIntent,
	TextMutationResult,
	TextReadRequest,
} from "@obsidian-ai-bridge/protocol";

/** Storage-independent proof that immutable bytes match their content address. */
export interface BlobEvidence {
	/** SHA-256 digest proven by the storage adapter. */
	hash: string;
	/** Exact immutable byte count. */
	size: number;
}

/** Capabilities for immutable blob publication and verified metadata lookup. */
export interface BlobStore {
	/** Return evidence only when storage exposes a canonical SHA-256 checksum. */
	head(hash: string): Promise<BlobEvidence | undefined>;
	/** Persist request bytes only after body and stored-object verification. */
	putVerified(
		declaration: BlobDeclaration,
		body: ReadableStream<Uint8Array>,
		signal: AbortSignal,
	): Promise<BlobEvidence>;
}

/** Result of an authorized current or retained blob metadata lookup. */
export type BlobMetadataReadResult =
	| { ok: true; body: BlobMetadata }
	| { ok: false; failure: FileFailure };

/** Authority gateway for atomically publishing verified blob references. */
export interface BlobVaultGateway {
	/** Check current policy and ticket state before using external stored bytes. */
	commitBlob(
		context: AuthorizationContext,
		intent: TextMutationIntent,
		ticketId: string,
		key?: IdempotencyKey,
	): Promise<TextMutationResult>;
	/** Read immutable metadata selected by epoch, path, and optional revision. */
	readBlobMetadata(
		context: AuthorizationContext,
		request: TextReadRequest,
	): Promise<BlobMetadataReadResult>;
}
