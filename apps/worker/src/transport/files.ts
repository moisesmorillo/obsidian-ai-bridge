import type {
	AuthorizationContext,
	CurrentEpochOperation,
	FileHttpFailureInput,
	TextMutationDescriptor,
	TextReadRequest,
} from "@obsidian-ai-bridge/protocol";
import {
	EpochSchema,
	encodeFileFailure,
	IdempotencyKeySchema,
	parseETag,
	TextMutationDescriptorSchema,
	TextReadRequestSchema,
} from "@obsidian-ai-bridge/protocol";
import { FileOperationDenied } from "@worker/application/files";
import {
	executeTextMutation,
	type TextVaultGateway,
} from "@worker/application/text-files";
import { prepareTextPayload } from "@worker/application/text-payload";
import type { Env } from "@worker/env";
import { Hono } from "hono";

/** Maximum actual request body size accepted for inline text, in bytes. */
const MAX_TEXT_BYTES = 1_000_000;

/** Register current and historical inline text routes behind injected identity and vault authority. */
export function createFileRouter(
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
	resolveVault: (env: Env, request: Request) => TextVaultGateway,
): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	router.onError((_error, _context) =>
		errorResponse({ kind: "internal_error" }),
	);
	router.all("/*", async (context) => {
		const identity = await resolveIdentity(context.req.raw);
		if (identity === null) return errorResponse({ kind: "unauthorized" });
		const path = context.req.path.slice("/v1/files/".length);
		if (!path || path.includes("?") || path.includes("#"))
			return errorResponse({ kind: "invalid_path" });
		if (context.req.method === "GET") {
			if (!identity.scopes.includes("vault:read"))
				return errorResponse({ kind: "forbidden_scope" });
			const query = new URL(context.req.url).searchParams;
			if (
				[...query.keys()].some(
					(key) => !["rev", "offset", "length"].includes(key),
				) ||
				["rev", "offset", "length"].some((key) => query.getAll(key).length > 1)
			)
				return errorResponse({ kind: "invalid_request" });
			const rev = query.has("rev") ? Number(query.get("rev")) : undefined;
			const epochHeader = context.req.header("X-Vault-Epoch");
			const gateway = resolveVault(context.env, context.req.raw);
			if (
				(epochHeader !== undefined &&
					!EpochSchema.safeParse(epochHeader).success) ||
				(rev !== undefined && epochHeader === undefined)
			)
				return currentEpochMismatch(gateway, identity, "read");
			const epoch = epochHeader;
			const request: TextReadRequest = {
				path,
				...(epoch === undefined ? {} : { epoch }),
				...(rev === undefined ? {} : { rev }),
				...(query.has("offset") ? { offset: Number(query.get("offset")) } : {}),
				...(query.has("length") ? { length: Number(query.get("length")) } : {}),
			};
			const parsed = TextReadRequestSchema.safeParse(request);
			if (!parsed.success) return errorResponse({ kind: "invalid_request" });
			const result = await gateway.readText(identity, parsed.data);
			if (!result.ok) return errorResponse(result.failure);
			return context.json(result.body, 200, { ETag: result.body.etag });
		}
		if (context.req.method !== "PUT" && context.req.method !== "DELETE")
			return errorResponse({ kind: "not_found" });
		const requiredScope =
			context.req.method === "PUT" ? "vault:write" : "vault:delete";
		if (!identity.scopes.includes(requiredScope))
			return errorResponse({ kind: "forbidden_scope" });
		const match = context.req.header("If-Match");
		const none = context.req.header("If-None-Match");
		const epoch = context.req.header("X-Vault-Epoch");
		const keyHeader = context.req.header("Idempotency-Key");
		if (
			context.req.method === "PUT" &&
			((!match && none !== "*") || (match && none))
		)
			return errorResponse({ kind: "invalid_request" });
		if (context.req.method === "PUT" && !EpochSchema.safeParse(epoch).success) {
			const gateway = resolveVault(context.env, context.req.raw);
			return currentEpochMismatch(gateway, identity, "put");
		}
		if (context.req.method === "DELETE" && (!match || none || epoch))
			return errorResponse({ kind: "invalid_request" });
		if (context.req.method === "DELETE" && context.req.raw.body !== null)
			return errorResponse({ kind: "invalid_request" });
		if (match) {
			try {
				if (epoch && parseETag(match).epoch !== epoch)
					return errorResponse({ kind: "invalid_request" });
			} catch {
				return errorResponse({ kind: "invalid_request" });
			}
		}
		const key =
			keyHeader === undefined
				? undefined
				: IdempotencyKeySchema.safeParse(keyHeader);
		if (keyHeader !== undefined && !key?.success)
			return errorResponse({ kind: "invalid_request" });
		const descriptor: TextMutationDescriptor = {
			op: context.req.method === "PUT" ? "put" : "delete",
			paths: [path],
			precondition: match ? { kind: "match", etag: match } : { kind: "absent" },
			...(epoch === undefined ? {} : { epoch }),
		};
		const parsed = TextMutationDescriptorSchema.safeParse(descriptor);
		if (!parsed.success) return errorResponse({ kind: "invalid_request" });
		const gateway = resolveVault(context.env, context.req.raw);
		const result = await executeTextMutation(
			gateway,
			identity,
			parsed.data,
			key?.success ? key.data : undefined,
			() => readBoundedText(context.req.raw),
		);
		if (!result.ok) return errorResponse(result.failure);
		return context.json(result.response.body, result.response.status, {
			ETag: result.response.body.etag,
		});
	});
	return router;
}

/** Return an authoritative epoch mismatch after operation-specific policy checks. */
async function currentEpochMismatch(
	gateway: TextVaultGateway,
	identity: AuthorizationContext,
	operation: CurrentEpochOperation,
): Promise<Response> {
	const result = await gateway.getCurrentEpoch(identity, operation);
	if (!result.ok) return errorResponse(result.failure);
	return errorResponse({
		kind: "epoch_mismatch",
		current_epoch: result.current_epoch,
	});
}

/** Read no more than the inline text byte ceiling, regardless of Content-Length. */
async function readBoundedText(request: Request) {
	const reader = request.body?.getReader();
	if (!reader) return prepareTextPayload(new Uint8Array());
	const chunks: Uint8Array[] = [];
	let size = 0;
	let aborted = request.signal.aborted;
	/** Cancel a pending body read when the caller aborts the Request. */
	const cancelOnAbort = () => {
		aborted = true;
		void reader.cancel("Request aborted").catch(() => undefined);
	};
	request.signal.addEventListener("abort", cancelOnAbort, { once: true });
	try {
		while (true) {
			if (aborted) throw new FileOperationDenied({ kind: "invalid_request" });
			const { done, value } = await reader.read();
			if (aborted) throw new FileOperationDenied({ kind: "invalid_request" });
			if (done) break;
			size += value.byteLength;
			if (size > MAX_TEXT_BYTES) {
				await reader.cancel();
				throw new FileOperationDenied({ kind: "text_too_large" });
			}
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		request.signal.removeEventListener("abort", cancelOnAbort);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return prepareTextPayload(bytes);
}

/** Encode a canonical failure without exposing thrown exception details. */
function errorResponse(failure: FileHttpFailureInput): Response {
	const result = encodeFileFailure(failure);
	return Response.json(result.body, {
		status: result.status,
		headers: result.headers,
	});
}
