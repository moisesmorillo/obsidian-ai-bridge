import type {
	AuthorizationContext,
	FileHttpFailureInput,
	ManifestEntry,
	ManifestPage,
} from "@obsidian-ai-bridge/protocol";
import {
	encodeFileFailure,
	ReadQuerySchema,
} from "@obsidian-ai-bridge/protocol";
import { tryAcquireReadSlot } from "@worker/application/read-budget";
import { ReadAborted } from "@worker/application/read-demand";
import type {
	LazyReadSession,
	ReadBatch,
	ReadOutcome,
	ReadSession,
	ReadVaultGateway,
} from "@worker/application/reads";
import {
	openChangesRead,
	openHistoryRead,
	openManifestRead,
	ReadBatchFailure,
	readVault,
} from "@worker/application/reads";
import type { Env } from "@worker/env";
import { decodeAndNormalizePath } from "@worker/transport/path";
import {
	encodeJsonChunks,
	jsonReadSource,
	ownedReadResponse,
} from "@worker/transport/read-response";
import { Hono } from "hono";

/** Retry delay returned when all isolate read slots have owners. */
const READ_RETRY_AFTER = "1";

/** Remove the MCP-only update time before transport exposes public manifest rows. */
function openPublicManifestRead(
	gateway: ReadVaultGateway,
	identity: AuthorizationContext,
	token: string | undefined,
	signal: AbortSignal,
): Promise<
	ReadOutcome<
		LazyReadSession<ManifestEntry, Omit<ManifestPage, "entries" | "next_page">>
	>
> {
	return openManifestRead(gateway, identity, token, signal).then((opened) => {
		if (!opened.ok) return opened;
		const source = opened.body;
		const session: LazyReadSession<
			ManifestEntry,
			Omit<ManifestPage, "entries" | "next_page">
		> = {
			ok: true,
			body: source.body,
			/** Read one public batch without internal update times. */
			async readBatch() {
				const batch = await source.readBatch();
				return {
					...batch,
					rows: batch.rows.map(({ updated_at: _updatedAt, ...entry }) => entry),
				};
			},
			cancel: () => source.cancel(),
			finish: (completion) => source.finish(completion),
		};
		return { ok: true, body: session, finish: session.finish };
	});
}

/** Register bounded metadata reads and hold one shared isolate slot through response EOF. */
export function createReadRouter(
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
	resolveVault: (env: Env, request: Request) => ReadVaultGateway,
): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	router.onError(() => failureResponse({ kind: "internal_error" }));
	router.get("/vault", async (context) => {
		const parsed = readQuery(context.req.raw, []);
		if (!parsed.ok) return failureResponse(parsed.failure);
		const prepared = await prepareRead(context.req.raw, resolveIdentity);
		if (prepared instanceof Response) return prepared;
		const slot = tryAcquireReadSlot();
		if (!slot) return limitedResponse();
		return produce(
			context.env,
			context.req.raw,
			prepared,
			slot,
			resolveVault,
			(gateway, identity) =>
				readVault(gateway, identity, context.req.raw.signal),
		);
	});
	router.get("/manifest", async (context) => {
		const parsed = readQuery(context.req.raw, ["page"]);
		if (!parsed.ok) return failureResponse(parsed.failure);
		const prepared = await prepareRead(context.req.raw, resolveIdentity);
		if (prepared instanceof Response) return prepared;
		const slot = tryAcquireReadSlot();
		if (!slot) return limitedResponse();
		return produceLazy(
			context.env,
			context.req.raw,
			prepared,
			slot,
			resolveVault,
			(gateway, identity) =>
				openPublicManifestRead(
					gateway,
					identity,
					parsed.query.page,
					context.req.raw.signal,
				),
		);
	});
	router.get("/changes", async (context) => {
		const parsed = readQuery(context.req.raw, ["epoch", "since", "limit"]);
		if (!parsed.ok) return failureResponse(parsed.failure);
		if (parsed.query.epoch === undefined || parsed.query.since === undefined)
			return failureResponse({ kind: "invalid_request" });
		const prepared = await prepareRead(context.req.raw, resolveIdentity);
		if (prepared instanceof Response) return prepared;
		const slot = tryAcquireReadSlot();
		if (!slot) return limitedResponse();
		const limit =
			parsed.query.limit === undefined ? 1000 : Number(parsed.query.limit);
		return produceLazy(
			context.env,
			context.req.raw,
			prepared,
			slot,
			resolveVault,
			(gateway, identity) =>
				openChangesRead(
					gateway,
					identity,
					parsed.query.epoch as string,
					Number(parsed.query.since),
					limit,
					context.req.raw.signal,
				),
			false,
		);
	});
	router.get("/history/*", async (context) => {
		const parsed = readQuery(context.req.raw, ["page"]);
		if (!parsed.ok) return failureResponse(parsed.failure);
		const pathname = new URL(context.req.url).pathname;
		const path = pathname.startsWith("/v1/history/")
			? decodeAndNormalizePath(pathname.slice("/v1/history/".length))
			: undefined;
		if (path === undefined) return failureResponse({ kind: "invalid_path" });
		const prepared = await prepareRead(context.req.raw, resolveIdentity);
		if (prepared instanceof Response) return prepared;
		const slot = tryAcquireReadSlot();
		if (!slot) return limitedResponse();
		return produceLazy(
			context.env,
			context.req.raw,
			prepared,
			slot,
			resolveVault,
			(gateway, identity) =>
				openHistoryRead(
					gateway,
					identity,
					path,
					parsed.query.page,
					context.req.raw.signal,
				),
		);
	});
	return router;
}

