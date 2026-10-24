import { LocalAuthConfigurationSchema } from "@obsidian-ai-bridge/protocol";
import type { Env } from "@worker/env";
import {
	createRemoteJWKSet,
	customFetch,
	type FetchImplementation,
	jwtVerify,
} from "jose";

/** Verified identity claims from the configured Cloudflare Access application. */
export interface OwnerIdentity {
	subject: string;
	email?: string;
}

/** Cache JWKS resolvers by the configured Access issuer for bounded key refresh. */
const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Read a bounded Access JWKS response and reject oversized or excessive key sets. */
async function fetchAccessKeys(
	url: string,
	options: Parameters<FetchImplementation>[1],
): Promise<Response> {
	const response = await fetch(url, options);
	if (!response.ok) {
		await response.body?.cancel();
		return new Response(null, { status: response.status });
	}
	if (!response.body) throw new Error("Access JWKS response has no body");
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > 65_536) {
		await response.body.cancel();
		throw new Error("Access JWKS response exceeds its byte limit");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > 65_536) {
			await reader.cancel();
			throw new Error("Access JWKS response exceeds its byte limit");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
	if (
		typeof document !== "object" ||
		document === null ||
		!("keys" in document) ||
		!Array.isArray(document.keys) ||
		document.keys.length > 16
	)
		throw new Error("Access JWKS document is invalid");
	return new Response(bytes, {
		status: response.status,
		headers: response.headers,
	});
}

/** Return a cached remote-key resolver with a fixed issuer endpoint. */
function getAccessKeySet(
	issuer: string,
): ReturnType<typeof createRemoteJWKSet> {
	const cached = accessKeySets.get(issuer);
	if (cached) return cached;
	const resolver = createRemoteJWKSet(
		new URL(`${issuer}/cdn-cgi/access/certs`),
		{
			cacheMaxAge: 300_000,
			timeoutDuration: 5_000,
			cooldownDuration: 30_000,
			[customFetch]: fetchAccessKeys,
		},
	);
	accessKeySets.set(issuer, resolver);
	return resolver;
}

/** Validate the configured Access JWT and return identity only for the owner subject. */
export async function verifyOwnerAccess(
	request: Request,
	env: Env,
): Promise<OwnerIdentity | null> {
	const config = LocalAuthConfigurationSchema.safeParse({
		ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
		ACCESS_AUDIENCE: env.ACCESS_AUDIENCE,
		OWNER_SUBJECT: env.OWNER_SUBJECT,
	});
	if (!config.success) return null;
	const { ACCESS_TEAM_DOMAIN, ACCESS_AUDIENCE, OWNER_SUBJECT } = config.data;
	if (!ACCESS_TEAM_DOMAIN || !ACCESS_AUDIENCE || !OWNER_SUBJECT) return null;
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) return null;
	try {
		const team = new URL(ACCESS_TEAM_DOMAIN);
		if (
			team.protocol !== "https:" ||
			team.pathname !== "/" ||
			team.search ||
			team.hash
		)
			return null;
		const issuer = team.origin;
		const jwks = getAccessKeySet(issuer);
		const { payload, protectedHeader } = await jwtVerify(token, jwks, {
			issuer,
			audience: ACCESS_AUDIENCE,
			algorithms: ["RS256"],
			clockTolerance: 0,
		});
		if (
			protectedHeader.jku ||
			protectedHeader.x5u ||
			typeof payload.sub !== "string" ||
			payload.sub !== OWNER_SUBJECT
		)
			return null;
		if (
			typeof payload.iat !== "number" ||
			payload.iat > Math.floor(Date.now() / 1000)
		)
			return null;
		if (typeof payload.exp !== "number") return null;
		return {
			subject: payload.sub,
			...(typeof payload.email === "string" ? { email: payload.email } : {}),
		};
	} catch {
		return null;
	}
}
