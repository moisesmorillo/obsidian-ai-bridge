import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import type { HistoryVaultGateway } from "@worker/application/history";
import type { ReadVaultGateway } from "@worker/application/reads";
import type { SearchVaultGateway } from "@worker/application/search";
import type { TextVaultGateway } from "@worker/application/text-files";
import type { Env } from "@worker/env";
import { createFileRouter } from "@worker/transport/files";
import { handleMcpHttp } from "@worker/transport/mcp-http";
import { createReadRouter } from "@worker/transport/reads";
import { createSearchRouter } from "@worker/transport/search";
import { Hono } from "hono";

/** Build the Worker router with identity and vault selection supplied at composition. */
export function createWorker(
	resolveIdentity: (request: Request) => Promise<AuthorizationContext | null>,
	resolveVault: (
		env: Env,
		request: Request,
	) => TextVaultGateway &
		HistoryVaultGateway &
		ReadVaultGateway &
		SearchVaultGateway,
	resolveBlobs: (env: Env) => BlobContentStore,
): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	app.route(
		"/v1/files",
		createFileRouter(resolveIdentity, resolveVault, resolveBlobs),
	);
	app.route("/v1", createReadRouter(resolveIdentity, resolveVault));
	app.route("/v1", createSearchRouter(resolveIdentity, resolveVault));
	app.all("/mcp", (context) =>
		handleMcpHttp(
			context.req.raw,
			context.env,
			resolveIdentity,
			resolveVault,
			resolveBlobs,
		),
	);
	return app;
}
