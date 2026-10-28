import type { DeviceCredential } from "@obsidian-ai-bridge/protocol";
import { describe, expect, it } from "vitest";
import {
	DeviceSession,
	type DeviceSessionHost,
} from "../src/auth/device-session";
import type { CredentialStorage } from "../src/infrastructure/credential-storage";
import type { OAuthTransport } from "../src/infrastructure/oauth-transport";

const origin = "https://service.test";

/** Keeps a defensive synthetic credential record for one session test. */
class MemoryCredentials implements CredentialStorage {
	warning = null;
	value: DeviceCredential | null = null;
	failWrites = false;
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
}

/** Captures transport requests and returns only synthetic OAuth data. */
class FakeTransport implements OAuthTransport {
	readonly calls: { url: string; options?: Record<string, unknown> }[] = [];
	discoveryOverride: unknown = null;
	failTokenRequests = false;
	/** Returns fixed metadata or synthetic tokens and records no secret output. */
	async request(
		url: string,
		options?: Record<string, unknown>,
	): Promise<unknown> {
		this.calls.push({ url, options });
		if (url.endsWith("oauth-authorization-server"))
			return (
				this.discoveryOverride ?? {
					issuer: origin,
					registration_endpoint: `${origin}/oauth/register`,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/oauth/token`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
				}
			);
		if (url.endsWith("oauth/register"))
			return { client_id: "synthetic-client" };
		if (url.endsWith("oauth/token")) {
			if (this.failTokenRequests) throw new Error("synthetic exchange failure");
			return {
				access_token: "synthetic-access-token",
				refresh_token: "synthetic-refresh-token",
				token_type: "Bearer",
				expires_in: 3600,
				scope: "vault:read vault:write vault:delete",
			};
		}
		return { ok: true };
	}
}

/** Creates one controller whose browser action only captures a URL. */
function createSession(now: () => number = Date.now) {
	const transport = new FakeTransport();
	const credentials = new MemoryCredentials();
	let browserUrl = "";
	let clientId = "";
	let failClientId = false;
	const host: DeviceSessionHost = {
		transport,
		credentials,
		getClientId: () => clientId || null,
		openBrowser: (url) => {
			browserUrl = url;
		},
		setClientId: async (value) => {
			if (failClientId)
				throw new Error("synthetic journal persistence failure");
			clientId = value;
		},
		statusChanged: () => {},
	};
	return {
		session: new DeviceSession(origin, host, now),
		transport,
		credentials,
		browserUrl: () => browserUrl,
		clientId: () => clientId,
		setStoredClientId: (value: string) => {
			clientId = value;
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
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("oauth/token")),
		).toHaveLength(0);
		await test.session.callback({
			code: "synthetic-code",
			state: auth.searchParams.get("state") ?? "",
		});
		expect(test.credentials.value?.access_token).toBe("synthetic-access-token");
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
		await test.session.connect();
		const nextAuth = new URL(test.browserUrl());
		const nextState = nextAuth.searchParams.get("state") ?? "";
		await expect(
			test.session.callback({ error: "access_denied", state: nextState }),
		).rejects.toThrow();
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
		expect(
			test.transport.calls.filter((call) => call.url.endsWith("oauth/token")),
		).toHaveLength(0);
	});

	it("retains old credentials when reconnect is cancelled or exchange fails", async () => {
		const test = createSession();
		test.credentials.value = {
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
	});

	it("restores old credentials when journal identity persistence fails", async () => {
		const test = createSession();
		test.credentials.value = {
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

	it("blocks authorization when rotated credentials cannot persist", async () => {
		const test = createSession(() => 10_000);
		test.credentials.value = {
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

	it("serializes concurrent refresh and waits for verified rotated credentials", async () => {
		const test = createSession(() => 10_000);
		test.credentials.value = {
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
