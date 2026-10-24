import type { Env } from "@worker/env";
import { verifyOwnerAccess } from "@worker/infrastructure/auth/access";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Build the minimum bindings needed by the Access verifier tests. */
function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		VAULTS: {} as Env["VAULTS"],
		R2_BUCKET: {} as Env["R2_BUCKET"],
		ACCESS_TEAM_DOMAIN: "https://team.example",
		ACCESS_AUDIENCE: "access-app-test",
		OWNER_SUBJECT: "owner-test",
		...overrides,
	};
}

describe("verifyOwnerAccess", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("denies missing configuration and missing assertions", async () => {
		expect(
			await verifyOwnerAccess(
				new Request("https://service.example"),
				makeEnv({ OWNER_SUBJECT: undefined }),
			),
		).toBeNull();
		expect(
			await verifyOwnerAccess(
				new Request("https://service.example"),
				makeEnv(),
			),
		).toBeNull();
	});

	it.each([
		["wrong issuer", { iss: "https://wrong.example" }],
		["wrong audience", { aud: "wrong-app" }],
		["expired assertion", { exp: Math.floor(Date.now() / 1000) - 60 }],
		["future issued assertion", { iat: Math.floor(Date.now() / 1000) + 60 }],
		["malformed subject", { sub: 7 }],
	] as const)("rejects %s claims", async (_name, claims) => {
		const { publicKey, privateKey } = await generateKeyPair("RS256");
		const jwk = await exportJWK(publicKey);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					keys: [{ ...jwk, kid: "negative-key", alg: "RS256", use: "sig" }],
				}),
			),
		);
		const token = await new SignJWT({
			iss: "https://negative.example",
			aud: "access-app-test",
			sub: "owner-test",
			iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 300,
			...claims,
		} as JWTPayload)
			.setProtectedHeader({ alg: "RS256", kid: "negative-key" })
			.sign(privateKey);
		const team = "https://negative.example";
		const response = await verifyOwnerAccess(
			new Request("https://service.example", {
				headers: { "Cf-Access-Jwt-Assertion": token },
			}),
			makeEnv({ ACCESS_TEAM_DOMAIN: team }),
		);
		expect(response).toBeNull();
	});

	it("refreshes rotated keys only after the resolver cooldown", async () => {
		vi.useFakeTimers();
		const oldPair = await generateKeyPair("RS256");
		const nextPair = await generateKeyPair("RS256");
		const oldJwk = await exportJWK(oldPair.publicKey);
		const nextJwk = await exportJWK(nextPair.publicKey);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					keys: [{ ...oldJwk, kid: "old-key", alg: "RS256", use: "sig" }],
				}),
			)
			.mockResolvedValue(
				Response.json({
					keys: [{ ...nextJwk, kid: "new-key", alg: "RS256", use: "sig" }],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		/** Sign one token for a selected local JWKS key identifier. */
		const createToken = (kid: string, privateKey: CryptoKey) =>
			new SignJWT({})
				.setProtectedHeader({ alg: "RS256", kid })
				.setIssuer("https://rotation.example")
				.setAudience("access-app-test")
				.setSubject("owner-test")
				.setIssuedAt()
				.setExpirationTime("5m")
				.sign(privateKey);
		/** Validate one signed token against this test's configured Access issuer. */
		const requestWith = async (token: string) =>
			verifyOwnerAccess(
				new Request("https://service.example", {
					headers: { "Cf-Access-Jwt-Assertion": token },
				}),
				makeEnv({ ACCESS_TEAM_DOMAIN: "https://rotation.example" }),
			);
		expect(
			await requestWith(await createToken("old-key", oldPair.privateKey)),
		).toEqual({ subject: "owner-test" });
		expect(
			await requestWith(await createToken("new-key", nextPair.privateKey)),
		).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_001);
		expect(
			await requestWith(await createToken("new-key", nextPair.privateKey)),
		).toEqual({ subject: "owner-test" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects Access key sets above the fixed key count", async () => {
		const { publicKey, privateKey } = await generateKeyPair("RS256");
		const jwk = await exportJWK(publicKey);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					keys: Array.from({ length: 17 }, (_, index) => ({
						...jwk,
						kid: `limit-${index}`,
						alg: "RS256",
						use: "sig",
					})),
				}),
			),
		);
		const token = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256", kid: "limit-0" })
			.setIssuer("https://key-limit.example")
			.setAudience("access-app-test")
			.setSubject("owner-test")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		await expect(
			verifyOwnerAccess(
				new Request("https://service.example", {
					headers: { "Cf-Access-Jwt-Assertion": token },
				}),
				makeEnv({ ACCESS_TEAM_DOMAIN: "https://key-limit.example" }),
			),
		).resolves.toBeNull();
	});

	it("fails closed when the Access key endpoint fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		const token =
			"eyJhbGciOiJSUzI1NiIsImtpZCI6Im1pc3NpbmcifQ.eyJzdWIiOiJvd25lci10ZXN0In0.signature";
		await expect(
			verifyOwnerAccess(
				new Request("https://service.example", {
					headers: { "Cf-Access-Jwt-Assertion": token },
				}),
				makeEnv({ ACCESS_TEAM_DOMAIN: "https://key-failure.example" }),
			),
		).resolves.toBeNull();
	});

	it("returns verified owner claims and rejects another subject", async () => {
		const { publicKey, privateKey } = await generateKeyPair("RS256");
		const jwk = await exportJWK(publicKey);
		const fetchMock = vi.fn(async () =>
			Response.json({
				keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const token = await new SignJWT({ email: "owner@example.test" })
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuer("https://team.example")
			.setAudience("access-app-test")
			.setSubject("owner-test")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const request = new Request("https://service.example", {
			headers: { "Cf-Access-Jwt-Assertion": token },
		});
		await expect(verifyOwnerAccess(request, makeEnv())).resolves.toEqual({
			subject: "owner-test",
			email: "owner@example.test",
		});
		const foreign = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuer("https://team.example")
			.setAudience("access-app-test")
			.setSubject("other")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		await expect(
			verifyOwnerAccess(
				new Request("https://service.example", {
					headers: { "Cf-Access-Jwt-Assertion": foreign },
				}),
				makeEnv(),
			),
		).resolves.toBeNull();
		const { privateKey: wrongKey } = await generateKeyPair("RS256");
		const wrongSignature = await new SignJWT({})
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuer("https://team.example")
			.setAudience("access-app-test")
			.setSubject("owner-test")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(wrongKey);
		await expect(
			verifyOwnerAccess(
				new Request("https://service.example", {
					headers: { "Cf-Access-Jwt-Assertion": wrongSignature },
				}),
				makeEnv(),
			),
		).resolves.toBeNull();
		const wrongAlgorithm = await new SignJWT({ sub: "owner-test" })
			.setProtectedHeader({ alg: "HS256", kid: "test-key" })
			.setIssuer("https://team.example")
			.setAudience("access-app-test")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(new TextEncoder().encode("synthetic-secret"));
		await expect(
			verifyOwnerAccess(
				new Request("https://service.example", {
					headers: { "Cf-Access-Jwt-Assertion": wrongAlgorithm },
				}),
				makeEnv(),
			),
		).resolves.toBeNull();
		const keyUrl = await new SignJWT({})
			.setProtectedHeader({
				alg: "RS256",
				kid: "test-key",
				jku: "https://evil.test/keys",
			})
			.setIssuer("https://team.example")
			.setAudience("access-app-test")
			.setSubject("owner-test")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		await expect(
			verifyOwnerAccess(
				new Request("https://service.example", {
					headers: { "Cf-Access-Jwt-Assertion": keyUrl },
				}),
				makeEnv(),
			),
		).resolves.toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
