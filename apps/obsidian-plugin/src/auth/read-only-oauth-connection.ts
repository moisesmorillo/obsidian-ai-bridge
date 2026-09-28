import type { MirrorOrigin } from "@obsidian-ai-bridge/core";
import { z } from "zod";

/** Obsidian's registered native callback; no vault name or credential enters it. */
export const OAUTH_CALLBACK_URI = "obsidian://ai-bridge-oauth";
/** Obsidian protocol action matching the registered redirect URI. */
export const OAUTH_CALLBACK_ACTION = "ai-bridge-oauth";
/** Prefix reserved for OAuth grants with read permission only. */
export const READ_ONLY_OAUTH_SECRET_PREFIX = "ai-bridge-oauth-";

const MAX_RESPONSE_LENGTH = 16 * 1024;
const AUTHORIZATION_LIFETIME_MILLISECONDS = 10 * 60 * 1000;
const REST_RESOURCE_PATH = "/api/v2";

const registrationSchema = z.object({ client_id: z.string().min(1).max(256) });
const tokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  refresh_token: z.string().min(1).max(4096),
  token_type: z.literal("bearer"),
  expires_in: z.number().int().positive().max(86400),
  scope: z.literal("read"),
  resource: z.url(),
});

/** Only the fields needed from a native Obsidian protocol callback. */
export interface OAuthCallbackParameters {
  readonly code?: string | undefined;
  readonly state?: string | undefined;
  readonly iss?: string | undefined;
  readonly error?: string | undefined;
}

/** HTTP response seam used without browser CORS or an ambient Access cookie. */
export interface OAuthClientResponse {
  readonly status: number;
  readonly text: string;
}

/** Side effects kept outside the PKCE and callback validator. */
export interface ReadOnlyOAuthHost {
  /** Stable, non-sensitive label that distinguishes this installation's grant. */
  readonly installationName: string;
  /** Sends a bounded protocol request through Obsidian's native HTTP API. */
  request(
    url: string,
    body: string,
    contentType: string,
  ): Promise<OAuthClientResponse>;
  /** Opens the owner authorization page in a browser. */
  openBrowser(url: string): void;
  /** Saves short-lived and renewable credentials in native SecretStorage. */
  saveTokens(accessToken: string, refreshToken: string): Promise<boolean>;
  /** Confirms the issued bearer can read the exact REST resource. */
  verifyRead(origin: MirrorOrigin, accessToken: string): Promise<boolean>;
  /** Publishes only the endpoint and native access-secret reference. */
  saveConnection(origin: MirrorOrigin): Promise<boolean>;
}

/** Closed, sanitized outcome; no code, verifier, or token reaches UI callers. */
export type OAuthConnectionResult =
  | { readonly kind: "started" }
  | { readonly kind: "connected" }
  | { readonly kind: "busy" }
  | { readonly kind: "failed" };

/** Ephemeral verifier and issuer binding for one browser round trip. */
interface PendingAuthorization {
  readonly origin: MirrorOrigin;
  readonly clientId: string;
  readonly verifier: string;
  readonly state: string;
  readonly startedAt: number;
}

/** One plugin-session read-only OAuth attempt, fenced by state and exact issuer. */
export class ReadOnlyOAuthConnection {
  private pending: PendingAuthorization | null = null;
  private busy = false;
  private detached = false;

  /** @param host - Native browser, HTTP, and secret-storage effects. */
  constructor(private readonly host: ReadOnlyOAuthHost) {}

