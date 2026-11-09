import type { AuthorizationContext } from "@vaultwire/protocol";
import type { BlobContentStore } from "@worker/application/blobs";
import type { HistoryVaultGateway } from "@worker/application/history";
import type { MeasurementGateway } from "@worker/application/measurements";
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
	resolveMeasurements?: (
		env: Env,
		request: Request,
	) => Pick<MeasurementGateway, "recordRequest" | "recordFeedPreparation">,
): Hono<{ Bindings: Env }> {
	const app = new Hono<{ Bindings: Env }>();
	const identities = new WeakMap<Request, AuthorizationContext | null>();
	/** Cache provider identity once per request for hooks and route handlers. */
	const identityFor = async (request: Request) => {
		if (identities.has(request)) return identities.get(request) ?? null;
		const identity = await resolveIdentity(request);
		identities.set(request, identity);
		return identity;
	};
	app.use("*", async (context, next) => {
		const request = context.req.raw;
		const pathname = new URL(request.url).pathname;
		const rest = pathname.startsWith("/v1/");
		const mcp = pathname === "/mcp";
		const observedAt = Date.now();
		const identity = rest || mcp ? await identityFor(request) : null;
		if (identity && resolveMeasurements) {
			try {
				context.executionCtx.waitUntil(
					Promise.resolve()
						.then(() =>
							resolveMeasurements(context.env, request).recordRequest({
								client_id: identity.client_id,
								protocol: mcp ? "mcp" : "rest",
								feed_request: rest && pathname === "/v1/changes",
								observed_at: observedAt,
							}),
						)
						.catch(() => undefined),
				);
			} catch {
				// Metrics are best-effort and must not change a valid sync response.
			}
		}
		await next();
		if (
			identity &&
			rest &&
			pathname === "/v1/changes" &&
			context.res.status >= 200 &&
			context.res.status < 300 &&
			!request.signal.aborted &&
			resolveMeasurements
		) {
			const completedAt = Date.now();
			if (completedAt < observedAt) return;
			try {
				context.executionCtx.waitUntil(
					Promise.resolve()
						.then(() =>
							resolveMeasurements(context.env, request).recordFeedPreparation({
								client_id: identity.client_id,
								observed_at: completedAt,
								duration_ms: completedAt - observedAt,
							}),
						)
						.catch(() => undefined),
				);
			} catch {
				// A failed metric write must not consume or delay the lazy response body.
			}
		}
	});
	app.route(
		"/v1/files",
		createFileRouter(identityFor, resolveVault, resolveBlobs),
	);
	app.route("/v1", createReadRouter(identityFor, resolveVault));
	app.route("/v1", createSearchRouter(identityFor, resolveVault));
	app.all("/mcp", (context) =>
		handleMcpHttp(
			context.req.raw,
			context.env,
			identityFor,
			resolveVault,
			resolveBlobs,
		),
	);
	return app;
}
