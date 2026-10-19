import type {
	AuthorizationContext,
	FileHttpFailureInput,
	OperationDescriptor,
	RenameReservation,
} from "@obsidian-ai-bridge/protocol";
import {
	EpochSchema,
	encodeFileFailure,
	FileCommandSchema,
	HistoryRequestSchema,
	IdempotencyKeySchema,
	normalizePath,
	OperationDescriptorSchema,
	parseETag,
	RenameRequestSchema,
	RenameReservationSchema,
	RestoreRequestSchema,
} from "@obsidian-ai-bridge/protocol";
import { FileOperationDenied } from "@worker/application/files";
import {
	executeFileCommand,
	type HistoryVaultGateway,
} from "@worker/application/history";
import type { TextVaultGateway } from "@worker/application/text-files";
import type { Env } from "@worker/env";
import { Hono } from "hono";

/** Maximum actual UTF-8 request bytes read for any inline history command. */
const MAX_COMMAND_BYTES = 1_000_000;

/** Handle one raw-suffix file command through reserved native admission. */
export async function handleHistoryCommand(
	request: Request,
	identity: AuthorizationContext,
	gateway: HistoryVaultGateway & Pick<TextVaultGateway, "getCurrentEpoch">,
	path: string,
	operation: "rename" | "append" | "restore",
): Promise<Response> {
	if (!identity.scopes.includes("vault:write"))
		return errorResponse({ kind: "forbidden_scope" });
	const match = request.headers.get("If-Match");
	const epochHeader = request.headers.get("X-Vault-Epoch");
	const keyHeader = request.headers.get("Idempotency-Key");
	if (operation !== "rename" && request.headers.has("If-None-Match"))
		return errorResponse({ kind: "invalid_request" });
	const keyResult =
		keyHeader === null ? undefined : IdempotencyKeySchema.safeParse(keyHeader);
	if (keyHeader !== null && !keyResult?.success)
		return errorResponse({ kind: "invalid_request" });
	const key = keyResult?.success ? keyResult.data : undefined;
	let descriptor: OperationDescriptor | RenameReservation;
	if (operation === "rename") {
		if (!match || request.headers.has("If-None-Match"))
			return errorResponse({ kind: "invalid_request" });
		try {
			const etagEpoch = parseETag(match).epoch;
			if (epochHeader !== null && epochHeader !== etagEpoch)
				return errorResponse({ kind: "invalid_request" });
		} catch {
			return errorResponse({ kind: "invalid_request" });
		}
		const reservation = RenameReservationSchema.safeParse({
			path,
			if_match: match,
			...(epochHeader === null ? {} : { epoch: epochHeader }),
		});
		if (!reservation.success) return errorResponse({ kind: "invalid_request" });
		descriptor = reservation.data;
	} else {
		const op = operation;
		let epoch = epochHeader ?? undefined;
		if (
			(op === "append" && epoch === undefined) ||
			(epoch !== undefined && !EpochSchema.safeParse(epoch).success)
		) {
			const current = await gateway.getCurrentEpoch(identity, op);
			if (!current.ok) return errorResponse(current.failure);
			return errorResponse({
				kind: "epoch_mismatch",
				current_epoch: current.current_epoch,
			});
		}
		if (op === "restore" && epoch === undefined && match) {
			try {
				epoch = parseETag(match).epoch;
			} catch {
				return errorResponse({ kind: "invalid_request" });
			}
		}
		if (op === "restore" && !match)
			return errorResponse({ kind: "invalid_request" });
		if (op === "append" && match)
			return errorResponse({ kind: "invalid_request" });
		const candidate = OperationDescriptorSchema.safeParse({
			op,
			paths: [path],
			precondition:
				op === "append" ? { kind: "none" } : { kind: "match", etag: match },
			...(epoch === undefined ? {} : { epoch }),
		});
		if (!candidate.success) return errorResponse({ kind: "invalid_request" });
		descriptor = candidate.data;
	}
	const result = await executeFileCommand(
		gateway,
		identity,
		descriptor,
		key,
		async () => {
			const bytes = await readBounded(request, MAX_COMMAND_BYTES);
			if (operation === "append") {
				let content: string;
				try {
					content = new TextDecoder("utf-8", {
						fatal: true,
						ignoreBOM: true,
					}).decode(bytes);
				} catch {
					throw new FileOperationDenied({ kind: "invalid_request" });
				}
				const hash = await hashBytes(bytes);
				const intent = {
					op: "append" as const,
					epoch: epochHeader ?? undefined,
					paths: [path],
					precondition: { kind: "none" as const },
					payload_hash: hash,
					size: bytes.byteLength,
				};
				const command = FileCommandSchema.safeParse({
					op: "append",
					intent,
					content,
					key,
				});
				if (!command.success)
					throw new FileOperationDenied({ kind: "invalid_request" });
				return command.data;
			}
			let json: unknown;
			try {
				json = JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(bytes),
				);
			} catch {
				throw new FileOperationDenied({ kind: "invalid_request" });
			}
			if (operation === "rename") {
				const parsedBody = RenameRequestSchema.safeParse(json);
				if (!parsedBody.success)
					throw new FileOperationDenied({ kind: "invalid_request" });
				const body = parsedBody.data;
				const canonical = JSON.stringify({ to: body.to });
				const intent = {
					op: "rename" as const,
					epoch: epochHeader ?? parseETag(match ?? "").epoch,
					paths: [path, body.to],
					precondition: { kind: "match" as const, etag: match ?? "" },
					payload_hash: await hashBytes(new TextEncoder().encode(canonical)),
					size: new TextEncoder().encode(canonical).byteLength,
				};
				const command = FileCommandSchema.safeParse({
					op: "rename",
					intent,
					body,
					...(key === undefined ? {} : { key }),
				});
				if (!command.success)
					throw new FileOperationDenied({ kind: "invalid_request" });
				return command.data;
			}
			const parsedBody = RestoreRequestSchema.safeParse(json);
			if (!parsedBody.success)
				throw new FileOperationDenied({ kind: "invalid_request" });
			const body = parsedBody.data;
			const canonical = JSON.stringify({
				source_rev: body.source_rev,
				as_conflict_copy: body.as_conflict_copy ?? false,
			});
			const canonicalBytes = new TextEncoder().encode(canonical);
			const intent = {
				op: "restore" as const,
				epoch: parseETag(match ?? "").epoch,
				paths: [path],
				precondition: { kind: "match" as const, etag: match ?? "" },
				payload_hash: await hashBytes(canonicalBytes),
				size: canonicalBytes.byteLength,
			};
			const command = FileCommandSchema.safeParse({
				op: "restore",
				intent,
				body,
				...(key === undefined ? {} : { key }),
			});
			if (!command.success)
				throw new FileOperationDenied({ kind: "invalid_request" });
			return command.data;
		},
	);
	if (!result.ok) return errorResponse(result.failure);
	return Response.json(result.response.body, {
		status: result.response.status,
		headers: { ETag: result.response.body.etag },
	});
}

