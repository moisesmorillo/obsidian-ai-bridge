/** Private R2 key prefix kept outside the note and recovery namespaces. */
export const GRANT_REVOCATION_OBJECT_PREFIX = "auth/revoked/";

/** Closed outcomes for the authoritative revocation check. */
export const GRANT_REVOCATION_STATUS = {
  active: "active",
  revoked: "revoked",
  unavailable: "unavailable",
} as const;

/** Closed outcomes for an idempotent revocation write. */
export const GRANT_REVOCATION_RESULT = {
  confirmed: "confirmed",
  uncertain: "uncertain",
} as const;
