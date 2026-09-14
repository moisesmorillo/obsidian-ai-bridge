import {
  APPLICATION_ETAG_PATTERN,
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

/** Opening delimiter and protocol prefix shared by ETag formatting and parsing. */
const APPLICATION_ETAG_REVISION_PREFIX = `"${APPLICATION_ETAG_PREFIX}`;

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
 * Formats one validated application revision as the protocol's strong ETag.
 *
 * @param revision - Validated application generation identity.
 * @returns The canonical quoted strong validator for that generation.
 */
export function formatApplicationEtag(
  revision: ApplicationRevision,
): ApplicationEtag {
  return `${APPLICATION_ETAG_REVISION_PREFIX}${revision}"` as ApplicationEtag;
}

/**
 * Parses one canonical strong M3 application ETag to its generation identity.
 *
 * Weak validators, wildcards, lists, alternate prefixes, and malformed revisions
 * have no application-generation representation.
 *
 * @param value - Untrusted HTTP ETag candidate.
 * @returns The validated application revision, or `undefined` for any other syntax.
 */
export function parseApplicationEtag(
  value: string,
): ApplicationRevision | undefined {
  if (!APPLICATION_ETAG_PATTERN.test(value)) return undefined;
  return createApplicationRevision(
    value.slice(APPLICATION_ETAG_REVISION_PREFIX.length, -1),
  );
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
  if (parseApplicationEtag(value) === undefined) return undefined;
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
