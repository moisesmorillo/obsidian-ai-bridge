import { env, runInDurableObject } from "cloudflare:test";
import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import { EMPTY_PAYLOAD_HASH } from "@obsidian-ai-bridge/protocol";
import { SqliteAdmissionAuthority } from "@worker/infrastructure/sqlite/admission";
import { SqliteReadStore } from "@worker/infrastructure/sqlite/reads";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { clearTestVault } from "@worker/test-fixtures/admission";

/** Stable epoch and read-only identity for direct native read tests. */
export const NATIVE_READ_EPOCH = "0123456789abcdef0123456789abcdef";
/** Read-only grant used by real Durable Object native tests. */
export const NATIVE_READ_CONTEXT: AuthorizationContext = {
	client_id: "native-read-client",
	grant_id: "native-read-grant",
	scopes: ["vault:read"],
};

/** Collaborators and controlled time inside one real SQLite Durable Object. */
export interface NativeReadFixture {
	storage: DurableObjectStorage;
	/** Shared admission authority used by the read store and test ticket creation. */
	admissions: SqliteAdmissionAuthority;
	reads: SqliteReadStore;
	/** SQL text emitted by read-store projections, without bound values. */
	queries: string[];
	/** Set the Unix-millisecond clock used for ticket expiry and feed retention. */
	setNow(value: number): void;
	/** Create one active read ticket for the supplied canonical path scope. */
	authorizeRead(
		context?: AuthorizationContext,
		paths?: string[],
	): Promise<string>;
}

/** Run native read assertions against an isolated, initialized SQLite Durable Object. */
export async function withNativeReadFixture(
	assert: (fixture: NativeReadFixture) => Promise<void>,
): Promise<void> {
	const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
	await runInDurableObject(stub, async (_instance, state) => {
		const storage = state.storage;
		clearTestVault(storage);
		storage.sql.exec("PRAGMA foreign_keys = ON");
		let now = 1_000_000_000;
		let ticketSequence = 0;
		initializeVaultStorage(
			storage,
			() => NATIVE_READ_EPOCH,
			() => now,
		);
		const admissions = new SqliteAdmissionAuthority(storage, {
			now: () => now,
			newTicketId: () => (++ticketSequence).toString(16).padStart(32, "0"),
		});
		const queries: string[] = [];
		const reads = new SqliteReadStore(storage, admissions, {
			now: () => now,
			logger: {
				logQuery: (query) => {
					queries.push(query);
				},
			},
		});
		/** Authorize a body-free ticket for one test read scope. */
		const authorizeRead = async (
			context = NATIVE_READ_CONTEXT,
			paths: string[] = [],
		) => {
			const result = await admissions.authorize(context, {
				op: "read",
				paths,
				precondition: { kind: "none" },
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			});
			if (!result.ok)
				throw new Error(`Read authorization failed: ${result.failure.kind}`);
			return result.ticket.id;
		};
		await assert({
			storage,
			admissions,
			reads,
			queries,
			setNow: (value) => {
				now = value;
			},
			authorizeRead,
		});
	});
}

/** Insert one immutable retained feed row for floor and identity tests. */
export function seedReadChange(
	storage: DurableObjectStorage,
	input: {
		seq: number;
		at: number;
		path?: string;
		rev?: number;
		op?: "put" | "delete" | "rename";
		hash?: string;
		fromPath?: string;
		fromRev?: number;
	},
): void {
	storage.sql.exec(
		"INSERT INTO changes(seq,op,path,rev,hash,from_path,from_rev,origin,at) VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', ?)",
		input.seq,
		input.op ?? "put",
		input.path ?? `files/${input.seq}.md`,
		input.rev ?? 1,
		input.hash ?? "a".repeat(64),
		input.fromPath ?? null,
		input.fromRev ?? null,
		input.at,
	);
}
