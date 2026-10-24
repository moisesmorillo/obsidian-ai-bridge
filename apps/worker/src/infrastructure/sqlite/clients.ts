import type {
	BeginClientConsentResult,
	ListClientGrantsResult,
	ListClientsResult,
	RegisterClientGrantRequest,
} from "@obsidian-ai-bridge/protocol";
import {
	BeginClientConsentResultSchema,
	ListClientGrantsResultSchema,
	ListClientsResultSchema,
	OwnerCsrfConsumeRequestSchema,
	OwnerCsrfStateRequestSchema,
	RegisterClientGrantRequestSchema,
} from "@obsidian-ai-bridge/protocol";
import { vaultSchema } from "@worker/infrastructure/sqlite/schema-model";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

/** Maximum durable OAuth clients in one vault registry. */
export const MAX_OAUTH_CLIENTS = 1_024;
/** Maximum durable OAuth grants across one vault registry. */
export const MAX_OAUTH_GRANTS = 8_192;
/** Maximum active provider consent fences in one vault registry. */
const MAX_PENDING_CONSENTS = 1_024;
/** Provider consent records expire at the same ten-minute bound as their browser handle. */
const CONSENT_TTL_MS = 10 * 60 * 1_000;
/** Maximum provider grants selected for cleanup by one owner request. */
export const MAX_GRANT_CLEANUP_BATCH = 16;
/** Maximum returned clients or grants in one owner page. */
export const OWNER_PAGE_SIZE = 32;

/** SQLite client row used only inside the registry adapter. */
type ClientRow = {
	client_id: string;
	owner_subject: string;
	generation: number;
	name: string;
	created_at: number;
	last_seen_at: number | null;
};
/** SQLite grant row used only inside the registry adapter. */
type GrantRow = {
	grant_id: string;
	created_at: number;
	cleanup_pending: number;
};
/** SQLite grant identity used for bounded revocation cleanup. */
type GrantIdRow = { grant_id: string };

/** SQLite registry for owner client records and generation-fenced provider grants. */
export class SqliteClientRegistry {
	private readonly db;

	/** Create a registry session over the selected vault's native SQLite storage. */
	constructor(
		storage: DurableObjectStorage,
		private readonly now: () => number,
	) {
		this.db = drizzle(storage, { schema: vaultSchema });
	}

	/** Store one pending consent at the current client generation. */
	beginClientConsent(
		ownerSubject: string,
		clientId: string,
		name: string,
	): BeginClientConsentResult {
		return this.db.transaction((tx) => {
			let client = tx.all<ClientRow>(
				sql`SELECT * FROM client_generations WHERE client_id = ${clientId}`,
			)[0];
			if (!client) {
				const count =
					tx.all<{ count: number }>(
						"SELECT COUNT(*) AS count FROM client_generations",
					)[0]?.count ?? 0;
				if (count >= MAX_OAUTH_CLIENTS)
					throw new Error("Client registry is full");
				tx.run(
					sql`INSERT INTO client_generations (client_id, owner_subject, generation, name, created_at, last_seen_at) VALUES (${clientId}, ${ownerSubject}, 0, ${name}, ${this.now()}, NULL)`,
				);
				client = tx.all<ClientRow>(
					sql`SELECT * FROM client_generations WHERE client_id = ${clientId}`,
				)[0];
			}
			if (!client || client.owner_subject !== ownerSubject)
				throw new Error("Client owner does not match");
			tx.run(
				sql`UPDATE client_generations SET name = ${name} WHERE client_id = ${clientId}`,
			);
			tx.run(
				sql`DELETE FROM client_consents WHERE created_at <= ${this.now() - CONSENT_TTL_MS}`,
			);
			const pendingCount =
				tx.all<{ count: number }>(
					sql`SELECT COUNT(*) AS count FROM client_consents`,
				)[0]?.count ?? 0;
			if (pendingCount >= MAX_PENDING_CONSENTS)
				throw new Error("Pending consent registry is full");
			const result = BeginClientConsentResultSchema.parse({
				generation: client.generation,
				consent_id: crypto.randomUUID(),
			});
			tx.run(
				sql`INSERT INTO client_consents (consent_id, client_id, owner_subject, generation, created_at) VALUES (${result.consent_id}, ${clientId}, ${ownerSubject}, ${result.generation}, ${this.now()})`,
			);
			return result;
		});
	}

