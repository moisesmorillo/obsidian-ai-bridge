import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import type { HistoryVaultGateway } from "@worker/application/history";
import type { ReadVaultGateway } from "@worker/application/reads";
import type { TextVaultGateway } from "@worker/application/text-files";
import type { Env } from "@worker/env";
import { createFileRouter } from "@worker/transport/files";
import { createReadRouter } from "@worker/transport/reads";
import { Hono } from "hono";

/** Build the Worker router with identity and vault selection supplied at composition. */
export function createWorker(
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
	resolveVault: (
		env: Env,
		request: Request,
	) => TextVaultGateway & HistoryVaultGateway & ReadVaultGateway,
	resolveBlobs: (env: Env) => BlobContentStore,
): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route(
		"/v1/files",
		createFileRouter(resolveIdentity, resolveVault, resolveBlobs),
	);
	app.route("/v1", createReadRouter(resolveIdentity, resolveVault));
	return app;
}
