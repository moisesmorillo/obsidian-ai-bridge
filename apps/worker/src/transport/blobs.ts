import {
	type AuthorizationContext,
	type BlobDeclaration,
	BlobDeclarationHeadersSchema,
	encodeFileFailure,
	selectByteRange,
	type TextReadRequest,
} from "@obsidian-ai-bridge/protocol";
import type {
	BlobContentStore,
	BlobVaultGateway,
} from "@worker/application/blobs";
import { FileOperationDenied } from "@worker/application/files";
import { assertReadDemand } from "@worker/application/read-demand";

/** Parse paired declarations and reject conflicting transport sizes before body demand. */
export function parseBlobDeclaration(
	request: Request,
): BlobDeclaration | undefined {
	const hash = request.headers.get("X-Content-SHA256");
	const size = request.headers.get("X-Content-Size");
	const parsed = BlobDeclarationHeadersSchema.safeParse({
		...(hash === null ? {} : { "x-content-sha256": hash }),
		...(size === null ? {} : { "x-content-size": size }),
	});
	if (!parsed.success) {
		const overflow = parsed.error.issues.every(
			(issue) => issue.code === "too_big" && issue.path[0] === "size",
		);
		throw new FileOperationDenied({
			kind: overflow ? "blob_too_large" : "invalid_request",
		});
	}
	const length = request.headers.get("Content-Length");
	if (
		parsed.data !== undefined &&
		length !== null &&
		(!/^(?:0|[1-9][0-9]*)$/.test(length) || Number(length) !== parsed.data.size)
	)
		throw new FileOperationDenied({ kind: "invalid_request" });
	return parsed.data;
}

/** Select authority before storage access, then stream only the selected immutable bytes. */
export async function readBlobResponse(
	gateway: Pick<BlobVaultGateway, "readBlobMetadata">,
	store: BlobContentStore,
	identity: AuthorizationContext,
	request: TextReadRequest,
	rangeHeader: string | null,
	admissionId: string,
	signal?: AbortSignal,
): Promise<Response> {
	assertReadDemand(signal);
	const selected = await gateway.readBlobMetadata(
		identity,
		request,
		admissionId,
	);
	if (!selected.ok) {
		const failure = encodeFileFailure(selected.failure);
		return Response.json(failure.body, {
			status: failure.status,
			headers: failure.headers,
		});
	}
	assertReadDemand(signal);
	const metadata = selected.body;
	if (metadata.deleted) {
		const failure = encodeFileFailure({ kind: "tombstone" });
		return Response.json(failure.body, {
			status: failure.status,
			headers: failure.headers,
		});
	}
	if (request.offset !== undefined || request.length !== undefined) {
		const failure = encodeFileFailure({ kind: "invalid_request" });
		return Response.json(failure.body, {
			status: failure.status,
			headers: failure.headers,
		});
	}
	const range =
		rangeHeader === null
			? undefined
			: selectByteRange(rangeHeader, metadata.size);
	if (rangeHeader !== null && range === undefined)
		return new Response(null, {
			status: 416,
			headers: {
				"Content-Range": `bytes */${metadata.size}`,
				ETag: metadata.etag,
				"Cache-Control": "no-transform",
				"Accept-Ranges": "bytes",
			},
		});
	const body = await store.read(metadata.hash, metadata.size, range);
	const length =
		range === undefined ? metadata.size : range.end - range.start + 1;
	const fixed = new FixedLengthStream(length);
	const sourceReader = body.getReader();
	const writer = fixed.writable.getWriter();
	let sourceStopped = false;
	let sourceCancellation: Promise<void> | undefined;
	/** Cancel the real storage reader once and retain its cleanup promise. */
	function cancelSource(reason: unknown): Promise<void> {
		if (sourceCancellation) return sourceCancellation;
		sourceCancellation = sourceReader.cancel(reason).then(() => undefined);
		return sourceCancellation;
	}
	/** Stop storage demand when request cancellation races the response consumer. */
	function onAbort(): void {
		sourceStopped = true;
		void cancelSource(signal?.reason).catch(() => undefined);
		void writer.abort(signal?.reason).catch(() => undefined);
	}
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	const piping = (async () => {
		try {
			while (!sourceStopped) {
				const item = await sourceReader.read();
				if (item.done) {
					await writer.close();
					return;
				}
				await writer.write(item.value);
			}
		} catch (error) {
			try {
				await writer.abort(error);
			} catch {
				// The fixed stream can already be aborted by response cancellation.
			}
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (sourceCancellation) await sourceCancellation;
			sourceReader.releaseLock();
		}
	})();
	void piping.catch(() => {});
	const reader = fixed.readable.getReader();
	let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
	let cancelled = false;
	const responseBody = new ReadableStream<Uint8Array>({
		type: "bytes",
		/** Forward one fixed-length chunk without holding pull open during cancellation. */
		pull(controller) {
			if (reading) return;
			const current = reader.read();
			reading = current;
			void current.then(
				(result) => {
					if (reading !== current || cancelled) return;
					reading = undefined;
					if (result.done) controller.close();
					else controller.enqueue(result.value);
				},
				(error: unknown) => {
					if (reading !== current || cancelled) return;
					reading = undefined;
					controller.error(error);
				},
			);
		},
		/** Cancel the storage reader and join the fixed-length stream pump. */
		async cancel(reason) {
			cancelled = true;
			signal?.removeEventListener("abort", onAbort);
			await Promise.allSettled([
				cancelSource(reason),
				writer.abort(reason),
				reader.cancel(reason),
				piping,
				reading,
			]);
		},
	});
	const headers = new Headers({
		ETag: metadata.etag,
		"Cache-Control": "no-transform",
		"Accept-Ranges": "bytes",
		"Content-Type": "application/octet-stream",
		"Content-Length": String(length),
		"X-File-Large": String(metadata.large),
	});
	if (range !== undefined)
		headers.set(
			"Content-Range",
			`bytes ${range.start}-${range.end}/${metadata.size}`,
		);
	return new Response(responseBody, {
		status: range === undefined ? 200 : 206,
		headers,
	});
}
