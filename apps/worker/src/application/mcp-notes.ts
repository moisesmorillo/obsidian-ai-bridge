import type {
	AdmissionCompletion,
	AdmissionFinishResult,
	AuthorizationContext,
	FileFailure,
	McpHistoryResult,
	McpListNotesResult,
	McpReadNoteInput,
	McpReadNoteResult,
	McpSearchNotesResult,
} from "@obsidian-ai-bridge/protocol";
import { EMPTY_PAYLOAD_HASH } from "@obsidian-ai-bridge/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import type { HistoryVaultGateway } from "@worker/application/history";
import { ReadAborted } from "@worker/application/read-demand";
import type { LazyReadSession } from "@worker/application/reads";
import {
	openHistoryRead,
	openManifestRead,
	ReadBatchFailure,
	type ReadVaultGateway,
} from "@worker/application/reads";
import type { SearchVaultGateway } from "@worker/application/search";
import { readSearch } from "@worker/application/search";
import type { TextVaultGateway } from "@worker/application/text-files";

/** Estimated JSON bytes allowed for one structured MCP list result. */
const MCP_LIST_RESULT_BYTES_LIMIT = 65_536;
/** Bound manifest traversal to a safe integer while retaining only bounded batches. */
const MCP_MANIFEST_SCAN_LIMIT = Number.MAX_SAFE_INTEGER;

/** Gateways required to map MCP reads to the existing durable read operations. */
export type McpNotesGateway = TextVaultGateway &
	HistoryVaultGateway &
	ReadVaultGateway &
	SearchVaultGateway;

/** Durable read authority transferred to the MCP response producer. */
export interface McpReadOwner {
	/** Known application completion, or uncertain work that must keep its deadline. */
	readonly completion: AdmissionCompletion;
	/** Cancel and join any started read work before owner settlement. */
	cancel(): Promise<void>;
	/** Settle after response EOF or cancellation cleanup. */
	finish(completion: AdmissionCompletion): Promise<AdmissionFinishResult>;
}

/** One bounded MCP read result or canonical application failure with optional authority. */
export type McpReadOutcome<T extends object> =
	| { ok: true; epoch: string; value: T; owner?: McpReadOwner }
	| {
			ok: false;
			failure:
				| FileFailure
				| { kind: "result_too_large" }
				| { kind: "internal_error" };
			owner?: McpReadOwner;
	  };

/** Current epoch or the authoritative scope and revocation failure. */
export type McpEpochOutcome =
	| { ok: true; epoch: string }
	| { ok: false; failure: FileFailure };

/** Check scope and authoritative revocation before returning the current epoch. */
export async function currentMcpEpoch(
	gateway: McpNotesGateway,
	identity: AuthorizationContext,
): Promise<McpEpochOutcome> {
	const operation = identity.scopes.includes("vault:read")
		? "read"
		: identity.scopes.includes("vault:write")
			? "put"
			: "delete";
	const result = await gateway.getCurrentEpoch(identity, operation);
	return result.ok
		? { ok: true, epoch: result.current_epoch }
		: { ok: false, failure: result.failure };
}

/** Keep lazy read admission with its MCP result until response ownership settles it. */
async function settleMcpRead<T extends object, Row, Metadata>(
	session: LazyReadSession<Row, Metadata>,
	read: () => Promise<McpReadOutcome<T>>,
): Promise<McpReadOutcome<T>> {
	let completion: AdmissionCompletion = "settled";
	let outcome: McpReadOutcome<T>;
	try {
		outcome = await read();
	} catch (error) {
		completion =
			error instanceof ReadBatchFailure || error instanceof ReadAborted
				? "settled"
				: "uncertain";
		outcome = {
			ok: false,
			failure:
				error instanceof ReadAborted
					? { kind: "invalid_request" }
					: error instanceof ReadBatchFailure
						? error.failure
						: { kind: "internal_error" },
		};
	}
	return {
		...outcome,
		owner: createMcpReadOwner(
			completion,
			() => session.cancel(),
			(completion) => session.finish(completion),
		),
	};
}

/** Combine application certainty with response producer completion before durable finish. */
function createMcpReadOwner(
	completion: AdmissionCompletion,
	cancel: () => Promise<void>,
	finish: (completion: AdmissionCompletion) => Promise<AdmissionFinishResult>,
): McpReadOwner {
	let finished: Promise<AdmissionFinishResult> | undefined;
	return {
		completion,
		cancel,
		/** Keep one settlement promise across repeated response callbacks. */
		finish(responseCompletion) {
			const effectiveCompletion =
				completion === "uncertain" || responseCompletion === "uncertain"
					? "uncertain"
					: "settled";
			finished ??= finish(effectiveCompletion);
			return finished;
		},
	};
}

