import { Buffer } from "node:buffer";
import {
  CLIENT_PERMISSION,
  CREDENTIAL_REGISTRY_VERSION,
  MAX_ACTIVE_CREDENTIALS,
} from "@worker/auth/auth.constants";
import type {
  ClientPermission,
  CredentialRegistry,
  CredentialRegistryEntry,
} from "@worker/auth/auth.types";
import {
  CREDENTIAL_NAME_PATTERN,
  digestCredentialToken,
  validateCredentialRegistry,
} from "@worker/auth/credential-registry";

/** Exact secure-random byte count used for every new opaque bearer. */
export const CREDENTIAL_TOKEN_BYTES = 32;

/** Closed lifecycle failure reasons safe to display without configuration values. */
export const CREDENTIAL_LIFECYCLE_FAILURE = {
  capacityExceeded: "capacity_exceeded",
  credentialNotFound: "credential_not_found",
  invalidMetadata: "invalid_metadata",
  invalidRegistry: "invalid_registry",
  secureRandomUnavailable: "secure_random_unavailable",
} as const;

/** Operator-supplied non-secret metadata for one new client. */
export interface NewCredentialMetadata {
  /** Unique display label accepted by the registry grammar. */
  readonly name: string;
  /** Exact requested permissions; implied permissions are never added. */
  readonly permissions: readonly string[];
}

/** Injectable cryptographic source for deterministic failure and lifecycle tests. */
export interface CredentialGenerationDependencies {
  /** Fills the exact token buffer from a cryptographically secure source. */
  readonly fillRandom: (target: Uint8Array<ArrayBuffer>) => void;
  /** Generates a fresh canonical UUID-v4 client identity. */
  readonly randomUuid: () => string;
  /** Derives the domain-separated verifier for the generated bearer. */
  readonly digestToken: (token: string) => Promise<string>;
}

/** One generated credential returned for immediate one-time operator transfer. */
export interface GeneratedCredential {
  /** Digest-only complete replacement registry. */
  readonly registry: CredentialRegistry;
  /** Newly generated public client identity. */
  readonly clientId: string;
  /** Raw opaque bearer that must be transferred once and is never serialized with the registry. */
  readonly token: string;
}

/** One generated client secret from a total-registry replacement operation. */
export interface ReplacementCredentialSecret {
  /** Operator-facing name identifying the intended consuming client. */
  readonly name: string;
  /** Fresh immutable client identity. */
  readonly clientId: string;
  /** Fresh raw bearer shown only by the caller's explicit transfer channel. */
  readonly token: string;
}

/** Complete result of replacing an untrusted or lost registry with all-new authority. */
export interface RegistryReplacement {
  /** Fresh digest-only registry unrelated to the lost verifier set. */
  readonly registry: CredentialRegistry;
  /** Fresh client secrets for deliberate one-time reprovisioning. */
  readonly credentials: readonly ReplacementCredentialSecret[];
}

/** Typed lifecycle result that never places raw tokens in a failure. */
export type CredentialLifecycleResult<Value> =
  | { readonly kind: "success"; readonly value: Value }
  | {
      readonly kind: "failure";
      readonly reason: (typeof CREDENTIAL_LIFECYCLE_FAILURE)[keyof typeof CREDENTIAL_LIFECYCLE_FAILURE];
    };

/** Production cryptographic generation dependencies backed by Web Crypto. */
const credentialGenerationDependencies: CredentialGenerationDependencies = {
  fillRandom: (target) => crypto.getRandomValues(target),
  randomUuid: () => crypto.randomUUID(),
  digestToken: digestCredentialToken,
};

/**
 * Creates a valid empty registry for initial provisioning or deliberate total revocation.
 *
 * @returns Versioned registry with no active authentication authority.
 */
export function createEmptyCredentialRegistry(): CredentialRegistry {
  return { version: CREDENTIAL_REGISTRY_VERSION, credentials: [] };
}

