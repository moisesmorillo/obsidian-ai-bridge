import type {
	AuthorizationContext,
	FileCommand,
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
import { decodeAndNormalizePath } from "@worker/transport/path";
import { Hono } from "hono";

/** Maximum actual UTF-8 request bytes read for any inline history command. */
const MAX_COMMAND_BYTES = 1_000_000;

/** Request facts validated before admission and deferred body decoding. */
type ValidatedHistoryCommandRequest =
	| {
			operation: "rename";
			descriptor: RenameReservation;
			match: string;
			epochHeader: string | null;
			key: string | undefined;
	  }
	| {
			operation: "append";
			descriptor: OperationDescriptor;
			epoch: string;
			key: string | undefined;
	  }
	| {
			operation: "restore";
			descriptor: OperationDescriptor;
			match: string;
			key: string | undefined;
	  };

/** Closed operation set derived from the validated transport request states. */
type HistoryCommandOperation = ValidatedHistoryCommandRequest["operation"];

/** Either validated transport state or its ordered protocol failure response. */
type HistoryCommandValidation =
	| { ok: true; request: ValidatedHistoryCommandRequest }
	| { ok: false; response: Response };

/** Handle one raw-suffix file command through reserved native admission. */
export async function handleHistoryCommand(
	request: Request,
	identity: AuthorizationContext,
	gateway: HistoryVaultGateway & Pick<TextVaultGateway, "getCurrentEpoch">,
	path: string,
	operation: HistoryCommandOperation,
): Promise<Response> {
	const validation = await validateHistoryCommandRequest(
		request,
		identity,
		gateway,
		path,
		operation,
	);
	if (!validation.ok) return validation.response;
	const commandRequest = validation.request;
	const result = await executeFileCommand(
		gateway,
		identity,
		commandRequest.descriptor,
		commandRequest.key,
		() => decodeHistoryCommand(request, path, commandRequest),
	);
	if (!result.ok) return errorResponse(result.failure);
	return Response.json(result.response.body, {
		status: result.response.status,
		headers: { ETag: result.response.body.etag },
	});
}

/** Validate command headers and descriptor before admission or body reading. */
async function validateHistoryCommandRequest(
	request: Request,
	identity: AuthorizationContext,
	gateway: HistoryVaultGateway & Pick<TextVaultGateway, "getCurrentEpoch">,
	path: string,
	operation: HistoryCommandOperation,
): Promise<HistoryCommandValidation> {
	if (!identity.scopes.includes("vault:write"))
		return { ok: false, response: errorResponse({ kind: "forbidden_scope" }) };
	const match = request.headers.get("If-Match");
	const epochHeader = request.headers.get("X-Vault-Epoch");
	const keyHeader = request.headers.get("Idempotency-Key");
	if (operation !== "rename" && request.headers.has("If-None-Match"))
		return { ok: false, response: errorResponse({ kind: "invalid_request" }) };
	const keyResult =
		keyHeader === null ? undefined : IdempotencyKeySchema.safeParse(keyHeader);
	if (keyHeader !== null && !keyResult?.success)
		return { ok: false, response: errorResponse({ kind: "invalid_request" }) };
	const key = keyResult?.success ? keyResult.data : undefined;
	switch (operation) {
		case "rename": {
			if (!match || request.headers.has("If-None-Match"))
				return {
					ok: false,
					response: errorResponse({ kind: "invalid_request" }),
				};
			try {
				const etagEpoch = parseETag(match).epoch;
				if (epochHeader !== null && epochHeader !== etagEpoch)
					return {
						ok: false,
						response: errorResponse({ kind: "invalid_request" }),
					};
			} catch {
				return {
					ok: false,
					response: errorResponse({ kind: "invalid_request" }),
				};
			}
			const reservation = RenameReservationSchema.safeParse({
				path,
				if_match: match,
				...(epochHeader === null ? {} : { epoch: epochHeader }),
			});
			if (!reservation.success)
				return {
					ok: false,
					response: errorResponse({ kind: "invalid_request" }),
				};
			return {
				ok: true,
				request: {
					operation,
					descriptor: reservation.data,
					match,
					epochHeader,
					key,
				},
			};
		}
		case "append": {
			const epoch = epochHeader ?? undefined;
			if (epoch === undefined || !EpochSchema.safeParse(epoch).success) {
				const response = await currentEpochMismatch(
					gateway,
					identity,
					operation,
				);
				return { ok: false, response };
			}
			if (match)
				return {
					ok: false,
					response: errorResponse({ kind: "invalid_request" }),
				};
			const candidate = OperationDescriptorSchema.safeParse({
				op: operation,
				paths: [path],
				precondition: { kind: "none" },
				epoch,
			});
			if (!candidate.success)
				return {
					ok: false,
					response: errorResponse({ kind: "invalid_request" }),
				};
			return {
				ok: true,
				request: { operation, descriptor: candidate.data, epoch, key },
			};
		}
		case "restore": {
			let epoch = epochHeader ?? undefined;
			if (epoch !== undefined && !EpochSchema.safeParse(epoch).success) {
				const response = await currentEpochMismatch(
					gateway,
					identity,
					operation,
				);
				return { ok: false, response };
			}
			if (epoch === undefined && match) {
				try {
					epoch = parseETag(match).epoch;
				} catch {
					return {
						ok: false,
						response: errorResponse({ kind: "invalid_request" }),
					};
				}
			}
			if (!match)
				return {
					ok: false,
					response: errorResponse({ kind: "invalid_request" }),
				};
			const candidate = OperationDescriptorSchema.safeParse({
				op: operation,
				paths: [path],
				precondition: { kind: "match", etag: match },
				...(epoch === undefined ? {} : { epoch }),
			});
			if (!candidate.success)
				return {
					ok: false,
					response: errorResponse({ kind: "invalid_request" }),
				};
			return {
				ok: true,
				request: { operation, descriptor: candidate.data, match, key },
			};
		}
	}
}

/** Return the authoritative current-epoch failure for missing or invalid epoch input. */
async function currentEpochMismatch(
	gateway: HistoryVaultGateway & Pick<TextVaultGateway, "getCurrentEpoch">,
	identity: AuthorizationContext,
	operation: "append" | "restore",
): Promise<Response> {
	const current = await gateway.getCurrentEpoch(identity, operation);
	if (!current.ok) return errorResponse(current.failure);
	return errorResponse({
		kind: "epoch_mismatch",
		current_epoch: current.current_epoch,
	});
}

/** Read and decode bytes only after application admission invokes this callback. */
async function decodeHistoryCommand(
	request: Request,
	path: string,
	commandRequest: ValidatedHistoryCommandRequest,
): Promise<FileCommand> {
	const bytes = await readBounded(request, MAX_COMMAND_BYTES);
	switch (commandRequest.operation) {
		case "append":
			return decodeAppendCommand(
				bytes,
				path,
				commandRequest.epoch,
				commandRequest.key,
			);
		case "rename":
			return decodeRenameCommand(bytes, path, commandRequest);
		case "restore":
			return decodeRestoreCommand(bytes, path, commandRequest);
	}
}

/** Build a command from exact append bytes and reject invalid UTF-8. */
async function decodeAppendCommand(
	bytes: Uint8Array,
	path: string,
	epoch: string,
	key: string | undefined,
): Promise<FileCommand> {
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		throw new FileOperationDenied({ kind: "invalid_request" });
	}
	const intent = {
		op: "append" as const,
		epoch,
		paths: [path],
		precondition: { kind: "none" as const },
		payload_hash: await hashBytes(bytes),
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

/** Parse strict UTF-8 JSON and bind canonical rename bytes to source admission. */
async function decodeRenameCommand(
	bytes: Uint8Array,
	path: string,
	commandRequest: Extract<
		ValidatedHistoryCommandRequest,
		{ operation: "rename" }
	>,
): Promise<FileCommand> {
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new FileOperationDenied({ kind: "invalid_request" });
	}
	const parsedBody = RenameRequestSchema.safeParse(json);
	if (!parsedBody.success)
		throw new FileOperationDenied({ kind: "invalid_request" });
	const body = parsedBody.data;
	const canonical = JSON.stringify({ to: body.to });
	const canonicalBytes = new TextEncoder().encode(canonical);
	const intent = {
		op: "rename" as const,
		epoch: commandRequest.epochHeader ?? parseETag(commandRequest.match).epoch,
		paths: [path, body.to],
		precondition: { kind: "match" as const, etag: commandRequest.match },
		payload_hash: await hashBytes(canonicalBytes),
		size: canonicalBytes.byteLength,
	};
	const command = FileCommandSchema.safeParse({
		op: "rename",
		intent,
		body,
		...(commandRequest.key === undefined ? {} : { key: commandRequest.key }),
	});
	if (!command.success)
		throw new FileOperationDenied({ kind: "invalid_request" });
	return command.data;
}

/** Build restore identity from canonical metadata and the observed current destination ETag. */
async function decodeRestoreCommand(
	bytes: Uint8Array,
	path: string,
	commandRequest: Extract<
		ValidatedHistoryCommandRequest,
		{ operation: "restore" }
	>,
): Promise<FileCommand> {
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new FileOperationDenied({ kind: "invalid_request" });
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
		epoch: parseETag(commandRequest.match).epoch,
		paths: [path],
		precondition: { kind: "match" as const, etag: commandRequest.match },
		payload_hash: await hashBytes(canonicalBytes),
		size: canonicalBytes.byteLength,
	};
	const command = FileCommandSchema.safeParse({
		op: "restore",
		intent,
		body,
		...(commandRequest.key === undefined ? {} : { key: commandRequest.key }),
	});
	if (!command.success)
		throw new FileOperationDenied({ kind: "invalid_request" });
	return command.data;
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
		const prefix = "/v1/history/";
		const path = pathname.startsWith(prefix)
			? decodeAndNormalizePath(pathname.slice(prefix.length))
			: undefined;
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
