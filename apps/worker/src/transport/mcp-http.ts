import {
	INVALID_PARAMS,
	isCallToolResult,
	isJSONRPCErrorResponse,
	isJSONRPCNotification,
	isJSONRPCRequest,
	isJSONRPCResultResponse,
	type JSONRPCMessage,
	SUPPORTED_PROTOCOL_VERSIONS,
	type Transport,
} from "@modelcontextprotocol/server";
import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import {
	encodeFileFailure,
	type FileFailure,
	McpToolErrorSchema,
} from "@obsidian-ai-bridge/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import type {
	McpNotesGateway,
	McpReadOwner,
} from "@worker/application/mcp-notes";
import { currentMcpEpoch } from "@worker/application/mcp-notes";
import { tryAcquireReadSlot } from "@worker/application/read-budget";
import type { Env } from "@worker/env";
import {
	createMcpServer,
	mcpMutationScope,
	mutationInputFailure,
} from "@worker/transport/mcp";
import {
	encodeJsonChunks,
	jsonReadSource,
	ownedReadResponse,
} from "@worker/transport/read-response";

/** Maximum wire bytes accepted for one MCP envelope. */
const MCP_BODY_LIMIT = 6_100_000;
/** Limit nesting before the SDK sees a materialized JSON value. */
const MCP_MAX_DEPTH = 64;
/** Bound all container separators and string tokens in the decoded envelope. */
const MCP_MAX_STRUCTURAL_TOKENS = 65_536;
/** Bound comma separators within one individual container. */
const MCP_MAX_CONTAINER_ITEMS = 16_384;
let mcpEnvelopeActive = false;

/** Hold one MCP request across body demand, dispatch, response production, and cancellation. */
function acquireMcpEnvelope(): (() => void) | undefined {
	if (mcpEnvelopeActive) return undefined;
	mcpEnvelopeActive = true;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		mcpEnvelopeActive = false;
	};
}

/** Read a bounded request body before JSON parsing. */
async function readEnvelope(request: Request): Promise<string> {
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > MCP_BODY_LIMIT)
	)
		throw new RangeError("MCP request exceeds its byte limit");
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("MCP request body is empty");
	const bytes = new Uint8Array(MCP_BODY_LIMIT);
	let total = 0;
	let completed = false;
	/** Stop a pending body read so abort cleanup can release its slot. */
	const cancelEnvelope = () => {
		void reader.cancel(request.signal.reason).catch(() => undefined);
	};
	if (request.signal.aborted) cancelEnvelope();
	else request.signal.addEventListener("abort", cancelEnvelope, { once: true });
	try {
		for (;;) {
			if (request.signal.aborted)
				throw new DOMException("Request aborted", "AbortError");
			const item = await reader.read();
			if (request.signal.aborted)
				throw new DOMException("Request aborted", "AbortError");
			if (item.done) {
				completed = true;
				break;
			}
			if (total + item.value.byteLength > MCP_BODY_LIMIT)
				throw new RangeError("MCP request exceeds its byte limit");
			bytes.set(item.value, total);
			total += item.value.byteLength;
		}
	} finally {
		request.signal.removeEventListener("abort", cancelEnvelope);
		if (!completed) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, total),
		);
	} catch {
		throw new SyntaxError("MCP request body is not valid UTF-8");
	}
}

/** Scan JSON delimiters and string tokens before JSON.parse can build a full object tree. */
function checkEnvelopeStructure(source: string): void {
	const containerCommas = new Uint32Array(MCP_MAX_DEPTH);
	let depth = 0;
	let containers = 0;
	let separators = 0;
	let strings = 0;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === '"') {
			strings += 1;
			if (strings > MCP_MAX_STRUCTURAL_TOKENS)
				throw new RangeError("MCP request exceeds structural complexity limit");
			for (index += 1; index < source.length; index += 1) {
				if (source[index] === "\\") {
					index += 1;
					continue;
				}
				if (source[index] === '"') break;
			}
			continue;
		}
		if (character === "{" || character === "[") {
			depth += 1;
			containers += 1;
			if (depth > MCP_MAX_DEPTH || containers > MCP_MAX_STRUCTURAL_TOKENS)
				throw new RangeError("MCP request exceeds structural complexity limit");
			containerCommas[depth - 1] = 0;
			continue;
		}
		if (character === "}" || character === "]") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (character === ",") {
			separators += 1;
			if (separators > MCP_MAX_STRUCTURAL_TOKENS)
				throw new RangeError("MCP request exceeds structural complexity limit");
			if (depth > 0) {
				containerCommas[depth - 1] += 1;
				if (containerCommas[depth - 1] >= MCP_MAX_CONTAINER_ITEMS)
					throw new RangeError(
						"MCP request exceeds structural complexity limit",
					);
			}
		}
	}
}

/** Provide a no-op owner for SDK failures without an application admission. */
const EMPTY_MCP_READ_OWNER = { finish: async () => ({ ok: true as const }) };

