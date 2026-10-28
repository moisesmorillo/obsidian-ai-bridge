import {
	ClientIdSchema,
	type DeviceCredential,
	DeviceCredentialSchema,
	DeviceDiscoverySchema,
	DeviceRegistrationResponseSchema,
	DeviceTokenResponseSchema,
} from "@obsidian-ai-bridge/protocol";
import type { CredentialStorage } from "@plugin/infrastructure/credential-storage";
import type { OAuthTransport } from "@plugin/infrastructure/oauth-transport";

/** Exact private-use callback registered by the Worker for Obsidian enrollment. */
const CALLBACK_URI = "obsidian://ai-bridge/callback";
/** Permissions requested by a device during the approved enrollment flow. */
const SCOPES = ["vault:read", "vault:write", "vault:delete"] as const;
/** Maximum in-memory lifetime for one uncompleted browser consent request. */
const CONSENT_LIFETIME_MS = 10 * 60 * 1000;

/** Safe enrollment state exposed to settings without credential or callback data. */
export type DeviceSessionStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnect";

/** Host effects required for browser consent and journal identity persistence. */
export interface DeviceSessionHost {
	/** RequestUrl-backed transport for same-origin OAuth and API endpoints. */
	readonly transport: OAuthTransport;
	/** Device-scoped persistence that verifies writes before the session uses them. */
	readonly credentials: CredentialStorage;
	/** Returns the journal identity that must match the credential record on restart. */
	getClientId(): string | null;
	/** Opens only the constructed authorization URL in the external browser. */
	openBrowser(url: string): void;
	/** Persists the registered identity in serialized local journal state. */
	setClientId(clientId: string): Promise<void>;
	/** Publishes a fixed safe status without sensitive OAuth response values. */
	statusChanged(status: DeviceSessionStatus): void;
}

/** In-memory proof and lifecycle fence for exactly one pending browser authorization. */
interface PendingConsent {
	/** Public client selected by this attempt. */
	clientId: string;
	/** One-time PKCE secret that must not leave memory except in the token request. */
	verifier: string;
	/** Random browser round-trip value required before code exchange. */
	state: string;
	/** Discovery issuer used to reject a mismatched callback. */
	issuer: string;
	/** Discovery-validated endpoint used for the code exchange. */
	tokenEndpoint: string;
	/** Absolute expiry in milliseconds from the injected clock. */
	expiresAt: number;
	/** Session generation that fences cancellation, reconnect, and unload. */
	generation: number;
}

/** Owns one in-memory PKCE attempt, validated credentials, refresh, and same-origin requests. */
export class DeviceSession {
	private pending: PendingConsent | null = null;
	private credential: DeviceCredential | null = null;
	private closed = false;
	private generation = 0;
	private refreshTail: Promise<void> = Promise.resolve();
	private readonly serviceOrigin: string;

	/** Validates one canonical HTTPS origin before any token-bearing network request. */
	constructor(
		serviceUrl: string,
		private readonly host: DeviceSessionHost,
		private readonly now: () => number = Date.now,
	) {
		const parsed = new URL(serviceUrl);
		if (
			parsed.protocol !== "https:" ||
			parsed.origin !== serviceUrl ||
			parsed.pathname !== "/" ||
			parsed.search ||
			parsed.hash
		)
			throw new Error("Service URL must be a canonical HTTPS origin");
		this.serviceOrigin = parsed.origin;
	}

