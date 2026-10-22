import type {
	AuthorizationContext,
	FileHttpFailureInput,
	SearchResult,
} from "@obsidian-ai-bridge/protocol";
import {
	encodeFileFailure,
	SearchLimitSchema,
	SearchRequestSchema,
	searchQueryFailure,
} from "@obsidian-ai-bridge/protocol";
import { tryAcquireReadSlot } from "@worker/application/read-budget";
import { ReadAborted } from "@worker/application/read-demand";
import type { ReadOutcome } from "@worker/application/reads";
import type { SearchVaultGateway } from "@worker/application/search";
import { readSearch } from "@worker/application/search";
import type { Env } from "@worker/env";
import {
	encodeJsonChunks,
	jsonReadSource,
	ownedReadResponse,
} from "@worker/transport/read-response";
import { Hono } from "hono";

/** Register strict literal search and retain the shared read slot through response EOF. */
export function createSearchRouter(
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
	resolveVault: (env: Env, request: Request) => SearchVaultGateway,
): Hono<{ Bindings: Env }> {
	const router = new Hono<{ Bindings: Env }>();
	router.get("/search", async (context) => {
		const parsed = parseSearchQuery(context.req.raw);
		if (!parsed.ok) return failureResponse(parsed.failure);
		const identity = await resolveIdentity(context.req.raw);
		if (identity === null) return failureResponse({ kind: "unauthorized" });
		if (!identity.scopes.includes("vault:read"))
			return failureResponse({ kind: "forbidden_scope" });
		const release = tryAcquireReadSlot();
		if (!release)
			return failureResponse({
				kind: "admission_limited",
				retry_after_seconds: 1,
			});
		let outcome: ReadOutcome<SearchResult>;
		try {
			outcome = await readSearch(
				resolveVault(context.env, context.req.raw),
				identity,
				parsed.request,
				context.req.raw.signal,
			);
		} catch (error) {
			release();
			return failureResponse(
				error instanceof ReadAborted
					? { kind: "invalid_request" }
					: { kind: "internal_error" },
			);
		}
		if (!outcome.ok) {
			release();
			return failureResponse(outcome.failure);
		}
		return ownedReadResponse(
			jsonReadSource(encodeJsonChunks(outcome.body)),
			outcome,
			release,
			{ headers: { "Content-Type": "application/json" } },
			context.req.raw.signal,
		);
	});
	return router;
}

/** Reject unknown or repeated parameters before parsing canonical search values. */
function parseSearchQuery(request: Request) {
	const params = new URL(request.url).searchParams;
	if ([...params.keys()].some((key) => key !== "q" && key !== "limit"))
		return {
			ok: false as const,
			failure: { kind: "invalid_request" as const },
		};
	if (params.getAll("q").length !== 1 || params.getAll("limit").length > 1)
		return {
			ok: false as const,
			failure: { kind: "invalid_request" as const },
		};
	const query = params.get("q");
	if (query === null)
		return {
			ok: false as const,
			failure: { kind: "invalid_request" as const },
		};
	const queryFailure = searchQueryFailure(query);
	if (queryFailure !== undefined)
		return { ok: false as const, failure: { kind: queryFailure } };
	const rawLimit = params.get("limit");
	if (rawLimit !== null && !/^(?:0|[1-9][0-9]*)$/.test(rawLimit))
		return {
			ok: false as const,
			failure: { kind: "invalid_request" as const },
		};
	const parsedLimit = SearchLimitSchema.safeParse(
		rawLimit === null ? undefined : Number(rawLimit),
	);
	if (!parsedLimit.success)
		return {
			ok: false as const,
			failure: { kind: "invalid_request" as const },
		};
	const requestValue = SearchRequestSchema.parse({
		query,
		limit: parsedLimit.data,
	});
	return { ok: true as const, request: requestValue };
}

/** Encode only canonical safe HTTP failure fields. */
function failureResponse(failure: FileHttpFailureInput): Response {
	const encoded = encodeFileFailure(failure);
	return new Response(JSON.stringify(encoded.body), {
		status: encoded.status,
		headers: {
			"Content-Type": "application/json",
			...encoded.headers,
		},
	});
}
