import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import type { Env } from "@worker/env";
import { createFileRouter } from "@worker/transport/files";
import { Hono } from "hono";

/** Build the Worker router with identity and vault selection supplied at composition. */
export function createWorker(
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
	resolveVault: (
		env: Env,
		request: Request,
	) => import("@worker/application/text-files").TextVaultGateway,
): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/files", createFileRouter(resolveIdentity, resolveVault));
	return app;
}
