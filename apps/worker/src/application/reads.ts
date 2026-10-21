import type {
	AdmissionCompletion,
	AdmissionFinishResult,
	AdmissionResult,
	AuthorizationContext,
	ChangeEntry,
	ChangesPage,
	FileFailure,
	HistoryPage,
	HistoryPageEntry,
	HistoryUpperResponse,
	ManifestEntry,
	ManifestPage,
	MetadataBatchRequest,
	MetadataBatchResponse,
	OperationIntent,
	VaultReadResponse,
	VaultReadResult,
} from "@obsidian-ai-bridge/protocol";
import {
	decodeReadCursor,
	EMPTY_PAYLOAD_HASH,
	encodeReadCursor,
	formatETag,
	parseETag,
} from "@obsidian-ai-bridge/protocol";
import { AdmissionDenied } from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";

/** Native operations needed for one read admission across every batch. */
export interface ReadVaultGateway {
	/** Create one reusable active ticket for the complete public read. */
	authorize(
		context: AuthorizationContext,
		intent: OperationIntent,
	): Promise<AdmissionResult>;
	/** Settle known work or retain uncertain work to its original deadline. */
	finishAdmission(
		context: AuthorizationContext,
		ticketId: string,
		completion: AdmissionCompletion,
	): AdmissionFinishResult | Promise<AdmissionFinishResult>;
	/** Read aggregate vault metadata through the active ticket. */
	readVault(
		context: AuthorizationContext,
		admissionId: string,
	): Promise<VaultReadResponse>;
	/** Read one bounded metadata batch through the active ticket. */
	readBatch(
		context: AuthorizationContext,
		request: MetadataBatchRequest,
		admissionId: string,
	): Promise<MetadataBatchResponse>;
	/** Capture the current history ceiling without returning revision rows. */
	readHistoryUpper(
		context: AuthorizationContext,
		admissionId: string,
		path: string,
	): Promise<HistoryUpperResponse>;
}

/** Successful read result with the admission owner retained until response completion. */
export interface ReadSession<T> {
	readonly ok: true;
	readonly body: T;
	/** Settle once after response production, or retain an uncertain ticket to its deadline. */
	finish(completion: AdmissionCompletion): Promise<AdmissionFinishResult>;
}

/** Read outcome whose successful branch owns a deferred admission settlement hook. */
export type ReadOutcome<T> =
	| ReadSession<T>
	| {
			ok: false;
			failure: FileFailure;
	  };

/** Read the authorized aggregate summary and return its admission owner to transport. */
export async function readVault(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
): Promise<ReadOutcome<VaultReadResult>> {
	const begun = await beginRead(gateway, context, []);
	if (!begun.ok) return begun;
	try {
		const response = await gateway.readVault(context, begun.ticket.id);
		if (!response.ok)
			return finishReadFailure(
				gateway,
				context,
				begun.ticket.id,
				response.failure,
			);
		return createReadSession(gateway, context, begun.ticket.id, response.body);
	} catch (error) {
		return finishKnownFailure(gateway, context, begun.ticket.id, error);
	}
}

/** Read one manifest page and retain its admission until transport settles the response. */
export async function readManifest(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	token?: string,
): Promise<ReadOutcome<ManifestPage>> {
	const begun = await beginRead(gateway, context, []);
	if (!begun.ok) return begun;
	try {
		const summaryResponse = await gateway.readVault(context, begun.ticket.id);
		if (!summaryResponse.ok)
			return finishReadFailure(
				gateway,
				context,
				begun.ticket.id,
				summaryResponse.failure,
			);
		const summary = summaryResponse.body;
		const cursor =
			token === undefined
				? undefined
				: decodeCursor(
						token,
						{ kind: "manifest", epoch: summary.epoch },
						summary.epoch,
					);
		const head =
			cursor?.kind === "manifest" ? cursor.head_seq : summary.head_seq;
		let afterPath = cursor?.kind === "manifest" ? cursor.last_path : null;
		const entries: ManifestEntry[] = [];
		let more = false;
		while (entries.length < 256) {
			const limit = Math.min(64, 256 - entries.length);
			const result = await gateway.readBatch(
				context,
				{
					collection: "manifest",
					epoch: summary.epoch,
					head_seq: head,
					after_path: afterPath,
					limit,
				},
				begun.ticket.id,
			);
			if (!result.ok)
				return finishReadFailure(
					gateway,
					context,
					begun.ticket.id,
					result.failure,
				);
			if (result.body.collection !== "manifest")
				throw new Error("Native manifest batch returned another collection");
			const batch = result.body;
			const consumed = batch.rows.slice(0, limit);
			entries.push(...consumed);
			const last = consumed.at(-1);
			if (entries.length === 256) {
				if (batch.rows.length > consumed.length) more = true;
				else if (last && batch.rows.length === limit) {
					const lookahead = await gateway.readBatch(
						context,
						{
							collection: "manifest",
							epoch: summary.epoch,
							head_seq: head,
							after_path: last.path,
							limit: 1,
						},
						begun.ticket.id,
					);
					if (!lookahead.ok)
						return finishReadFailure(
							gateway,
							context,
							begun.ticket.id,
							lookahead.failure,
						);
					if (lookahead.body.collection !== "manifest")
						throw new Error(
							"Native manifest batch returned another collection",
						);
					more = lookahead.body.rows.length > 0;
				}
				break;
			}
			if (!last || batch.rows.length < limit) break;
			afterPath = last.path;
		}
		const lastPath = entries.at(-1)?.path;
		const next_page =
			more && lastPath !== undefined
				? encodeReadCursor({
						version: 1,
						kind: "manifest",
						epoch: summary.epoch,
						head_seq: head,
						last_path: lastPath,
					})
				: null;
		return createReadSession(gateway, context, begun.ticket.id, {
			epoch: summary.epoch,
			head_seq: head,
			entries,
			next_page,
		});
	} catch (error) {
		return finishKnownFailure(gateway, context, begun.ticket.id, error);
	}
}

