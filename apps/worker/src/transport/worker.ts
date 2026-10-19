import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import type { HistoryVaultGateway } from "@worker/application/history";
import type { TextVaultGateway } from "@worker/application/text-files";
import type { Env } from "@worker/env";
import { createFileRouter } from "@worker/transport/files";
import { createHistoryRouter } from "@worker/transport/history";
import { Hono } from "hono";

/** Build the Worker router with identity and vault selection supplied at composition. */
export function createWorker(
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
	resolveVault: (
		env: Env,
		request: Request,
	) => TextVaultGateway & HistoryVaultGateway,
): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route("/v1/files", createFileRouter(resolveIdentity, resolveVault));
	app.route("/v1/history", createHistoryRouter(resolveIdentity, resolveVault));
	return app;
}
