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
	gateway: BlobVaultGateway,
	store: BlobContentStore,
	identity: AuthorizationContext,
	request: TextReadRequest,
	rangeHeader: string | null,
): Promise<Response> {
	const selected = await gateway.readBlobMetadata(identity, request);
	if (!selected.ok) {
		const failure = encodeFileFailure(selected.failure);
		return Response.json(failure.body, {
			status: failure.status,
			headers: failure.headers,
		});
	}
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
				"Accept-Ranges": "bytes",
			},
		});
	const body = await store.read(metadata.hash, metadata.size, range);
	const headers = new Headers({
		ETag: metadata.etag,
		"Accept-Ranges": "bytes",
		"Content-Type": "application/octet-stream",
		"Content-Length": String(
			range === undefined ? metadata.size : range.end - range.start + 1,
		),
		"X-File-Large": String(metadata.large),
	});
	if (range !== undefined)
		headers.set(
			"Content-Range",
			`bytes ${range.start}-${range.end}/${metadata.size}`,
		);
	return new Response(body, {
		status: range === undefined ? 200 : 206,
		headers,
	});
}