/** Read retained history through the first observed upper revision and keep the ticket open. */
export async function readHistory(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	path: string,
	token?: string,
): Promise<ReadOutcome<HistoryPage>> {
	const begun = await beginRead(gateway, context, [path]);
	if (!begun.ok) return begun;
	try {
		const upperResponse = await gateway.readHistoryUpper(
			context,
			begun.ticket.id,
			path,
		);
		if (!upperResponse.ok)
			return finishReadFailure(
				gateway,
				context,
				begun.ticket.id,
				upperResponse.failure,
			);
		const upper = upperResponse.body;
		const cursor =
			token === undefined
				? undefined
				: decodeCursor(
						token,
						{ kind: "history", epoch: upper.epoch, path },
						upper.epoch,
					);
		if (upper.upper_etag === null) {
			if (cursor) throw new FileOperationDenied({ kind: "invalid_request" });
			return createReadSession(gateway, context, begun.ticket.id, {
				epoch: upper.epoch,
				entries: [],
				next_page: null,
			});
		}
		const upperEtag =
			cursor?.kind === "history" ? cursor.upper_etag : upper.upper_etag;
		let afterRev =
			cursor?.kind === "history" ? parseETag(cursor.last_etag).rev : null;
		const entries: HistoryPageEntry[] = [];
		let more = false;
		while (entries.length < 256) {
			const limit = Math.min(64, 256 - entries.length);
			const result = await gateway.readBatch(
				context,
				{
					collection: "history",
					epoch: upper.epoch,
					path,
					upper_etag: upperEtag,
					after_rev: afterRev,
					limit,
				},
				begun.ticket.id,
			);
			if (!result.ok)
				return finishReadFailure(
					gateway,
					context,
					begun.ticket.id,
					result.failure,
				);
			if (result.body.collection !== "history")
				throw new Error("Native history batch returned another collection");
			const batch = result.body;
			const consumed = batch.rows.slice(0, limit);
			entries.push(
				...consumed.map((row) => ({
					etag: formatETag(upper.epoch, row.rev),
					hash: row.hash,
					size: row.size,
					deleted: row.deleted,
					origin: row.origin,
					at: row.at,
				})),
			);
			const last = consumed.at(-1);
			if (entries.length === 256) {
				if (batch.rows.length > consumed.length) more = true;
				else if (last && batch.rows.length === limit) {
					const lookahead = await gateway.readBatch(
						context,
						{
							collection: "history",
							epoch: upper.epoch,
							path,
							upper_etag: upperEtag,
							after_rev: last.rev,
							limit: 1,
						},
						begun.ticket.id,
					);
					if (!lookahead.ok)
						return finishReadFailure(
							gateway,
							context,
							begun.ticket.id,
							lookahead.failure,
						);
					if (lookahead.body.collection !== "history")
						throw new Error("Native history batch returned another collection");
					more = lookahead.body.rows.length > 0;
				}
				break;
			}
			if (!last || batch.rows.length < limit) break;
			afterRev = last.rev;
		}
		const lastEntry = entries.at(-1);
		const next_page =
			more && lastEntry
				? encodeReadCursor({
						version: 1,
						kind: "history",
						epoch: upper.epoch,
						head_seq:
							cursor?.kind === "history" ? cursor.head_seq : upper.head_seq,
						path,
						upper_etag: upperEtag,
						last_etag: lastEntry.etag,
					})
				: null;
		return createReadSession(gateway, context, begun.ticket.id, {
			epoch: upper.epoch,
			entries,
			next_page,
		});
	} catch (error) {
		return finishKnownFailure(gateway, context, begun.ticket.id, error);
	}
}