/** Keep the read owner and local slots through JSON production and cancellation. */
function encodedResponse(
	message: JSONRPCMessage,
	release: () => void,
	signal: AbortSignal,
	owner?: McpReadOwner,
	status = 200,
): Response {
	return ownedReadResponse(
		jsonReadSource(
			encodeJsonChunks(message),
			() => owner?.cancel() ?? Promise.resolve(),
		),
		owner ?? EMPTY_MCP_READ_OWNER,
		release,
		{
			status,
			headers: {
				"content-type": "application/json",
				"cache-control": "no-store",
			},
		},
		signal,
	);
}

/** Add the authorized epoch and preserve missing-key failures across SDK argument validation. */
function withAuthorizedEpoch(
	message: JSONRPCMessage,
	epoch: string,
	inputFailure?: FileFailure,
): JSONRPCMessage {
	if (isJSONRPCErrorResponse(message)) {
		if (
			inputFailure?.kind !== "idempotency_key_required" ||
			message.error.code !== INVALID_PARAMS
		)
			return message;
	} else if (
		!isJSONRPCResultResponse(message) ||
		!isCallToolResult(message.result) ||
		!message.result.isError ||
		message.result.structuredContent !== undefined
	)
		return message;
	if (message.id === undefined || message.id === null) return message;
	return {
		jsonrpc: "2.0",
		id: message.id,
		result: {
			content: [],
			isError: true,
			structuredContent: McpToolErrorSchema.parse({
				epoch,
				code: inputFailure?.kind ?? "invalid_request",
				message: "Tool input failed canonical schema validation.",
			}),
		},
	};
}

/** Minimal per-request SDK transport with stateless JSON response delivery. */
class McpJsonTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: (message: JSONRPCMessage) => void;
	private resolveMessage?: (message: JSONRPCMessage) => void;
	private pending: Promise<JSONRPCMessage | null> | undefined;

	/** Keep the checked epoch for SDK validation errors before tool callbacks. */
	constructor(
		private readonly epoch: string,
		private readonly inputFailure?: FileFailure,
	) {}

	/** Start this single-request transport. */
	async start(): Promise<void> {}

	/** Deliver an SDK response through the owning HTTP response stream. */
	async send(message: JSONRPCMessage): Promise<void> {
		this.resolveMessage?.(
			withAuthorizedEpoch(message, this.epoch, this.inputFailure),
		);
	}

	/** Close this stateless request transport. */
	async close(): Promise<void> {
		this.onclose?.();
	}

	/** Dispatch one parsed envelope through MCP SDK semantics and wait for its response. */
	async receive(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
		if ("method" in message && !("id" in message)) {
			this.onmessage?.(message);
			return null;
		}
		this.pending = new Promise((resolve) => {
			this.resolveMessage = resolve;
		});
		this.onmessage?.(message);
		return this.pending;
	}
}

/** Build no-store headers and an optional OAuth resource challenge. */
function httpFailureHeaders(
	challenge: boolean,
	serviceOrigin?: string,
): Headers {
	const headers = new Headers({ "cache-control": "no-store" });
	if (challenge && serviceOrigin)
		headers.set(
			"www-authenticate",
			`Bearer resource_metadata="${serviceOrigin}/.well-known/oauth-protected-resource"`,
		);
	return headers;
}

/** Return one eager HTTP failure before read ownership starts. */
function httpFailure(
	status: number,
	code: string,
	challenge = false,
	serviceOrigin?: string,
): Response {
	return Response.json(
		{ error: code },
		{
			status,
			headers: httpFailureHeaders(challenge, serviceOrigin),
		},
	);
}

/** Keep an acquired read slot and durable owner through a bounded HTTP error body. */
function ownedHttpFailure(
	status: number,
	code: string,
	release: () => void,
	signal: AbortSignal,
	challenge = false,
	serviceOrigin?: string,
	owner?: McpReadOwner,
): Response {
	return ownedReadResponse(
		jsonReadSource(
			encodeJsonChunks({ error: code }),
			() => owner?.cancel() ?? Promise.resolve(),
		),
		owner ?? EMPTY_MCP_READ_OWNER,
		release,
		{
			status,
			headers: httpFailureHeaders(challenge, serviceOrigin),
		},
		signal,
	);
}

