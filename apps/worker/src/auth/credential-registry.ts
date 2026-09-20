import { isUuidV4 } from "@obsidian-ai-bridge/core";
import {
  CLIENT_PERMISSION,
  CREDENTIAL_REGISTRY_VERSION,
  MAX_ACTIVE_CREDENTIALS,
} from "@worker/auth/auth.constants";
import type {
  ClientPrincipal,
  CredentialRegistry,
} from "@worker/auth/auth.types";
import { z } from "zod";

/** Exact ASCII grammar for operator-facing active credential names. */
export const CREDENTIAL_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9])?$/;

/** Canonical lowercase hexadecimal representation of one SHA-256 token digest. */
export const CREDENTIAL_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Domain separator prepended to UTF-8 token bytes before SHA-256. */
export const CREDENTIAL_DIGEST_DOMAIN =
  "obsidian-ai-bridge:client-credential:v1\0";

/** Closed registry decode outcome that never exposes rejected configuration values. */
export type CredentialRegistryDecodeResult =
  | { readonly kind: "valid"; readonly registry: CredentialRegistry }
  | { readonly kind: "invalid" };

/** Injectable digest/comparison seam used to prove complete registry evaluation. */
export interface CredentialVerificationDependencies {
  /** Produces the canonical domain-separated digest for the supplied bearer. */
  readonly digest: (token: string) => Promise<string>;
  /** Compares canonical digest representations without content-dependent exit. */
  readonly matches: (left: string, right: string) => boolean;
}

/** Strict closed permission value accepted in serialized registry entries. */
const clientPermissionSchema = z.enum([
  CLIENT_PERMISSION.read,
  CLIENT_PERMISSION.write,
  CLIENT_PERMISSION.delete,
]);

/** Strict registry entry shape before complete-registry uniqueness checks. */
const credentialRegistryEntrySchema = z
  .object({
    clientId: z.string().refine(isUuidV4),
    name: z.string().regex(CREDENTIAL_NAME_PATTERN),
    permissions: z
      .array(clientPermissionSchema)
      .min(1)
      .max(Object.keys(CLIENT_PERMISSION).length),
    tokenDigest: z.string().regex(CREDENTIAL_DIGEST_PATTERN),
  })
  .strict()
  .superRefine((entry, context) => {
    if (new Set(entry.permissions).size !== entry.permissions.length) {
      context.addIssue({
        code: "custom",
        message: "Credential permissions must be unique.",
        path: ["permissions"],
      });
    }
  });

/** Single semantic owner for the complete version, shape, bound, and uniqueness contract. */
const credentialRegistrySchema = z
  .object({
    version: z.literal(CREDENTIAL_REGISTRY_VERSION),
    credentials: z
      .array(credentialRegistryEntrySchema)
      .max(MAX_ACTIVE_CREDENTIALS),
  })
  .strict()
  .superRefine((registry, context) => {
    const clientIds = new Set<string>();
    const names = new Set<string>();
    const digests = new Set<string>();

    registry.credentials.forEach((entry, index) => {
      const foldedName = entry.name.toLowerCase();
      addDuplicateIssue(context, clientIds, entry.clientId, index, "clientId");
      addDuplicateIssue(context, names, foldedName, index, "name");
      addDuplicateIssue(
        context,
        digests,
        entry.tokenDigest,
        index,
        "tokenDigest",
      );
    });
  });

/** Default Web Crypto verification behavior used by production authentication. */
const credentialVerificationDependencies: CredentialVerificationDependencies = {
  digest: digestCredentialToken,
  matches: constantTimeDigestEqual,
};

/**
 * Strictly validates a parsed registry as one atomic configuration value.
 *
 * @param value - Untrusted parsed registry data.
 * @returns The complete registry or one sanitized invalid result; entries are never partially accepted.
 */
export function validateCredentialRegistry(
  value: unknown,
): CredentialRegistryDecodeResult {
  const result = credentialRegistrySchema.safeParse(value);
  return result.success
    ? { kind: "valid", registry: result.data }
    : { kind: "invalid" };
}

