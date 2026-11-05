import {
	type MeasurementResponse,
	MeasurementResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import type {
	ClientRegistryGateway,
	OwnerCleanupExternalCallBudget,
} from "@worker/application/clients";
import {
	consumeOwnerCsrf,
	listClientGrants,
	listClients,
	renameClient,
	revokeClient,
	storeOwnerCsrf,
} from "@worker/application/clients";
import type { Env } from "@worker/env";
import { verifyOwnerAccess } from "@worker/infrastructure/auth/access";
import { createProviderGrantCleanup } from "@worker/infrastructure/auth/oauth";
import { Hono } from "hono";

/** Browser cookie that binds one-use owner form state to this browser. */
const OWNER_BROWSER_COOKIE = "__Host-oab-owner";
/** Owner form state expires after ten minutes. */
const OWNER_STATE_TTL_MS = 10 * 60 * 1000;
/** Maximum accepted owner form body. */
const OWNER_FORM_LIMIT = 4_096;
/** Cap provider KV calls and registry RPCs, including CSRF, but not inner DO SQL. */
const OWNER_CLEANUP_EXTERNAL_CALL_LIMIT = 48;

/** Resolve the authoritative registry for the configured canonical service vault. */
export type OwnerRegistryResolver = (
	env: Env,
	request: Request,
) => ClientRegistryGateway;

/** Resolve owner-only measurements from the host-selected Vault. */
export type OwnerMeasurementResolver = (
	env: Env,
	request: Request,
) => {
	/** Verify owner subject in the Vault before any measurement observation read. */
	readMeasurements(ownerSubject: string): Promise<MeasurementResponse | null>;
};

/** Escape provider-controlled and owner-controlled strings before HTML rendering. */
function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return entities[character] ?? character;
	});
}

