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
	ManifestEntry,
	ManifestPage,
	MetadataBatchRequest,
	MetadataBatchResult,
	OperationIntent,
	VaultReadResult,
} from "@obsidian-ai-bridge/protocol";
import {
	EMPTY_PAYLOAD_HASH,
	encodeReadCursor,
} from "@obsidian-ai-bridge/protocol";
import { formatETag, parseETag } from "@protocol/codecs/etag";
import { decodeReadCursor } from "@protocol/codecs/reads";
import { AdmissionDenied } from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";

/** Native methods needed to hold one authorized read across its bounded batches. */
export interface ReadVaultGateway {
	/** Reserve one reusable read ticket for the full public response. */
	authorize(
		context: AuthorizationContext,
		intent: OperationIntent,
	): Promise<AdmissionResult>;
	/** Settle known work or retain uncertain work to the original ticket deadline. */
	finishAdmission(
		context: AuthorizationContext,
		ticketId: string,
		completion: AdmissionCompletion,
	): AdmissionFinishResult | Promise<AdmissionFinishResult>;
	/** Read the aggregate summary while the same response ticket remains active. */
	readVault(
		context: AuthorizationContext,
		admissionId: string,
	): Promise<VaultReadResult>;
	/** Read one metadata-only batch after native ticket and current policy checks. */
	readBatch(
		context: AuthorizationContext,
		request: MetadataBatchRequest,
		admissionId: string,
	): Promise<MetadataBatchResult>;
	/** Capture the path's current revision ceiling without returning revision rows. */
	readHistoryUpper(
		context: AuthorizationContext,
		admissionId: string,
		path: string,
	): Promise<{ epoch: string; head_seq: number; upper_etag: string | null }>;
}

/** Read the authorized aggregate summary without selecting current file rows. */
export async function readVault(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
) {
	const begun = await beginRead(gateway, context, [], undefined);
	if (!begun.ok) return begun;
	try {
		const body = await gateway.readVault(context, begun.ticket.id);
		await gateway.finishAdmission(context, begun.ticket.id, "settled");
		return { ok: true as const, body };
	} catch (error) {
		await gateway.finishAdmission(context, begun.ticket.id, "uncertain");
		return failure(error);
	}
}

