import { env, runInDurableObject } from "cloudflare:test";
import type { AuthorizationContext } from "@obsidian-ai-bridge/protocol";
import { pathKey } from "@obsidian-ai-bridge/protocol";
import { prepareTextPayload } from "@worker/application/text-payload";
import { SqliteAdmissionAuthority } from "@worker/infrastructure/sqlite/admission";
import { SqliteMutationCoordinator } from "@worker/infrastructure/sqlite/mutations";
import { initializeVaultStorage } from "@worker/infrastructure/sqlite/schema";
import { SqliteTextStore } from "@worker/infrastructure/sqlite/text-files";
import { clearTestVault } from "@worker/test-fixtures/admission";

/** Fixed epoch used by isolated native text-store fixtures. */
export const TEXT_FIXTURE_EPOCH = "0123456789abcdef0123456789abcdef";

/** Authorization with read, write, and delete rights for direct native tests. */
export const TEXT_FIXTURE_CONTEXT: AuthorizationContext = {
	client_id: "text-store-client",
	grant_id: "text-store-grant",
	scopes: ["vault:read", "vault:write", "vault:delete"],
};

/** Native authorities and a controllable Unix-millisecond clock for text tests. */
export type TextStoreFixture = {
	storage: DurableObjectStorage;
	admissions: SqliteAdmissionAuthority;
	coordinator: SqliteMutationCoordinator;
	store: SqliteTextStore;
	setNow: (value: number) => void;
};

/** Capture all rows that conditional publication can change or consume in one test vault. */
export function captureTextStoreState(storage: DurableObjectStorage) {
	return {
		files: storage.sql.exec("SELECT * FROM files ORDER BY path").toArray(),
		revisions: storage.sql
			.exec("SELECT * FROM revisions ORDER BY path, rev")
			.toArray(),
		changes: storage.sql.exec("SELECT * FROM changes ORDER BY seq").toArray(),
		fts: storage.sql
			.exec("SELECT rowid, path, content FROM files_fts ORDER BY rowid")
			.toArray(),
		meta: storage.sql
			.exec("SELECT key, value FROM meta ORDER BY key")
			.toArray(),
		receipts: storage.sql
			.exec("SELECT * FROM receipts ORDER BY client_id, key")
			.toArray(),
		admissions: storage.sql
			.exec("SELECT * FROM operation_admissions ORDER BY id")
			.toArray(),
		claims: storage.sql
			.exec("SELECT * FROM mutation_claims ORDER BY client_id, key")
			.toArray(),
	};
}

/** Seed one live Markdown path plus exact history, feed, FTS, receipt, and unrelated admission ownership. */
export async function seedLiveTextState(
	storage: DurableObjectStorage,
	input: {
		path: string;
		content: string;
		revision?: number;
		sequence?: number;
	},
): Promise<void> {
	const payload = await prepareTextPayload(
		new TextEncoder().encode(input.content),
	);
	const revision = input.revision ?? 1;
	const sequence = input.sequence ?? 1;
	storage.sql.exec(
		"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, ?, ?, ?, ?, 'text', ?, 0, 321, 'seed-client')",
		input.path,
		pathKey(input.path),
		revision,
		sequence,
		payload.payload_hash,
		payload.size,
		payload.content,
	);
	storage.sql.exec(
		"INSERT INTO revisions(path,rev,hash,size,kind,content,deleted,origin,at) VALUES (?, ?, ?, ?, 'text', ?, 0, 'seed-client', 321)",
		input.path,
		revision,
		payload.payload_hash,
		payload.size,
		payload.content,
	);
	storage.sql.exec(
		"INSERT INTO changes(seq,op,path,rev,hash,origin,at) VALUES (?, 'put', ?, ?, ?, 'seed-client', 321)",
		sequence,
		input.path,
		revision,
		payload.payload_hash,
	);
	if (input.path.endsWith(".md"))
		storage.sql.exec(
			"INSERT INTO files_fts(path,content) VALUES (?, ?)",
			input.path,
			payload.content,
		);
	storage.sql.exec(
		"UPDATE meta SET value = ? WHERE key = 'head_seq'",
		String(sequence),
	);
	storage.sql.exec("UPDATE meta SET value = '1' WHERE key = 'live_file_count'");
	storage.sql.exec(
		"INSERT INTO receipts(client_id,key,fingerprint,status,body,at) VALUES ('seed-client','seed-receipt','seed-fingerprint',201,'{}',321)",
	);
	storage.sql.exec(
		"INSERT INTO operation_admissions(id,client_id,grant_id,epoch,fingerprint,admitted_at,expires_at,state) VALUES ('ffffffffffffffffffffffffffffffff','unrelated-client','unrelated-grant',?,'unrelated-fingerprint',10,50000,'uncertain')",
		TEXT_FIXTURE_EPOCH,
	);
	storage.sql.exec(
		"INSERT INTO mutation_claims(client_id,key,admission_id) VALUES ('unrelated-client','unrelated-key-01','ffffffffffffffffffffffffffffffff')",
	);
}

/** Create a real SQLite vault and all Task 3 collaborators inside a disposable Durable Object. */
export async function withTextStore(
	assert: (fixture: TextStoreFixture) => Promise<void>,
): Promise<void> {
	const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
	await runInDurableObject(stub, async (_instance, state) => {
		const storage = state.storage;
		clearTestVault(storage);
		storage.sql.exec("PRAGMA foreign_keys = ON");
		initializeVaultStorage(
			storage,
			() => TEXT_FIXTURE_EPOCH,
			() => 10_000,
		);
		let now = 10_000;
		let sequence = 0;
		const admissions = new SqliteAdmissionAuthority(storage, {
			now: () => now,
			newTicketId: () => (++sequence).toString(16).padStart(32, "0"),
		});
		const coordinator = new SqliteMutationCoordinator(storage, admissions, {
			now: () => now,
		});
		const store = new SqliteTextStore(storage, coordinator, { now: () => now });
		await assert({
			storage,
			admissions,
			coordinator,
			store,
			setNow: (value) => {
				now = value;
			},
		});
	});
}
