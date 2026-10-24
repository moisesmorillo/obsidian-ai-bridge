import type {
	ListClientGrantsResult,
	ListClientsResult,
} from "@obsidian-ai-bridge/protocol";

/** Application capability for one selected vault's durable owner registry. */
export interface ClientRegistryGateway {
	/** Persist consent generation and opaque identity before the provider issues a code. */
	beginClientConsent(
		ownerSubject: string,
		clientId: string,
		name: string,
	): Promise<{ generation: number; consent_id: string }>;
	/** Accept only callback grants whose owner and consent generation remain current. */
	registerClientGrant(input: {
		owner_subject: string;
		client_id: string;
		grant_id: string;
		generation: number;
		consent_id: string;
	}): Promise<boolean>;
	/** Read a finite client page from the selected vault. */
	listClients(
		ownerSubject: string,
		cursor?: string,
	): Promise<ListClientsResult>;
	/** Read a finite grant page without exposing provider tokens. */
	listClientGrants(
		ownerSubject: string,
		clientId: string,
		cursor?: string,
	): Promise<ListClientGrantsResult>;
	/** Rename only a client owned by the verified Access subject. */
	renameClient(
		ownerSubject: string,
		clientId: string,
		name: string,
	): Promise<boolean>;
	/** Commit generation closure and durable grant denial before provider cleanup. */
	revokeClient(
		ownerSubject: string,
		clientId: string,
	): Promise<{
		generation: number;
		cleanup_pending: boolean;
		grants: string[];
	} | null>;
	/** Clear the pending flag only after provider cleanup succeeds. */
	markGrantCleanupComplete(clientId: string, grantId: string): Promise<void>;
	/** Store one expiring browser and owner binding for a form action. */
	storeOwnerCsrf(input: {
		owner_subject: string;
		browser_id: string;
		state: string;
		expires_at: number;
	}): Promise<void>;
	/** Consume the matching owner form state once within its expiration. */
	consumeOwnerCsrf(input: {
		owner_subject: string;
		browser_id: string;
		state: string;
		now: number;
	}): Promise<boolean>;
}

/** Provider-only cleanup capability. Authoritative denial always occurs before this call. */
export interface ProviderGrantCleanup {
	/** Remove one provider grant and its tokens from the configured store. */
	revokeGrant(grantId: string, ownerSubject: string): Promise<void>;
}

/** Persist an owner-authorized consent fence before the provider issues authorization code. */
export async function beginClientConsent(
	registry: ClientRegistryGateway,
	ownerSubject: string,
	clientId: string,
	name: string,
): Promise<{ generation: number; consent_id: string }> {
	return registry.beginClientConsent(ownerSubject, clientId, name);
}

/** Persist one browser-bound state through the selected vault registry. */
export async function storeOwnerCsrf(
	registry: ClientRegistryGateway,
	input: {
		owner_subject: string;
		browser_id: string;
		state: string;
		expires_at: number;
	},
): Promise<void> {
	return registry.storeOwnerCsrf(input);
}

/** Consume a browser-bound owner state at most once. */
export async function consumeOwnerCsrf(
	registry: ClientRegistryGateway,
	input: {
		owner_subject: string;
		browser_id: string;
		state: string;
		now: number;
	},
): Promise<boolean> {
	return registry.consumeOwnerCsrf(input);
}

/** List a bounded page of clients from the selected vault registry. */
export async function listClients(
	registry: ClientRegistryGateway,
	ownerSubject: string,
	cursor?: string,
): Promise<ListClientsResult> {
	return registry.listClients(ownerSubject, cursor);
}

/** List one finite page of known grants without exposing provider token data. */
export async function listClientGrants(
	registry: ClientRegistryGateway,
	ownerSubject: string,
	clientId: string,
	cursor?: string,
): Promise<ListClientGrantsResult> {
	return registry.listClientGrants(ownerSubject, clientId, cursor);
}

/** Change the display name for a client owned by the verified subject. */
export async function renameClient(
	registry: ClientRegistryGateway,
	ownerSubject: string,
	clientId: string,
	name: string,
): Promise<boolean> {
	return registry.renameClient(ownerSubject, clientId, name);
}

/** Persist each cleanup confirmation after authoritative grant denial already committed. */
export async function revokeClient(
	registry: ClientRegistryGateway,
	provider: ProviderGrantCleanup,
	ownerSubject: string,
	clientId: string,
): Promise<{ generation: number; cleanup_pending: boolean } | null> {
	const durable = await registry.revokeClient(ownerSubject, clientId);
	if (!durable) return null;
	let cleanupPending = durable.cleanup_pending;
	for (const grantId of durable.grants) {
		try {
			await provider.revokeGrant(grantId, ownerSubject);
			await registry.markGrantCleanupComplete(clientId, grantId);
		} catch {
			cleanupPending = true;
		}
	}
	return { generation: durable.generation, cleanup_pending: cleanupPending };
}