  /**
   * Registers a public client and starts one PKCE authorization request.
   * @param origin - Configured canonical HTTPS Worker origin.
   * @returns Sanitized start or refusal outcome.
   */
  async start(origin: MirrorOrigin): Promise<OAuthConnectionResult> {
    if (
      this.pending !== null &&
      Date.now() - this.pending.startedAt >= AUTHORIZATION_LIFETIME_MILLISECONDS
    )
      this.pending = null;
    if (this.detached || this.busy || this.pending !== null)
      return { kind: "busy" };
    if (!isCanonicalHttpsOrigin(origin)) return { kind: "failed" };
    this.busy = true;
    try {
      const verifier = randomBase64Url(32);
      const state = randomBase64Url(32);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
      );
      const challenge = base64Url(new Uint8Array(digest));
      const registered = await this.host.request(
        `${origin}/oauth/register`,
        JSON.stringify({
          client_name: this.host.installationName,
          redirect_uris: [OAUTH_CALLBACK_URI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
        "application/json",
      );
      const client = parseResponse(registrationSchema, registered, 201);
      if (client === null || this.detached) return { kind: "failed" };
      this.pending = {
        origin,
        clientId: client.client_id,
        verifier,
        state,
        startedAt: Date.now(),
      };
      const authorization = new URL("/authorize", origin);
      authorization.searchParams.set("client_id", client.client_id);
      authorization.searchParams.set("redirect_uri", OAUTH_CALLBACK_URI);
      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("scope", "read");
      authorization.searchParams.set(
        "resource",
        `${origin}${REST_RESOURCE_PATH}`,
      );
      authorization.searchParams.set("state", state);
      authorization.searchParams.set("code_challenge", challenge);
      authorization.searchParams.set("code_challenge_method", "S256");
      this.host.openBrowser(authorization.toString());
      return { kind: "started" };
    } catch {
      this.pending = null;
      return { kind: "failed" };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Consumes a matching callback once, then exchanges its code before publishing credentials.
   * @param params - Untrusted native protocol callback parameters.
   * @returns Sanitized connection or refusal outcome.
   */
  async complete(
    params: OAuthCallbackParameters,
  ): Promise<OAuthConnectionResult> {
    const pending = this.pending;
    if (this.detached || this.busy || pending === null)
      return { kind: "failed" };
    this.pending = null;
    if (
      Date.now() - pending.startedAt >= AUTHORIZATION_LIFETIME_MILLISECONDS ||
      params.error !== undefined ||
      params.state !== pending.state ||
      params.iss !== pending.origin ||
      typeof params.code !== "string" ||
      params.code.length === 0 ||
      params.code.length > 4096
    )
      return { kind: "failed" };
    this.busy = true;
    try {
      const tokenResponse = await this.host.request(
        `${pending.origin}/oauth/token`,
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: pending.clientId,
          code: params.code,
          redirect_uri: OAUTH_CALLBACK_URI,
          code_verifier: pending.verifier,
          resource: `${pending.origin}${REST_RESOURCE_PATH}`,
        }).toString(),
        "application/x-www-form-urlencoded",
      );
      const tokens = parseResponse(tokenSchema, tokenResponse, 200);
      if (
        tokens === null ||
        tokens.resource !== `${pending.origin}${REST_RESOURCE_PATH}` ||
        this.detached
      )
        return { kind: "failed" };
      if (!(await this.host.verifyRead(pending.origin, tokens.access_token))) {
        return { kind: "failed" };
      }
      if (this.detached) return { kind: "failed" };
      if (
        !(await this.host.saveTokens(tokens.access_token, tokens.refresh_token))
      ) {
        return { kind: "failed" };
      }
      if (this.detached || !(await this.host.saveConnection(pending.origin))) {
        return { kind: "failed" };
      }
      return { kind: "connected" };
    } catch {
      return { kind: "failed" };
    } finally {
      this.busy = false;
    }
  }

  /** Rejects callbacks and late responses after this plugin attachment unloads. */
  detach(): void {
    this.detached = true;
    this.pending = null;
  }
}

/**
 * @param reference - Configured native SecretStorage reference.
 * @returns Whether the reference belongs to the read-only OAuth connection.
 */
export function isReadOnlyOAuthSecretReference(reference: string): boolean {
  return /^ai-bridge-oauth-[0-9a-f]{32}$/.test(reference);
}

/** @returns A bounded, schema-valid OAuth response for the expected status. */
function parseResponse<Schema extends z.ZodType>(
  schema: Schema,
  response: OAuthClientResponse,
  expectedStatus: number,
): z.output<Schema> | null {
  if (
    response.status !== expectedStatus ||
    response.text.length > MAX_RESPONSE_LENGTH
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(response.text);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * @param value - Untrusted configured origin.
 * @returns Whether a configured bridge origin is exact canonical HTTPS.
 */
function isCanonicalHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

/**
 * @param byteCount - Number of random bytes.
 * @returns Cryptographically random unpadded base64url bytes.
 */
function randomBase64Url(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** @returns URL-safe unpadded encoding of binary input. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
