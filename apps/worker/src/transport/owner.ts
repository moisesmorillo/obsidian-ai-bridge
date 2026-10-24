import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { ClientRegistryGateway } from "@worker/application/clients";
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
import { createOAuthOptions } from "@worker/infrastructure/auth/oauth";
import { Hono } from "hono";

/** Browser cookie that binds one-use owner form state to this browser. */
const OWNER_BROWSER_COOKIE = "__Host-oab-owner";
/** Owner form state expires after ten minutes. */
const OWNER_STATE_TTL_MS = 10 * 60 * 1000;
/** Maximum accepted owner form body. */
const OWNER_FORM_LIMIT = 4_096;

/** Resolve the authoritative registry for the configured canonical service vault. */
export type OwnerRegistryResolver = (
	env: Env,
	request: Request,
) => ClientRegistryGateway;

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
				const grantLink = `<a href="/owner/clients/${encodeURIComponent(client.client_id)}/grants">View grants (${client.grant_count})</a>`;
				return `<li><h2>${escapeHtml(client.name || client.client_id)}</h2><p>Client: ${escapeHtml(client.client_id)}</p>${grantLink}<form method="post" action="/owner/clients/${encodeURIComponent(client.client_id)}/rename"><input type="hidden" name="csrf" value="${state}"><label>Name <input name="name" maxlength="80" value="${escapeHtml(client.name)}"></label><button>Rename</button></form><form method="post" action="/owner/clients/${encodeURIComponent(client.client_id)}/revoke"><input type="hidden" name="csrf" value="${state}"><button>Revoke</button></form></li>`;
			})
			.join("");
		const next = page.next_cursor
			? `<a href="/owner/clients?cursor=${encodeURIComponent(page.next_cursor)}">Next page</a>`
			: "";
		return new Response(
			`<!doctype html><html><head><meta charset="utf-8"><title>Owner clients</title></head><body><main><h1>Connected clients</h1><ul>${clientMarkup}</ul>${next}</main></body></html>`,
			{
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"set-cookie": `${OWNER_BROWSER_COOKIE}=${browserId}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=600`,
				},
			},
		);
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
			.map(
				(grant) =>
					`<li>${escapeHtml(grant.grant_id)}${grant.cleanup_pending ? " (provider cleanup pending)" : ""}</li>`,
			)
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
		const accepted = await consumeOwnerCsrf(registry, {
			owner_subject: owner.subject,
			browser_id: browserId,
			state: form.state,
			now: Date.now(),
		});
		if (!accepted) return context.text("Invalid owner form", 403);
		if (!context.env.OAUTH_KV)
			return context.text("OAuth cleanup is unavailable", 503);
		const options = createOAuthOptions(
			context.env,
			{ fetch: async () => new Response(null, { status: 401 }) },
			app,
		);
		if (!options) return context.text("OAuth cleanup is unavailable", 503);
		const provider = getOAuthApi(options, context.env);
		const result = await revokeClient(
			registry,
			provider,
			owner.subject,
			context.req.param("clientId"),
		);
		if (!result) return context.text("Client not found", 404);
		return Response.redirect(
			`${context.env.SERVICE_ORIGIN}/owner/clients`,
			303,
		);
	});
	return app;
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