/** Handle one authenticated stateless Streamable HTTP MCP request. */
export async function handleMcpHttp(
	request: Request,
	env: Env,
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
	resolveGateway: (env: Env, request: Request) => McpNotesGateway,
	resolveBlobs: (env: Env) => BlobContentStore,
): Promise<Response> {
	if (request.method === "GET" || request.method === "DELETE")
		return new Response(null, { status: 405, headers: { allow: "POST" } });
	if (request.method !== "POST")
		return new Response(null, { status: 405, headers: { allow: "POST" } });
	const origin = request.headers.get("origin");
	if (origin !== null && origin !== env.SERVICE_ORIGIN)
		return httpFailure(403, "invalid_origin");
	const contentType = (request.headers.get("content-type") ?? "")
		.split(";", 1)[0]
		.trim()
		.toLowerCase();
	if (contentType !== "application/json")
		return httpFailure(415, "unsupported_media_type");
	const accept = (request.headers.get("accept") ?? "").toLowerCase();
	if (
		!accept.includes("application/json") ||
		!accept.includes("text/event-stream")
	)
		return httpFailure(406, "not_acceptable");
	const identity = await resolveIdentity(request);
	if (identity === null)
		return httpFailure(401, "unauthorized", true, env.SERVICE_ORIGIN);
	if (
		!identity.scopes.some((scope) =>
			["vault:read", "vault:write", "vault:delete"].includes(scope),
		)
	)
		return httpFailure(403, "forbidden_scope", true, env.SERVICE_ORIGIN);
	const releaseEnvelope = acquireMcpEnvelope();
	if (!releaseEnvelope)
		return new Response(null, { status: 429, headers: { "retry-after": "1" } });
	let releaseRead: (() => void) | undefined;
	/** Release every isolate slot acquired by this tool request. */
	const release = () => {
		releaseRead?.();
		releaseRead = undefined;
		releaseEnvelope();
	};
	let readOwner: McpReadOwner | undefined;
	let closeServer: (() => Promise<void>) | undefined;
	try {
		const gateway = resolveGateway(env, request);
		const epoch = await currentMcpEpoch(gateway, identity);
		if (!epoch.ok)
			return ownedHttpFailure(
				epoch.failure.kind === "revoked" ? 401 : 403,
				epoch.failure.kind,
				release,
				request.signal,
				epoch.failure.kind !== "revoked",
				env.SERVICE_ORIGIN,
			);
		const protocolVersion = request.headers.get("mcp-protocol-version");
		if (
			protocolVersion !== null &&
			!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
		)
			return ownedHttpFailure(
				400,
				"unsupported_protocol_version",
				release,
				request.signal,
			);
		const body = await readEnvelope(request);
		checkEnvelopeStructure(body);
		const parsedMessage: unknown = JSON.parse(body);
		if (
			!isJSONRPCRequest(parsedMessage) &&
			!isJSONRPCNotification(parsedMessage)
		)
			return ownedHttpFailure(400, "invalid_request", release, request.signal);
		const message: JSONRPCMessage = parsedMessage;
		const callName =
			"method" in message && message.method === "tools/call"
				? message.params?.name
				: undefined;
		const mutationScope = mcpMutationScope(callName);
		if (mutationScope !== undefined && !identity.scopes.includes(mutationScope))
			return ownedHttpFailure(
				403,
				"forbidden_scope",
				release,
				request.signal,
				true,
				env.SERVICE_ORIGIN,
			);
		const readTools = new Set([
			"list_notes",
			"read_note",
			"search_notes",
			"get_history",
		]);
		if (typeof callName === "string" && readTools.has(callName)) {
			if (!identity.scopes.includes("vault:read")) {
				release();
				return httpFailure(403, "forbidden_scope", true, env.SERVICE_ORIGIN);
			}
			releaseRead = tryAcquireReadSlot();
			if (!releaseRead) {
				releaseEnvelope();
				return new Response(null, {
					status: 429,
					headers: { "retry-after": "1" },
				});
			}
		}
		let boundaryFailure: string | undefined;
		/** Resolve mutation body-slot ownership after its response owner settles. */
		let resolveResponseProduction: () => void = () => {};
		const responseProduction = new Promise<void>((resolve) => {
			resolveResponseProduction = resolve;
		});
		const server = createMcpServer(
			identity,
			gateway,
			resolveBlobs(env),
			(owner: McpReadOwner) => {
				readOwner = owner;
			},
			responseProduction,
			resolveResponseProduction,
			request.signal,
			(kind: string) => {
				boundaryFailure = kind;
			},
		);
		const inputFailure = mutationInputFailure(
			callName,
			message.params?.arguments,
		);
		const transport = new McpJsonTransport(epoch.epoch, inputFailure);
		closeServer = () => server.close();
		await server.connect(transport);
		const response = await transport.receive(message);
		if (boundaryFailure !== undefined) {
			await server.close();
			return ownedHttpFailure(
				boundaryFailure === "revoked" ? 401 : 403,
				boundaryFailure,
				release,
				request.signal,
				boundaryFailure !== "revoked",
				env.SERVICE_ORIGIN,
				readOwner,
			);
		}
		if (response === null) {
			await server.close();
			release();
			return new Response(null, {
				status: 202,
				headers: { "cache-control": "no-store" },
			});
		}
		await server.close();
		return encodedResponse(
			response,
			release,
			request.signal,
			readOwner,
			inputFailure?.kind === "idempotency_key_required"
				? encodeFileFailure(inputFailure).status
				: 200,
		);
	} catch (error) {
		await closeServer?.().catch(() => undefined);
		if (error instanceof RangeError)
			return ownedHttpFailure(
				413,
				error.message.includes("structural complexity")
					? "request_too_complex"
					: "request_too_large",
				release,
				request.signal,
				false,
				undefined,
				readOwner,
			);
		if (error instanceof SyntaxError)
			return ownedHttpFailure(
				400,
				"invalid_json",
				release,
				request.signal,
				false,
				undefined,
				readOwner,
			);
		return ownedHttpFailure(
			500,
			"internal_error",
			release,
			request.signal,
			false,
			undefined,
			readOwner,
		);
	}
}