/** Read one named cookie without treating unrelated cookie data as trusted input. */
function readCookie(request: Request, name: string): string | null {
	for (const item of request.headers.get("cookie")?.split(";") ?? []) {
		const [key, ...rest] = item.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return null;
}

/** Return a no-store response with a safely rendered finite client page. */
export function createOwnerHandler(
	resolveRegistry: OwnerRegistryResolver,
	resolveMeasurements?: OwnerMeasurementResolver,
): ExportedHandler<Env> {
	const app = new Hono<{ Bindings: Env }>();
	app.get("/owner/clients", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return context.text("Unauthorized", 401);
		const origin = context.env.SERVICE_ORIGIN;
		if (!origin || new URL(context.req.url).origin !== origin)
			return context.text("Not found", 404);
		const browserId =
			readCookie(context.req.raw, OWNER_BROWSER_COOKIE) ?? crypto.randomUUID();
		if (!isUuid(browserId)) return context.text("Unauthorized", 401);
		const state = crypto.randomUUID();
		const registry = resolveRegistry(context.env, context.req.raw);
		await storeOwnerCsrf(registry, {
			owner_subject: owner.subject,
			browser_id: browserId,
			state,
			expires_at: Date.now() + OWNER_STATE_TTL_MS,
		});
		const page = await listClients(
			registry,
			owner.subject,
			context.req.query("cursor"),
		);
		const clientMarkup = page.clients
			.map((client) => {
				const stateLabel =
					client.grant_count === 0
						? "No accepted grants"
						: client.active_grant_count === 0
							? "Revoked"
							: client.active_grant_count < client.grant_count
								? "Mixed active and revoked history"
								: "Active registry grant";
				const cleanupLabel =
					client.cleanup_pending_count === 0
						? "No provider cleanup pending"
						: `${client.cleanup_pending_count} provider cleanup pending`;
				const grantLink = `<a href="/owner/clients/${encodeURIComponent(client.client_id)}/grants">View grants (${client.grant_count})</a>`;
				return `<li><h2>${escapeHtml(client.name || client.client_id)}</h2><p>Client: ${escapeHtml(client.client_id)}</p><p>Registry state: ${stateLabel}</p><p>${cleanupLabel}</p><p>Grant counts show retained grant history. Active registry grants do not prove that provider tokens are current or unexpired.</p>${grantLink}<form method="post" action="/owner/clients/${encodeURIComponent(client.client_id)}/rename"><input type="hidden" name="csrf" value="${state}"><label>Name <input name="name" maxlength="80" value="${escapeHtml(client.name)}"></label><button>Rename</button></form><form method="post" action="/owner/clients/${encodeURIComponent(client.client_id)}/revoke"><input type="hidden" name="csrf" value="${state}"><button>Revoke</button></form></li>`;
			})
			.join("");
		const next = page.next_cursor
			? `<a href="/owner/clients?cursor=${encodeURIComponent(page.next_cursor)}">Next page</a>`
			: "";
		return new Response(
			`<!doctype html><html><head><meta charset="utf-8"><title>Owner clients</title></head><body><main><h1>Connected clients</h1><p><a href="/owner/measurements?format=html">Service measurements</a></p><ul>${clientMarkup}</ul>${next}</main></body></html>`,
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"set-cookie": `${OWNER_BROWSER_COOKIE}=${browserId}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`,
				},
			},
		);
	});

	app.get("/owner/measurements", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return noStoreText("Unauthorized", 401);
		if (!isCanonicalOwnerOrigin(context.req.raw, context.env))
			return noStoreText("Not found", 404);
		if (!resolveMeasurements) return noStoreText("Unavailable", 503);
		try {
			const gateway = resolveMeasurements(context.env, context.req.raw);
			const response = await gateway.readMeasurements(owner.subject);
			if (!response) return noStoreText("Forbidden", 403);
			const parsed = MeasurementResponseSchema.parse(response);
			if (context.req.query("format") === "html")
				return new Response(renderMeasurements(parsed), {
					headers: {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-store",
					},
				});
			return new Response(JSON.stringify(parsed), {
				headers: {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
				},
			});
		} catch {
			return noStoreText("Unavailable", 503);
		}
	});

	app.get("/owner/clients/:clientId/grants", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return context.text("Unauthorized", 401);
		const registry = resolveRegistry(context.env, context.req.raw);
		const page = await listClientGrants(
			registry,
			owner.subject,
			context.req.param("clientId"),
			context.req.query("cursor"),
		);
		const grants = page.grants
			.map((grant) => {
				const grantState = grant.revoked ? "Revoked" : "Active registry grant";
				const cleanupState = grant.cleanup_pending
					? "provider cleanup pending"
					: grant.revoked
						? "provider cleanup complete"
						: "provider cleanup not pending";
				return `<li>${escapeHtml(grant.grant_id)} — ${grantState}, ${cleanupState}</li>`;
			})
			.join("");
		const next = page.next_cursor
			? `<a href="/owner/clients/${encodeURIComponent(context.req.param("clientId"))}/grants?cursor=${encodeURIComponent(page.next_cursor)}">Next page</a>`
			: "";
		return new Response(
			`<!doctype html><html><body><main><h1>Client grants</h1><ul>${grants}</ul>${next}</main></body></html>`,
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
				},
			},
		);
	});

	app.post("/owner/clients/:clientId/rename", async (context) => {
		if (!isSameOrigin(context.req.raw, context.env))
			return context.text("Forbidden", 403);
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return context.text("Unauthorized", 401);
		const form = await readForm(context.req.raw);
		if (!form) return context.text("Invalid owner form", 400);
		const browserId = readCookie(context.req.raw, OWNER_BROWSER_COOKIE);
		if (!browserId || !isUuid(browserId) || !isUuid(form.state))
			return context.text("Invalid owner form", 400);
		const registry = resolveRegistry(context.env, context.req.raw);
		const accepted = await consumeOwnerCsrf(registry, {
			owner_subject: owner.subject,
			browser_id: browserId,
			state: form.state,
			now: Date.now(),
		});
		if (!accepted) return context.text("Invalid owner form", 403);
		if (!form.name || form.name.trim().length > 80)
			return context.text("Invalid client name", 400);
		if (
			!(await renameClient(
				registry,
				owner.subject,
				context.req.param("clientId"),
				form.name.trim(),
			))
		)
			return context.text("Client not found", 404);
		return Response.redirect(
			`${context.env.SERVICE_ORIGIN}/owner/clients`,
			303,
		);
	});

	app.post("/owner/clients/:clientId/revoke", async (context) => {
		if (!isSameOrigin(context.req.raw, context.env))
			return context.text("Forbidden", 403);
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner) return context.text("Unauthorized", 401);
		const form = await readForm(context.req.raw);
		if (!form) return context.text("Invalid owner form", 400);
		const browserId = readCookie(context.req.raw, OWNER_BROWSER_COOKIE);
		if (!browserId || !isUuid(browserId) || !isUuid(form.state))
			return context.text("Invalid owner form", 400);
		const registry = resolveRegistry(context.env, context.req.raw);
		const budget: OwnerCleanupExternalCallBudget = {
			remainingCalls: OWNER_CLEANUP_EXTERNAL_CALL_LIMIT,
		};
		budget.remainingCalls -= 1;
		const accepted = await consumeOwnerCsrf(registry, {
			owner_subject: owner.subject,
			browser_id: browserId,
			state: form.state,
			now: Date.now(),
		});
		if (!accepted) return context.text("Invalid owner form", 403);
		if (!context.env.OAUTH_KV)
			return context.text("OAuth cleanup is unavailable", 503);
		const provider = createProviderGrantCleanup(context.env);
		const result = await revokeClient(
			registry,
			provider,
			owner.subject,
			context.req.param("clientId"),
			budget,
		);
		if (!result) return context.text("Client not found", 404);
		return Response.redirect(
			`${context.env.SERVICE_ORIGIN}/owner/clients`,
			303,
		);
	});
	return app;
}

