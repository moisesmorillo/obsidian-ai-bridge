import type { DeviceCredential } from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";
import {
	DeviceSession,
	type DeviceSessionHost,
	type DeviceSessionStatus,
} from "../src/auth/device-session";
import type {
	CredentialStorage,
	CredentialWriteTransaction,
} from "../src/infrastructure/credential-storage";
import type { OAuthTransport } from "../src/infrastructure/oauth-transport";

const origin = "https://service.test";

/** Keeps a defensive synthetic credential record for one session test. */
class MemoryCredentials implements CredentialStorage {
	warning = null;
	value: DeviceCredential | null = null;
	failWrites = false;
	/** Shared admission queue for this test device store. */
	private writeTail: Promise<void> = Promise.resolve();
	/** Returns the test's current record without exposing mutation authority. */
	async read(): Promise<DeviceCredential | null> {
		return this.value;
	}
	/** Stores a cloned synthetic record as a successful verified write. */
	async write(value: DeviceCredential): Promise<void> {
		if (this.failWrites)
			throw new Error("synthetic credential persistence failure");
		this.value = structuredClone(value);
	}
	/** Removes the synthetic credential record. */
	async clear(): Promise<void> {
		this.value = null;
	}
	/** Serializes a credential transaction until its journal companion settles. */
	async runWriteTransaction<T>(
		action: (transaction: CredentialWriteTransaction) => Promise<T>,
	): Promise<T> {
		const result = this.writeTail.then(async () => {
			let active = true;
			/** Rejects transaction callbacks that escaped the test write lifetime. */
			const assertActive = () => {
				if (!active) throw new Error("synthetic transaction expired");
			};
			try {
				return await action({
					read: () => {
						assertActive();
						return this.read();
					},
					write: async (value) => {
						assertActive();
						return this.write(value);
					},
					clear: async () => {
						assertActive();
						return this.clear();
					},
				});
			} finally {
				active = false;
			}
		});
		this.writeTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

/** Captures transport requests and returns only synthetic OAuth data. */
class FakeTransport implements OAuthTransport {
	readonly calls: { url: string; options?: Record<string, unknown> }[] = [];
	discoveryOverride: unknown = null;
	failTokenRequests = false;
	tokenType = "Bearer";
	beforeRefreshResponse: (() => Promise<void>) | null = null;

	/** Binds synthetic discovery endpoints to one test service origin. */
	constructor(private readonly serviceOrigin = origin) {}
	/** Returns fixed metadata or synthetic tokens and records no secret output. */
	async request(
		url: string,
		options?: Record<string, unknown>,
	): Promise<unknown> {
		this.calls.push({ url, options });
		if (url.endsWith("oauth-authorization-server"))
			return (
				this.discoveryOverride ?? {
					issuer: this.serviceOrigin,
					registration_endpoint: `${this.serviceOrigin}/oauth/register`,
					authorization_endpoint: `${this.serviceOrigin}/authorize`,
					token_endpoint: `${this.serviceOrigin}/oauth/token`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
				}
			);
		if (url.endsWith("oauth/register"))
			return { client_id: "synthetic-client" };
		if (url.endsWith("oauth/token")) {
			if (this.failTokenRequests) throw new Error("synthetic exchange failure");
			const isRefresh = String(options?.body ?? "").includes(
				"grant_type=refresh_token",
			);
			if (isRefresh) await this.beforeRefreshResponse?.();
			return {
				access_token: isRefresh
					? "rotated-old-access-token"
					: "synthetic-access-token",
				refresh_token: isRefresh
					? "rotated-old-refresh-token"
					: "synthetic-refresh-token",
				token_type: this.tokenType,
				expires_in: 3600,
				scope: "vault:read vault:write vault:delete",
			};
		}
		return { ok: true };
	}
}

/** Creates sessions that share one device store and journal identity. */
function createSession(
	now: () => number = Date.now,
	serviceOrigin = origin,
	credentials = new MemoryCredentials(),
	identity = { clientId: "" },
) {
	const transport = new FakeTransport(serviceOrigin);
	let browserUrl = "";
	const statuses: DeviceSessionStatus[] = [];
	let failBrowser = false;
	let clientIdPersistence: (() => Promise<void>) | null = null;
	let failClientId = false;
	const host: DeviceSessionHost = {
		transport,
		credentials,
		getClientId: () => identity.clientId || null,
		openBrowser: (url) => {
			if (failBrowser) throw new Error("synthetic browser failure");
			browserUrl = url;
		},
		setClientId: async (value, isCurrent = () => true) => {
			if (failClientId)
				throw new Error("synthetic journal persistence failure");
			await clientIdPersistence?.();
			if (!isCurrent()) throw new Error("synthetic stale identity write");
			identity.clientId = value;
		},
		statusChanged: (status) => statuses.push(status),
	};
	return {
		session: new DeviceSession(serviceOrigin, host, now),
		createForOrigin: (nextOrigin: string) =>
			new DeviceSession(nextOrigin, host, now),
		transport,
		credentials,
		browserUrl: () => browserUrl,
		clientId: () => identity.clientId,
		statuses: () => [...statuses],
		setBrowserFailure: (value: boolean) => {
			failBrowser = value;
		},
		setClientIdPersistence: (action: (() => Promise<void>) | null) => {
			clientIdPersistence = action;
		},
		setStoredClientId: (value: string) => {
			identity.clientId = value;
		},
		failClientId: (value: boolean) => {
			failClientId = value;
		},
	};
}

describe("DeviceSession", () => {
	it("starts browser PKCE and stores credentials only after a matching callback", async () => {
		const test = createSession();
		await test.session.connect();
		const auth = new URL(test.browserUrl());
		expect(auth.searchParams.get("redirect_uri")).toBe(
			"obsidian://ai-bridge/callback",
		);
		expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
		expect(test.credentials.value).toBeNull();
		await expect(
			test.session.callback({ code: "synthetic-code", state: "wrong" }),
		).rejects.toThrow();
		expect(test.statuses().at(-1)).toBe("connecting");
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("oauth/token")),
		).toHaveLength(0);
		await test.session.callback({
			code: "synthetic-code",
			state: auth.searchParams.get("state") ?? "",
		});
		expect(test.credentials.value?.access_token).toBe("synthetic-access-token");
	});

	it("rejects discovery whose issuer differs from the configured origin", async () => {
		const test = createSession();
		test.transport.discoveryOverride = {
			issuer: "https://attacker.test",
			registration_endpoint: `${origin}/oauth/register`,
			authorization_endpoint: `${origin}/authorize`,
			token_endpoint: `${origin}/oauth/token`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
		};
		await expect(test.session.connect()).rejects.toThrow();
		expect(
			test.transport.calls.some((call) => call.url.endsWith("oauth/register")),
		).toBe(false);
	});

	it("rejects discovery endpoints outside the configured origin before browser consent", async () => {
		const test = createSession();
		test.transport.discoveryOverride = {
			issuer: origin,
			registration_endpoint: "https://attacker.test/register",
			authorization_endpoint: `${origin}/authorize`,
			token_endpoint: `${origin}/oauth/token`,
			response_types_supported: ["code"],
			code_challenge_methods_supported: ["S256"],
		};
		await expect(test.session.connect()).rejects.toThrow();
		expect(test.browserUrl()).toBe("");
		expect(
			test.transport.calls.some((call) => call.url.endsWith("oauth/register")),
		).toBe(false);
	});

	it("rejects a callback issuer mismatch before exchanging its code", async () => {
		const test = createSession();
		await test.session.connect();
		const auth = new URL(test.browserUrl());
		await expect(
			test.session.callback({
				code: "synthetic-code",
				state: auth.searchParams.get("state") ?? "",
				iss: "https://attacker.test",
			}),
		).rejects.toThrow();
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("oauth/token")),
		).toHaveLength(0);
		expect(test.credentials.value).toBeNull();
		expect(test.statuses().at(-1)).toBe("reconnect");
	});

	it("reports a browser-launch failure without retaining pending consent", async () => {
		const test = createSession();
		test.setBrowserFailure(true);
		await expect(test.session.connect()).rejects.toThrow();
		expect(test.browserUrl()).toBe("");
		await expect(
			test.session.callback({ code: "synthetic-code", state: "any-state" }),
		).rejects.toThrow();
		expect(test.statuses().at(-1)).toBe("reconnect");
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("oauth/token")),
		).toHaveLength(0);
	});

	it("exchanges one valid callback and persists device identity", async () => {
		const test = createSession();
		await test.session.connect();
		const auth = new URL(test.browserUrl());
		await test.session.callback({
			code: "synthetic-code",
			state: auth.searchParams.get("state") ?? "",
		});
		expect(test.credentials.value?.access_token).toBe("synthetic-access-token");
		await expect(
			test.session.callback({
				code: "synthetic-code",
				state: auth.searchParams.get("state") ?? "",
			}),
		).rejects.toThrow();
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("oauth/token")),
		).toHaveLength(1);
		expect(test.clientId()).toBe("synthetic-client");
		expect(test.session).toBeDefined();
	});

	it("rejects denied, missing, expired, and replayed callbacks without extra exchanges", async () => {
		let clock = 1000;
		const test = createSession(() => clock);
		await test.session.connect();
		const auth = new URL(test.browserUrl());
		const state = auth.searchParams.get("state") ?? "";
		await expect(test.session.callback({ state })).rejects.toThrow();
		expect(test.statuses().at(-1)).toBe("reconnect");
		await test.session.connect();
		const nextAuth = new URL(test.browserUrl());
		const nextState = nextAuth.searchParams.get("state") ?? "";
		await expect(
			test.session.callback({ error: "access_denied", state: nextState }),
		).rejects.toThrow();
		expect(test.statuses().at(-1)).toBe("reconnect");
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("oauth/token")),
		).toHaveLength(0);
		await test.session.connect();
		const expiring = new URL(test.browserUrl());
		clock += 10 * 60 * 1000;
		await expect(
			test.session.callback({
				code: "synthetic-code",
				state: expiring.searchParams.get("state") ?? "",
			}),
		).rejects.toThrow("expired");
		expect(test.statuses().at(-1)).toBe("reconnect");
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("oauth/token")),
		).toHaveLength(0);
	});

	it("retains old credentials when reconnect is cancelled or exchange fails", async () => {
		const test = createSession();
		test.credentials.value = {
			service_origin: "https://service.test",
			client_id: "old-client",
			access_token: "old-access",
			refresh_token: "old-refresh",
			token_type: "Bearer",
			expires_at: Date.now() + 3600_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		test.setStoredClientId("old-client");
		await test.session.restore();
		await test.session.connect();
		test.session.cancel();
		expect(test.credentials.value?.client_id).toBe("old-client");
		await test.session.connect();
		const auth = new URL(test.browserUrl());
		test.transport.failTokenRequests = true;
		await expect(
			test.session.callback({
				code: "synthetic-code",
				state: auth.searchParams.get("state") ?? "",
			}),
		).rejects.toThrow();
		expect(test.credentials.value?.client_id).toBe("old-client");
		expect(test.statuses().at(-1)).toBe("connected");
	});

	it("restores old credentials when journal identity persistence fails", async () => {
		const test = createSession();
		test.credentials.value = {
			service_origin: "https://service.test",
			client_id: "old-client",
			access_token: "old-access",
			refresh_token: "old-refresh",
			token_type: "Bearer",
			expires_at: Date.now() + 3600_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		test.setStoredClientId("old-client");
		await test.session.restore();
		await test.session.connect();
		const auth = new URL(test.browserUrl());
		test.failClientId(true);
		await expect(
			test.session.callback({
				code: "synthetic-code",
				state: auth.searchParams.get("state") ?? "",
			}),
		).rejects.toThrow();
		expect(test.credentials.value?.client_id).toBe("old-client");
	});

	it("normalizes lowercase bearer values on exchange and refresh", async () => {
		const test = createSession(() => 10_000);
		test.transport.tokenType = "bearer";
		await test.session.connect();
		const auth = new URL(test.browserUrl());
		await test.session.callback({
			code: "synthetic-code",
			state: auth.searchParams.get("state") ?? "",
		});
		expect(test.credentials.value?.token_type).toBe("Bearer");
		const exchangedCredential = test.credentials.value;
		expect(exchangedCredential).not.toBeNull();
		if (!exchangedCredential) throw new Error("Credential was not stored");
		test.credentials.value = { ...exchangedCredential, expires_at: 10_000 };
		await test.session.restore();
		await expect(test.session.request("/v1/vault")).resolves.toEqual({
			ok: true,
		});
		expect(test.credentials.value?.token_type).toBe("Bearer");
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("oauth/token")),
		).toHaveLength(2);
	});

	it("blocks protected requests after the refresh server rejects a token", async () => {
		const test = createSession(() => 10_000);
		test.credentials.value = {
			service_origin: "https://service.test",
			client_id: "synthetic-client",
			access_token: "expired-access-token",
			refresh_token: "synthetic-refresh-token",
			token_type: "Bearer",
			expires_at: 10_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		test.setStoredClientId("synthetic-client");
		test.transport.failTokenRequests = true;
		await test.session.restore();
		await expect(test.session.request("/v1/vault")).rejects.toThrow();
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("/v1/vault")),
		).toHaveLength(0);
	});

	it("blocks authorization when rotated credentials cannot persist", async () => {
		const test = createSession(() => 10_000);
		test.credentials.value = {
			service_origin: "https://service.test",
			client_id: "synthetic-client",
			access_token: "expired-access-token",
			refresh_token: "synthetic-refresh-token",
			token_type: "Bearer",
			expires_at: 10_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		test.setStoredClientId("synthetic-client");
		test.credentials.failWrites = true;
		await test.session.restore();
		await expect(test.session.request("/v1/vault")).rejects.toThrow();
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("/v1/vault")),
		).toHaveLength(0);
	});

	it("restores a validated stored credential without a protected request", async () => {
		const test = createSession();
		await test.session.connect();
		const auth = new URL(test.browserUrl());
		await test.session.callback({
			code: "synthetic-code",
			state: auth.searchParams.get("state") ?? "",
		});
		const restarted = createSession();
		restarted.credentials.value = test.credentials.value;
		restarted.setStoredClientId("synthetic-client");
		await restarted.session.restore();
		expect(restarted.transport.calls).toHaveLength(0);
	});

	it("blocks credentials that do not match the persisted device identity", async () => {
		const test = createSession();
		test.credentials.value = {
			service_origin: "https://service.test",
			client_id: "credential-client",
			access_token: "synthetic-access-token",
			refresh_token: "synthetic-refresh-token",
			token_type: "Bearer",
			expires_at: Date.now() + 3600_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		test.setStoredClientId("different-journal-client");
		await expect(test.session.restore()).rejects.toThrow();
		await expect(test.session.request("/v1/vault")).rejects.toThrow();
		expect(test.transport.calls).toHaveLength(0);
	});

	it("does not send stored credentials to a changed service origin", async () => {
		const credentials = new MemoryCredentials();
		const identity = { clientId: "old-client" };
		const test = createSession(Date.now, origin, credentials, identity);
		credentials.value = {
			service_origin: "https://service.test",
			client_id: "old-client",
			access_token: "old-origin-access-token",
			refresh_token: "old-origin-refresh-token",
			token_type: "Bearer",
			expires_at: Date.now() + 3600_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		await test.session.restore();
		const changedOrigin = test.createForOrigin("https://other-service.test");
		await expect(changedOrigin.restore()).rejects.toThrow();
		await expect(changedOrigin.request("/v1/vault")).rejects.toThrow();
		expect(
			test.transport.calls.some(
				(call) =>
					call.url.startsWith("https://other-service.test/") &&
					JSON.stringify(call.options).includes("old-origin-access-token"),
			),
		).toBe(false);
		expect(
			test.transport.calls.some((call) =>
				(
					call.options?.headers as Record<string, string> | undefined
				)?.authorization?.includes("old-origin-access-token"),
			),
		).toBe(false);
	});

	it("keeps callback credentials when same-generation refresh finishes late", async () => {
		const test = createSession(() => 10_000);
		test.credentials.value = {
			service_origin: "https://service.test",
			client_id: "old-client",
			access_token: "old-access",
			refresh_token: "old-refresh",
			token_type: "Bearer",
			expires_at: 10_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		test.setStoredClientId("old-client");
		await test.session.restore();
		let releaseRefresh: (() => void) | undefined;
		let markRefreshStarted: (() => void) | undefined;
		const refreshStarted = new Promise<void>((resolve) => {
			markRefreshStarted = resolve;
		});
		test.transport.beforeRefreshResponse = () =>
			new Promise((resolve) => {
				releaseRefresh = resolve;
				markRefreshStarted?.();
			});
		await test.session.connect();
		const request = test.session.request("/v1/vault");
		await refreshStarted;
		const auth = new URL(test.browserUrl());
		await test.session.callback({
			code: "new-code",
			state: auth.searchParams.get("state") ?? "",
		});
		releaseRefresh?.();
		await expect(request).resolves.toEqual({ ok: true });
		expect(test.clientId()).toBe("synthetic-client");
		expect(test.credentials.value?.client_id).toBe("synthetic-client");
		expect(test.credentials.value?.access_token).toBe("synthetic-access-token");
		const protectedCall = test.transport.calls.find((call) =>
			call.url.endsWith("/v1/vault"),
		);
		expect(protectedCall?.options?.headers).toEqual({
			authorization: "Bearer synthetic-access-token",
		});
		expect(JSON.stringify(protectedCall?.options)).not.toContain(
			"rotated-old-access-token",
		);
	});

	it("cancels queued journal identity persistence before it changes state", async () => {
		const test = createSession();
		test.credentials.value = {
			service_origin: "https://service.test",
			client_id: "old-client",
			access_token: "old-access",
			refresh_token: "old-refresh",
			token_type: "Bearer",
			expires_at: Date.now() + 3600_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		test.setStoredClientId("old-client");
		await test.session.restore();
		await test.session.connect();
		const auth = new URL(test.browserUrl());
		let releaseIdentity: (() => void) | undefined;
		let markIdentityStarted: (() => void) | undefined;
		const identityStarted = new Promise<void>((resolve) => {
			markIdentityStarted = resolve;
		});
		test.setClientIdPersistence(
			() =>
				new Promise((resolve) => {
					releaseIdentity = resolve;
					markIdentityStarted?.();
				}),
		);
		const callback = test.session.callback({
			code: "new-code",
			state: auth.searchParams.get("state") ?? "",
		});
		await identityStarted;
		test.session.cancel();
		releaseIdentity?.();
		await expect(callback).rejects.toThrow();
		expect(test.clientId()).toBe("old-client");
		expect(test.credentials.value?.client_id).toBe("old-client");
	});

	it("serializes concurrent refresh and waits for verified rotated credentials", async () => {
		const test = createSession(() => 10_000);
		test.credentials.value = {
			service_origin: "https://service.test",
			client_id: "synthetic-client",
			access_token: "expired-access-token",
			refresh_token: "synthetic-refresh-token",
			token_type: "Bearer",
			expires_at: 10_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		};
		test.setStoredClientId("synthetic-client");
		await test.session.restore();
		await Promise.all([
			test.session.request("/v1/vault"),
			test.session.request("/v1/vault"),
		]);
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("oauth/token")),
		).toHaveLength(1);
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("/v1/vault")),
		).toHaveLength(2);
	});

	it("fences a stored-credential read that completes after unload", async () => {
		const test = createSession();
		let finishRead: ((value: DeviceCredential) => void) | undefined;
		let markReadStarted: (() => void) | undefined;
		const readStarted = new Promise<void>((resolve) => {
			markReadStarted = resolve;
		});
		test.credentials.read = async () =>
			new Promise((resolve) => {
				finishRead = resolve;
				markReadStarted?.();
			});
		const pending = test.session.request("/v1/vault");
		await readStarted;
		test.session.close();
		finishRead?.({
			service_origin: "https://service.test",
			client_id: "synthetic-client",
			access_token: "synthetic-access-token",
			refresh_token: "synthetic-refresh-token",
			token_type: "Bearer",
			expires_at: Date.now() + 3600_000,
			scope: ["vault:read", "vault:write", "vault:delete"],
		});
		await expect(pending).rejects.toThrow("closed");
		expect(test.transport.calls).toHaveLength(0);
	});

	it("rejects a cross-origin API path before transport", async () => {
		const test = createSession();
		await expect(
			test.session.request("https://attacker.test/steal"),
		).rejects.toThrow();
		expect(test.transport.calls).toHaveLength(0);
	});
});
