import type {
	AdmissionCompletion,
	AdmissionFinishResult,
	AdmissionResult,
	AuthorizationContext,
	ChangeEntry,
	ChangesPage,
	FileFailure,
	HistoryPageEntry,
	HistoryUpperResponse,
	ManifestPage,
	MetadataBatchRequest,
	MetadataBatchResponse,
	MetadataManifestRow,
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
import { assertReadDemand, ReadAborted } from "@worker/application/read-demand";

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

/** One demanded metadata batch and its page-completion state. */
export interface ReadBatch<T> {
	readonly rows: readonly T[];
	readonly done: boolean;
	readonly next_page: string | null;
}

/** Lazy page session that keeps native demand and durable admission under response ownership. */
export interface LazyReadSession<T, M> {
	readonly ok: true;
	readonly body: M;
	/** Read at most one bounded native batch after downstream demand. */
	readBatch(): Promise<ReadBatch<T>>;
	/** Stop future demand and wait for any started native batch. */
	cancel(): Promise<void>;
	/** Settle once after response EOF or cancellation cleanup. */
	finish(completion: AdmissionCompletion): Promise<AdmissionFinishResult>;
}

/** Preserve a canonical batch failure across the lazy session boundary. */
export class ReadBatchFailure extends Error {
	/** Preserve the native policy failure for settlement by the admission owner. */
	constructor(readonly failure: FileFailure) {
		super("Metadata batch returned a policy failure");
	}
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
	signal?: AbortSignal,
): Promise<ReadOutcome<VaultReadResult>> {
	const begun = await beginRead(gateway, context, [], signal);
	if (!begun.ok) return begun;
	try {
		assertReadDemand(signal);
		const response = await gateway.readVault(context, begun.ticket.id);
		if (!response.ok)
			return finishReadFailure(
				gateway,
				context,
				begun.ticket.id,
				response.failure,
			);
		assertReadDemand(signal);
		return createReadSession(gateway, context, begun.ticket.id, response.body);
	} catch (error) {
		return finishKnownFailure(gateway, context, begun.ticket.id, error);
	}
}

/** Open one manifest traversal with a caller row cap; default to the public 256-row page. */
export async function openManifestRead(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	token?: string,
	signal?: AbortSignal,
	rowLimit = 256,
): Promise<
	ReadOutcome<
		LazyReadSession<
			MetadataManifestRow,
			Omit<ManifestPage, "entries" | "next_page">
		>
	>
> {
	const begun = await beginRead(gateway, context, [], signal);
	if (!begun.ok) return begun;
	try {
		if (!Number.isSafeInteger(rowLimit) || rowLimit < 1)
			throw new FileOperationDenied({ kind: "invalid_request" });
		assertReadDemand(signal);
		const summary = await gateway.readVault(context, begun.ticket.id);
		if (!summary.ok)
			return finishReadFailure(
				gateway,
				context,
				begun.ticket.id,
				summary.failure,
			);
		assertReadDemand(signal);
		const cursor =
			token === undefined
				? undefined
				: decodeCursor(
						token,
						{ kind: "manifest", epoch: summary.body.epoch },
						summary.body.epoch,
					);
		const epoch = summary.body.epoch;
		const head =
			cursor?.kind === "manifest" ? cursor.head_seq : summary.body.head_seq;
		let after = cursor?.kind === "manifest" ? cursor.last_path : null;
		const owner = createReadSession(gateway, context, begun.ticket.id, {
			epoch,
			head_seq: head,
		});
		const lazy = createLazyTraversal(
			owner,
			rowLimit,
			async (limit) => {
				const result = await gateway.readBatch(
					context,
					{
						collection: "manifest",
						epoch,
						head_seq: head,
						after_path: after,
						limit,
					},
					begun.ticket.id,
				);
				if (!result.ok) throw new ReadBatchFailure(result.failure);
				if (result.body.collection !== "manifest")
					throw new Error("Unexpected metadata collection");
				const rows = result.body.rows.slice(0, limit);
				after = rows.at(-1)?.path ?? after;
				return { rows, more: result.body.rows.length > limit };
			},
			() =>
				after === null
					? null
					: encodeReadCursor({
							version: 1,
							kind: "manifest",
							epoch,
							head_seq: head,
							last_path: after,
						}),
			signal,
		);
		return { ok: true, body: lazy, finish: lazy.finish };
	} catch (error) {
		return finishKnownFailure(gateway, context, begun.ticket.id, error);
	}
}

/** Open history under its first observed revision ceiling without collecting rows. */
export async function openHistoryRead(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	path: string,
	token?: string,
	signal?: AbortSignal,
): Promise<ReadOutcome<LazyReadSession<HistoryPageEntry, { epoch: string }>>> {
	const begun = await beginRead(gateway, context, [path], signal);
	if (!begun.ok) return begun;
	try {
		assertReadDemand(signal);
		const result = await gateway.readHistoryUpper(
			context,
			begun.ticket.id,
			path,
		);
		if (!result.ok)
			return finishReadFailure(
				gateway,
				context,
				begun.ticket.id,
				result.failure,
			);
		assertReadDemand(signal);
		const upper = result.body;
		const cursor =
			token === undefined
				? undefined
				: decodeCursor(
						token,
						{ kind: "history", epoch: upper.epoch, path },
						upper.epoch,
					);
		if (upper.upper_etag === null && cursor)
			throw new FileOperationDenied({ kind: "invalid_request" });
		const upperEtag =
			cursor?.kind === "history" ? cursor.upper_etag : upper.upper_etag;
		const head = cursor?.kind === "history" ? cursor.head_seq : upper.head_seq;
		let after =
			cursor?.kind === "history" ? parseETag(cursor.last_etag).rev : null;
		const owner = createReadSession(gateway, context, begun.ticket.id, {
			epoch: upper.epoch,
		});
		const lazy = createLazyTraversal(
			owner,
			256,
			async (limit) => {
				if (upperEtag === null) return { rows: [], more: false };
				const batch = await gateway.readBatch(
					context,
					{
						collection: "history",
						epoch: upper.epoch,
						path,
						upper_etag: upperEtag,
						after_rev: after,
						limit,
					},
					begun.ticket.id,
				);
				if (!batch.ok) throw new ReadBatchFailure(batch.failure);
				if (batch.body.collection !== "history")
					throw new Error("Unexpected metadata collection");
				const consumed = batch.body.rows.slice(0, limit);
				after = consumed.at(-1)?.rev ?? after;
				return {
					rows: consumed.map((row) => ({
						etag: formatETag(upper.epoch, row.rev),
						hash: row.hash,
						size: row.size,
						deleted: row.deleted,
						origin: row.origin,
						at: row.at,
					})),
					more: batch.body.rows.length > limit,
				};
			},
			() =>
				after === null || upperEtag === null
					? null
					: encodeReadCursor({
							version: 1,
							kind: "history",
							epoch: upper.epoch,
							head_seq: head,
							path,
							upper_etag: upperEtag,
							last_etag: formatETag(upper.epoch, after),
						}),
			signal,
		);
		return { ok: true, body: lazy, finish: lazy.finish };
	} catch (error) {
		return finishKnownFailure(gateway, context, begun.ticket.id, error);
	}
}

/** Open an immutable feed traversal at the captured head with a bounded public limit. */
export async function openChangesRead(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	epoch: string,
	since: number,
	limit = 1000,
	signal?: AbortSignal,
): Promise<
	ReadOutcome<LazyReadSession<ChangeEntry, Omit<ChangesPage, "entries">>>
> {
	const begun = await beginRead(gateway, context, [], signal);
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
		assertReadDemand(signal);
		const summary = await gateway.readVault(context, begun.ticket.id);
		if (!summary.ok)
			return finishReadFailure(
				gateway,
				context,
				begun.ticket.id,
				summary.failure,
			);
		assertReadDemand(signal);
		if (summary.body.epoch !== epoch)
			throw new FileOperationDenied({
				kind: "epoch_mismatch",
				current_epoch: summary.body.epoch,
			});
		let after = since;
		const owner = createReadSession(gateway, context, begun.ticket.id, {
			epoch,
			head_seq: summary.body.head_seq,
		});
		const lazy = createLazyTraversal(
			owner,
			limit,
			async (batchLimit) => {
				const result = await gateway.readBatch(
					context,
					{
						collection: "changes",
						epoch,
						head_seq: summary.body.head_seq,
						after_seq: after,
						limit: batchLimit,
					},
					begun.ticket.id,
				);
				if (!result.ok) throw new ReadBatchFailure(result.failure);
				if (result.body.collection !== "changes")
					throw new Error("Unexpected metadata collection");
				const rows = result.body.rows.slice(0, batchLimit);
				after = rows.at(-1)?.seq ?? after;
				return { rows, more: result.body.rows.length > batchLimit };
			},
			() => null,
			signal,
		);
		return { ok: true, body: lazy, finish: lazy.finish };
	} catch (error) {
		return finishKnownFailure(gateway, context, begun.ticket.id, error);
	}
}