/** Render units, windows, lower-bound coverage, and unknown or stale labels for owners. */
function renderMeasurements(response: MeasurementResponse): string {
	/** Show a numeric storage value or a safe explicit unknown reason. */
	const display = (value: {
		status: string;
		value?: number;
		reason?: string;
	}) =>
		value.status === "observed"
			? String(value.value)
			: `Unknown (${value.reason ?? "not observed"})`;
	const clientRows = response.requests.clients
		.map(
			(client) =>
				`<li>${escapeHtml(client.client_id)}: REST ${client.requests_rest}, MCP ${client.requests_mcp}. Last feed request ${client.last_feed_request_at === null ? "unknown" : new Date(client.last_feed_request_at).toISOString()}. Observed poll interval ${client.minimum_poll_interval_ms ?? "unknown"}–${client.maximum_poll_interval_ms ?? "unknown"} ms.</li>`,
		)
		.join("");
	return `<!doctype html><html><head><meta charset="utf-8"><title>Service measurements</title></head><body><main><h1>Service measurements</h1><p>Requests are observed lower bounds, not billing totals. Client coverage: ${response.coverage}.</p><p>UTC window: ${response.day_start === null ? "Unknown" : `${new Date(response.day_start).toISOString()} to ${new Date(response.day_end ?? response.day_start).toISOString()}`}. Observed from ${response.observed_from === null ? "unknown" : new Date(response.observed_from).toISOString()} through ${response.observed_through === null ? "unknown" : new Date(response.observed_through).toISOString()}.</p><p>REST requests: ${response.requests.rest_count ?? "Unknown"}. MCP requests: ${response.requests.mcp_count ?? "Unknown"}. Request data: ${response.requests.status}, ${response.requests.stale ? "stale" : "fresh"}. Request observation window: ${response.requests.observed_from === null ? "unknown" : new Date(response.requests.observed_from).toISOString()} to ${response.requests.observed_through === null ? "unknown" : new Date(response.requests.observed_through).toISOString()}.</p><p>Feed response preparation p95: ${response.feed_latency.p95 ?? "Unknown"} milliseconds. Boundary: authenticated router entry to successful /v1/changes response headers. This excludes lazy body production, network transfer, plugin apply, and publication delay. Retained samples: ${response.feed_latency.sample_count} of ${response.feed_latency.total_sample_count}. Latency: ${response.feed_latency.status}, ${response.feed_latency.stale ? "stale" : "fresh"}.</p><p>DO SQLite allocated bytes: ${display(response.storage.database_bytes)}. Referenced R2 blob bytes: ${display(response.storage.referenced_blob_bytes)}.</p><h2>Observed clients</h2><ul>${clientRows}</ul><p><a href="/owner/measurements">Measurement JSON</a></p><p><a href="/owner/clients">Connected clients</a></p></main></body></html>`;
}

/** Return a text response that cannot be stored by a browser or intermediary. */
function noStoreText(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

/** Check the canonical service origin before any owner measurement read. */
function isCanonicalOwnerOrigin(request: Request, env: Env): boolean {
	return Boolean(
		env.SERVICE_ORIGIN && new URL(request.url).origin === env.SERVICE_ORIGIN,
	);
}

/** Accept state changes only when both the request URL and Origin match configured service origin. */
function isSameOrigin(request: Request, env: Env): boolean {
	if (!env.SERVICE_ORIGIN) return false;
	try {
		return (
			new URL(request.url).origin === env.SERVICE_ORIGIN &&
			request.headers.get("origin") === env.SERVICE_ORIGIN
		);
	} catch {
		return false;
	}
}

/** Read one bounded URL-encoded form and reject duplicate CSRF or name fields. */
async function readForm(
	request: Request,
): Promise<{ state: string; name?: string } | null> {
	if (
		request.headers.get("content-type")?.split(";", 1)[0] !==
		"application/x-www-form-urlencoded"
	)
		return null;
	const declared = request.headers.get("content-length");
	if (
		declared !== null &&
		(!/^\d+$/.test(declared) || Number(declared) > OWNER_FORM_LIMIT)
	)
		return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > OWNER_FORM_LIMIT) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		const form = new URLSearchParams(body);
		const states = form.getAll("csrf");
		const names = form.getAll("name");
		if (states.length !== 1 || names.length > 1) return null;
		return { state: states[0] ?? "", name: names[0] };
	} catch {
		return null;
	} finally {
		reader.releaseLock();
	}
}

/** Validate a canonical UUID form-state identifier. */
function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}
