import type {
	AdmissionCompletion,
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

/** Gateways required to map MCP reads to the existing durable read operations. */
export type McpNotesGateway = TextVaultGateway &
	HistoryVaultGateway &
	ReadVaultGateway &
	SearchVaultGateway;

/** One bounded MCP read result or canonical application failure. */
export type McpReadOutcome<T extends object> =
	| { ok: true; epoch: string; value: T }
	| {
			ok: false;
			failure:
				| FileFailure
				| { kind: "result_too_large" }
				| { kind: "internal_error" };
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
	if (!identity.scopes.includes("vault:read"))
		return { ok: false, failure: { kind: "forbidden_scope" } };
	const result = await gateway.getCurrentEpoch(identity, "read");
	return result.ok
		? { ok: true, epoch: result.current_epoch }
		: { ok: false, failure: result.failure };
}

/** Keep lazy read admission until batch work and cancellation cleanup settle. */
async function settleMcpRead<T extends object, Row, Metadata>(
	session: LazyReadSession<Row, Metadata>,
	read: () => Promise<McpReadOutcome<T>>,
): Promise<McpReadOutcome<T>> {
	let completion: AdmissionCompletion = "settled";
	let outcome: McpReadOutcome<T> | undefined;
	let aborted = false;
	try {
		outcome = await read();
	} catch (error) {
		completion =
			error instanceof ReadBatchFailure || error instanceof ReadAborted
				? "settled"
				: "uncertain";
		if (error instanceof ReadAborted) aborted = true;
		else if (error instanceof ReadBatchFailure)
			outcome = { ok: false, failure: error.failure };
		else outcome = { ok: false, failure: { kind: "internal_error" } };
	}
	let cleanupFailed = false;
	try {
		await session.cancel();
	} catch {
		completion = "uncertain";
		cleanupFailed = true;
	}
	let finishSucceeded = false;
	try {
		finishSucceeded = (await session.finish(completion)).ok;
	} catch {
		finishSucceeded = false;
	}
	if (aborted) throw new ReadAborted();
	if (cleanupFailed || !finishSucceeded)
		return { ok: false, failure: { kind: "internal_error" } };
	return outcome ?? { ok: false, failure: { kind: "internal_error" } };
}

/** Read at most 256 manifest rows and reject excess data without partial success. */
export async function listMcpNotes(
	gateway: McpNotesGateway,
	identity: AuthorizationContext,
	prefix?: string,
	includeLarge = false,
	signal?: AbortSignal,
): Promise<McpReadOutcome<Pick<McpListNotesResult, "entries">>> {
	const opened = await openManifestRead(gateway, identity, undefined, signal);
	if (!opened.ok) return { ok: false, failure: opened.failure };
	return settleMcpRead(opened.body, async () => {
		const entries: McpListNotesResult["entries"][number][] = [];
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
				if (entries.length === 256)
					return { ok: false, failure: { kind: "result_too_large" } };
				if (row.updated_at === undefined)
					return { ok: false, failure: { kind: "internal_error" } };
				entries.push({
					path: row.path,
					etag: row.etag,
					size: row.size,
					updated_at: row.updated_at,
					large: row.large,
				});
			}
			if (batch.next_page !== null)
				return { ok: false, failure: { kind: "result_too_large" } };
			if (batch.done)
				return { ok: true, epoch: opened.body.body.epoch, value: { entries } };
		}
	});
}

/** Read one selected text revision and compare its ETag before returning its fragment. */
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
	try {
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
				if (signal?.aborted) throw error;
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
	} finally {
		await gateway.finishAdmission(identity, begun.ticket.id, completion);
	}
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

/** Search under existing read admission and preserve canonical coverage counts. */
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
	await result.finish("settled");
	const { epoch: _epoch, ...value } = result.body;
	return { ok: true, epoch, value };
}

/** Read at most 256 retained history rows and reject excess data without truncation. */
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
