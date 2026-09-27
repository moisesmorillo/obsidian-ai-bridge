import { isUuidV4 } from "@obsidian-ai-bridge/core";
import type { GrantRevocationId } from "@worker/auth/grant-revocation.types";

/**
 * Parses the independent grant revocation identity without accepting R2 key syntax.
 *
 * @param value - Untrusted grant identity.
 * @returns Canonical UUID-v4 identity, or `undefined` for invalid syntax.
 */
export function parseGrantRevocationId(
  value: string,
): GrantRevocationId | undefined {
  if (!isUuidV4(value)) return undefined;
  return value as GrantRevocationId;
}

/** @returns A fresh cryptographically random grant revocation identity. */
export function createGrantRevocationId(): GrantRevocationId {
  const id = parseGrantRevocationId(crypto.randomUUID());
  if (id === undefined)
    throw new Error("The runtime generated an invalid UUID");
  return id;
}
