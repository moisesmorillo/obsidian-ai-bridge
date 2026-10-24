import { env, runInDurableObject, SELF } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, vi } from "vitest";

let ownerKeys: Awaited<ReturnType<typeof generateKeyPair>> | undefined;

/** Issue one provider token through the real Access consent and OAuth code flow. */
export async function issueToken(
	scope = "vault:read vault:write",
): Promise<{ token: string; clientId: string }> {
	ownerKeys ??= await generateKeyPair("RS256");
	const jwk = await exportJWK(ownerKeys.publicKey);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				keys: [{ ...jwk, kid: "mcp-owner", alg: "RS256", use: "sig" }],
			}),
		),
	);
	const assertion = await new SignJWT({})
		.setProtectedHeader({ alg: "RS256", kid: "mcp-owner" })
		.setIssuer("https://team.test")
		.setAudience("synthetic-access-app")
		.setSubject("synthetic-owner")
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(ownerKeys.privateKey);
	const registration = await SELF.fetch("https://service.test/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "MCP test",
			redirect_uris: ["https://mcp.test/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	expect(registration.status).toBe(201);
	const registered: unknown = await registration.json();
	if (
		typeof registered !== "object" ||
		registered === null ||
		!("client_id" in registered) ||
		typeof registered.client_id !== "string"
	)
		throw new Error("Expected provider client identity");
	const clientId = registered.client_id;
	const verifier =
		"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-._~";
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
	const query = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: "https://mcp.test/callback",
		scope,
		state: "mcp-test",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: "https://service.test",
	});
	const consent = await SELF.fetch(`https://service.test/authorize?${query}`, {
		headers: { "Cf-Access-Jwt-Assertion": assertion },
	});
	const cookie = consent.headers.get("set-cookie")?.split(";")[0] ?? "";
	const handle =
		(await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
	const approval = await SELF.fetch("https://service.test/authorize/consent", {
		method: "POST",
		redirect: "manual",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			cookie,
			"Cf-Access-Jwt-Assertion": assertion,
		},
		body: new URLSearchParams({ handle, decision: "approve" }),
	});
	const code =
		new URL(
			approval.headers.get("location") ?? "https://invalid/",
		).searchParams.get("code") ?? "";
	const token = await SELF.fetch("https://service.test/oauth/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			redirect_uri: "https://mcp.test/callback",
			code_verifier: verifier,
			resource: "https://service.test",
		}),
	});
	expect(token.status).toBe(200);
	const issued: unknown = await token.json();
	if (
		typeof issued !== "object" ||
		issued === null ||
		!("access_token" in issued) ||
		typeof issued.access_token !== "string"
	)
		throw new Error("Expected provider access token");
	return { token: issued.access_token, clientId };
}

/** Read active durable admission states for one real OAuth client. */
export async function activeAdmissionStates(
	clientId: string,
): Promise<string[]> {
	const vault = env.VAULTS.get(env.VAULTS.idFromName("service.test"));
	return runInDurableObject(vault, (_instance, state) =>
		state.storage.sql
			.exec(
				"SELECT state FROM operation_admissions WHERE client_id = ? ORDER BY state",
				clientId,
			)
			.toArray()
			.map((row) => String(row.state)),
	);
}

/** Send one real MCP JSON message to the production Worker entry point. */
export function postMcp(
	token: string,
	message: unknown,
	headers: Record<string, string> = {},
) {
	return SELF.fetch("https://service.test/mcp", {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		body: JSON.stringify(message),
	});
}
