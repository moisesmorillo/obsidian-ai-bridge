import type { AuthorizationContext } from "@vaultwire/protocol";
import { AuthorizationContextSchema } from "@vaultwire/protocol";
import type { ClientRegistryGateway } from "@worker/application/clients";
import type { HistoryVaultGateway } from "@worker/application/history";
import type { MeasurementGateway } from "@worker/application/measurements";
import type { ReadVaultGateway } from "@worker/application/reads";
import type { SearchVaultGateway } from "@worker/application/search";
import type { TextVaultGateway } from "@worker/application/text-files";
import type { Env } from "@worker/env";
import {
	createAuthorizeHandler,
	createOAuthWorker,
	readVerifiedAuthorization,
} from "@worker/infrastructure/auth/oauth";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import type {
	OwnerBlobGcResolver,
	OwnerExportResolver,
} from "@worker/transport/owner";
import { createOwnerHandler } from "@worker/transport/owner";
import { createWorker } from "@worker/transport/worker";

/** Read the provider-validated client, grant, and token scopes for each REST request. */
async function resolveIdentity(
	request: Request,
): Promise<AuthorizationContext | null> {
	const identity = readVerifiedAuthorization(request);
	return identity ? AuthorizationContextSchema.parse(identity) : null;
}

/** Select the vault named by the request host after identity validation. */
function resolveVault(
	env: Env,
	request: Request,
): TextVaultGateway &
	HistoryVaultGateway &
	ReadVaultGateway &
	SearchVaultGateway {
	const stub = env.VAULTS.get(env.VAULTS.idFromName(new URL(request.url).host));
	return {
		getCurrentEpoch: async (...args: Parameters<typeof stub.getCurrentEpoch>) =>
			await stub.getCurrentEpoch(...args),
		beginMutation: async (...args: Parameters<typeof stub.beginMutation>) =>
			await stub.beginMutation(...args),
		authorize: async (...args: Parameters<typeof stub.authorize>) =>
			await stub.authorize(...args),
		commitText: async (...args: Parameters<typeof stub.commitText>) =>
			await stub.commitText(...args),
		authorizeBlob: async (...args: Parameters<typeof stub.authorizeBlob>) =>
			await stub.authorizeBlob(...args),
		commitBlob: async (...args: Parameters<typeof stub.commitBlob>) =>
			await stub.commitBlob(...args),
		readBlobMetadata: async (
			...args: Parameters<typeof stub.readBlobMetadata>
		) => await stub.readBlobMetadata(...args),
		finishAdmission: async (...args: Parameters<typeof stub.finishAdmission>) =>
			await stub.finishAdmission(...args),
		readText: async (...args: Parameters<typeof stub.readText>) =>
			await stub.readText(...args),
		beginRenameSource: async (
			...args: Parameters<typeof stub.beginRenameSource>
		) => await stub.beginRenameSource(...args),
		authorizeRenameSource: async (
			...args: Parameters<typeof stub.authorizeRenameSource>
		) => await stub.authorizeRenameSource(...args),
		commitFileCommand: async (
			...args: Parameters<typeof stub.commitFileCommand>
		) => await stub.commitFileCommand(...args),
		readHistory: async (...args: Parameters<typeof stub.readHistory>) =>
			await stub.readHistory(...args),
		readVault: async (...args: Parameters<typeof stub.readVault>) =>
			await stub.readVault(...args),
		readHistoryUpper: async (
			...args: Parameters<typeof stub.readHistoryUpper>
		) => await stub.readHistoryUpper(...args),
		readBatch: async (...args: Parameters<typeof stub.readBatch>) =>
			await stub.readBatch(...args),
		search: async (...args: Parameters<typeof stub.search>) =>
			await stub.search(...args),
	};
}

/** Select bounded service measurement RPCs for the host-selected Vault. */
function resolveMeasurements(
	env: Env,
	request: Request,
): Pick<MeasurementGateway, "recordRequest" | "recordFeedPreparation"> {
	const stub = env.VAULTS.get(env.VAULTS.idFromName(new URL(request.url).host));
	return {
		recordRequest: async (...args) =>
			await stub.recordMeasurementRequest(...args),
		recordFeedPreparation: async (...args) =>
			await stub.recordFeedPreparation(...args),
	};
}

/** Expose only owner registry capabilities for the host-selected canonical vault. */
function resolveClientRegistry(
	env: Env,
	request: Request,
): ClientRegistryGateway {
	const stub = env.VAULTS.get(env.VAULTS.idFromName(new URL(request.url).host));
	return {
		beginClientConsent: async (...args) =>
			await stub.beginClientConsent(...args),
		registerClientGrant: async (...args) =>
			await stub.registerClientGrant(...args),
		removeClient: async (...args) => await stub.removeClient(...args),
		sweepStaleClients: async (...args) => await stub.sweepStaleClients(...args),
		listClients: async (...args) => await stub.listClients(...args),
		listClientGrants: async (...args) => await stub.listClientGrants(...args),
		renameClient: async (...args) => await stub.renameClient(...args),
		revokeClient: async (...args) => {
			const result = await stub.revokeClient(...args);
			return result
				? {
						generation: result.generation,
						cleanup_pending: result.cleanupPending,
						grants: result.grants,
					}
				: null;
		},
		markGrantCleanupComplete: async (...args) =>
			await stub.markGrantCleanupComplete(...args),
		storeOwnerCsrf: async (...args) => await stub.storeOwnerCsrf(...args),
		consumeOwnerCsrf: async (...args) => await stub.consumeOwnerCsrf(...args),
	};
}

