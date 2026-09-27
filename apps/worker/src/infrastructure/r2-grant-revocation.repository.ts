import {
  GRANT_REVOCATION_OBJECT_PREFIX,
  GRANT_REVOCATION_RESULT,
  GRANT_REVOCATION_STATUS,
} from "@worker/auth/grant-revocation.constants";
import type {
  GrantRevocationId,
  GrantRevocationResult,
  GrantRevocationStatus,
} from "@worker/auth/grant-revocation.types";

/** R2 operations required for permanent, create-only grant revocation markers. */
export interface GrantRevocationBucketPort {
  /** @returns Metadata for an existing marker, or `null` for exact absence. */
  head(key: string): Promise<{ readonly key: string } | null>;
  /** @returns Metadata for a created marker, or `null` on a failed absence precondition. */
  put(
    key: string,
    body: string,
    options: {
      readonly onlyIf: Headers;
      readonly httpMetadata: { readonly contentType: string };
    },
  ): Promise<{ readonly key: string } | null>;
}

/**
 * Uses strongly consistent R2 marker presence as the grant's irreversible deny fence.
 *
 * Only a confirmed absence permits later OAuth validation to proceed. No delete or
 * overwrite capability is exposed by this adapter.
 */
export class R2GrantRevocationRepository {
  /** @param bucket - Existing private R2 binding, restricted to head and conditional put. */
  constructor(private readonly bucket: GrantRevocationBucketPort) {}

  /**
   * Checks the authoritative marker without ever treating a read failure as active.
   *
   * @param id - Validated opaque per-grant revocation identity.
   * @returns Revoked, active, or unavailable; callers must deny on unavailable.
   */
  async check(id: GrantRevocationId): Promise<GrantRevocationStatus> {
    try {
      const marker = await this.bucket.head(this.key(id));
      return marker === null
        ? GRANT_REVOCATION_STATUS.active
        : GRANT_REVOCATION_STATUS.revoked;
    } catch {
      return GRANT_REVOCATION_STATUS.unavailable;
    }
  }

  /**
   * Writes a create-only marker, including the idempotent already-present case.
   *
   * @param id - Validated opaque per-grant revocation identity.
   * @returns Confirmed only after a successful write or authoritative read-back.
   */
  async revoke(id: GrantRevocationId): Promise<GrantRevocationResult> {
    const onlyIf = new Headers({ "If-None-Match": "*" });
    try {
      const written = await this.bucket.put(this.key(id), "", {
        onlyIf,
        httpMetadata: { contentType: "application/octet-stream" },
      });
      if (written !== null) return GRANT_REVOCATION_RESULT.confirmed;
    } catch {
      // A failed response may follow a committed write; read back before refusing.
    }

    return (await this.check(id)) === GRANT_REVOCATION_STATUS.revoked
      ? GRANT_REVOCATION_RESULT.confirmed
      : GRANT_REVOCATION_RESULT.uncertain;
  }

  /** @returns Private marker key that cannot overlap a note or recovery object. */
  private key(id: GrantRevocationId): string {
    return `${GRANT_REVOCATION_OBJECT_PREFIX}${id}`;
  }
}