/** Own one active batch, page capacity, cancellation, and failure certainty for every collection. */
function createLazyTraversal<T, M>(
	owner: ReadSession<M>,
	cap: number,
	fetchBatch: (limit: number) => Promise<{ rows: T[]; more: boolean }>,
	nextPage: () => string | null,
	signal?: AbortSignal,
): LazyReadSession<T, M> {
	let count = 0;
	let stopped = false;
	let uncertain = false;
	let active: Promise<ReadBatch<T>> | undefined;
	return {
		ok: true,
		body: owner.body,
		/** Demand one batch, and retain unknown authority outcomes to the original deadline. */
		async readBatch() {
			if (active) return active;
			if (stopped) return { rows: [], done: true, next_page: null };
			active = (async () => {
				try {
					assertReadDemand(signal);
					const batch = await fetchBatch(Math.min(64, cap - count));
					assertReadDemand(signal);
					count += batch.rows.length;
					const done = !batch.more || count === cap;
					if (done) stopped = true;
					return {
						rows: batch.rows,
						done,
						next_page: done && batch.more ? nextPage() : null,
					};
				} catch (error) {
					stopped = true;
					uncertain = !(
						error instanceof ReadBatchFailure || error instanceof ReadAborted
					);
					throw error;
				}
			})();
			try {
				return await active;
			} finally {
				active = undefined;
			}
		},
		/** Join the started batch before the response owner settles its ticket. */
		async cancel() {
			stopped = true;
			if (active) await active.catch(() => undefined);
		},
		/** Never settle an unknown authority result as known completed work. */
		async finish(completion) {
			return owner.finish(uncertain ? "uncertain" : completion);
		},
	};
}

/** Authorize the canonical body-free read intent before cursor or data demand. */
async function beginRead(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	paths: string[],
	signal?: AbortSignal,
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
		assertReadDemand(signal);
		const result = await gateway.authorize(context, intent);
		return result.ok ? { ok: true, ticket: result.ticket } : result;
	} catch (error) {
		if (isKnownFailure(error)) return { ok: false, failure: error.failure };
		throw error;
	}
}

/** Keep one admission active until its caller reports response completion or uncertainty. */
export function createReadSession<T>(
	gateway: Pick<ReadVaultGateway, "finishAdmission">,
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
			finishResult ??= Promise.resolve().then(() =>
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

/** Settle known policy failures and local aborts. Unknown faults retain their original durable deadline. */
async function finishKnownFailure<T>(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	ticketId: string,
	error: unknown,
): Promise<ReadOutcome<T>> {
	if (error instanceof ReadAborted) {
		await gateway.finishAdmission(context, ticketId, "settled");
		throw error;
	}
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