	/** Record an actual provider grant only when its consent generation remains current. */
	registerClientGrant(input: RegisterClientGrantRequest): boolean {
		const request = RegisterClientGrantRequestSchema.parse(input);
		return this.db.transaction((tx) => {
			const client = tx.all<ClientRow>(
				sql`SELECT * FROM client_generations WHERE client_id = ${request.client_id}`,
			)[0];
			if (
				!client ||
				client.owner_subject !== request.owner_subject ||
				client.generation !== request.generation
			)
				return false;
			const prior = tx.all<{
				client_id: string;
				generation: number;
				consent_id: string;
			}>(
				sql`SELECT client_id, generation, consent_id FROM client_grants WHERE grant_id = ${request.grant_id}`,
			)[0];
			if (prior)
				return (
					prior.client_id === request.client_id &&
					prior.generation === request.generation &&
					prior.consent_id === request.consent_id
				);
			const consent = tx.all<{ consent_id: string }>(
				sql`SELECT consent_id FROM client_consents WHERE consent_id = ${request.consent_id} AND client_id = ${request.client_id} AND owner_subject = ${request.owner_subject} AND generation = ${request.generation}`,
			)[0];
			if (!consent) return false;
			const count =
				tx.all<{ count: number }>(
					"SELECT COUNT(*) AS count FROM client_grants",
				)[0]?.count ?? 0;
			if (count >= MAX_OAUTH_GRANTS) return false;
			tx.run(
				sql`INSERT INTO client_grants (client_id, grant_id, owner_subject, generation, consent_id, created_at, cleanup_pending) VALUES (${request.client_id}, ${request.grant_id}, ${request.owner_subject}, ${request.generation}, ${request.consent_id}, ${this.now()}, 0)`,
			);
			tx.run(
				sql`DELETE FROM client_consents WHERE consent_id = ${request.consent_id}`,
			);
			tx.run(
				sql`UPDATE client_generations SET last_seen_at = ${this.now()} WHERE client_id = ${request.client_id}`,
			);
			return true;
		});
	}

	/** Read one finite owner page with no more than 32 durable grants per client. */
	listClients(ownerSubject: string, cursor?: string): ListClientsResult {
		const offset = parsePageCursor(cursor);
		return this.db.transaction((tx) => {
			const total =
				tx.all<{ count: number }>(
					sql`SELECT COUNT(*) AS count FROM client_generations WHERE owner_subject = ${ownerSubject}`,
				)[0]?.count ?? 0;
			const page = tx.all<ClientRow>(
				sql`SELECT * FROM client_generations WHERE owner_subject = ${ownerSubject} ORDER BY client_id LIMIT ${OWNER_PAGE_SIZE} OFFSET ${offset}`,
			);
			const clients = page.map((client) => {
				const grantCount =
					tx.all<{ count: number }>(
						sql`SELECT COUNT(*) AS count FROM client_grants WHERE client_id = ${client.client_id}`,
					)[0]?.count ?? 0;
				return {
					client_id: client.client_id,
					name: client.name,
					generation: client.generation,
					created_at: client.created_at,
					last_seen_at: client.last_seen_at,
					grant_count: grantCount,
					grants: [],
					grants_cursor: null,
				};
			});
			return ListClientsResultSchema.parse({
				clients,
				next_cursor:
					offset + page.length < total ? `v1:${offset + page.length}` : null,
			});
		});
	}

	/** Read one finite page of grant identifiers owned by the selected client. */
	listClientGrants(
		ownerSubject: string,
		clientId: string,
		cursor?: string,
	): ListClientGrantsResult {
		const offset = parsePageCursor(cursor);
		return this.db.transaction((tx) => {
			const owner = tx.all<{ client_id: string }>(
				sql`SELECT client_id FROM client_generations WHERE client_id = ${clientId} AND owner_subject = ${ownerSubject}`,
			)[0];
			if (!owner)
				return ListClientGrantsResultSchema.parse({
					grants: [],
					next_cursor: null,
				});
			const total =
				tx.all<{ count: number }>(
					sql`SELECT COUNT(*) AS count FROM client_grants WHERE client_id = ${clientId}`,
				)[0]?.count ?? 0;
			const grants = tx.all<GrantRow>(
				sql`SELECT grant_id, created_at, cleanup_pending FROM client_grants WHERE client_id = ${clientId} ORDER BY grant_id LIMIT ${OWNER_PAGE_SIZE} OFFSET ${offset}`,
			);
			return ListClientGrantsResultSchema.parse({
				grants: grants.map((grant) => ({
					grant_id: grant.grant_id,
					created_at: grant.created_at,
					cleanup_pending: grant.cleanup_pending === 1,
				})),
				next_cursor:
					offset + grants.length < total
						? `v1:${offset + grants.length}`
						: null,
			});
		});
	}

