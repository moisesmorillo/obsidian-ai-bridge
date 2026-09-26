import { CACHE_CONTROL_NO_STORE } from "@worker/http/http.constants";

/** Exact route used to verify that Access authenticated this Worker invocation. */
export const ACCESS_SESSION_PATH = "/auth/session";

const SESSION_HEADERS = { "Cache-Control": CACHE_CONTROL_NO_STORE };

/**
 * Confirms a signed-in human identity without exposing identity fields or
 * creating an application client principal.
 *
 * @param access - Access context supplied by Cloudflare for this invocation.
 * @returns An uncached empty response; missing or unusable identity fails closed.
 */
export async function resolveAccessSession(
  access: CloudflareAccessContext | undefined,
): Promise<Response> {
  if (access === undefined) {
    return new Response(null, { status: 401, headers: SESSION_HEADERS });
  }

  try {
    const identity = await access.getIdentity();
    if (
      typeof identity?.email !== "string" ||
      identity.email.trim().length === 0
    ) {
      return new Response(null, { status: 401, headers: SESSION_HEADERS });
    }
  } catch {
    return new Response(null, { status: 401, headers: SESSION_HEADERS });
  }

  return new Response(null, { status: 204, headers: SESSION_HEADERS });
}
