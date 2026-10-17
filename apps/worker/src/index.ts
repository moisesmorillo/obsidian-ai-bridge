import { Hono } from "hono";

export { Vault } from "@worker/infrastructure/durable-object/vault";

/** Intentionally exports an empty router: no routes or runtime effects exist yet. */
const app = new Hono();

export default app;
