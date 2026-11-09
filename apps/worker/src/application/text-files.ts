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
} from "@vaultwire/protocol";
import { EMPTY_PAYLOAD_HASH } from "@vaultwire/protocol";
import {
	type AdmissionByteReservation,
	LOCAL_ADMISSION_RETRY_SECONDS,
	REST_BODY_BYTE_ALLOWANCE,
} from "@worker/application/admission-budget";
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
	/** Select current or retained text under the active response ticket and current read policy. */
	readText(
		context: AuthorizationContext,
		request: TextReadRequest,
		admissionId: string,
	): Promise<TextReadResult>;
}

/** One original line and its exact terminator from a Markdown source string. */
type MarkdownSourceLine = Readonly<{
	text: string;
	ending: string;
	start: number;
}>;

/** A parsed ATX heading outside any fenced code block. */
type MarkdownHeading = Readonly<{ level: number; text: string }>;

/**
 * Insert text at the end of the first exact heading section without normalizing source bytes.
 * Returns undefined when no matching ATX heading exists outside fenced code.
 */
export function appendTextUnderHeading(
	content: string,
	heading: string,
	text: string,
): string | undefined {
	const wanted = heading.trim();
	if (!wanted) return undefined;
	const lines: MarkdownSourceLine[] = [];
	let offset = 0;
	while (offset < content.length) {
		const match = /([^\r\n]*)(\r\n|\n|\r|$)/y;
		match.lastIndex = offset;
		const found = match.exec(content);
		if (!found) break;
		lines.push({ text: found[1] ?? "", ending: found[2] ?? "", start: offset });
		offset = match.lastIndex;
		if (found[2] === "") break;
	}
	const headings: (MarkdownHeading | undefined)[] = [];
	let fence: { marker: "`" | "~"; length: number } | undefined;
	for (const line of lines) {
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
		if (fence !== undefined) {
			if (
				fenceMatch &&
				fenceMatch[1]?.[0] === fence.marker &&
				(fenceMatch[1]?.length ?? 0) >= fence.length &&
				/^\s*$/.test(fenceMatch[2] ?? "")
			)
				fence = undefined;
			headings.push(undefined);
			continue;
		}
		if (fenceMatch) {
			const marker = fenceMatch[1]?.[0];
			if (marker === "`" || marker === "~")
				fence = { marker, length: fenceMatch[1]?.length ?? 3 };
			headings.push(undefined);
			continue;
		}
		const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line.text);
		if (!match) {
			headings.push(undefined);
			continue;
		}
		const value = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
		headings.push({ level: match[1]?.length ?? 1, text: value });
	}
	const first = headings.findIndex((item) => item?.text === wanted);
	if (first < 0) return undefined;
	let insertion = content.length;
	for (let index = first + 1; index < headings.length; index += 1) {
		const item = headings[index];
		if (item && item.level <= (headings[first]?.level ?? 1)) {
			insertion = lines[index]?.start ?? content.length;
			break;
		}
	}
	let lineEnding = "\n";
	const boundaryIndex =
		insertion === content.length
			? lines.length
			: lines.findIndex((line) => line.start === insertion);
	for (let index = boundaryIndex - 1; index >= first; index -= 1) {
		const ending = lines[index]?.ending;
		if (ending) {
			lineEnding = ending;
			break;
		}
	}
	if (insertion < content.length)
		return `${content.slice(0, insertion)}${text}${lineEnding}${content.slice(insertion)}`;
	const prefix = /(?:\r\n|\n|\r)$/.test(content) ? "" : lineEnding;
	return `${content}${prefix}${text}`;
}

/**
 * Reserve PUT capacity before body demand, then authorize and publish the exact mutation.
 * Optional response production retains that capacity after operation cleanup. DELETE does not acquire a body slot.
 */
export async function executeTextMutation(
	gateway: TextVaultGateway,
	context: AuthorizationContext,
	descriptor: TextMutationDescriptor,
	key: IdempotencyKey | undefined,
	readPayload: () => Promise<TextPayload>,
	declaration?: BlobDeclaration,
	responseProduction?: Promise<void>,
	byteReservation?: AdmissionByteReservation,
): Promise<TextMutationResult> {
	if (descriptor.op === "put") {
		const release = tryAcquireBodySlot(
			responseProduction,
			REST_BODY_BYTE_ALLOWANCE,
			byteReservation,
		);
		if (release === undefined)
			return {
				ok: false,
				failure: {
					kind: "admission_limited",
					retry_after_seconds: LOCAL_ADMISSION_RETRY_SECONDS,
				},
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