/** Estimate one serialized list row without materializing the enclosing MCP response. */
function estimateMcpListEntryBytes(
	entry: McpListNotesResult["entries"][number],
): number {
	return new TextEncoder().encode(JSON.stringify(entry)).byteLength;
}

/** Traverse bounded manifest batches and bound only matching MCP result rows and bytes. */
export async function listMcpNotes(
	gateway: McpNotesGateway,
	identity: AuthorizationContext,
	prefix?: string,
	includeLarge = false,
	signal?: AbortSignal,
): Promise<McpReadOutcome<Pick<McpListNotesResult, "entries">>> {
	const opened = await openManifestRead(
		gateway,
		identity,
		undefined,
		signal,
		MCP_MANIFEST_SCAN_LIMIT,
	);
	if (!opened.ok) return { ok: false, failure: opened.failure };
	return settleMcpRead(opened.body, async () => {
		const entries: McpListNotesResult["entries"][number][] = [];
		let estimatedBytes = 128;
		for (;;) {
			const batch = await opened.body.readBatch();
			for (const row of batch.rows) {
				if (
					row.deleted ||
					!/\.(?:md|canvas)$/i.test(row.path) ||
					(!includeLarge && row.large) ||
					(prefix !== undefined && !row.path.startsWith(prefix))
				)
					continue;
				if (row.updated_at === undefined)
					return { ok: false, failure: { kind: "internal_error" } };
				const entry = {
					path: row.path,
					etag: row.etag,
					size: row.size,
					updated_at: row.updated_at,
					large: row.large,
				};
				const nextBytes =
					estimatedBytes +
					estimateMcpListEntryBytes(entry) +
					(entries.length > 0 ? 1 : 0);
				if (entries.length >= 256 || nextBytes > MCP_LIST_RESULT_BYTES_LIMIT)
					return { ok: false, failure: { kind: "result_too_large" } };
				entries.push(entry);
				estimatedBytes = nextBytes;
			}
			if (batch.next_page !== null)
				return { ok: false, failure: { kind: "result_too_large" } };
			if (batch.done)
				return { ok: true, epoch: opened.body.body.epoch, value: { entries } };
		}
	});
}

/** Read one selected revision and transfer its admission with the bounded fragment. */
export async function readMcpNote(
	gateway: Pick<
		TextVaultGateway,
		"authorize" | "readText" | "readBlobMetadata" | "finishAdmission"
	>,
	identity: AuthorizationContext,
	input: McpReadNoteInput,
	store: BlobContentStore,
	signal?: AbortSignal,
): Promise<McpReadOutcome<Omit<McpReadNoteResult, "epoch">>> {
	const begun = await gateway.authorize(identity, {
		op: "read",
		paths: [input.path],
		precondition: { kind: "none" },
		payload_hash: EMPTY_PAYLOAD_HASH,
		size: 0,
	});
	if (!begun.ok) return { ok: false, failure: begun.failure };
	let completion: AdmissionCompletion = "settled";
	let outcome: McpReadOutcome<Omit<McpReadNoteResult, "epoch">>;
	try {
		outcome = await (async () => {
			if (signal?.aborted)
				return { ok: false, failure: { kind: "invalid_request" } };
			completion = "uncertain";
			const selected = await gateway.readText(
				identity,
				{ path: input.path, offset: input.offset, length: input.length },
				begun.ticket.id,
			);
			completion = "settled";
			if (signal?.aborted)
				throw new DOMException("Request aborted", "AbortError");
			if (!selected.ok) {
				if (selected.failure.kind !== "not_implemented")
					return { ok: false, failure: selected.failure };
				completion = "uncertain";
				const blob = await gateway.readBlobMetadata(
					identity,
					{ path: input.path },
					begun.ticket.id,
				);
				completion = "settled";
				if (signal?.aborted)
					throw new DOMException("Request aborted", "AbortError");
				if (!blob.ok) return { ok: false, failure: blob.failure };
				const epoch = blob.body.etag.slice(1, 33);
				if (input.etag !== undefined && input.etag !== blob.body.etag)
					return {
						ok: true,
						epoch,
						value: { path: input.path, etag: blob.body.etag, truncated: true },
					};
				if (blob.body.deleted)
					return { ok: false, failure: { kind: "not_found" } };
				try {
					const content = await readBlobTextFragment(
						store,
						blob.body.hash,
						blob.body.size,
						input.offset ?? 0,
						input.length ?? 1_000_000,
						signal,
					);
					return {
						ok: true,
						epoch,
						value: { path: input.path, etag: blob.body.etag, ...content },
					};
				} catch (error) {
					if (signal?.aborted)
						return { ok: false, failure: { kind: "invalid_request" } };
					return {
						ok: false,
						failure:
							error instanceof RangeError
								? { kind: "result_too_large" }
								: { kind: "internal_error" },
					};
				}
			}
			const epoch = selected.body.etag.slice(1, 33);
			if (input.etag !== undefined && input.etag !== selected.body.etag)
				return {
					ok: true,
					epoch,
					value: {
						path: input.path,
						etag: selected.body.etag,
						truncated: selected.body.truncated,
					},
				};
			if (selected.body.deleted)
				return { ok: false, failure: { kind: "not_found" } };
			return {
				ok: true,
				epoch,
				value: {
					path: input.path,
					etag: selected.body.etag,
					content: selected.body.content ?? "",
					truncated: selected.body.truncated,
				},
			};
		})();
	} catch {
		outcome = {
			ok: false,
			failure: signal?.aborted
				? { kind: "invalid_request" }
				: { kind: "internal_error" },
		};
	}
	const owner = createMcpReadOwner(
		completion,
		async () => {},
		(effectiveCompletion) =>
			gateway.finishAdmission(identity, begun.ticket.id, effectiveCompletion),
	);
	return { ...outcome, owner };
}