/** Register current content-free history reads with decoded canonical paths. */
export function createHistoryRouter(
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
	resolveVault: (env: Env, request: Request) => HistoryVaultGateway,
): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	router.onError(() => errorResponse({ kind: "internal_error" }));
	router.get("/*", async (context) => {
		const identity = await resolveIdentity(context.req.raw);
		if (identity === null) return errorResponse({ kind: "unauthorized" });
		if (!identity.scopes.includes("vault:read"))
			return errorResponse({ kind: "forbidden_scope" });
		const pathname = new URL(context.req.url).pathname;
		const path = decodeRoutePath(pathname, "/v1/history/");
		if (path === undefined) return errorResponse({ kind: "invalid_path" });
		if (new URL(context.req.url).search)
			return errorResponse({ kind: "invalid_request" });
		const gateway = resolveVault(context.env, context.req.raw);
		const request = HistoryRequestSchema.safeParse({ path });
		if (!request.success) return errorResponse({ kind: "invalid_path" });
		const result = await gateway.readHistory(identity, request.data);
		if (!result.ok) return errorResponse(result.failure);
		return context.json(result.entries);
	});
	return router;
}

/** Extract and decode a route path once after checking its literal prefix. */
export function decodeRoutePath(
	pathname: string,
	prefix: string,
): string | undefined {
	if (!pathname.startsWith(prefix)) return undefined;
	try {
		return normalizePath(decodeURIComponent(pathname.slice(prefix.length)));
	} catch {
		return undefined;
	}
}

/** Read a body under its actual byte ceiling and cancel on failure or abort. */
async function readBounded(
	request: Request,
	limit: number,
): Promise<Uint8Array> {
	const reader = request.body?.getReader();
	if (reader === undefined) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	/** Cancel any pending stream read when the request aborts. */
	const cancel = () => {
		void reader.cancel("Request aborted").catch(() => undefined);
	};
	request.signal.addEventListener("abort", cancel, { once: true });
	try {
		while (true) {
			if (request.signal.aborted)
				throw new FileOperationDenied({ kind: "invalid_request" });
			const item = await reader.read();
			if (request.signal.aborted)
				throw new FileOperationDenied({ kind: "invalid_request" });
			if (item.done) break;
			size += item.value.byteLength;
			if (size > limit) {
				await reader.cancel();
				throw new FileOperationDenied({ kind: "text_too_large" });
			}
			chunks.push(item.value);
		}
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		request.signal.removeEventListener("abort", cancel);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/** Return the lowercase SHA-256 digest for exact request bytes. */
async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Encode a transport or canonical domain failure without exception details. */
function errorResponse(failure: FileHttpFailureInput): Response {
	const result = encodeFileFailure(failure);
	return Response.json(result.body, {
		status: result.status,
		headers: result.headers,
	});
}
