import type { NoteService } from "@obsidian-ai-bridge/core";
import type { WorkerEnv } from "@worker/env/env.types";
import type { Logger } from "@worker/logging/logger.types";

/**
 * Resolves a request-scoped application service from Cloudflare bindings.
 *
 * @param environment - Active Worker bindings for the request.
 * @returns The transport-independent note service for those bindings.
 */
export type NoteServiceResolver = (environment: WorkerEnv) => NoteService;

/**
 * Resolves the bearer token expected for an incoming API request.
 *
 * @param environment - Active Worker bindings containing secret configuration.
 * @returns The expected token, or `undefined` when authentication is not configured.
 */
export type AuthenticationTokenResolver = (
  environment: WorkerEnv,
) => string | undefined;

/**
 * Long-lived dependencies used to assemble the Hono application graph once per isolate.
 *
 * Request-specific services are resolved by middleware, not while routes are registered.
 */
export interface WorkerAppDependencies {
  /** Structured logger used by request middleware. */
  readonly logger: Logger;

  /** Factory that resolves the application service from current bindings. */
  readonly resolveNoteService: NoteServiceResolver;

  /** Factory that resolves the expected authentication token from current bindings. */
  readonly resolveToken: AuthenticationTokenResolver;
}
