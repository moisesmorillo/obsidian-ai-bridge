import type {
  CurrentGenerationService,
  MirrorAssociationId,
  MirrorWriterId,
  RecoveryService,
} from "@obsidian-ai-bridge/core";
import type { AuthenticationConfiguration } from "@worker/auth/auth.types";
import type { WorkerEnv } from "@worker/env/env.types";
import type { Logger } from "@worker/logging/logger.types";

/** Validated non-secret identity guard configured for one mirror namespace. */
export interface MirrorDesignation {
  /** Association accepted from cooperating mutation clients. */
  readonly associationId: MirrorAssociationId;
  /** Writer accepted from cooperating mutation clients. */
  readonly writerId: MirrorWriterId;
}

/** Request-scoped M3 application services and optional validated designation. */
export interface WorkerMirrorServices {
  /** Current-generation inspection and mutation application service. */
  readonly current: CurrentGenerationService;
  /** Recovery inspection and maintenance application service. */
  readonly recovery: RecoveryService;
  /** Validated configuration, or `null` when mutation configuration fails closed. */
  readonly designation: MirrorDesignation | null;
}

/**
 * Resolves request-scoped mirror application services from Cloudflare bindings.
 *
 * @param environment - Active Worker bindings for the request.
 * @returns Services backed by the active bucket and validated static designation.
 */
export type MirrorServicesResolver = (
  environment: WorkerEnv,
) => WorkerMirrorServices;

/**
 * Resolves the exclusive authentication authority selected for an incoming request.
 *
 * @param environment - Active Worker bindings containing confidential verifier configuration.
 * @returns Registry, temporary singleton migration, or fail-closed invalid configuration.
 */
export type AuthenticationConfigurationResolver = (
  environment: WorkerEnv,
) => AuthenticationConfiguration;

/** Long-lived dependencies used to assemble the Worker transport once per isolate. */
export interface WorkerAppDependencies {
  /** Structured logger used by request middleware. */
  readonly logger: Logger;

  /** Factory resolving current-generation, recovery, and designation dependencies. */
  readonly resolveMirrorServices: MirrorServicesResolver;

  /** Factory resolving exactly one authentication authority from current bindings. */
  readonly resolveAuthentication: AuthenticationConfigurationResolver;
}