/** Authenticate and check read scope before any authoritative read demand. */
async function prepareRead(
	request: Request,
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
): Promise<AuthorizationContext | Response> {
	const identity = await resolveIdentity(request);
	if (identity === null) return failureResponse({ kind: "unauthorized" });
	if (!identity.scopes.includes("vault:read"))
		return failureResponse({ kind: "forbidden_scope" });
	return identity;
}

/** Validate query key multiplicity and canonical field values without reading native data. */
function readQuery(request: Request, allowed: readonly string[]) {
	const params = new URL(request.url).searchParams;
	if ([...params.keys()].some((key) => !allowed.includes(key)))
		return {
			ok: false as const,
			failure: { kind: "invalid_request" as const },
		};
	for (const key of allowed)
		if (params.getAll(key).length > 1)
			return {
				ok: false as const,
				failure: { kind: "invalid_request" as const },
			};
	const parsed = ReadQuerySchema.safeParse(
		Object.fromEntries(params.entries()),
	);
	return parsed.success
		? { ok: true as const, query: parsed.data }
		: { ok: false as const, failure: { kind: "invalid_request" as const } };
}

/** Run one application read and transfer its durable admission to the response stream. */
async function produce<T>(
	env: Env,
	request: Request,
	identity: AuthorizationContext,
	releaseSlot: () => void,
	resolveVault: (env: Env, request: Request) => ReadVaultGateway,
	read: (
		gateway: ReadVaultGateway,
		identity: AuthorizationContext,
	) => Promise<ReadOutcome<T>>,
): Promise<Response> {
	let outcome: ReadOutcome<T>;
	try {
		outcome = await read(resolveVault(env, request), identity);
	} catch {
		releaseSlot();
		return failureResponse({ kind: "internal_error" });
	}
	if (!outcome.ok) {
		releaseSlot();
		return failureResponse(outcome.failure);
	}
	return ownedJsonResponse(outcome, releaseSlot, request.signal);
}

/** Open one lazy page and retain only its first bounded batch before response headers. */
async function produceLazy<T, M>(
	env: Env,
	request: Request,
	identity: AuthorizationContext,
	releaseSlot: () => void,
	resolveVault: (env: Env, request: Request) => ReadVaultGateway,
	read: (
		gateway: ReadVaultGateway,
		identity: AuthorizationContext,
	) => Promise<ReadOutcome<LazyReadSession<T, M>>>,
	paged = true,
): Promise<Response> {
	let opened: ReadOutcome<LazyReadSession<T, M>>;
	try {
		opened = await read(resolveVault(env, request), identity);
	} catch {
		releaseSlot();
		return failureResponse({ kind: "internal_error" });
	}
	if (!opened.ok) {
		releaseSlot();
		return failureResponse(opened.failure);
	}
	const session = opened.body;
	let first: ReadBatch<T>;
	try {
		first = await session.readBatch();
	} catch (error) {
		try {
			await session.cancel();
			await session.finish(
				error instanceof ReadBatchFailure || error instanceof ReadAborted
					? "settled"
					: "uncertain",
			);
		} finally {
			releaseSlot();
		}
		return failureResponse(
			error instanceof ReadBatchFailure
				? error.failure
				: { kind: "internal_error" },
		);
	}
	return ownedReadResponse(
		jsonReadSource(pageChunks(session, first, paged), () => session.cancel()),
		session,
		releaseSlot,
		{
			headers: { "Content-Type": "application/json; charset=UTF-8" },
		},
		request.signal,
	);
}

/** Serialize one bounded batch at a time, without requesting the next batch before row consumption. */
async function* pageChunks<T, M>(
	session: LazyReadSession<T, M>,
	batch: ReadBatch<T>,
	paged: boolean,
): AsyncGenerator<Uint8Array> {
	const encoder = new TextEncoder();
	yield encoder.encode("{");
	for (const [key, value] of Object.entries(session.body as object)) {
		yield* encodeJsonChunks(key);
		yield encoder.encode(":");
		yield* encodeJsonChunks(value);
		yield encoder.encode(",");
	}
	yield encoder.encode('"entries":[');
	let separator = "";
	while (true) {
		for (const row of batch.rows) {
			if (separator) yield encoder.encode(separator);
			separator = ",";
			yield* encodeJsonChunks(row);
		}
		if (batch.done) break;
		// Drop the consumed batch before the next native request starts.
		batch = { rows: [], done: false, next_page: null };
		batch = await session.readBatch();
	}
	yield encoder.encode("]");
	if (paged) {
		yield encoder.encode(',"next_page":');
		yield* encodeJsonChunks(batch.next_page);
	}
	yield encoder.encode("}");
}

/** Encode a scalar summary through the same response lifetime and bounded JSON producer. */
function ownedJsonResponse<T>(
	session: ReadSession<T>,
	releaseSlot: () => void,
	signal: AbortSignal,
): Response {
	return ownedReadResponse(
		jsonReadSource(encodeJsonChunks(session.body)),
		session,
		releaseSlot,
		{
			headers: { "Content-Type": "application/json; charset=UTF-8" },
		},
		signal,
	);
}

/** Return the canonical file-failure envelope with its protocol status and headers. */
function failureResponse(failure: FileHttpFailureInput): Response {
	const encoded = encodeFileFailure(failure);
	return Response.json(encoded.body, {
		status: encoded.status,
		headers: encoded.headers,
	});
}

/** Reject a fifth concurrent read without waiting or starting native data work. */
function limitedResponse(): Response {
	return failureResponse({
		kind: "admission_limited",
		retry_after_seconds: Number(READ_RETRY_AFTER),
	});
}