	/** Change the display name for one client owned by the configured Access subject. */
	renameClient(ownerSubject: string, clientId: string, name: string): boolean {
		return this.db.transaction((tx) => {
			const client = tx.all<{ client_id: string }>(
				sql`SELECT client_id FROM client_generations WHERE client_id = ${clientId} AND owner_subject = ${ownerSubject}`,
			)[0];
			if (!client) return false;
			tx.run(
				sql`UPDATE client_generations SET name = ${name} WHERE client_id = ${clientId} AND owner_subject = ${ownerSubject}`,
			);
			return true;
		});
	}

	/** Atomically advance the client fence and durably deny every known grant before cleanup. */
	revokeClient(
		ownerSubject: string,
		clientId: string,
	): { generation: number; cleanupPending: boolean; grants: string[] } | null {
		return this.db.transaction((tx) => {
			const client = tx.all<ClientRow>(
				sql`SELECT * FROM client_generations WHERE client_id = ${clientId} AND owner_subject = ${ownerSubject}`,
			)[0];
			if (!client) return null;
			if (!Number.isSafeInteger(client.generation + 1))
				throw new Error("Client generation is exhausted");
			const generation = client.generation + 1;
			tx.run(
				sql`UPDATE client_generations SET generation = ${generation} WHERE client_id = ${clientId}`,
			);
			tx.run(sql`DELETE FROM client_consents WHERE client_id = ${clientId}`);
			const grants = tx.all<GrantIdRow>(
				sql`SELECT grant_id FROM client_grants WHERE client_id = ${clientId} ORDER BY grant_id`,
			);
			tx.run(
				sql`UPDATE client_grants SET cleanup_pending = 1 WHERE client_id = ${clientId} AND grant_id NOT IN (SELECT grant_id FROM revoked_grants)`,
			);
			for (const grant of grants)
				tx.run(
					sql`INSERT INTO revoked_grants (grant_id, at) VALUES (${grant.grant_id}, ${this.now()}) ON CONFLICT(grant_id) DO NOTHING`,
				);
			const pendingRows = tx.all<GrantIdRow>(
				sql`SELECT grant_id FROM client_grants WHERE client_id = ${clientId} AND cleanup_pending = 1 ORDER BY grant_id LIMIT ${MAX_GRANT_CLEANUP_BATCH + 1}`,
			);
			const pending = pendingRows
				.slice(0, MAX_GRANT_CLEANUP_BATCH)
				.map(({ grant_id }) => grant_id);
			return {
				generation,
				cleanupPending: pendingRows.length > MAX_GRANT_CLEANUP_BATCH,
				grants: pending,
			};
		});
	}

	/** Record provider cleanup only after the provider confirms the grant removal. */
	markGrantCleanupComplete(clientId: string, grantId: string): void {
		this.db.transaction((tx) => {
			tx.run(
				sql`UPDATE client_grants SET cleanup_pending = 0 WHERE client_id = ${clientId} AND grant_id = ${grantId}`,
			);
		});
	}

	/** Store one browser-bound CSRF state with a bounded expiration. */
	storeOwnerCsrf(input: unknown): void {
		const request = OwnerCsrfStateRequestSchema.parse(input);
		this.db.transaction((tx) => {
			tx.run(
				sql`DELETE FROM owner_csrf_states WHERE expires_at < ${this.now()}`,
			);
			tx.run(
				sql`DELETE FROM owner_csrf_states WHERE owner_subject = ${request.owner_subject} AND browser_id = ${request.browser_id}`,
			);
			tx.run(
				sql`INSERT INTO owner_csrf_states (state, owner_subject, browser_id, expires_at) VALUES (${request.state}, ${request.owner_subject}, ${request.browser_id}, ${request.expires_at})`,
			);
		});
	}

	/** Consume one unexpired CSRF state for the same browser and owner. */
	consumeOwnerCsrf(input: unknown): boolean {
		const request = OwnerCsrfConsumeRequestSchema.parse(input);
		return this.db.transaction((tx) => {
			const row = tx.all<{ state: string }>(
				sql`SELECT state FROM owner_csrf_states WHERE state = ${request.state} AND browser_id = ${request.browser_id} AND owner_subject = ${request.owner_subject} AND expires_at > ${request.now}`,
			)[0];
			if (!row) return false;
			tx.run(
				sql`DELETE FROM owner_csrf_states WHERE state = ${request.state} AND browser_id = ${request.browser_id} AND owner_subject = ${request.owner_subject}`,
			);
			return true;
		});
	}
}

/** Decode a versioned offset cursor without accepting unbounded collection traversal. */
function parsePageCursor(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	const match = /^v1:(0|[1-9][0-9]{0,8})$/.exec(cursor);
	if (!match) throw new Error("Invalid owner page cursor");
	const offset = Number(match[1]);
	if (!Number.isSafeInteger(offset))
		throw new Error("Invalid owner page cursor");
	return offset;
}
