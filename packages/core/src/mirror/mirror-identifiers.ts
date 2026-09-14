import {
  APPLICATION_ETAG_PREFIX,
  CONTENT_SHA_256_PATTERN,
  UUID_V4_PATTERN,
} from "@core/mirror/mirror.constants";
import type {
  ApplicationEtag,
  ApplicationRevision,
  ContentSha256,
  MirrorAssociationId,
  MirrorOperationId,
  MirrorWriterId,
  RecoverySnapshotId,
} from "@core/mirror/mirror.types";

/**
 * Validates canonical lowercase UUID-v4 syntax without treating the identity as authorization.
 *
 * @param value - Untrusted identity candidate.
 * @returns Whether the candidate has canonical UUID-v4 syntax.
 */
export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

/**
 * Validates canonical lowercase SHA-256 content digests.
 *
 * @param value - Untrusted digest candidate.
 * @returns Whether the candidate is exactly 64 lowercase hexadecimal characters.
 */
export function isContentSha256(value: string): boolean {
  return CONTENT_SHA_256_PATTERN.test(value);
}

/**
 * Creates a validated mirror association identity.
 *
 * @param value - Untrusted association identity candidate.
 * @returns The opaque identity, or `undefined` when it is not canonical UUID-v4 syntax.
 */
export function createMirrorAssociationId(
  value: string,
): MirrorAssociationId | undefined {
  return createUuidV4<MirrorAssociationId>(value);
}

/**
 * Creates a validated designated mirror-writer identity.
 *
 * @param value - Untrusted writer identity candidate.
 * @returns The opaque identity, or `undefined` when it is not canonical UUID-v4 syntax.
 */
export function createMirrorWriterId(
  value: string,
): MirrorWriterId | undefined {
  return createUuidV4<MirrorWriterId>(value);
}

/**
 * Creates a validated idempotency identity for one exact mutation operation.
 *
 * @param value - Untrusted operation identity candidate.
 * @returns The opaque identity, or `undefined` when it is not canonical UUID-v4 syntax.
 */
export function createMirrorOperationId(
  value: string,
): MirrorOperationId | undefined {
  return createUuidV4<MirrorOperationId>(value);
}

/**
 * Creates a validated fresh application-generation revision.
 *
 * @param value - Untrusted revision candidate.
 * @returns The opaque revision, or `undefined` when it is not canonical UUID-v4 syntax.
 */
export function createApplicationRevision(
  value: string,
): ApplicationRevision | undefined {
  return createUuidV4<ApplicationRevision>(value);
}

/**
 * Creates a validated recovery snapshot identity.
 *
 * @param value - Untrusted recovery identity candidate.
 * @returns The opaque identity, or `undefined` when it is not canonical UUID-v4 syntax.
 */
export function createRecoverySnapshotId(
  value: string,
): RecoverySnapshotId | undefined {
  return createUuidV4<RecoverySnapshotId>(value);
}

/**
 * Creates a validated canonical SHA-256 content digest.
 *
 * @param value - Untrusted digest candidate.
 * @returns The opaque digest, or `undefined` when it is not canonical lowercase SHA-256.
 */
export function createContentSha256(value: string): ContentSha256 | undefined {
  if (!isContentSha256(value)) return undefined;
  return value as ContentSha256;
}

/**
 * Creates a strong M3 application ETag from one validated application revision.
 *
 * @param value - Untrusted HTTP ETag candidate.
 * @returns The opaque ETag, or `undefined` when it is not one strong M3 validator.
 */
export function createApplicationEtag(
  value: string,
): ApplicationEtag | undefined {
  const prefix = `"${APPLICATION_ETAG_PREFIX}`;
  if (!value.startsWith(prefix) || !value.endsWith('"')) return undefined;
  const revision = value.slice(prefix.length, -1);
  if (createApplicationRevision(revision) === undefined) return undefined;
  return value as ApplicationEtag;
}

/**
 * Checks whether a value is the only accepted strong M3 application ETag format.
 *
 * @param value - Untrusted HTTP ETag candidate.
 * @returns Whether the candidate can be used as an M3 application ETag.
 */
export function isApplicationEtag(value: string): value is ApplicationEtag {
  return createApplicationEtag(value) !== undefined;
}

/**
 * Narrows a UUID-v4 candidate to a semantic opaque identity after validation.
 *
 * @param value - Untrusted UUID-v4 candidate.
 * @returns The requested opaque identity, or `undefined` when validation fails.
 */
function createUuidV4<Identity extends string>(
  value: string,
): Identity | undefined {
  if (!isUuidV4(value)) return undefined;
  return value as Identity;
}