/**
 * Adds one fresh independently addressable credential after validating the complete result.
 *
 * @param registry - Existing complete digest-only registry.
 * @param metadata - New client name and exact permissions.
 * @param dependencies - Secure generation boundary.
 * @returns Fresh one-time bearer plus complete replacement registry, or a closed failure.
 */
export async function createCredential(
  registry: CredentialRegistry,
  metadata: NewCredentialMetadata,
  dependencies: CredentialGenerationDependencies = credentialGenerationDependencies,
): Promise<CredentialLifecycleResult<GeneratedCredential>> {
  if (validateCredentialRegistry(registry).kind !== "valid") {
    return failure(CREDENTIAL_LIFECYCLE_FAILURE.invalidRegistry);
  }
  if (registry.credentials.length >= MAX_ACTIVE_CREDENTIALS) {
    return failure(CREDENTIAL_LIFECYCLE_FAILURE.capacityExceeded);
  }

  const permissions = validateMetadata(metadata);
  if (permissions === null) {
    return failure(CREDENTIAL_LIFECYCLE_FAILURE.invalidMetadata);
  }

  let clientId: string;
  let token: string;
  let tokenDigest: string;
  try {
    clientId = dependencies.randomUuid();
    const randomBytes = new Uint8Array(new ArrayBuffer(CREDENTIAL_TOKEN_BYTES));
    dependencies.fillRandom(randomBytes);
    token = Buffer.from(randomBytes).toString("base64url");
    tokenDigest = await dependencies.digestToken(token);
  } catch {
    return failure(CREDENTIAL_LIFECYCLE_FAILURE.secureRandomUnavailable);
  }

  const entry: CredentialRegistryEntry = {
    clientId,
    name: metadata.name,
    permissions,
    tokenDigest,
  };
  const candidate: CredentialRegistry = {
    version: CREDENTIAL_REGISTRY_VERSION,
    credentials: [...registry.credentials, entry],
  };
  if (validateCredentialRegistry(candidate).kind !== "valid") {
    return failure(CREDENTIAL_LIFECYCLE_FAILURE.invalidRegistry);
  }

  return {
    kind: "success",
    value: { registry: candidate, clientId, token },
  };
}

/**
 * Creates a distinct replacement while retaining the old client for bounded verification overlap.
 *
 * @param registry - Existing complete registry containing the old client.
 * @param clientId - Exact old client identity retained until explicit revoke.
 * @param metadata - Replacement name and permissions.
 * @param dependencies - Secure generation boundary.
 * @returns Distinct replacement credential and overlapped registry, or a closed failure.
 */
export async function rotateCredential(
  registry: CredentialRegistry,
  clientId: string,
  metadata: NewCredentialMetadata,
  dependencies: CredentialGenerationDependencies = credentialGenerationDependencies,
): Promise<CredentialLifecycleResult<GeneratedCredential>> {
  if (validateCredentialRegistry(registry).kind !== "valid") {
    return failure(CREDENTIAL_LIFECYCLE_FAILURE.invalidRegistry);
  }
  if (!registry.credentials.some((entry) => entry.clientId === clientId)) {
    return failure(CREDENTIAL_LIFECYCLE_FAILURE.credentialNotFound);
  }

  return createCredential(registry, metadata, dependencies);
}

/**
 * Removes exactly one active credential without modifying unrelated entries.
 *
 * @param registry - Existing complete digest-only registry.
 * @param clientId - Exact immutable identity to revoke.
 * @returns Complete replacement registry, or a closed failure.
 */
