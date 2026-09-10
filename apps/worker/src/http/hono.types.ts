import type { OpenAPIHono } from "@hono/zod-openapi";
import type { NoteService } from "@obsidian-ai-bridge/core";
import type { WorkerEnv } from "@worker/env/env.types";
import type { Context, MiddlewareHandler } from "hono";

/** Context variables injected before request handlers execute. */
export interface WorkerContextVariables {
  /** Application service resolved from the active environment bindings. */
  readonly noteService: NoteService;
}

/** Explicit Hono environment for the Cloudflare Worker transport adapter. */
export interface WorkerHonoEnvironment {
  /** Cloudflare bindings available to transport middleware. */
  readonly Bindings: WorkerEnv;

  /** Request-scoped services available through the Hono context. */
  readonly Variables: WorkerContextVariables;
}

/** Hono context whose bindings and injected services are fully typed. */
export type WorkerContext = Context<WorkerHonoEnvironment>;

/** Hono middleware bound to the Worker environment and context variables. */
export type WorkerMiddleware = MiddlewareHandler<WorkerHonoEnvironment>;

/** Hono OpenAPI application bound to the Worker environment. */
export type WorkerApplication = OpenAPIHono<WorkerHonoEnvironment>;
