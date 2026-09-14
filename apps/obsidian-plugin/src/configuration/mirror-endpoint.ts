import type { MirrorOrigin } from "@obsidian-ai-bridge/core";

/** Maximum accepted endpoint preference length before URL parsing. */
export const MAX_MIRROR_ORIGIN_LENGTH = 2048;

/** Closed endpoint validation failures suitable for sanitized settings feedback. */
export const MIRROR_ENDPOINT_FAILURE = {
  malformed: "malformed",
  notOrigin: "not-origin",
  insecure: "insecure",
  loopbackOptInRequired: "loopback-opt-in-required",
} as const;

/** Sanitized endpoint validation failure. */
export type MirrorEndpointFailure =
  (typeof MIRROR_ENDPOINT_FAILURE)[keyof typeof MIRROR_ENDPOINT_FAILURE];

/** Result of validating and canonicalizing one configured Worker origin. */
export type MirrorEndpointResult =
  | { readonly kind: "valid"; readonly origin: MirrorOrigin }
  | { readonly kind: "invalid"; readonly reason: MirrorEndpointFailure };

const ABSOLUTE_HTTP_ORIGIN_PATTERN = /^(https?):\/\/([^/?#]+)\/?$/;
const EXACT_LOOPBACK_AUTHORITY_PATTERN =
  /^(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:0|[1-9][0-9]{0,4}))?$/;

/**
 * Validates an absolute root origin before URL canonicalization.
 *
 * HTTP is restricted to exact literal loopback authority and explicit development
 * opt-in. Numeric aliases, userinfo, LAN addresses, suffixes, paths, queries,
 * fragments, and fallback repair are rejected before `URL` can normalize them.
 *
 * @param input - Raw user preference.
 * @param allowLoopbackHttp - Explicit origin-bound development permission.
 * @returns Canonical origin or a sanitized refusal.
 */
export function validateMirrorEndpoint(
  input: string,
  allowLoopbackHttp: boolean,
): MirrorEndpointResult {
  if (
    input.length === 0 ||
    input.length > MAX_MIRROR_ORIGIN_LENGTH ||
    input.trim() !== input
  ) {
    return invalid(MIRROR_ENDPOINT_FAILURE.malformed);
  }
  const lexical = ABSOLUTE_HTTP_ORIGIN_PATTERN.exec(input);
  if (lexical === null) return invalid(MIRROR_ENDPOINT_FAILURE.notOrigin);
  const scheme = lexical[1];
  const authority = lexical[2];
  if (
    scheme === undefined ||
    authority === undefined ||
    authority.includes("@")
  ) {
    return invalid(MIRROR_ENDPOINT_FAILURE.malformed);
  }
  if (scheme === "http") {
    if (!EXACT_LOOPBACK_AUTHORITY_PATTERN.test(authority)) {
      return invalid(MIRROR_ENDPOINT_FAILURE.insecure);
    }
    if (!allowLoopbackHttp) {
      return invalid(MIRROR_ENDPOINT_FAILURE.loopbackOptInRequired);
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return invalid(MIRROR_ENDPOINT_FAILURE.malformed);
  }
  if (
    parsed.protocol !== `${scheme}:` ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return invalid(MIRROR_ENDPOINT_FAILURE.notOrigin);
  }
  return { kind: "valid", origin: parsed.origin };
}

/**
 * Validates a canonical persisted origin without granting new HTTP permission.
 *
 * @param value - Persisted canonical origin.
 * @returns Opaque origin only when it is already canonical and policy-valid.
 */
export function parsePersistedMirrorOrigin(
  value: string,
): MirrorOrigin | undefined {
  const parsed = validateMirrorEndpoint(value, true);
  if (parsed.kind !== "valid" || parsed.origin !== value) return undefined;
  return parsed.origin;
}

function invalid(reason: MirrorEndpointFailure): MirrorEndpointResult {
  return { kind: "invalid", reason };
}