export function revokeCredential(
  registry: CredentialRegistry,
  clientId: string,
): CredentialLifecycleResult<CredentialRegistry> {
  if (validateCredentialRegistry(registry).kind !== "valid") {
    return failure(CREDENTIAL_LIFECYCLE_FAILURE.invalidRegistry);
  }

  const remaining = registry.credentials.filter(
    (entry) => entry.clientId !== clientId,
  );
  if (remaining.length === registry.credentials.length) {
    return failure(CREDENTIAL_LIFECYCLE_FAILURE.credentialNotFound);
  }

  const candidate: CredentialRegistry = {
    version: CREDENTIAL_REGISTRY_VERSION,
    credentials: remaining,
  };
  return validateCredentialRegistry(candidate).kind === "valid"
    ? { kind: "success", value: candidate }
    : failure(CREDENTIAL_LIFECYCLE_FAILURE.invalidRegistry);
}

/**
 * Replaces a lost or plausibly compromised client without retaining an overlap window.
 *
 * @param registry - Existing complete digest-only registry.
 * @param clientId - Exact lost client identity removed from the result.
 * @param metadata - Fresh replacement metadata.
 * @param dependencies - Secure generation boundary.
 * @returns Fresh credential and registry with the old digest absent.
 */
export async function replaceLostCredential(
  registry: CredentialRegistry,
  clientId: string,
  metadata: NewCredentialMetadata,
  dependencies: CredentialGenerationDependencies = credentialGenerationDependencies,
): Promise<CredentialLifecycleResult<GeneratedCredential>> {
  const revoked = revokeCredential(registry, clientId);
  if (revoked.kind !== "success") {
    return revoked;
  }

  return createCredential(revoked.value, metadata, dependencies);
}

/**
 * Builds an unrelated all-new registry for deliberate recovery from total verifier loss.
 *
 * @param clients - Complete non-secret client metadata to reprovision.
 * @param dependencies - Secure generation boundary used independently per client.
 * @returns Fresh registry and one-time client secrets, or a closed failure with no partial registry.
 */
export async function replaceEntireRegistry(
  clients: readonly NewCredentialMetadata[],
  dependencies: CredentialGenerationDependencies = credentialGenerationDependencies,
): Promise<CredentialLifecycleResult<RegistryReplacement>> {
  if (clients.length === 0) {
    return failure(CREDENTIAL_LIFECYCLE_FAILURE.invalidMetadata);
  }

  let registry = createEmptyCredentialRegistry();
  const credentials: ReplacementCredentialSecret[] = [];

  for (const metadata of clients) {
    const created = await createCredential(registry, metadata, dependencies);
    if (created.kind !== "success") {
      return created;
    }
    registry = created.value.registry;
    credentials.push({
      name: metadata.name,
      clientId: created.value.clientId,
      token: created.value.token,
    });
  }

  return { kind: "success", value: { registry, credentials } };
}

/**
 * Validates and canonicalizes operator metadata without inventing implied permissions.
 *
 * @param metadata - Untrusted CLI/client metadata.
 * @returns Canonically ordered exact permissions, or null when any field is invalid.
 */
function validateMetadata(
  metadata: NewCredentialMetadata,
): readonly ClientPermission[] | null {
  if (!CREDENTIAL_NAME_PATTERN.test(metadata.name)) {
    return null;
  }
  if (
    metadata.permissions.length === 0 ||
    new Set(metadata.permissions).size !== metadata.permissions.length
  ) {
    return null;
  }

  const requested = new Set(metadata.permissions);
  const permissions = [
    CLIENT_PERMISSION.read,
    CLIENT_PERMISSION.write,
    CLIENT_PERMISSION.delete,
  ].filter((permission) => requested.has(permission));
  if (permissions.length !== metadata.permissions.length) {
    return null;
  }

  return permissions;
}

/**
 * Creates a sanitized lifecycle failure without secret or registry material.
 *
 * @param reason - Closed operator-safe failure reason.
 * @returns Typed failure result.
 */
function failure(
  reason: (typeof CREDENTIAL_LIFECYCLE_FAILURE)[keyof typeof CREDENTIAL_LIFECYCLE_FAILURE],
): CredentialLifecycleResult<never> {
  return { kind: "failure", reason };
}