	/** Registers a public client and opens browser consent while retaining any old session. */
	async connect(): Promise<void> {
		this.assertOpen();
		const generation = ++this.generation;
		this.pending = null;
		this.setStatus("connecting");
		try {
			const discovery = await this.discover();
			this.assertCurrent(generation);
			const registration = DeviceRegistrationResponseSchema.parse(
				await this.host.transport.request(discovery.registration_endpoint, {
					method: "POST",
					contentType: "application/json",
					body: JSON.stringify({
						client_name: "Obsidian desktop",
						redirect_uris: [CALLBACK_URI],
						grant_types: ["authorization_code", "refresh_token"],
						response_types: ["code"],
						token_endpoint_auth_method: "none",
					}),
				}),
			);
			this.assertCurrent(generation);
			const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
			const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
			const challenge = base64Url(
				new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						new TextEncoder().encode(verifier),
					),
				),
			);
			this.assertCurrent(generation);
			const pending: PendingConsent = {
				clientId: registration.client_id,
				verifier,
				state,
				issuer: discovery.issuer,
				tokenEndpoint: discovery.token_endpoint,
				expiresAt: this.now() + CONSENT_LIFETIME_MS,
				generation,
			};
			this.pending = pending;
			const authorization = new URL(discovery.authorization_endpoint);
			for (const [key, value] of Object.entries({
				response_type: "code",
				client_id: registration.client_id,
				redirect_uri: CALLBACK_URI,
				scope: SCOPES.join(" "),
				state,
				code_challenge: challenge,
				code_challenge_method: "S256",
				resource: this.serviceOrigin,
			}))
				authorization.searchParams.set(key, value);
			this.host.openBrowser(authorization.toString());
			this.assertCurrent(generation);
		} catch {
			if (generation === this.generation && !this.closed) {
				this.pending = null;
				this.setStatus(this.credential ? "connected" : "reconnect");
			}
			throw new Error("Could not start device authorization");
		}
	}

	/** Restores validated device credentials after restart without requesting protected data. */
	async restore(): Promise<void> {
		this.assertOpen();
		try {
			const stored = await this.host.credentials.read();
			this.assertOpen();
			this.credential = stored ? DeviceCredentialSchema.parse(stored) : null;
			if (this.credential) this.assertCredentialIdentity(this.credential);
			this.setStatus(this.credential ? "connected" : "disconnected");
		} catch {
			this.credential = null;
			this.setStatus("reconnect");
			throw new Error("Stored device credentials need attention");
		}
	}

	/** Cancels pending consent without changing stored credentials or journal operations. */
	cancel(): void {
		this.generation += 1;
		this.pending = null;
		this.setStatus(this.credential ? "connected" : "disconnected");
	}

	/** Validates one protocol callback before exchanging its code or installing credentials. */
	async callback(params: Record<string, string>): Promise<void> {
		this.assertOpen();
		const pending = this.pending;
		if (!pending || pending.generation !== this.generation)
			throw new Error("No active device authorization");
		if (this.now() >= pending.expiresAt) {
			this.pending = null;
			throw new Error("Device authorization is expired");
		}
		if (params.state !== pending.state)
			throw new Error("Device authorization state is invalid");
		if (params.iss && params.iss !== pending.issuer) {
			this.pending = null;
			throw new Error("Device authorization issuer is invalid");
		}
		if (Boolean(params.code) === Boolean(params.error) || !params.code) {
			this.pending = null;
			throw new Error("Device authorization was not approved");
		}
		const generation = pending.generation;
		this.pending = null;
		try {
			const form = new URLSearchParams({
				grant_type: "authorization_code",
				client_id: pending.clientId,
				code: params.code,
				redirect_uri: CALLBACK_URI,
				code_verifier: pending.verifier,
				resource: this.serviceOrigin,
			});
			const token = DeviceTokenResponseSchema.parse(
				await this.host.transport.request(pending.tokenEndpoint, {
					method: "POST",
					contentType: "application/x-www-form-urlencoded",
					body: form.toString(),
				}),
			);
			this.assertCurrent(generation);
			const credential = this.makeCredential(pending.clientId, token);
			const previousCredential = this.credential;
			await this.host.credentials.write(credential);
			this.assertCurrent(generation);
			try {
				await this.host.setClientId(pending.clientId);
			} catch {
				try {
					if (previousCredential)
						await this.host.credentials.write(previousCredential);
					else await this.host.credentials.clear();
				} catch {
					this.credential = null;
					this.setStatus("reconnect");
				}
				throw new Error("Device identity persistence failed");
			}
			this.assertCurrent(generation);
			this.credential = credential;
			this.pending = null;
			this.setStatus("connected");
		} catch {
			if (generation === this.generation && !this.closed) {
				this.pending = null;
				this.setStatus(this.credential ? "connected" : "reconnect");
			}
			throw new Error("Device authorization failed");
		}
	}

	/** Sends a same-origin API request only after valid credentials and any required refresh. */
	async request(
		path: string,
		options: { method?: string; body?: string } = {},
	): Promise<unknown> {
		this.assertOpen();
		const url = new URL(path, this.serviceOrigin);
		if (url.origin !== this.serviceOrigin || url.protocol !== "https:")
			throw new Error("API request must use the configured service origin");
		const credential = await this.getCredential();
		this.assertOpen();
		const response = await this.host.transport.request(url.toString(), {
			method: options.method ?? "GET",
			body: options.body,
			headers: { authorization: `Bearer ${credential.access_token}` },
		});
		this.assertOpen();
		return response;
	}

	/** Fences asynchronous completions and drops in-memory consent secrets on unload. */
	close(): void {
		this.closed = true;
		this.generation += 1;
		this.pending = null;
		this.credential = null;
	}

	/** Reads service metadata and rejects every endpoint outside the configured HTTPS origin. */
	private async discover() {
		const raw = await this.host.transport.request(
			`${this.serviceOrigin}/.well-known/oauth-authorization-server`,
		);
		const discovery = DeviceDiscoverySchema.parse(raw);
		for (const endpoint of [
			discovery.issuer,
			discovery.registration_endpoint,
			discovery.authorization_endpoint,
			discovery.token_endpoint,
		]) {
			const parsed = new URL(endpoint);
			if (
				parsed.origin !== this.serviceOrigin ||
				parsed.protocol !== "https:" ||
				parsed.username ||
				parsed.password
			)
				throw new Error("OAuth endpoint origin is invalid");
		}
		if (discovery.issuer !== this.serviceOrigin)
			throw new Error("OAuth issuer is invalid");
		if (
			!discovery.response_types_supported.includes("code") ||
			!discovery.code_challenge_methods_supported.includes("S256") ||
			(discovery.grant_types_supported &&
				!discovery.grant_types_supported.includes("refresh_token"))
		)
			throw new Error("OAuth service does not support required enrollment");
		return discovery;
	}

	/** Returns usable credentials after one serialized, verified refresh if they expire soon. */
	private async getCredential(): Promise<DeviceCredential> {
		if (!this.credential) {
			const stored = await this.host.credentials.read();
			this.assertOpen();
			if (stored) {
				try {
					const validated = DeviceCredentialSchema.parse(stored);
					this.assertCredentialIdentity(validated);
					this.credential = validated;
				} catch {
					this.setStatus("reconnect");
					throw new Error("Stored device credentials need attention");
				}
			}
		}
		const current = this.credential;
		if (!current) throw new Error("Reconnect is required");
		if (current.expires_at > this.now() + 30_000) return current;
		const refresh = this.refreshTail.then(async () => {
			this.assertOpen();
			if (this.credential && this.credential.expires_at > this.now() + 30_000)
				return;
			const body = new URLSearchParams({
				grant_type: "refresh_token",
				client_id: current.client_id,
				refresh_token: current.refresh_token,
				resource: this.serviceOrigin,
			});
			const metadata = await this.discover();
			const token = DeviceTokenResponseSchema.parse(
				await this.host.transport.request(metadata.token_endpoint, {
					method: "POST",
					contentType: "application/x-www-form-urlencoded",
					body: body.toString(),
				}),
			);
			const next = this.makeCredential(current.client_id, token);
			await this.host.credentials.write(next);
			this.assertOpen();
			this.credential = next;
		});
		this.refreshTail = refresh.then(
			() => undefined,
			() => undefined,
		);
		try {
			await refresh;
		} catch {
			this.setStatus("reconnect");
			throw new Error("Reconnect is required");
		}
		if (!this.credential) throw new Error("Reconnect is required");
		return this.credential;
	}

	/** Builds a canonical record and rejects token responses that omit requested device scopes. */
	private makeCredential(
		clientId: string,
		token: {
			access_token: string;
			refresh_token: string;
			token_type: string;
			expires_in: number;
			scope?: string;
		},
	): DeviceCredential {
		const scope = token.scope ? token.scope.split(" ") : [...SCOPES];
		if (!SCOPES.every((required) => scope.includes(required)))
			throw new Error("OAuth token has insufficient device scopes");
		return DeviceCredentialSchema.parse({
			client_id: ClientIdSchema.parse(clientId),
			access_token: token.access_token,
			refresh_token: token.refresh_token,
			token_type: token.token_type,
			expires_at: this.now() + token.expires_in * 1000,
			scope,
		});
	}

	/** Blocks token use when the persisted device identity differs from the credential client. */
	private assertCredentialIdentity(credential: DeviceCredential): void {
		if (this.host.getClientId() !== credential.client_id)
			throw new Error("Stored device identity does not match credentials");
	}

	/** Blocks stale asynchronous effects from replacing a newer session or closed controller. */
	private assertCurrent(generation: number): void {
		this.assertOpen();
		if (generation !== this.generation)
			throw new Error("Authorization is stale");
	}

	/** Throws when the plugin lifecycle no longer owns this controller. */
	private assertOpen(): void {
		if (this.closed) throw new Error("Device session is closed");
	}

	/** Publishes only a fixed safe status enum to the settings adapter. */
	private setStatus(status: DeviceSessionStatus): void {
		if (!this.closed) this.host.statusChanged(status);
	}
}

/** Encodes random PKCE bytes with URL-safe base64 and no padding. */
function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}
