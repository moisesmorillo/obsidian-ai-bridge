import {
	getOAuthApi,
	OAuthError,
	OAuthProvider,
	type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import {
	type AuthorizationContext,
	AuthorizationContextSchema,
	LocalAuthConfigurationSchema,
	VaultScopeSchema,
} from "@obsidian-ai-bridge/protocol";
import type { Env } from "@worker/env";
import { verifyOwnerAccess } from "@worker/infrastructure/auth/access";
import { Hono } from "hono";

/** OAuth scope vocabulary accepted by this resource. */
const SCOPES = VaultScopeSchema.options;

/** Internal request field added only after provider token validation. */
const CONTEXT_HEADER = "X-OAB-Verified-Authorization";

/** Escape untrusted OAuth metadata before placing it in consent markup. */
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

/** Build fixed-origin provider options with strict grants and validated scopes. */
export function createOAuthOptions(
	env: Env,
	apiHandler: ExportedHandler<Env>,
	defaultHandler: ExportedHandler<Env>,
): OAuthProviderOptions<Env> | null {
	const config = LocalAuthConfigurationSchema.safeParse({
		SERVICE_ORIGIN: env.SERVICE_ORIGIN,
		ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
		ACCESS_AUDIENCE: env.ACCESS_AUDIENCE,
		OWNER_SUBJECT: env.OWNER_SUBJECT,
	});
	if (!config.success) return null;
	const origin = config.data.SERVICE_ORIGIN;
	if (!origin || !env.OAUTH_KV) return null;
	let serviceOrigin: string;
	try {
		const parsed = new URL(origin);
		if (
			parsed.protocol !== "https:" ||
			parsed.origin !== origin ||
			parsed.pathname !== "/" ||
			parsed.search ||
			parsed.hash
		)
			return null;
		serviceOrigin = parsed.origin;
	} catch {
		return null;
	}
	return {
		apiRoute: ["/v1", "/mcp"],
		apiHandler,
		defaultHandler,
		authorizeEndpoint: `${serviceOrigin}/authorize`,
		tokenEndpoint: `${serviceOrigin}/oauth/token`,
		clientRegistrationEndpoint: `${serviceOrigin}/oauth/register`,
		clientIdMetadataDocumentEnabled: false,
		allowTokenExchangeGrant: false,
		disallowPublicClientRegistration: false,
		clientRegistrationCallback: ({ clientMetadata }) => {
			const grants = clientMetadata.grant_types;
			const responses = clientMetadata.response_types;
			if (
				!Array.isArray(grants) ||
				grants.some(
					(grant) =>
						grant !== "authorization_code" && grant !== "refresh_token",
				) ||
				!Array.isArray(responses) ||
				responses.some((response) => response !== "code")
			)
				return {
					code: "invalid_client_metadata",
					description: "Only code and refresh grants are supported",
				};
		},
		scopesSupported: [...SCOPES],
		resourceMetadata: {
			resource: serviceOrigin,
			resource_name: "Obsidian AI Bridge",
		},
		accessTokenTTL: 3600,
		refreshTokenTTL: 2_592_000,
		cookiePrefix: "__Host-oab-",
		tokenExchangeCallback: async ({
			grantType,
			clientId,
			grantId,
			scope,
			requestedScope,
			userId,
			props,
			env: callbackEnv,
		}) => {
			if (grantType !== "authorization_code" && grantType !== "refresh_token") {
				throw new Error("Unsupported grant type");
			}
			if (scope.some((item) => !(SCOPES as readonly string[]).includes(item))) {
				throw new Error("Unknown scope");
			}
			const generation = props?.generation;
			const consentId = props?.consent_id;
			const registry = callbackEnv.VAULTS.get(
				callbackEnv.VAULTS.idFromName(
					new URL(callbackEnv.SERVICE_ORIGIN as string).host,
				),
			);
			const accepted = await registry.registerClientGrant({
				owner_subject: userId,
				client_id: clientId,
				grant_id: grantId,
				generation,
				consent_id: consentId,
			});
			if (!accepted)
				throw new OAuthError("invalid_grant", {
					description: "Client consent is no longer current",
				});
			return {
				newProps: {
					...props,
					client_id: clientId,
					grant_id: grantId,
					generation,
					consent_id: consentId,
				},
				accessTokenScope: [...requestedScope],
			};
		},
	};
}

/** Render Access-protected consent and complete or decline the provider request. */
export function createAuthorizeHandler(): ExportedHandler<Env> {
	const app = new Hono<{ Bindings: Env }>();
	app.get("/authorize", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner || !context.env.SERVICE_ORIGIN || !context.env.OAUTH_KV) {
			return context.text("Unauthorized", 401);
		}
		const options = createOAuthOptions(
			context.env,
			{ fetch: async () => new Response(null, { status: 401 }) },
			app,
		);
		if (!options) return context.text("OAuth is not configured", 503);
		try {
			const api = getOAuthApi(options, context.env);
			const authRequest = await api.parseAuthRequest(context.req.raw);
			if (
				authRequest.codeChallengeMethod !== "S256" ||
				!authRequest.codeChallenge ||
				authRequest.scope.some(
					(scope) => !(SCOPES as readonly string[]).includes(scope),
				)
			)
				return context.text("Invalid authorization request", 400);
			const description = await api.describeConsent(authRequest);
			const consent = await api.beginConsent(authRequest);
			const html = `<!doctype html><html><body><main><h1>Authorize ${escapeHtml(description.clientName)}</h1><p>Application: ${escapeHtml(description.clientName)}</p><p>Redirect URI: ${escapeHtml(description.redirectUri)}</p><ul>${description.scope.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")}</ul><form method="post" action="/authorize/consent"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}"><label>Client name <input name="client_name" maxlength="80"></label><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form></main></body></html>`;
			return new Response(html, {
				headers: new Headers([
					["content-type", "text/html; charset=utf-8"],
					["cache-control", "no-store"],
					...consent.headers,
				]),
			});
		} catch {
			return context.text("Invalid authorization request", 400);
		}
	});
	app.post("/authorize/consent", async (context) => {
		const owner = await verifyOwnerAccess(context.req.raw, context.env);
		if (!owner || !context.env.SERVICE_ORIGIN || !context.env.OAUTH_KV) {
			return context.text("Unauthorized", 401);
		}
		const options = createOAuthOptions(
			context.env,
			{ fetch: async () => new Response(null, { status: 401 }) },
			app,
		);
		if (!options) return context.text("OAuth is not configured", 503);
		try {
			const browserRequest = new Request(context.req.raw.url, {
				method: "GET",
				headers: context.req.raw.headers,
			});
			const form = await context.req.formData();
			const decisions = form.getAll("decision");
			if (
				decisions.length !== 1 ||
				typeof decisions[0] !== "string" ||
				(decisions[0] !== "approve" && decisions[0] !== "deny")
			)
				return context.text("Invalid consent decision", 400);
			const decision = decisions[0];
			const handle = String(form.get("handle") ?? "");
			const api = getOAuthApi(options, context.env);
			if (decision === "deny") {
				const denied = await api.denyConsent(browserRequest, handle);
				return new Response(null, {
					status: 302,
					headers: new Headers(denied.headers),
				});
			}
			const consent = await api.approveConsent(browserRequest, handle);
			const name = String(form.get("client_name") ?? "")
				.trim()
				.slice(0, 80);
			const registry = context.env.VAULTS.get(
				context.env.VAULTS.idFromName(new URL(context.env.SERVICE_ORIGIN).host),
			);
			const fence = await registry.beginClientConsent(
				owner.subject,
				consent.request.clientId,
				name || "OAuth client",
			);
			const result = await api.completeAuthorization({
				request: consent.request,
				userId: owner.subject,
				metadata: { client_name: name },
				scope: [...consent.request.scope],
				props: {
					client_id: consent.request.clientId,
					generation: fence.generation,
					consent_id: fence.consent_id,
				},
			});
			return new Response(null, {
				status: 302,
				headers: new Headers([
					["location", result.redirectTo],
					["cache-control", "no-store"],
					...consent.headers,
				]),
			});
		} catch {
			return context.text("Invalid or expired consent", 400);
		}
	});
	return app;
}

