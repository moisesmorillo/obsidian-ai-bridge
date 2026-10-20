import type {
	AuthorizationContext,
	BlobAuthorizationResult,
	BlobDeclaration,
	BlobMetadata,
	ByteRangeSelection,
	FileFailure,
	IdempotencyKey,
	TextMutationDescriptor,
	TextMutationIntent,
	TextMutationResult,
	TextReadRequest,
} from "@obsidian-ai-bridge/protocol";
import { tryAcquireBodySlot } from "@worker/application/body-budget";
import { FileOperationDenied } from "@worker/application/files";
import type { TextVaultGateway } from "@worker/application/text-files";

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
	/** Bind the full intent and replay a matching receipt under current policy before storage. */
	authorizeBlob(
		context: AuthorizationContext,
		intent: TextMutationIntent,
		admissionId: string,
		key?: IdempotencyKey,
	): Promise<BlobAuthorizationResult>;
	/** Read immutable metadata selected by epoch, path, and optional revision. */
	readBlobMetadata(
		context: AuthorizationContext,
		request: TextReadRequest,
	): Promise<BlobMetadataReadResult>;
}

/** Immutable content access without platform SDK response types. */
export interface BlobContentStore extends BlobStore {
	/** Stream verified immutable bytes, or report missing storage. */
	read(
		hash: string,
		size: number,
		range?: ByteRangeSelection,
	): Promise<ReadableStream<Uint8Array>>;
}

/** Authority calls needed for one declared upload and its receipt lifetime. */
export type BlobPutGateway = Pick<
	TextVaultGateway,
	"beginMutation" | "authorizeBlob" | "commitBlob" | "finishAdmission"
>;

/** Authorize declared bytes before storage and retain capacity until all started work settles. */
export async function executeBlobPut(
	gateway: BlobPutGateway,
	store: BlobStore,
	context: AuthorizationContext,
	descriptor: TextMutationDescriptor,
	key: IdempotencyKey | undefined,
	declaration: BlobDeclaration,
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): Promise<TextMutationResult> {
	const release = tryAcquireBodySlot();
	if (!release)
		return {
			ok: false,
			failure: { kind: "admission_limited", retry_after_seconds: 1 },
		};
	try {
		const reservation = await gateway.beginMutation(context, descriptor, key);
		if (!reservation.ok) return reservation;
		const intent: TextMutationIntent = { ...descriptor, ...declaration };
		let completion: "settled" | "uncertain" = "uncertain";
		try {
			const authorization = await gateway.authorizeBlob(
				context,
				intent,
				reservation.lease.admission_id,
				key,
			);
			if (!authorization.ok) {
				completion = "settled";
				return { ok: false, failure: authorization.failure };
			}
			if ("response" in authorization) {
				completion = "settled";
				return authorization;
			}
			if (signal.aborted) {
				completion = "settled";
				return { ok: false, failure: { kind: "invalid_request" } };
			}
			await store.putVerified(declaration, body, signal);
			if (signal.aborted) {
				// Verified storage is known. No publication call starts after cancellation.
				completion = "settled";
				return { ok: false, failure: { kind: "invalid_request" } };
			}
			const result = await gateway.commitBlob(
				context,
				intent,
				authorization.ticket.id,
				key,
			);
			completion = "settled";
			return result;
		} catch (error) {
			if (error instanceof FileOperationDenied) {
				// Storage failures can follow a successful immutable write with a lost result.
				if (error.failure.kind !== "blob_storage_unavailable")
					completion = "settled";
				return { ok: false, failure: error.failure };
			}
			throw error;
		} finally {
			try {
				await gateway.finishAdmission(
					context,
					reservation.lease.admission_id,
					completion,
				);
			} catch {
				/* Preserve the known result and the original deadline on uncertain cleanup. */
			}
		}
	} finally {
		release();
	}
}

/** Declared size selects blob storage for large text, while other extensions always use blobs. */
export function usesBlobStorage(
	path: string,
	declaration: BlobDeclaration | undefined,
): boolean {
	return !/\.(?:md|canvas)$/.test(path) || (declaration?.size ?? 0) > 1_000_000;
}
