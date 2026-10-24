import { env, SELF } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import productionWorker from "@worker/index";
import {
	createAuthorizeHandler,
	createOAuthOptions,
} from "@worker/infrastructure/auth/oauth";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

let ownerKeyPair: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
let ownerJwk: Awaited<ReturnType<typeof exportJWK>> | undefined;

/** Sign a local Access assertion and expose its public key through a local JWKS response. */
async function ownerAssertion(expiry = "1h"): Promise<string> {
	ownerKeyPair ??= await generateKeyPair("RS256");
	ownerJwk ??= await exportJWK(ownerKeyPair.publicKey);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				keys: [{ ...ownerJwk, kid: "f2-owner", alg: "RS256", use: "sig" }],
			}),
		),
	);
	return new SignJWT({})
		.setProtectedHeader({ alg: "RS256", kid: "f2-owner" })
		.setIssuer("https://team.test")
		.setAudience("synthetic-access-app")
		.setSubject("synthetic-owner")
		.setIssuedAt()
		.setExpirationTime(expiry)
		.sign(ownerKeyPair.privateKey);
}

/** Register a public client through the production Worker endpoint. */
async function registerPublicClient(
	redirectUri = "https://flow.test/callback",
	clientName = "Synthetic flow client",
): Promise<{ client_id: string }> {
	const response = await SELF.fetch("https://service.test/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: clientName,
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	expect(response.status).toBe(201);
	return (await response.json()) as { client_id: string };
}

/** Create the verifier and S256 challenge pair required by OAuth 2.1. */
function createPkce(): { verifier: string; challenge: Promise<string> } {
	const verifier =
		"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-._~";
	const challenge = crypto.subtle
		.digest("SHA-256", new TextEncoder().encode(verifier))
		.then((digest) =>
			btoa(String.fromCharCode(...new Uint8Array(digest)))
				.replaceAll("+", "-")
				.replaceAll("/", "_")
				.replaceAll("=", ""),
		);
	return { verifier, challenge };
}

/** Fail a test with a clear message when a required response field is absent. */
function requireValue<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined)
		throw new Error(`${label} is missing`);
	return value;
}

/** Create one authorization request and exchange its code using the real entry point. */
async function issueAccessToken(
	clientId: string,
	assertion: string,
	scope: string,
	redirectUri = "https://flow.test/callback",
): Promise<{ access_token: string; refresh_token: string; scope: string }> {
	const { verifier, challenge } = createPkce();
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: redirectUri,
		scope,
		state: "synthetic-state",
		code_challenge: await challenge,
		code_challenge_method: "S256",
		resource: "https://service.test",
	});
	const consent = await SELF.fetch(`https://service.test/authorize?${query}`, {
		headers: { "Cf-Access-Jwt-Assertion": assertion },
	});
	const cookie = consent.headers.get("set-cookie")?.split(";")[0] ?? "";
	const handle =
		(await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
	const approved = await SELF.fetch("https://service.test/authorize/consent", {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			cookie,
			"Cf-Access-Jwt-Assertion": assertion,
		},
		body: new URLSearchParams({
			handle,
			decision: "approve",
			client_name: "Named client",
		}),
	});
	const redirect = requireValue(
		approved.headers.get("location"),
		"authorization redirect",
	);
	const code = requireValue(
		new URL(redirect).searchParams.get("code"),
		"authorization code",
	);
	const response = await SELF.fetch("https://service.test/oauth/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			redirect_uri: redirectUri,
			code_verifier: verifier,
			resource: "https://service.test",
		}),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as {
		access_token: string;
		refresh_token: string;
		scope: string;
	};
}