/** Expose only owner snapshot operations for the host-selected canonical vault. */
function resolveExports(
	env: Env,
	request: Request,
): ReturnType<OwnerExportResolver> {
	const stub = env.VAULTS.get(env.VAULTS.idFromName(new URL(request.url).host));
	return {
		start: async (...args) => await stub.startPackedExport(...args),
		list: async (...args) => await stub.listPackedExports(...args),
		download: async (...args) => await stub.getPackedExportDownload(...args),
	};
}

/** Return the host only for the exact canonical HTTPS service origin. */
function canonicalServiceHost(origin: string | undefined): string | null {
	if (!origin) return null;
	try {
		const parsed = new URL(origin);
		if (
			parsed.protocol !== "https:" ||
			parsed.origin !== origin ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash
		)
			return null;
		return parsed.host;
	} catch {
		return null;
	}
}

/** Expose only owner-authenticated bounded garbage-collection operations. */
function resolveBlobGc(
	env: Env,
	request: Request,
): ReturnType<OwnerBlobGcResolver> {
	const stub = env.VAULTS.get(env.VAULTS.idFromName(new URL(request.url).host));
	return {
		preview: async (...args) => await stub.previewBlobGc(...args),
		status: async (...args) => await stub.readBlobGcStatus(...args),
		collect: async (...args) => await stub.collectBlobGcBatch(...args),
	};
}

/** Route Access-protected owner pages and provider consent through one default handler. */
function createLocalAuthHandler(): ExportedHandler<Env> {
	const consent = createAuthorizeHandler();
	const owner = createOwnerHandler(
		resolveClientRegistry,
		(env, request) => {
			const stub = env.VAULTS.get(
				env.VAULTS.idFromName(new URL(request.url).host),
			);
			return {
				readMeasurements: async (ownerSubject) =>
					await stub.readMeasurements({ owner_subject: ownerSubject }),
			};
		},
		resolveExports,
		resolveBlobGc,
	);
	return {
		/** Route owner pages to verified Access handlers and all other local auth paths to consent. */
		fetch(request, env, context) {
			const handler = new URL(request.url).pathname.startsWith("/owner/")
				? owner
				: consent;
			if (!handler.fetch)
				return Promise.resolve(
					new Response("Handler unavailable", { status: 500 }),
				);
			return handler.fetch(request, env, context);
		},
	};
}

/** Dispatch REST only through the OAuth provider's validated resource-server handler. */
const worker = {
	/** Route OAuth and REST requests without deriving the service origin from Host. */
	fetch(
		request: Request,
		env?: Env,
		context?: ExecutionContext,
	): Promise<Response> {
		if (!env)
			return Promise.resolve(new Response("Not found", { status: 404 }));
		if (
			env.SERVICE_ORIGIN &&
			new URL(request.url).origin !== env.SERVICE_ORIGIN
		) {
			return Promise.resolve(new Response("Not found", { status: 404 }));
		}
		const executionContext =
			context ??
			({
				waitUntil: (_promise: Promise<unknown>) => undefined,
				passThroughOnException: () => undefined,
			} as ExecutionContext);
		const api = createWorker(
			resolveIdentity,
			resolveVault,
			(bindings) => new R2BlobStore(bindings.R2_BUCKET),
			resolveMeasurements,
		);
		const provider = createOAuthWorker(env, api, createLocalAuthHandler());
		return provider
			? provider.fetch(request, env, executionContext)
			: Promise.resolve(
					new Response("OAuth is not configured", {
						status: 503,
						headers: { "cache-control": "no-store" },
					}),
				);
	},
	/** Start one timestamp-keyed export on the canonical host Vault only. */
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		const host = canonicalServiceHost(env.SERVICE_ORIGIN);
		if (!host || !Number.isSafeInteger(controller.scheduledTime)) return;
		const createdAt = new Date(controller.scheduledTime).toISOString();
		const stub = env.VAULTS.get(env.VAULTS.idFromName(host));
		const result = await stub.startScheduledPackedExport(createdAt);
		if (!result)
			console.info(
				JSON.stringify({
					event: "scheduled_export_skipped",
					reason: "export_already_running",
					created_at: createdAt,
				}),
			);
	},
};

export { Vault } from "@worker/infrastructure/durable-object/vault";
export default worker;
