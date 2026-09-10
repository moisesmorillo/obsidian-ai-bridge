import type { NoteService } from "@obsidian-ai-bridge/core";
import type { WorkerEnv } from "@worker/env/env.types";
import type { Logger } from "@worker/logging/logger.types";

/** Creates a request-scoped application service from Cloudflare bindings. */
export type NoteServiceResolver = (environment: WorkerEnv) => NoteService;

/** Resolves the bearer token expected for an incoming API request. */
export type AuthenticationTokenResolver = (
  environment: WorkerEnv,
) => string | undefined;

/**
 * Long-lived dependencies used to assemble the Hono application graph once per isolate.
 *
 * Request-specific services are resolved by middleware, not while routes are registered.
 */
export interface WorkerAppDependencies {
  readonly logger: Logger;
  readonly resolveNoteService: NoteServiceResolver;
  readonly resolveToken: AuthenticationTokenResolver;
}