/** Read the authenticated context added only by the provider's validated API handler. */
export function readVerifiedAuthorization(
	request: Request,
): AuthorizationContext | null {
	const serialized = request.headers.get(CONTEXT_HEADER);
	if (!serialized) return null;
	try {
		const parsed: unknown = JSON.parse(serialized);
		return AuthorizationContextSchema.safeParse(parsed).data ?? null;
	} catch {
		return null;
	}
}

/** Create the provider wrapper that injects verified token properties into REST requests. */
export function createOAuthWorker(
	env: Env,
	api: ExportedHandler<Env>,
	defaultHandler: ExportedHandler<Env>,
): OAuthProvider<Env> | null {
	const apiHandler: ExportedHandler<Env> = {
		fetch: (request, bindings, context) => {
			const enriched = context as ExecutionContext & {
				props?: unknown;
				auth?: unknown;
			};
			const props = enriched.props as
				| { client_id?: unknown; grant_id?: unknown }
				| undefined;
			const auth = enriched.auth as
				| { clientId?: unknown; scope?: unknown }
				| undefined;
			const scopes = Array.isArray(auth?.scope) ? auth.scope : [];
			const identity = AuthorizationContextSchema.safeParse({
				client_id: props?.client_id ?? auth?.clientId,
				grant_id: props?.grant_id,
				scopes,
			});
			if (!identity.success)
				return Promise.resolve(new Response("Unauthorized", { status: 401 }));
			const headers = new Headers(request.headers);
			headers.set(CONTEXT_HEADER, JSON.stringify(identity.data));
			const trustedRequest = new Request(request, { headers } as RequestInit);
			const handler = api.fetch;
			if (!handler)
				return Promise.resolve(
					new Response("REST handler is unavailable", { status: 500 }),
				);
			return handler(
				trustedRequest as Parameters<typeof handler>[0],
				bindings,
				context,
			);
		},
	};
	const options = createOAuthOptions(env, apiHandler, defaultHandler);
	return options ? new OAuthProvider(options) : null;
}