/** Mark one stored access token as expired to test the production token check. */
async function expireAccessToken(token: string): Promise<void> {
	const [userId, grantId] = token.split(":");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	const tokenId = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const kv = requireValue(env.OAUTH_KV, "OAuth KV binding");
	const key = `token:${userId}:${grantId}:${tokenId}`;
	const stored = (await kv.get(key, { type: "json" })) as Record<
		string,
		unknown
	> | null;
	if (!stored) throw new Error("OAuth token record is missing");
	await kv.put(
		key,
		JSON.stringify({ ...stored, expiresAt: Math.floor(Date.now() / 1000) - 1 }),
	);
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("production OAuth entry", () => {
	it("publishes configured issuer, grant types, and origin resource", async () => {
		const response = await SELF.fetch(
			"https://service.test/.well-known/oauth-authorization-server",
		);
		expect(response.status).toBe(200);
		const metadata = (await response.json()) as Record<string, unknown>;
		expect(metadata.issuer).toBe("https://service.test");
		expect(metadata.grant_types_supported).toEqual([
			"authorization_code",
			"refresh_token",
		]);
		const resource = await SELF.fetch(
			"https://service.test/.well-known/oauth-protected-resource",
		);
		expect(((await resource.json()) as { resource?: unknown }).resource).toBe(
			"https://service.test",
		);
		expect(
			(
				await SELF.fetch(
					"https://untrusted.test/.well-known/oauth-authorization-server",
				)
			).status,
		).toBe(404);
	});

	it("denies unauthenticated owner and REST requests before durable work", async () => {
		expect(
			(await SELF.fetch("https://service.test/authorize?response_type=code"))
				.status,
		).toBe(401);
		expect(
			(
				await SELF.fetch("https://service.test/authorize?response_type=code", {
					headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
				})
			).status,
		).toBe(401);
		const bodyRequest = new Request(
			"https://service.test/v1/files/private.md",
			{
				method: "PUT",
				body: "must not reach the DO or R2",
			},
		);
		expect((await productionWorker.fetch(bodyRequest, env)).status).toBe(401);
		expect(bodyRequest.bodyUsed).toBe(false);
		expect((await SELF.fetch("https://service.test/mcp")).status).toBe(401);
		expect(
			(
				await SELF.fetch("https://service.test/v1/vault", {
					headers: {
						authorization: "Bearer malformed-external-token",
						"X-OAB-Verified-Authorization": JSON.stringify({
							client_id: "forged",
							grant_id: "forged",
							scopes: ["vault:read", "vault:write", "vault:delete"],
						}),
					},
				})
			).status,
		).toBe(401);
	});

	it("registers public clients through production OAuth", async () => {
		const client = await registerPublicClient();
		expect(client.client_id).toEqual(expect.any(String));
	});

	it("enforces S256 and renders escaped client and redirect facts", async () => {
		const assertion = await ownerAssertion();
		const client = await registerPublicClient(
			"https://client.test/callback?value=a&next=b",
			"<script>alert(1)</script>",
		);
		const { challenge } = createPkce();
		const query = new URLSearchParams({
			response_type: "code",
			client_id: client.client_id,
			redirect_uri: "https://client.test/callback?value=a&next=b",
			scope: "vault:read",
			state: "s256-state",
			code_challenge: await challenge,
			code_challenge_method: "plain",
			resource: "https://service.test",
		});
		const plain = await SELF.fetch(`https://service.test/authorize?${query}`, {
			headers: { "Cf-Access-Jwt-Assertion": assertion },
		});
		expect(plain.status).toBe(400);
		query.delete("code_challenge");
		query.delete("code_challenge_method");
		expect(
			(
				await SELF.fetch(`https://service.test/authorize?${query}`, {
					headers: { "Cf-Access-Jwt-Assertion": assertion },
				})
			).status,
		).toBe(400);
		query.set("code_challenge", await challenge);
		query.set("code_challenge_method", "S256");
		query.set("redirect_uri", "https://evil.test/callback");
		expect(
			(
				await SELF.fetch(`https://service.test/authorize?${query}`, {
					headers: { "Cf-Access-Jwt-Assertion": assertion },
				})
			).status,
		).toBe(400);
		query.set("redirect_uri", "https://client.test/callback?value=a&next=b");
		query.set("client_name", "<script>alert(1)</script>");
		const consent = await SELF.fetch(
			`https://service.test/authorize?${query}`,
			{
				headers: { "Cf-Access-Jwt-Assertion": assertion },
			},
		);
		expect(consent.status).toBe(200);
		const html = await consent.text();
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("https://client.test/callback?value=a&amp;next=b");
		expect(html).toContain("vault:read");
		expect(html).toContain('name="client_name"');
	});

	it("exchanges S256 codes once, downscopes, and rotates refresh tokens", async () => {
		const assertion = await ownerAssertion();
		const client = await registerPublicClient();
		const { verifier, challenge } = createPkce();
		const query = new URLSearchParams({
			response_type: "code",
			client_id: client.client_id,
			redirect_uri: "https://flow.test/callback",
			scope: "vault:read vault:write",
			state: "flow-state",
			code_challenge: await challenge,
			code_challenge_method: "S256",
			resource: "https://service.test",
		});
		const consent = await SELF.fetch(
			`https://service.test/authorize?${query}`,
			{
				headers: { "Cf-Access-Jwt-Assertion": assertion },
			},
		);
		const cookie = consent.headers.get("set-cookie")?.split(";")[0] ?? "";
		const handle =
			(await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
		const approved = await SELF.fetch(
			"https://service.test/authorize/consent",
			{
				method: "POST",
				redirect: "manual",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					cookie,
					"Cf-Access-Jwt-Assertion": assertion,
				},
				body: new URLSearchParams({
					handle,
					decision: "approve",
					client_name: "Named client",
				}),
			},
		);
		const location = requireValue(
			approved.headers.get("location"),
			"authorization redirect",
		);
		const code = requireValue(
			new URL(location).searchParams.get("code"),
			"authorization code",
		);
		/** Exchange this single-use code with the verifier from the authorization request. */
		const exchange = (codeVerifier: string) =>
			SELF.fetch("https://service.test/oauth/token", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					client_id: client.client_id,
					code,
					redirect_uri: "https://flow.test/callback",
					code_verifier: codeVerifier,
					resource: "https://service.test",
				}),
			});
		expect((await exchange(`${verifier}wrong`)).status).not.toBe(200);
		const response = await exchange(verifier);
		expect(response.status).toBe(200);
		const token = (await response.json()) as {
			access_token: string;
			refresh_token: string;
			scope: string;
		};
		expect(token.scope).toBe("vault:read vault:write");
		expect(
			(
				await SELF.fetch("https://service.test/v1/vault", {
					headers: { authorization: `Bearer ${token.access_token}` },
				})
			).status,
		).toBe(200);
		await expireAccessToken(token.access_token);
		expect(
			(
				await SELF.fetch("https://service.test/v1/vault", {
					headers: { authorization: `Bearer ${token.access_token}` },
				})
			).status,
		).toBe(401);
		/** Rotate a refresh token while asking for a downscoped permission set. */
		const refresh = (refreshToken: string) =>
			SELF.fetch("https://service.test/oauth/token", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					client_id: client.client_id,
					refresh_token: refreshToken,
					scope: "vault:read",
					resource: "https://service.test",
				}),
			});
		const rotated = await refresh(token.refresh_token);
		expect(rotated.status).toBe(200);
		const next = (await rotated.json()) as {
			refresh_token: string;
			scope: string;
		};
		expect(next.scope).toBe("vault:read");
		expect(next.refresh_token).not.toBe(token.refresh_token);
		expect((await refresh(next.refresh_token)).status).toBe(200);
		expect((await refresh(token.refresh_token)).status).not.toBe(200);
		expect((await refresh("malformed-refresh-token")).status).not.toBe(200);
		expect((await exchange(verifier)).status).not.toBe(200);
	});

	it("rejects forged, expired, reused, and foreign-browser consent handles and permits denial", async () => {
		const assertion = await ownerAssertion();
		const client = await registerPublicClient();
		const { challenge } = createPkce();
		const query = new URLSearchParams({
			response_type: "code",
			client_id: client.client_id,
			redirect_uri: "https://flow.test/callback",
			scope: "vault:read",
			state: "deny-state",
			code_challenge: await challenge,
			code_challenge_method: "S256",
			resource: "https://service.test",
		});
		const consent = await SELF.fetch(
			`https://service.test/authorize?${query}`,
			{
				headers: { "Cf-Access-Jwt-Assertion": assertion },
			},
		);
		const handle =
			(await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
		/** Submit one consent decision with the selected browser cookie and handle. */
		const post = (cookie: string, value: string) =>
			SELF.fetch("https://service.test/authorize/consent", {
				method: "POST",
				redirect: "manual",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					cookie,
					"Cf-Access-Jwt-Assertion": assertion,
				},
				body: new URLSearchParams({ handle: value, decision: "deny" }),
			});
		const cookie = consent.headers.get("set-cookie")?.split(";")[0] ?? "";
		expect((await post(cookie, "forged-handle")).status).toBe(400);
		expect((await post("", handle)).status).toBe(400);
		const denial = await post(cookie, handle);
		expect(denial.status).toBe(302);
		expect(
			new URL(
				requireValue(denial.headers.get("location"), "denial redirect"),
			).searchParams.get("error"),
		).toBe("access_denied");
		expect((await post(cookie, handle)).status).toBe(400);
		const expiringConsent = await SELF.fetch(
			`https://service.test/authorize?${query}`,
			{
				headers: { "Cf-Access-Jwt-Assertion": assertion },
			},
		);
		const expiringHandle =
			(await expiringConsent.text()).match(
				/name="handle" value="([^"]+)"/,
			)?.[1] ?? "";
		const expiringCookie =
			expiringConsent.headers.get("set-cookie")?.split(";")[0] ?? "";
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(expiringHandle),
		);
		const hash = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		await requireValue(env.OAUTH_KV, "OAuth KV binding").delete(
			`transaction:${hash}`,
		);
		expect((await post(expiringCookie, expiringHandle)).status).toBe(400);
	});

	it("keeps write-only tokens from reading or deleting", async () => {
		const assertion = await ownerAssertion();
		const client = await registerPublicClient();
		const token = await issueAccessToken(
			client.client_id,
			assertion,
			"vault:write",
		);
		expect(token.scope).toBe("vault:write");
		const headers = { authorization: `Bearer ${token.access_token}` };
		expect(
			(await SELF.fetch("https://service.test/v1/vault", { headers })).status,
		).toBe(403);
		expect(
			(
				await SELF.fetch("https://service.test/v1/files/forbidden.md", {
					method: "DELETE",
					headers: {
						...headers,
						"If-Match": '"0123456789abcdef0123456789abcdef.1"',
					},
				})
			).status,
		).toBe(403);
	});

	it("rejects client credentials and unknown scopes", async () => {
		const credentials = await SELF.fetch(
			"https://service.test/oauth/register",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					client_name: "Credentials client",
					redirect_uris: ["https://credentials.test/callback"],
					grant_types: ["client_credentials"],
					response_types: ["token"],
					token_endpoint_auth_method: "client_secret_post",
				}),
			},
		);
		expect(credentials.status).not.toBe(201);
		const unsupportedGrant = await SELF.fetch(
			"https://service.test/oauth/token",
			{
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "client_credentials",
					client_id: "unknown-client",
				}),
			},
		);
		expect(unsupportedGrant.status).not.toBe(200);
		const assertion = await ownerAssertion();
		const client = await registerPublicClient();
		const { challenge } = createPkce();
		const query = new URLSearchParams({
			response_type: "code",
			client_id: client.client_id,
			redirect_uri: "https://flow.test/callback",
			scope: "vault:admin",
			state: "unknown-scope",
			code_challenge: await challenge,
			code_challenge_method: "S256",
			resource: "https://service.test",
		});
		expect(
			(
				await SELF.fetch(`https://service.test/authorize?${query}`, {
					headers: { "Cf-Access-Jwt-Assertion": assertion },
				})
			).status,
		).toBe(400);
	});

	it("supports pre-registered public clients through the production flow", async () => {
		const options = createOAuthOptions(
			env,
			createAuthorizeHandler(),
			createAuthorizeHandler(),
		);
		const api = getOAuthApi(requireValue(options, "provider options"), env);
		const client = await api.createClient({
			redirectUris: ["https://registered.test/callback"],
			grantTypes: ["authorization_code", "refresh_token"],
			responseTypes: ["code"],
			tokenEndpointAuthMethod: "none",
		});
		const token = await issueAccessToken(
			client.clientId,
			await ownerAssertion(),
			"vault:read",
			"https://registered.test/callback",
		);
		expect(token.scope).toBe("vault:read");
	});
});