/** Read one manifest page with keyset batches and a cursor bound to its first head. */
export async function readManifest(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	token?: string,
) {
	const begun = await beginRead(gateway, context, [], undefined);
	if (!begun.ok) return begun;
	try {
		const summary = await gateway.readVault(context, begun.ticket.id);
		const cursor =
			token === undefined
				? undefined
				: decodeReadCursor(token, { kind: "manifest", epoch: summary.epoch });
		const head =
			cursor?.kind === "manifest" ? cursor.head_seq : summary.head_seq;
		let afterPath = cursor?.kind === "manifest" ? cursor.last_path : null;
		const entries: ManifestEntry[] = [];
		let more = false;
		while (entries.length < 256) {
			const result = await gateway.readBatch(
				context,
				{
					collection: "manifest",
					epoch: summary.epoch,
					head_seq: head,
					after_path: afterPath,
					limit: Math.min(64, 256 - entries.length),
				},
				begun.ticket.id,
			);
			if (result.collection !== "manifest")
				throw new Error("Native manifest batch returned another collection");
			const available = result.rows.slice(0, 256 - entries.length);
			entries.push(...available);
			if (result.rows.length > available.length) {
				more = true;
				break;
			}
			const last = available.at(-1);
			if (
				!last ||
				result.rows.length <
					Math.min(64, 256 - entries.length + available.length)
			)
				break;
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
		await gateway.finishAdmission(context, begun.ticket.id, "settled");
		return {
			ok: true as const,
			body: {
				epoch: summary.epoch,
				head_seq: head,
				entries,
				next_page,
			} satisfies ManifestPage,
		};
	} catch (error) {
		await gateway.finishAdmission(context, begun.ticket.id, "settled");
		return failure(error);
	}
}

/** Read a bounded retained history page through its first observed upper revision. */
export async function readHistory(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	path: string,
	token?: string,
) {
	const begun = await beginRead(gateway, context, [path], undefined);
	if (!begun.ok) return begun;
	try {
		const upper = await gateway.readHistoryUpper(
			context,
			begun.ticket.id,
			path,
		);
		const cursor =
			token === undefined
				? undefined
				: decodeReadCursor(token, {
						kind: "history",
						epoch: upper.epoch,
						path,
					});
		if (upper.upper_etag === null) {
			if (token !== undefined)
				throw new Error("History cursor has no current path");
			await gateway.finishAdmission(context, begun.ticket.id, "settled");
			return {
				ok: true as const,
				body: {
					epoch: upper.epoch,
					entries: [],
					next_page: null,
				} satisfies HistoryPage,
			};
		}
		const upperEtag =
			cursor?.kind === "history" ? cursor.upper_etag : upper.upper_etag;
		const afterEtag = cursor?.kind === "history" ? cursor.last_etag : undefined;
		const afterRev = afterEtag === undefined ? null : parseETag(afterEtag).rev;
		const entries: HistoryPageEntry[] = [];
		let after = afterRev;
		let more = false;
		while (entries.length < 256) {
			const remaining = 256 - entries.length;
			const result = await gateway.readBatch(
				context,
				{
					collection: "history",
					epoch: upper.epoch,
					path,
					upper_etag: upperEtag,
					after_rev: after,
					limit: Math.min(64, remaining),
				},
				begun.ticket.id,
			);
			if (result.collection !== "history")
				throw new Error("Native history batch returned another collection");
			const page = result.rows.slice(0, remaining);
			entries.push(
				...page.map((row) => ({
					etag: formatETag(upper.epoch, row.rev),
					hash: row.hash,
					size: row.size,
					deleted: row.deleted,
					origin: row.origin,
					at: row.at,
				})),
			);
			if (result.rows.length > page.length) {
				more = true;
				break;
			}
			const last = page.at(-1);
			if (!last || result.rows.length < Math.min(64, remaining)) break;
			after = parseETag(formatETag(upper.epoch, last.rev)).rev;
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
		await gateway.finishAdmission(context, begun.ticket.id, "settled");
		return {
			ok: true as const,
			body: { epoch: upper.epoch, entries, next_page } satisfies HistoryPage,
		};
	} catch (error) {
		await gateway.finishAdmission(context, begun.ticket.id, "settled");
		return failure(error);
	}
}

/** Read an ascending immutable feed page through the first observed head. */
export async function readChanges(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	epoch: string,
	since: number,
	limit = 1000,
) {
	const begun = await beginRead(gateway, context, [], undefined);
	if (!begun.ok) return begun;
	try {
		const summary = await gateway.readVault(context, begun.ticket.id);
		if (summary.epoch !== epoch)
			throw new FileOperationDenied({
				kind: "epoch_mismatch",
				current_epoch: summary.epoch,
			});
		let after = since;
		const entries: ChangeEntry[] = [];
		while (entries.length < limit) {
			const request = {
				collection: "changes" as const,
				epoch,
				head_seq: summary.head_seq,
				after_seq: after,
				limit: Math.min(64, limit - entries.length),
			};
			const result = await gateway.readBatch(context, request, begun.ticket.id);
			if (result.collection !== "changes")
				throw new Error("Native changes batch returned another collection");
			const page = result.rows.slice(0, limit - entries.length);
			entries.push(...page);
			if (
				result.rows.length > page.length ||
				result.rows.length < request.limit
			)
				break;
			const last = page.at(-1);
			if (!last) break;
			after = last.seq;
		}
		await gateway.finishAdmission(context, begun.ticket.id, "settled");
		return {
			ok: true as const,
			body: {
				epoch,
				head_seq: summary.head_seq,
				entries,
			} satisfies ChangesPage,
		};
	} catch (error) {
		await gateway.finishAdmission(context, begun.ticket.id, "settled");
		return failure(error);
	}
}

/** Authorize a reusable body-free read ticket with its canonical path ownership. */
async function beginRead(
	gateway: ReadVaultGateway,
	context: AuthorizationContext,
	paths: string[],
	epoch: string | undefined,
) {
	const intent = {
		op: "read" as const,
		paths,
		precondition: { kind: "none" as const },
		payload_hash: EMPTY_PAYLOAD_HASH,
		size: 0,
		...(epoch === undefined ? {} : { epoch }),
	};
	try {
		const result = await gateway.authorize(context, intent);
		return result.ok
			? { ok: true as const, ticket: result.ticket }
			: { ok: false as const, failure: result.failure };
	} catch (error) {
		return failure(error);
	}
}

/** Map native policy exceptions to canonical safe failures. */
function failure(error: unknown): { ok: false; failure: FileFailure } {
	if (error instanceof AdmissionDenied || error instanceof FileOperationDenied)
		return { ok: false, failure: error.failure };
	return { ok: false, failure: { kind: "invalid_request" } };
}