/** Read ascending feed entries at the first observed head with a validated public limit. */
export async function readChanges(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	epoch: string,
	since: number,
	limit = 1000,
): Promise<ReadOutcome<ChangesPage>> {
	const begun = await beginRead(gateway, context, []);
	if (!begun.ok) return begun;
	try {
		if (
			!Number.isSafeInteger(since) ||
			since < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 1000
		)
			throw new FileOperationDenied({ kind: "invalid_request" });
		const summaryResponse = await gateway.readVault(context, begun.ticket.id);
		if (!summaryResponse.ok)
			return finishReadFailure(
				gateway,
				context,
				begun.ticket.id,
				summaryResponse.failure,
			);
		const summary = summaryResponse.body;
		if (summary.epoch !== epoch)
			throw new FileOperationDenied({
				kind: "epoch_mismatch",
				current_epoch: summary.epoch,
			});
		const entries: ChangeEntry[] = [];
		let after = since;
		while (entries.length < limit) {
			const batchLimit = Math.min(64, limit - entries.length);
			const result = await gateway.readBatch(
				context,
				{
					collection: "changes",
					epoch,
					head_seq: summary.head_seq,
					after_seq: after,
					limit: batchLimit,
				},
				begun.ticket.id,
			);
			if (!result.ok)
				return finishReadFailure(
					gateway,
					context,
					begun.ticket.id,
					result.failure,
				);
			if (result.body.collection !== "changes")
				throw new Error("Native changes batch returned another collection");
			const batch = result.body;
			const consumed = batch.rows.slice(0, batchLimit);
			entries.push(...consumed);
			const last = consumed.at(-1);
			if (entries.length === limit) {
				if (batch.rows.length > consumed.length) break;
				if (last && batch.rows.length === batchLimit) {
					const lookahead = await gateway.readBatch(
						context,
						{
							collection: "changes",
							epoch,
							head_seq: summary.head_seq,
							after_seq: last.seq,
							limit: 1,
						},
						begun.ticket.id,
					);
					if (!lookahead.ok)
						return finishReadFailure(
							gateway,
							context,
							begun.ticket.id,
							lookahead.failure,
						);
					if (lookahead.body.collection !== "changes")
						throw new Error("Native changes batch returned another collection");
				}
				break;
			}
			if (!last || batch.rows.length < batchLimit) break;
			after = last.seq;
		}
		return createReadSession(gateway, context, begun.ticket.id, {
			epoch,
			head_seq: summary.head_seq,
			entries,
		});
	} catch (error) {
		return finishKnownFailure(gateway, context, begun.ticket.id, error);
	}
}

/** Authorize the canonical body-free read intent before cursor or data demand. */
async function beginRead(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	paths: string[],
): Promise<
	| { ok: true; ticket: Extract<AdmissionResult, { ok: true }>["ticket"] }
	| { ok: false; failure: FileFailure }
> {
	const intent = {
		op: "read" as const,
		paths,
		precondition: { kind: "none" as const },
		payload_hash: EMPTY_PAYLOAD_HASH,
		size: 0,
	};
	try {
		const result = await gateway.authorize(context, intent);
		return result.ok ? { ok: true, ticket: result.ticket } : result;
	} catch (error) {
		if (isKnownFailure(error)) return { ok: false, failure: error.failure };
		throw error;
	}
}

/** Keep one admission active until its caller reports response completion or uncertainty. */
function createReadSession<T>(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	ticketId: string,
	body: T,
): ReadSession<T> {
	let finishResult: Promise<AdmissionFinishResult> | undefined;
	return {
		ok: true,
		body,
		/** Apply the response owner's completion once and keep the same promise on repeats. */
		finish(completion) {
			finishResult ??= Promise.resolve(
				gateway.finishAdmission(context, ticketId, completion),
			);
			return finishResult;
		},
	};
}

/** Settle only known policy or validation failures, then return their canonical response. */
async function finishReadFailure<T>(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	ticketId: string,
	failure: FileFailure,
): Promise<ReadOutcome<T>> {
	await gateway.finishAdmission(context, ticketId, "settled");
	return { ok: false, failure };
}

/** Settle known exceptions while allowing unknown transport and storage faults to propagate. */
async function finishKnownFailure<T>(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	ticketId: string,
	error: unknown,
): Promise<ReadOutcome<T>> {
	if (!isKnownFailure(error)) throw error;
	await gateway.finishAdmission(context, ticketId, "settled");
	return { ok: false, failure: error.failure };
}

/** Identify failures with a safe canonical response rather than uncertain storage errors. */
function isKnownFailure(
	error: unknown,
): error is AdmissionDenied | FileOperationDenied {
	return (
		error instanceof AdmissionDenied || error instanceof FileOperationDenied
	);
}

/** Decode a seek hint after authorization and preserve stale-epoch recovery details. */
function decodeCursor(
	token: string,
	context: Parameters<typeof decodeReadCursor>[1],
	currentEpoch: string,
) {
	try {
		return decodeReadCursor(token, context);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "read cursor epoch does not match"
		)
			throw new FileOperationDenied({
				kind: "epoch_mismatch",
				current_epoch: currentEpoch,
			});
		throw new FileOperationDenied({ kind: "invalid_request" });
	}
}
