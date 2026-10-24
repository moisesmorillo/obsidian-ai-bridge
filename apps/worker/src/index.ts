import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import { AuthorizationContextSchema } from "@obsidian-ai-bridge/protocol";
import type { ClientRegistryGateway } from "@worker/application/clients";
import type { HistoryVaultGateway } from "@worker/application/history";
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

/** Route Access-protected owner pages and provider consent through one default handler. */
function createLocalAuthHandler(): ExportedHandler<Env> {
	const consent = createAuthorizeHandler();
	const owner = createOwnerHandler(resolveClientRegistry);
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
		);
		const provider = createOAuthWorker(env, api, createLocalAuthHandler());
		return provider
			? provider.fetch(request, env, executionContext)
			: Promise.resolve(api.fetch(request, env, executionContext));
	},
};

export { Vault } from "@worker/infrastructure/durable-object/vault";
export default worker;
