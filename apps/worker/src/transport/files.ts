import type {
	AuthorizationContext,
	CurrentEpochOperation,
	TextMutationDescriptor,
	TextReadRequest,
} from "@obsidian-ai-bridge/protocol";
import {
	EpochSchema,
	IdempotencyKeySchema,
	parseETag,
	TextMutationDescriptorSchema,
	TextReadRequestSchema,
} from "@obsidian-ai-bridge/protocol";
import {
	type BlobContentStore,
	executeBlobPut,
	usesBlobStorage,
} from "@worker/application/blobs";
import { FileOperationDenied } from "@worker/application/files";
import type { HistoryVaultGateway } from "@worker/application/history";
import {
	executeTextMutation,
	type TextVaultGateway,
} from "@worker/application/text-files";
import { prepareTextPayload } from "@worker/application/text-payload";
import type { Env } from "@worker/env";
import {
	parseBlobDeclaration,
	readBlobResponse,
} from "@worker/transport/blobs";
import { readInlineBody } from "@worker/transport/body";
import { handleHistoryCommand } from "@worker/transport/history";
import {
	fileFailureResponse as errorResponse,
	withMutationResponse,
} from "@worker/transport/mutation-response";
import { decodeAndNormalizePath } from "@worker/transport/path";
import { Hono } from "hono";

/** Maximum actual request body size accepted for inline text, in bytes. */
const MAX_TEXT_BYTES = 1_000_000;

/** Register current and historical inline text routes behind injected identity and vault authority. */
export function createFileRouter(
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
	resolveVault: (
		env: Env,
		request: Request,
	) => TextVaultGateway & HistoryVaultGateway,
	resolveBlobs: (env: Env) => BlobContentStore,
): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	router.onError((error) =>
		errorResponse(
			error instanceof FileOperationDenied
				? error.failure
				: { kind: "internal_error" },
		),
	);
	router.all("/*", async (context) => {
		const identity = await resolveIdentity(context.req.raw);
		if (identity === null) return errorResponse({ kind: "unauthorized" });
		const rawPath = new URL(context.req.url).pathname;
		const command = fileCommandFromPath(rawPath);
		if (command !== undefined) {
			if (context.req.method !== "POST")
				return errorResponse({ kind: "not_found" });
			const { path, operation } = command;
			if (path === undefined) return errorResponse({ kind: "invalid_path" });
			return handleHistoryCommand(
				context.req.raw,
				identity,
				resolveVault(context.env, context.req.raw),
				path,
				operation,
			);
		}
		const path = filePathFromRequest(context.req.raw);
		if (path === undefined) return errorResponse({ kind: "invalid_path" });
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
			if (!result.ok) {
				if (result.failure.kind === "not_implemented")
					return readBlobResponse(
						gateway,
						resolveBlobs(context.env),
						identity,
						parsed.data,
						context.req.raw.headers.get("Range"),
					);
				return errorResponse(result.failure);
			}
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
		const declaration =
			context.req.method === "PUT"
				? parseBlobDeclaration(context.req.raw)
				: undefined;
		const isBlob =
			context.req.method === "PUT" && usesBlobStorage(path, declaration);
		if (isBlob && declaration === undefined)
			return errorResponse({ kind: "invalid_request" });
		/** Bind response production only to PUT. DELETE does not acquire body capacity. */
		const execute = async (
			responseProduction?: Promise<void>,
		): Promise<Response> => {
			const result =
				isBlob && declaration !== undefined
					? await executeBlobPut(
							gateway,
							resolveBlobs(context.env),
							identity,
							parsed.data,
							key?.success ? key.data : undefined,
							declaration,
							context.req.raw.body ?? new Blob([]).stream(),
							context.req.raw.signal,
							responseProduction,
						)
					: await executeTextMutation(
							gateway,
							identity,
							parsed.data,
							key?.success ? key.data : undefined,
							() => readBoundedText(context.req.raw),
							declaration,
							responseProduction,
						);
			if (!result.ok) return errorResponse(result.failure);
			return context.json(result.response.body, result.response.status, {
				ETag: result.response.body.etag,
			});
		};
		return context.req.method === "PUT"
			? withMutationResponse(execute)
			: execute();
	});
	return router;
}

/** Find a literal command suffix before decoding the source path exactly once. */
function fileCommandFromPath(
	pathname: string,
):
	| { path: string | undefined; operation: "rename" | "append" | "restore" }
	| undefined {
	const prefix = "/v1/files/";
	if (!pathname.startsWith(prefix)) return undefined;
	for (const operation of ["rename", "append", "restore"] as const) {
		const suffix = `:${operation}`;
		if (!pathname.endsWith(suffix)) continue;
		return {
			path: decodeAndNormalizePath(
				pathname.slice(prefix.length, -suffix.length),
			),
			operation,
		};
	}
	return undefined;
}

/** Decode the raw file URL path once, then apply the canonical path contract. */
function filePathFromRequest(request: Request): string | undefined {
	const pathname = new URL(request.url).pathname;
	const prefix = "/v1/files/";
	if (!pathname.startsWith(prefix)) return undefined;
	return decodeAndNormalizePath(pathname.slice(prefix.length));
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
	return prepareTextPayload(await readInlineBody(request, MAX_TEXT_BYTES));
}