/**
 * Parses and strictly validates serialized Worker registry configuration.
 *
 * @param serialized - Secret configuration text, or undefined when unconfigured.
 * @returns A complete validated registry or one sanitized invalid result.
 */
export function decodeCredentialRegistry(
  serialized: string | undefined,
): CredentialRegistryDecodeResult {
  if (serialized === undefined || serialized === "") {
    return { kind: "invalid" };
  }

  try {
    return validateCredentialRegistry(JSON.parse(serialized));
  } catch {
    return { kind: "invalid" };
  }
}

/**
 * Serializes only a fully valid digest-only registry in canonical field order.
 *
 * @param registry - Complete candidate registry.
 * @returns Compact JSON containing verifier material and non-secret metadata only.
 * @throws When the candidate violates any registry invariant.
 */
export function serializeCredentialRegistry(
  registry: CredentialRegistry,
): string {
  const validated = validateCredentialRegistry(registry);
  if (validated.kind !== "valid") {
    throw new Error("Invalid credential registry.");
  }

  return JSON.stringify({
    version: validated.registry.version,
    credentials: validated.registry.credentials.map((entry) => ({
      clientId: entry.clientId,
      name: entry.name,
      permissions: [...entry.permissions],
      tokenDigest: entry.tokenDigest,
    })),
  });
}

/**
 * Computes the accepted domain-separated SHA-256 verifier for an opaque bearer.
 *
 * @param token - Raw bearer held only for the duration of digest calculation.
 * @returns Canonical lowercase hexadecimal SHA-256 digest.
 * @throws When Web Crypto is unavailable or digest calculation fails.
 */
export async function digestCredentialToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const domain = encoder.encode(CREDENTIAL_DIGEST_DOMAIN);
  const tokenBytes = encoder.encode(token);
  const input = new Uint8Array(domain.byteLength + tokenBytes.byteLength);
  input.set(domain);
  input.set(tokenBytes, domain.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Resolves one bearer to its typed client principal after evaluating every registry digest.
 *
 * @param token - Raw bearer supplied in the sanitized Authorization boundary.
 * @param registry - Complete validated digest-only registry.
 * @param dependencies - Digest/comparison behavior; injectable only for deterministic verification tests.
 * @returns Matching principal without verifier material, or null when no digest matches.
 */
export async function resolveCredentialPrincipal(
  token: string,
  registry: CredentialRegistry,
  dependencies: CredentialVerificationDependencies = credentialVerificationDependencies,
): Promise<ClientPrincipal | null> {
  const suppliedDigest = await dependencies.digest(token);
  let matchedIndex = -1;

  registry.credentials.forEach((entry, index) => {
    if (dependencies.matches(suppliedDigest, entry.tokenDigest)) {
      matchedIndex = index;
    }
  });

  const matched = registry.credentials[matchedIndex];
  if (matched === undefined) {
    return null;
  }

  return {
    clientId: matched.clientId,
    name: matched.name,
    permissions: [...matched.permissions],
  };
}

/**
 * Adds one issue when a complete-registry uniqueness set already contains the value.
 *
 * @param context - Active Zod refinement context.
 * @param seen - Values already accepted earlier in registry order.
 * @param value - Canonical comparison value for the current entry.
 * @param index - Current registry entry index.
 * @param field - Entry field that owns the uniqueness constraint.
 */
function addDuplicateIssue(
  context: z.RefinementCtx,
  seen: Set<string>,
  value: string,
  index: number,
  field: "clientId" | "name" | "tokenDigest",
): void {
  if (seen.has(value)) {
    context.addIssue({
      code: "custom",
      message: "Credential registry values must be unique.",
      path: ["credentials", index, field],
    });
  }
  seen.add(value);
}

/**
 * Compares two canonical digest strings without exiting at their first difference.
 *
 * @param left - Supplied-token digest.
 * @param right - Configured verifier digest.
 * @returns Whether lengths and every character code match.
 */
function constantTimeDigestEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const longestLength = Math.max(left.length, right.length);

  for (let index = 0; index < longestLength; index += 1) {
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return difference === 0;
}
