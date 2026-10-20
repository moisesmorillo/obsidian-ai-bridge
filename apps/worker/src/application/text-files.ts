import type {
	AdmissionCompletion,
	AdmissionFinishResult,
	AdmissionResult,
	AuthorizationContext,
	BlobDeclaration,
	CurrentEpochOperation,
	CurrentEpochResult,
	IdempotencyKey,
	OperationDescriptor,
	OperationIntent,
	TextMutationBeginResult,
	TextMutationDescriptor,
	TextMutationIntent,
	TextMutationResult,
	TextPayload,
	TextReadRequest,
	TextReadResult,
} from "@obsidian-ai-bridge/protocol";
import { EMPTY_PAYLOAD_HASH } from "@obsidian-ai-bridge/protocol";
import type { BlobVaultGateway } from "@worker/application/blobs";
import { tryAcquireBodySlot } from "@worker/application/body-budget";
import { FileOperationDenied } from "@worker/application/files";

/** Promise-based boundary to the Durable Object text authority. */
export interface TextVaultGateway extends BlobVaultGateway {
	/** Return authoritative epoch metadata after revocation and scope checks without an admission. */
	getCurrentEpoch(
		context: AuthorizationContext,
		operation: CurrentEpochOperation,
	): Promise<CurrentEpochResult>;
	/** Reserve durable ownership before the Worker reads request bytes. */
	beginMutation(
		context: AuthorizationContext,
		descriptor: OperationDescriptor,
		key?: IdempotencyKey,
	): Promise<TextMutationBeginResult>;
	/** Bind the observed body identity to the reservation and recheck current policy. */
	authorize(
		context: AuthorizationContext,
		intent: OperationIntent,
		admissionId?: string,
	): Promise<AdmissionResult>;
	/** Commit the authorized bytes or return a canonical domain failure. */
	commitText(
		context: AuthorizationContext,
		intent: TextMutationIntent,
		ticketId: string,
		content: string | undefined,
		key?: IdempotencyKey,
	): Promise<TextMutationResult>;
	/** Settle known work or retain uncertain work until its original deadline. */
	finishAdmission(
		context: AuthorizationContext,
		ticketId: string,
		completion: AdmissionCompletion,
	): Promise<AdmissionFinishResult>;
	/** Read current or selected history after the authority checks read scope and epoch. */
	readText(
		context: AuthorizationContext,
		request: TextReadRequest,
	): Promise<TextReadResult>;
}

/** Reserve capacity before reading bytes, then authorize and publish one conditional mutation. */
export async function executeTextMutation(
	gateway: TextVaultGateway,
	context: AuthorizationContext,
	descriptor: TextMutationDescriptor,
	key: IdempotencyKey | undefined,
	readPayload: () => Promise<TextPayload>,
	declaration?: BlobDeclaration,
): Promise<TextMutationResult> {
	if (descriptor.op === "put") {
		const release = tryAcquireBodySlot();
		if (release === undefined)
			return {
				ok: false,
				failure: { kind: "admission_limited", retry_after_seconds: 1 },
			};
		try {
			return await executeTextMutationWithSlot(
				gateway,
				context,
				descriptor,
				key,
				readPayload,
				declaration,
			);
		} finally {
			release();
		}
	}
	return executeTextMutationWithSlot(
		gateway,
		context,
		descriptor,
		key,
		readPayload,
		declaration,
	);
}

/** Run the complete reservation and body lifetime after the caller acquires capacity. */
async function executeTextMutationWithSlot(
	gateway: TextVaultGateway,
	context: AuthorizationContext,
	descriptor: TextMutationDescriptor,
	key: IdempotencyKey | undefined,
	readPayload: () => Promise<TextPayload>,
	declaration?: BlobDeclaration,
): Promise<TextMutationResult> {
	const reservation = await gateway.beginMutation(context, descriptor, key);
	if (!reservation.ok) return reservation;
	let payload: TextPayload | undefined;
	try {
		payload =
			descriptor.op === "delete"
				? { content: "", payload_hash: EMPTY_PAYLOAD_HASH, size: 0 }
				: await readPayload();
		if (
			declaration !== undefined &&
			(payload.payload_hash !== declaration.payload_hash ||
				payload.size !== declaration.size)
		)
			throw new FileOperationDenied({ kind: "blob_integrity_mismatch" });
	} catch (error) {
		try {
			await gateway.finishAdmission(
				context,
				reservation.lease.admission_id,
				"settled",
			);
		} catch {
			// Keep the client-facing body failure even if settlement is unknown.
		}
		return {
			ok: false,
			failure:
				error instanceof FileOperationDenied
					? declaration !== undefined && error.failure.kind === "text_too_large"
						? { kind: "blob_integrity_mismatch" }
						: error.failure
					: { kind: "invalid_request" },
		};
	}
	const intent: TextMutationIntent = {
		...descriptor,
		payload_hash: payload.payload_hash,
		size: payload.size,
	};
	let authorized: AdmissionResult;
	try {
		authorized = await gateway.authorize(
			context,
			intent,
			reservation.lease.admission_id,
		);
	} catch (error) {
		try {
			await gateway.finishAdmission(
				context,
				reservation.lease.admission_id,
				"uncertain",
			);
		} catch {
			// Preserve the original RPC failure and the original admission deadline.
		}
		throw error;
	}
	if (!authorized.ok) {
		try {
			await gateway.finishAdmission(
				context,
				reservation.lease.admission_id,
				"settled",
			);
		} catch {
			// Preserve the canonical authorization failure if settlement is unknown.
		}
		return { ok: false, failure: authorized.failure };
	}
	let result: TextMutationResult;
	try {
		result = await gateway.commitText(
			context,
			intent,
			authorized.ticket.id,
			descriptor.op === "delete" ? undefined : payload.content,
			key,
		);
	} catch (error) {
		try {
			await gateway.finishAdmission(context, authorized.ticket.id, "uncertain");
		} catch {
			// Keep the original failure and let the original deadline release ownership.
		}
		throw error;
	}
	try {
		await gateway.finishAdmission(context, authorized.ticket.id, "settled");
	} catch {
		// The confirmed commit result takes precedence over a failed cleanup RPC.
	}
	return result;
}
