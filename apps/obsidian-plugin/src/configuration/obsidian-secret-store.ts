/** Narrow feature-detectable subset of Obsidian's official SecretStorage. */
export interface ObsidianSecretStorageHost {
  /** @param reference - Host-managed secret identifier. @returns Secret or null. */
  getSecret?(reference: string): string | null;
}

/** Closed native-secret reference check used by activation readiness. */
export type SecretReferenceStatus =
  | { readonly kind: "available" }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" };

/**
 * Narrow adapter over Obsidian SecretStorage for reference validation.
 *
 * The bearer value is inspected only long enough to prove a nonempty referenced
 * secret exists. It is never returned, cached, serialized, logged, or copied to a
 * plaintext plugin setting. Slice 4 will own just-in-time dispatch retrieval.
 */
export class ObsidianSecretReferenceStore {
  /** @param storage - Official vault-local native secret service. */
  constructor(private readonly storage: ObsidianSecretStorageHost) {}

  /**
   * @param reference - Host-managed secret identifier from validated preferences.
   * @returns Availability without exposing the bearer value.
   */
  check(reference: string | null): SecretReferenceStatus {
    if (reference === null) return { kind: "missing" };
    if (this.storage.getSecret === undefined) return { kind: "unavailable" };
    try {
      const secret = this.storage.getSecret(reference);
      return secret === null || secret.length === 0
        ? { kind: "missing" }
        : { kind: "available" };
    } catch {
      return { kind: "unavailable" };
    }
  }
}
