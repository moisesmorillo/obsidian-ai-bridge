import type {
  GRANT_REVOCATION_RESULT,
  GRANT_REVOCATION_STATUS,
} from "@worker/auth/grant-revocation.constants";

/** Opaque canonical UUID-v4 assigned to one independently revocable OAuth grant. */
export type GrantRevocationId = string & {
  readonly __brand: "GrantRevocationId";
};

/** Revocation lookup distinguishes safe absence from unavailable storage. */
export type GrantRevocationStatus =
  (typeof GRANT_REVOCATION_STATUS)[keyof typeof GRANT_REVOCATION_STATUS];

/** A revocation write is confirmed only when R2 confirms its persistent marker. */
export type GrantRevocationResult =
  (typeof GRANT_REVOCATION_RESULT)[keyof typeof GRANT_REVOCATION_RESULT];