/** Stream immutable UTF-8 bytes and retain only one bounded UTF-16 fragment. */
async function readBlobTextFragment(
	store: BlobContentStore,
	hash: string,
	size: number,
	offset: number,
	length: number,
	signal?: AbortSignal,
): Promise<{ content: string; truncated: boolean }> {
	const stream = await store.read(hash, size);
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const encoder = new TextEncoder();
	const end = offset + length;
	let total = 0;
	let selected = "";
	/** Cancel pending R2 reader work when this MCP operation aborts. */
	const abortRead = () => {
		void reader.cancel(signal?.reason).catch(() => undefined);
	};
	if (signal?.aborted) abortRead();
	else signal?.addEventListener("abort", abortRead, { once: true });
	try {
		for (;;) {
			if (signal?.aborted)
				throw new DOMException("Request aborted", "AbortError");
			const item = await reader.read();
			if (signal?.aborted)
				throw new DOMException("Request aborted", "AbortError");
			if (item.done) break;
			const text = decoder.decode(item.value, { stream: true });
			const start = Math.max(offset - total, 0);
			const stop = Math.min(end - total, text.length);
			if (stop > start) selected += text.slice(start, stop);
			total += text.length;
		}
		const tail = decoder.decode();
		const start = Math.max(offset - total, 0);
		const stop = Math.min(end - total, tail.length);
		if (stop > start) selected += tail.slice(start, stop);
		total += tail.length;
		if (encoder.encode(selected).byteLength > 1_000_000)
			throw new RangeError("MCP note fragment exceeds its output limit");
		return { content: selected, truncated: offset > 0 || end < total };
	} finally {
		signal?.removeEventListener("abort", abortRead);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

/** Search under existing read admission and transfer it to response production. */
export async function searchMcpNotes(
	gateway: McpNotesGateway,
	identity: AuthorizationContext,
	query: string,
	limit?: number,
	signal?: AbortSignal,
): Promise<McpReadOutcome<Omit<McpSearchNotesResult, "epoch">>> {
	const result = await readSearch(
		gateway,
		identity,
		{ query, limit: limit ?? 20 },
		signal,
	);
	if (!result.ok) return { ok: false, failure: result.failure };
	const epoch = result.body.epoch;
	const { epoch: _epoch, ...value } = result.body;
	return {
		ok: true,
		epoch,
		value,
		owner: createMcpReadOwner(
			"settled",
			async () => {},
			(completion) => result.finish(completion),
		),
	};
}

/** Read bounded retained history and transfer its admission to response production. */
export async function historyMcpNote(
	gateway: McpNotesGateway,
	identity: AuthorizationContext,
	path: string,
	signal?: AbortSignal,
): Promise<McpReadOutcome<Pick<McpHistoryResult, "entries">>> {
	const opened = await openHistoryRead(
		gateway,
		identity,
		path,
		undefined,
		signal,
	);
	if (!opened.ok) return { ok: false, failure: opened.failure };
	return settleMcpRead(opened.body, async () => {
		const entries: McpHistoryResult["entries"][number][] = [];
		for (;;) {
			const batch = await opened.body.readBatch();
			if (entries.length + batch.rows.length > 256)
				return { ok: false, failure: { kind: "result_too_large" } };
			entries.push(...batch.rows);
			if (batch.next_page !== null)
				return { ok: false, failure: { kind: "result_too_large" } };
			if (batch.done)
				return { ok: true, epoch: opened.body.body.epoch, value: { entries } };
		}
	});
}
