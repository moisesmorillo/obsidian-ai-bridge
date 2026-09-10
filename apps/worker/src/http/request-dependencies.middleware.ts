import type { NoteServiceResolver } from "@worker/app.types";
import type { WorkerMiddleware } from "@worker/http/hono.types";

/**
 * Resolves the request-scoped application service from the active Cloudflare bindings.
 *
 * @param resolveNoteService - Factory that hides R2 and repository wiring from handlers.
 * @returns Typed middleware that makes `noteService` available through `context.var`.
 */
export function createRequestDependenciesMiddleware(
  resolveNoteService: NoteServiceResolver,
): WorkerMiddleware {
  return async (context, next) => {
    context.set("noteService", resolveNoteService(context.env));
    await next();
  };
}
