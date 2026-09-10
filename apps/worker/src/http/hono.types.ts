import type { OpenAPIHono } from "@hono/zod-openapi";
import type { NoteService } from "@obsidian-ai-bridge/core";
import type { WorkerEnv } from "@worker/env/env.types";
import type { Context, MiddlewareHandler } from "hono";
import type { BlankInput, BlankSchema } from "hono/types";

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

/** Concrete route-path type used by Worker transport contexts and middleware. */
export type WorkerRoutePath = string;

/** Root base path used when constructing Worker Hono applications. */
export type WorkerBasePath = "/";

/** Hono context whose bindings, path, and input are fully typed. */
export type WorkerContext = Context<
  WorkerHonoEnvironment,
  WorkerRoutePath,
  BlankInput
>;

/** Hono middleware bound to the Worker environment, path, input, and response. */
export type WorkerMiddleware = MiddlewareHandler<
  WorkerHonoEnvironment,
  WorkerRoutePath,
  BlankInput,
  Response
>;

/** Hono OpenAPI application bound to the Worker environment and root route schema. */
export type WorkerApplication = OpenAPIHono<
  WorkerHonoEnvironment,
  BlankSchema,
  WorkerBasePath
>;
