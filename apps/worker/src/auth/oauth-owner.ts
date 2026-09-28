import type {
  AuthRequest,
  ClientInfo,
} from "@cloudflare/workers-oauth-provider";
import {
  AuthorizationError,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { CLIENT_PERMISSION } from "@worker/auth/auth.constants";
import { CREDENTIAL_NAME_PATTERN } from "@worker/auth/credential-registry";
import { GRANT_REVOCATION_RESULT } from "@worker/auth/grant-revocation.constants";
import { parseGrantRevocationId } from "@worker/auth/grant-revocation-id";
import { isCanonicalHttpsOrigin } from "@worker/auth/oauth-authenticate";
import { OAUTH_ROUTE_PATH } from "@worker/auth/oauth-routes";
import { createOAuthServer } from "@worker/auth/oauth-server";
import type { WorkerEnv } from "@worker/env/env.types";
import { R2GrantRevocationRepository } from "@worker/infrastructure/r2-grant-revocation.repository";
import { z } from "zod";

const MAX_FORM_BYTES = 8192;
const PAGE_SIZE = 50;
const NO_STORE = "no-store";

/**
 * @param redirectUri - Registered authorization callback.
 * @returns The consent form's browser or Obsidian redirect source.
 */
function formActionDestination(redirectUri: string): string {
  const redirect = new URL(redirectUri);
  return redirect.protocol === "obsidian:" ? "obsidian:" : redirect.origin;
}
const permissionSchema = z.enum([
  CLIENT_PERMISSION.read,
  CLIENT_PERMISSION.write,
  CLIENT_PERMISSION.delete,
]);
const grantMetadataSchema = z
  .object({
    name: z.string().regex(CREDENTIAL_NAME_PATTERN),
    revocationId: z.string(),
  })
  .strict();

/**
 * Authenticate owner UI requests with verified Access identity before provider work.
 * @param request - Incoming owner route request.
 * @param environment - Active OAuth and private R2 bindings.
 * @param access - Cloudflare's verified Access context, when present.
 * @returns A no-cache consent, grant-management, redirect, or refusal response.
 */
export async function handleOAuthOwnerRequest(
  request: Request,
  environment: WorkerEnv,
  access: CloudflareAccessContext | undefined,
): Promise<Response> {
  const owner = await ownerId(access);
  if (owner === undefined) return plain("Authentication is required.", 401);
  const issuer = environment.OAUTH_ISSUER;
  if (!isCanonicalHttpsOrigin(issuer))
    return plain("Authorization unavailable.", 503);

  const server = createOAuthServer<WorkerEnv>(issuer);
  const oauth = server.getOAuthApi(environment);
  const path = new URL(request.url).pathname;
  try {
    if (path === OAUTH_ROUTE_PATH.authorize && request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const client = await oauth.lookupClient(authRequest.clientId);
      if (client === null) return plain("Unknown client.", 400);
      const consent = await oauth.beginConsent(authRequest);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      consent.headers.set("Cache-Control", NO_STORE);
      consent.headers.set(
        "Content-Security-Policy",
        `default-src 'none'; form-action 'self' ${formActionDestination(authRequest.redirectUri)}; base-uri 'none'; frame-ancestors 'none'`,
      );
      return new Response(consentPage(client, authRequest, consent.handle), {
        headers: consent.headers,
      });
    }
    if (path === OAUTH_ROUTE_PATH.authorize && request.method === "POST") {
      if (!isSameOriginPost(request, issuer))
        return plain("Invalid form origin.", 403);
      const form = await readForm(request);
      if (form === undefined) return plain("Invalid form.", 400);
      const handle = form.get("handle");
      if (handle === null) return plain("Invalid form.", 400);
      if (form.get("decision") === "deny") {
        const denied = await oauth.denyConsent(request, handle);
        denied.headers.set("Cache-Control", NO_STORE);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      if (form.get("decision") !== "approve")
        return plain("Invalid decision.", 400);
      const name = form.get("name");
      const scopes = form.getAll("scope");
      if (name === null || !CREDENTIAL_NAME_PATTERN.test(name))
        return plain("Invalid client name.", 400);
      const parsedScopes = z
        .array(permissionSchema)
        .min(1)
        .max(3)
        .safeParse(scopes);
      if (!parsedScopes.success || new Set(scopes).size !== scopes.length) {
        return plain("Invalid permissions.", 400);
      }
      const approved = await oauth.approveConsent(request, handle, {
        scope: parsedScopes.data,
      });
      if (
        parsedScopes.data.some(
          (scope) => !approved.request.scope.includes(scope),
        )
      ) {
        return plain("Permissions exceed the request.", 400);
      }
      const principalId = crypto.randomUUID();
      const revocationId = crypto.randomUUID();
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: owner,
        metadata: { name, revocationId },
        scope: parsedScopes.data,
        props: {
          principalId,
          name,
          revocationId,
          permissions: parsedScopes.data,
        },
        revokeExistingGrants: false,
      });
      approved.headers.set("Location", redirectTo);
      approved.headers.set("Cache-Control", NO_STORE);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    if (path === OAUTH_ROUTE_PATH.grants && request.method === "GET") {
      const cursor =
        new URL(request.url).searchParams.get("cursor") ?? undefined;
      const page = await oauth.listUserGrants(owner, {
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      return html(grantsPage(page.items, page.cursor, cursor));
    }
    if (path === OAUTH_ROUTE_PATH.grants && request.method === "POST") {
      if (!isSameOriginPost(request, issuer))
        return plain("Invalid form origin.", 403);
      const form = await readForm(request);
      if (form === undefined) return plain("Invalid form.", 400);
      const grantId = form.get("grantId");
      const cursor = form.get("cursor") || undefined;
      if (grantId === null) return plain("Invalid grant.", 400);
      const page = await oauth.listUserGrants(owner, {
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const grant = page.items.find((item) => item.id === grantId);
      if (grant === undefined) return plain("Grant not found.", 404);
      const metadata = grantMetadataSchema.safeParse(grant.metadata);
      const revocationId = metadata.success
        ? parseGrantRevocationId(metadata.data.revocationId)
        : undefined;
      if (revocationId === undefined)
        return plain("Grant cannot be revoked safely.", 503);
      const marker = new R2GrantRevocationRepository(environment.VAULT_BUCKET);
      if (
        (await marker.revoke(revocationId)) !==
        GRANT_REVOCATION_RESULT.confirmed
      ) {
        return plain("Revocation could not be confirmed.", 503);
      }
      await oauth.revokeGrant(grantId, owner);
      return new Response(null, {
        status: 303,
        headers: {
          Location: `${issuer}${OAUTH_ROUTE_PATH.grants}`,
          "Cache-Control": NO_STORE,
        },
      });
    }
    return plain("Not found.", 404);
  } catch (error) {
    if (
      error instanceof AuthorizationError &&
      error.redirectUri &&
      path === OAUTH_ROUTE_PATH.authorize &&
      request.method === "GET"
    ) {
      const redirect = new URL(error.redirectUri);
      redirect.searchParams.set("error", error.code);
      redirect.searchParams.set("error_description", error.description);
      if (error.state) redirect.searchParams.set("state", error.state);
      if (error.issuer) redirect.searchParams.set("iss", error.issuer);
      return new Response(null, {
        status: 302,
        headers: {
          Location: redirect.href,
          "Cache-Control": NO_STORE,
        },
      });
    }
    if (
      error instanceof AuthorizationError ||
      error instanceof CimdFetchError
    ) {
      return plain("Authorization request rejected.", 400);
    }
    return plain("Authorization unavailable.", 503);
  }
}

/**
 * Resolve one stable grant owner from verified Access identity, never headers.
 * @param access - Cloudflare's verified Access context.
 * @returns Case-normalized owner ID or absence on any identity failure.
 */
async function ownerId(
  access: CloudflareAccessContext | undefined,
): Promise<string | undefined> {
  if (access === undefined) return undefined;
  try {
    const identity = await access.getIdentity();
    const email = identity?.email;
    return typeof email === "string" && email.trim().length > 0
      ? email.trim().toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accept browser forms only from the configured authorization origin.
 * @param request - Incoming form request.
 * @param issuer - Canonical authorization origin.
 * @returns Whether the origin and media type are exact.
 */
function isSameOriginPost(request: Request, issuer: string): boolean {
  return (
    request.headers.get("Origin") === issuer &&
    request.headers
      .get("Content-Type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "application/x-www-form-urlencoded"
  );
}

/**
 * Read a bounded URL-encoded form without buffering an unbounded request body.
 * @param request - Incoming POST request after origin and media-type checks.
 * @returns Parsed form or absence for oversized, invalid, or missing bodies.
 */
async function readForm(
  request: Request,
): Promise<URLSearchParams | undefined> {
  const reader = request.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_FORM_BYTES || chunks.length >= 32) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return undefined;
  }
}

/**
 * Escape all client-controlled text before embedding it in owner HTML.
 * @param value - Untrusted display text or attribute value.
 * @returns HTML-safe text.
 */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => `&#${character.charCodeAt(0)};`,
  );
}

/**
 * Render a per-client consent choice with verified redirect destination and scopes.
 * @param client - Provider-validated client metadata, still untrusted for HTML.
 * @param request - Provider-validated authorization request.
 * @param handle - Provider's browser-bound one-time consent handle.
 * @returns Escaped standalone consent page.
 */
function consentPage(
  client: ClientInfo,
  request: AuthRequest,
  handle: string,
): string {
  const displayName = client.clientName ?? client.clientId;
  const host = new URL(request.redirectUri).hostname;
  const clientOrigin = client.clientId.startsWith("https://")
    ? `Client domain: ${escapeHtml(new URL(client.clientId).hostname)}.`
    : "This client registered itself; its name is not verified.";
  const localWarning = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(host)
    ? "<p><strong>This sends access to an app on your computer. Continue only if you started this request.</strong></p>"
    : "";
  const scopes = request.scope
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label>`,
    )
    .join("<br>");
  return `<!doctype html><meta charset="utf-8"><title>Authorize ${escapeHtml(displayName)}</title>
<h1>Allow ${escapeHtml(displayName)} to access Obsidian Bridge?</h1>
<p>${clientOrigin} Tokens will be sent to <strong>${escapeHtml(host)}</strong>.</p>${localWarning}
<p>Resource: ${escapeHtml(request.resource ?? "")}</p>
<form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<label>Installation or client name <input name="name" maxlength="64" required value="${escapeHtml(displayName.slice(0, 64))}"></label>
<fieldset><legend>Permissions</legend>${scopes}</fieldset>
<button name="decision" value="approve">Allow</button>
<button name="decision" value="deny">Deny</button></form>`;
}

/**
 * Show only the owner's current grant page and revocation controls.
 * @param grants - One provider page of grants for the verified owner.
 * @param nextCursor - Opaque cursor to the next page, if any.
 * @param currentCursor - Opaque cursor identifying the displayed page.
 * @returns Escaped standalone management page.
 */
function grantsPage(
  grants: readonly {
    id: string;
    clientId: string;
    scope: string[];
    metadata: unknown;
    resource?: string | string[];
  }[],
  nextCursor: string | undefined,
  currentCursor: string | undefined,
): string {
  const rows = grants
    .map((grant) => {
      const metadata = grantMetadataSchema.safeParse(grant.metadata);
      const name = metadata.success ? metadata.data.name : "Unnamed grant";
      const resource = Array.isArray(grant.resource)
        ? grant.resource.join(", ")
        : (grant.resource ?? "Unknown resource");
      return `<li><strong>${escapeHtml(name)}</strong> — ${escapeHtml(resource)} — ${escapeHtml(grant.scope.join(", "))}
<form method="post"><input type="hidden" name="grantId" value="${escapeHtml(grant.id)}">
<input type="hidden" name="cursor" value="${escapeHtml(currentCursor ?? "")}">
<button>Revoke</button></form></li>`;
    })
    .join("");
  const next =
    nextCursor === undefined
      ? ""
      : `<a href="${OAUTH_ROUTE_PATH.grants}?cursor=${encodeURIComponent(nextCursor)}">Next page</a>`;
  return `<!doctype html><meta charset="utf-8"><title>Authorized clients</title>
<h1>Authorized clients</h1><ul>${rows}</ul>${next}`;
}

/**
 * Send no-cache owner HTML with browser framing disabled.
 * @param body - Escaped owner page.
 * @returns Restricted HTML response.
 */
function html(body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": NO_STORE,
      "Content-Security-Policy":
        "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
    },
  });
}

/**
 * Send an uncached refusal without provider or identity details.
 * @param body - Generic operator-facing error.
 * @param status - HTTP refusal status.
 * @returns Plain-text response.
 */
function plain(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": NO_STORE,
    },
  });
}
