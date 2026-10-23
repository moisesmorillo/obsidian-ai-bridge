import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
	AdmissionResult,
	AuthorizationContext,
	OperationDescriptor,
	OperationIntent,
} from "@obsidian-ai-bridge/protocol";
import {
	formatETag,
	IdempotencyKeySchema,
	MutationReceiptSchema,
	OperationTicketSchema,
	pathKey,
	TextPayloadSchema,
} from "@obsidian-ai-bridge/protocol";
import {
	prepareDescriptor,
	prepareOperation,
} from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";
import { prepareTextPayload } from "@worker/application/text-payload";
import {
	SqliteAdmissionAuthority,
	type VaultTransaction,
} from "@worker/infrastructure/sqlite/admission";
import { SqliteMutationCoordinator } from "@worker/infrastructure/sqlite/mutations";
import {
	initializeVaultStorage,
	SCHEMA_VERSION,
} from "@worker/infrastructure/sqlite/schema";
import { files, vaultSchema } from "@worker/infrastructure/sqlite/schema-model";
import {
	captureVaultState,
	clearTestVault,
} from "@worker/test-fixtures/admission";
import { SCHEMA_V2_RELATIONAL_STATEMENTS } from "@worker/test-fixtures/schema-v2";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

/** Fixed canonical epoch used by native bootstrap and mutation fixtures. */
const epoch = "0123456789abcdef0123456789abcdef";
/** Exact frozen v2 FTS statement from the recorded base schema. */
const schemaV2FtsStatement = `CREATE VIRTUAL TABLE files_fts USING fts5(
 path UNINDEXED, content, tokenize = 'trigram case_sensitive 0 remove_diacritics 1'
);`;
/** Write authorization used by claim and coordinator fixtures. */
const context: AuthorizationContext = {
	client_id: "claim-client",
	grant_id: "claim-grant",
	scopes: ["vault:write"],
};
/** Create-only mutation descriptor used by keyed reservation fixtures. */
const descriptor: OperationDescriptor = {
	op: "put",
	epoch,
	paths: ["claim.md"],
	precondition: { kind: "absent" },
};
/** Empty inline payload intent used to prepare independent native tickets. */
const intent: OperationIntent = {
	...descriptor,
	payload_hash:
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	size: 0,
};
/** Exact content, size, and SHA-256 for the four-byte live text fixture. */
const bodyPayload = TextPayloadSchema.parse({
	content: "body",
	payload_hash:
		"230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5",
	size: 4,
});
/** Opaque client key used by claim lifecycle fixtures. */
const idempotencyKey = IdempotencyKeySchema.parse("claim-key-0001");
/** Valid deterministic first admission identifier. */
const ticketId = OperationTicketSchema.shape.id.parse(
	"0123456789abcdef0123456789abcdef",
);
/** Valid IDs for raw relational constraint characterization. */
const fixtureTicketA = OperationTicketSchema.shape.id.parse("a".repeat(32));
/** Second valid ID for raw relational constraint characterization. */
const fixtureTicketB = OperationTicketSchema.shape.id.parse("b".repeat(32));
/** Valid absent ID used to prove missing settlement is inert. */
const missingTicketId = OperationTicketSchema.shape.id.parse("c".repeat(32));
/** Sequence counter for unique IDs across a native store test. */
let ticketSequence = 0;
/** Canonical compact receipt returned by test-owned publication callbacks. */
const receipt = MutationReceiptSchema.parse({
	status: 201,
	body: {
		path: "claim.md",
		etag: formatETag(epoch, 1),
		seq: 1,
		hash: intent.payload_hash,
		size: 0,
		deleted: false,
	},
});

/** Create native storage in a Durable Object and pass it to one bootstrap assertion. */
async function withNativeStorage(
	assert: (storage: DurableObjectStorage) => void,
) {
	const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
	await runInDurableObject(stub, (_instance, state) => assert(state.storage));
}

/** Build a complete frozen version-2 store with its canonical metadata. */
function seedVersionTwo(storage: DurableObjectStorage): void {
	for (const statement of SCHEMA_V2_RELATIONAL_STATEMENTS)
		storage.sql.exec(statement);
	storage.sql.exec(schemaV2FtsStatement);
	storage.sql.exec(
		"INSERT INTO meta(key, value) VALUES ('schema_version', '2'), ('epoch', ?), ('head_seq', '0'), ('created_at', '1'), ('live_file_count', '0')",
		epoch,
	);
}

/** Create a native schema, admission authority, and coordinator with controllable time. */
async function withMutationStore(
	assert: (fixture: MutationFixture) => Promise<void>,
) {
	const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
	await runInDurableObject(stub, async (_instance, state) => {
		const storage = state.storage;
		clearTestVault(storage);
		initializeVaultStorage(
			storage,
			() => epoch,
			() => 1,
		);
		let now = 10_000;
		ticketSequence = 0;
		const admissions = new SqliteAdmissionAuthority(storage, {
			now: () => now,
			newTicketId: nextTicketId,
		});
		const coordinator = new SqliteMutationCoordinator(storage, admissions, {
			now: () => now,
		});
		await assert({
			storage,
			admissions,
			coordinator,
			setNow: (value) => {
				now = value;
			},
		});
	});
}

/** Native collaborators and the test clock used by each lifecycle scenario. */
type MutationFixture = {
	storage: DurableObjectStorage;
	admissions: SqliteAdmissionAuthority;
	coordinator: SqliteMutationCoordinator;
	setNow: (value: number) => void;
};

/** Capture a rejected operation without allowing its exception to hide state assertions. */
async function captureOutcome<T>(operation: () => Promise<T> | T) {
	try {
		return { value: await operation() } as const;
	} catch (error) {
		return { error } as const;
	}
}

/** Read all durable mutation claims in their client-key order. */
function claimRows(storage: DurableObjectStorage) {
	return storage.sql
		.exec<{ client_id: string; key: string; admission_id: string }>(
			"SELECT client_id, key, admission_id FROM mutation_claims ORDER BY client_id, key",
		)
		.toArray();
}

/** Read all durable admission rows in their identifier order. */
function admissionRows(storage: DurableObjectStorage) {
	return storage.sql
		.exec<{
			id: string;
			client_id: string;
			grant_id: string;
			epoch: string;
			fingerprint: string;
			admitted_at: number;
			expires_at: number;
			state: string;
		}>("SELECT * FROM operation_admissions ORDER BY id")
		.toArray();
}

/** Seed bounded native admissions with claims across distinct clients. */
function seedGlobalClaims(
	storage: DurableObjectStorage,
	cycle: number,
	count: number,
	admittedAt: number,
	expiresAt: number,
): void {
	storage.transactionSync(() => {
		for (let index = 0; index < count; index += 1) {
			const id = `${cycle.toString(16).padStart(2, "0")}${index.toString(16).padStart(30, "0")}`;
			const clientId = `global-${cycle}-${Math.floor(index / 16)}`;
			const key = IdempotencyKeySchema.parse(`global-${cycle}-key-${index}`);
			storage.sql.exec(
				"INSERT INTO operation_admissions(id,client_id,grant_id,epoch,fingerprint,admitted_at,expires_at,state) VALUES (?, ?, 'grant', ?, 'fingerprint', ?, ?, 'reserved')",
				id,
				clientId,
				epoch,
				admittedAt,
				expiresAt,
			);
			storage.sql.exec(
				"INSERT INTO mutation_claims(client_id,key,admission_id) VALUES (?, ?, ?)",
				clientId,
				key,
				id,
			);
		}
	});
}

/** Read final receipt rows without changing their canonical stored representation. */
function receiptRows(storage: DurableObjectStorage) {
	return storage.sql
		.exec<{
			client_id: string;
			key: string;
			fingerprint: string;
			status: number;
			body: string;
			at: number;
		}>(
			"SELECT client_id, key, fingerprint, status, body, at FROM receipts ORDER BY client_id, key",
		)
		.toArray();
}

/** Authorize and prepare an independently usable active ticket for commit tests. */
async function activeOperation(admissions: SqliteAdmissionAuthority) {
	const prepared = await prepareOperation(context, intent);
	const authorized = await admissions.authorize(context, intent);
	return { prepared, authorized };
}

/** Fail the test setup unless native authorization issued a usable ticket. */
function expectTicket(
	result: AdmissionResult,
): asserts result is Extract<AdmissionResult, { ok: true }> {
	expect(result.ok).toBe(true);
}

/** Attach a client key to a real active admission for independent commit tests. */
function seedClaim(
	storage: DurableObjectStorage,
	clientId: string,
	key: string,
	admissionId: string,
): void {
	storage.sql.exec(
		"INSERT INTO mutation_claims(client_id,key,admission_id) VALUES (?, ?, ?)",
		clientId,
		key,
		admissionId,
	);
}

/** Seed a native inline row with an explicit canonical path key and tombstone state. */
function seedFile(
	storage: DurableObjectStorage,
	path: string,
	key: string,
	deleted: 0 | 1,
): void {
	storage.sql.exec(
		"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 1, 1, ?, ?, 'text', ?, ?, 1, 'test')",
		path,
		key,
		deleted === 1 ? "" : bodyPayload.payload_hash,
		deleted === 1 ? 0 : bodyPayload.size,
		deleted === 1 ? null : bodyPayload.content,
		deleted,
	);
}

/** Insert visible inline content inside the publisher transaction for rollback assertions. */
function publishTestFile(tx: VaultTransaction, path: string): void {
	tx.insert(files)
		.values({
			path,
			pathKey: pathKey(path),
			rev: 1,
			seq: 1,
			hash: intent.payload_hash,
			size: 0,
			kind: "text",
			content: "",
			blobHash: null,
			deleted: 0,
			updatedAt: 1,
			origin: "test",
		})
		.run();
}

/** Write a visible metadata change inside the publisher transaction. */
function publishMetadata(tx: VaultTransaction) {
	tx.run(sql.raw("UPDATE meta SET value = '1' WHERE key = 'head_seq'"));
	return receipt;
}

describe("vault mutation claim bootstrap", () => {
	it("uses schema version 5", () => {
		expect(SCHEMA_VERSION).toBe(5);
	});

	it("stores schema version 5 on fresh native storage", async () => {
		await withNativeStorage((storage) => {
			clearTestVault(storage);
			initializeVaultStorage(
				storage,
				() => epoch,
				() => 1,
			);
			expect(
				storage.sql
					.exec<{ value: string }>(
						"SELECT value FROM meta WHERE key = 'schema_version'",
					)
					.toArray(),
			).toEqual([{ value: "5" }]);
		});
	});

	it("creates the mutation claims table on fresh native storage", async () => {
		await withNativeStorage((storage) => {
			clearTestVault(storage);
			initializeVaultStorage(
				storage,
				() => epoch,
				() => 1,
			);
			expect(
				storage.sql
					.exec<{ name: string }>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mutation_claims'",
					)
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("accepts repeat initialization for the claim schema", async () => {
		await withNativeStorage((storage) => {
			clearTestVault(storage);
			initializeVaultStorage(
				storage,
				() => epoch,
				() => 1,
			);
			initializeVaultStorage(
				storage,
				() => epoch,
				() => 2,
			);
			expect(
				storage.sql
					.exec<{ name: string }>(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mutation_claims'",
					)
					.toArray(),
			).toHaveLength(1);
		});
	});

	it("rejects a complete version-2 store without changes", async () => {
		await withNativeStorage((storage) => {
			clearTestVault(storage);
			seedVersionTwo(storage);
			storage.sql.exec(
				"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES ('keep.md','keep.md',1,1,'hash',4,'text','keep',0,1,'test')",
			);
			const before = captureVaultState(storage);
			let epochCalls = 0;
			let timeCalls = 0;
			let rejected = false;
			try {
				initializeVaultStorage(
					storage,
					() => {
						epochCalls += 1;
						return epoch;
					},
					() => {
						timeCalls += 1;
						return 2;
					},
				);
			} catch {
				rejected = true;
			}
			expect(epochCalls).toBe(0);
			expect(timeCalls).toBe(0);
			expect(captureVaultState(storage)).toEqual(before);
			expect(rejected).toBe(true);
		});
	});
});

describe("native mutation claim constraints", () => {
	it("enables foreign keys and rejects missing or duplicate ownership", async () => {
		await withMutationStore(async ({ storage }) => {
			expect(
				storage.sql
					.exec<{ foreign_keys: number }>("PRAGMA foreign_keys")
					.toArray(),
			).toEqual([{ foreign_keys: 1 }]);
			const invalidForeignKey = await captureOutcome(() =>
				storage.sql.exec(
					"INSERT INTO mutation_claims(client_id,key,admission_id) VALUES (?, ?, ?)",
					"client",
					IdempotencyKeySchema.parse("missing-key"),
					"missing-ticket",
				),
			);
			expect(invalidForeignKey).toHaveProperty("error");
			storage.sql.exec(
				"INSERT INTO operation_admissions(id,client_id,grant_id,epoch,fingerprint,admitted_at,expires_at,state) VALUES (?, 'client','grant',?,'fingerprint',1,60001,'reserved'), (?, 'client','grant',?,'fingerprint',1,60001,'reserved')",
				fixtureTicketA,
				epoch,
				fixtureTicketB,
				epoch,
			);
			storage.sql.exec(
				"INSERT INTO mutation_claims(client_id,key,admission_id) VALUES (?, ?, ?)",
				"client",
				IdempotencyKeySchema.parse("key-one-123"),
				fixtureTicketA,
			);
			const duplicateKey = await captureOutcome(() =>
				storage.sql.exec(
					"INSERT INTO mutation_claims(client_id,key,admission_id) VALUES (?, ?, ?)",
					"client",
					IdempotencyKeySchema.parse("key-one-123"),
					fixtureTicketB,
				),
			);
			const duplicateOwner = await captureOutcome(() =>
				storage.sql.exec(
					"INSERT INTO mutation_claims(client_id,key,admission_id) VALUES (?, ?, ?)",
					"client",
					IdempotencyKeySchema.parse("key-two-123"),
					fixtureTicketA,
				),
			);
			expect(duplicateKey).toHaveProperty("error");
			expect(duplicateOwner).toHaveProperty("error");
			expect(claimRows(storage)).toEqual([
				{
					client_id: "client",
					key: IdempotencyKeySchema.parse("key-one-123"),
					admission_id: fixtureTicketA,
				},
			]);
		});
	});
});

describe("native admission settlement behavior", () => {
	it("settles only a matching ticket and ignores missing or unrelated tickets", async () => {
		await withMutationStore(async ({ storage, admissions }) => {
			const staleIntent: OperationIntent = {
				...intent,
				precondition: { kind: "match", etag: formatETag(epoch, 1) },
			};
			const prepared = await prepareOperation(context, staleIntent);
			const authorized = await admissions.authorize(context, staleIntent);
			expectTicket(authorized);
			const unrelatedIntent: OperationIntent = {
				...staleIntent,
				paths: ["unrelated.md"],
			};
			const unrelatedTicket = await admissions.authorize(
				context,
				unrelatedIntent,
			);
			expectTicket(unrelatedTicket);
			seedClaim(
				storage,
				context.client_id,
				idempotencyKey,
				authorized.ticket.id,
			);
			seedClaim(
				storage,
				context.client_id,
				IdempotencyKeySchema.parse("unrelated-key"),
				unrelatedTicket.ticket.id,
			);
			const db = drizzle(storage, { schema: vaultSchema });
			const before = admissionRows(storage);
			const claimsBefore = claimRows(storage);
			const unrelatedAdmission = before.find(
				({ id }) => id === unrelatedTicket.ticket.id,
			);
			const missing = await captureOutcome(() =>
				db.transaction((tx) =>
					admissions.settleMatchingInTransaction(
						tx,
						context,
						prepared,
						missingTicketId,
					),
				),
			);
			expect.soft(missing).toHaveProperty("value", undefined);
			expect.soft(admissionRows(storage)).toEqual(before);
			expect.soft(claimRows(storage)).toEqual(claimsBefore);
			const unrelated = await captureOutcome(() =>
				db.transaction((tx) =>
					admissions.settleMatchingInTransaction(
						tx,
						context,
						prepared,
						unrelatedTicket.ticket.id,
					),
				),
			);
			expect.soft(unrelated).toHaveProperty("value", undefined);
			expect.soft(admissionRows(storage)).toEqual(before);
			expect.soft(claimRows(storage)).toEqual(claimsBefore);
			const matching = await captureOutcome(() =>
				db.transaction((tx) =>
					admissions.settleMatchingInTransaction(
						tx,
						context,
						prepared,
						authorized.ticket.id,
					),
				),
			);
			expect.soft(matching).toHaveProperty("value", undefined);
			expect.soft(unrelatedAdmission).toBeDefined();
			expect.soft(admissionRows(storage)).toEqual([unrelatedAdmission]);
			expect.soft(claimRows(storage)).toEqual([
				{
					client_id: context.client_id,
					key: IdempotencyKeySchema.parse("unrelated-key"),
					admission_id: unrelatedTicket.ticket.id,
				},
			]);
		});
	});
});

describe("native mutation claim cascade constraints", () => {
	it("cascades admission removal and rolls back thrown transactions", async () => {
		await withMutationStore(async ({ storage }) => {
			storage.sql.exec(
				"INSERT INTO operation_admissions(id,client_id,grant_id,epoch,fingerprint,admitted_at,expires_at,state) VALUES (?, 'client','grant',?,'fingerprint',1,60001,'reserved')",
				fixtureTicketA,
				epoch,
			);
			storage.sql.exec(
				"INSERT INTO mutation_claims(client_id,key,admission_id) VALUES (?, ?, ?)",
				"client",
				IdempotencyKeySchema.parse("key-one-123"),
				fixtureTicketA,
			);
			const before = {
				claims: claimRows(storage),
				admissions: admissionRows(storage),
			};
			const thrown = await captureOutcome(() =>
				storage.transactionSync(() => {
					storage.sql.exec(
						"DELETE FROM operation_admissions WHERE id = ?",
						fixtureTicketA,
					);
					throw new Error("forced rollback");
				}),
			);
			expect(thrown).toHaveProperty("error");
			expect({
				claims: claimRows(storage),
				admissions: admissionRows(storage),
			}).toEqual(before);
			storage.sql.exec(
				"DELETE FROM operation_admissions WHERE id = ?",
				fixtureTicketA,
			);
			expect(claimRows(storage)).toEqual([]);
			expect(admissionRows(storage)).toEqual([]);
		});
	});
});

describe("native mutation claim lifecycle", () => {
	it("creates one claim for a new key and no claim for unkeyed work", async () => {
		await withMutationStore(async ({ storage, coordinator }) => {
			const keyed = await captureOutcome(() =>
				coordinator.beginMutation(context, descriptor, idempotencyKey),
			);
			const keyedClaims = claimRows(storage);
			const unkeyed = await captureOutcome(() =>
				coordinator.beginMutation(context, descriptor),
			);
			expect.soft(keyed).toHaveProperty("value", {
				ok: true,
				lease: { admission_id: ticketId, expires_at: 70_000 },
			});
			expect.soft(keyedClaims).toEqual([
				{
					client_id: context.client_id,
					key: idempotencyKey,
					admission_id: ticketId,
				},
			]);
			expect.soft(unkeyed).toHaveProperty("value.ok", true);
			expect.soft(admissionRows(storage)).toHaveLength(2);
			expect.soft(claimRows(storage)).toHaveLength(1);
		});
	});

	it("isolates client keys and reports a matching live claim as in progress", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const first = await admissions.reserve(context, descriptor);
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			seedClaim(
				storage,
				context.client_id,
				idempotencyKey,
				first.lease.admission_id,
			);
			const firstAdmission = admissionRows(storage);
			const firstClaim = claimRows(storage);
			const sameClient = await captureOutcome(() =>
				coordinator.beginMutation(context, descriptor, idempotencyKey),
			);
			expect
				.soft(sameClient)
				.toHaveProperty("value.failure.kind", "idempotency_in_progress");
			const beforeOtherClientAdmissions = admissionRows(storage);
			const beforeOtherClientClaims = claimRows(storage);
			const anotherClient = await captureOutcome(() =>
				coordinator.beginMutation(
					{ ...context, client_id: "another-client" },
					descriptor,
					idempotencyKey,
				),
			);
			expect.soft(anotherClient).toHaveProperty("value.ok", true);
			const otherClientValue = anotherClient.value;
			const otherAdmissionId =
				otherClientValue?.ok === true
					? otherClientValue.lease.admission_id
					: undefined;
			expect.soft(otherAdmissionId).toBeDefined();
			const afterOtherClientAdmissions = admissionRows(storage);
			const afterOtherClientClaims = claimRows(storage);
			expect.soft(afterOtherClientAdmissions).toHaveLength(2);
			expect
				.soft(new Set(afterOtherClientAdmissions.map(({ id }) => id)).size)
				.toBe(2);
			expect.soft(afterOtherClientAdmissions).toContainEqual(firstAdmission[0]);
			expect.soft(afterOtherClientClaims).toContainEqual(firstClaim[0]);
			expect.soft(afterOtherClientClaims).toHaveLength(2);
			expect.soft(afterOtherClientClaims).toContainEqual({
				client_id: "another-client",
				key: idempotencyKey,
				admission_id: otherAdmissionId,
			});
			expect.soft(afterOtherClientAdmissions).toContainEqual(
				expect.objectContaining({
					id: otherAdmissionId,
					client_id: "another-client",
				}),
			);
			expect.soft(beforeOtherClientAdmissions).toEqual(firstAdmission);
			expect.soft(beforeOtherClientClaims).toEqual(firstClaim);
		});
	});

	it("retains the original deadline and rejects consumption at exact expiry", async () => {
		await withMutationStore(
			async ({ storage, admissions, coordinator, setNow }) => {
				const prepared = await prepareOperation(context, intent);
				const reserved = await admissions.reserve(context, descriptor);
				expect(reserved.ok).toBe(true);
				if (!reserved.ok) return;
				const ticketId = reserved.lease.admission_id;
				seedClaim(storage, context.client_id, idempotencyKey, ticketId);
				expect(admissionRows(storage)[0]).toMatchObject({
					id: ticketId,
					client_id: context.client_id,
					grant_id: context.grant_id,
					epoch,
					fingerprint: (await prepareDescriptor(context, descriptor))
						.descriptorFingerprint,
					admitted_at: 10_000,
					expires_at: 70_000,
					state: "reserved",
				});
				setNow(20_000);
				const active = await admissions.authorize(context, intent, ticketId);
				expectTicket(active);
				const activeSnapshot = admissionRows(storage);
				const claimSnapshot = claimRows(storage);
				expect(activeSnapshot).toHaveLength(1);
				expect(activeSnapshot[0]).toEqual({
					id: ticketId,
					client_id: context.client_id,
					grant_id: context.grant_id,
					epoch,
					fingerprint: prepared.fingerprint,
					admitted_at: 10_000,
					expires_at: 70_000,
					state: "active",
				});
				expect(claimSnapshot).toEqual([
					{
						client_id: context.client_id,
						key: idempotencyKey,
						admission_id: ticketId,
					},
				]);
				setNow(70_000);
				let callbacks = 0;
				const expired = await captureOutcome(() =>
					coordinator.commit(
						context,
						prepared,
						active.ticket.id,
						idempotencyKey,
						() => {
							callbacks += 1;
							return receipt;
						},
					),
				);
				expect.soft(expired).toHaveProperty("value", {
					ok: false,
					failure: { kind: "invalid_ticket" },
				});
				expect.soft(callbacks).toBe(0);
				expect.soft(admissionRows(storage)).toEqual(activeSnapshot);
				expect.soft(claimRows(storage)).toEqual(claimSnapshot);
			},
		);
	});
});

describe("native admission finish characterization", () => {
	it("retains claims through uncertain finish and removes them on settled finish", async () => {
		await withMutationStore(async ({ storage, admissions }) => {
			const begun = await admissions.reserve(context, descriptor);
			expect(begun.ok).toBe(true);
			if (!begun.ok) return;
			const ticket = begun.lease.admission_id;
			seedClaim(storage, context.client_id, idempotencyKey, ticket);
			const uncertain = admissions.finish(context, ticket, "uncertain");
			expect(uncertain).toMatchObject({ ok: true });
			expect(claimRows(storage)).toHaveLength(1);
			const settled = admissions.finish(context, ticket, "settled");
			expect(settled).toMatchObject({ ok: true });
			expect(claimRows(storage)).toEqual([]);
		});
	});
});

describe("native mutation claim lifecycle", () => {
	it("cleans expired claims, preserves replacements from old completion, and survives eviction", async () => {
		let replacementAdmissionSnapshot: ReturnType<typeof admissionRows> = [];
		let replacementClaimSnapshot: ReturnType<typeof claimRows> = [];
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const storage = state.storage;
			clearTestVault(storage);
			initializeVaultStorage(
				storage,
				() => epoch,
				() => 1,
			);
			let now = 10_000;
			let sequence = 0;
			const admissions = new SqliteAdmissionAuthority(storage, {
				now: () => now,
				newTicketId: () => {
					sequence += 1;
					return sequence.toString(16).padStart(32, "0");
				},
			});
			const coordinator = new SqliteMutationCoordinator(storage, admissions, {
				now: () => now,
			});
			const expectedOriginalId = OperationTicketSchema.shape.id.parse(
				"1".padStart(32, "0"),
			);
			const expectedReplacementId = OperationTicketSchema.shape.id.parse(
				"2".padStart(32, "0"),
			);
			const preparedDescriptor = await prepareDescriptor(context, descriptor);
			const original = await admissions.reserve(context, descriptor);
			expect(original.ok).toBe(true);
			if (!original.ok) return;
			const originalId = original.lease.admission_id;
			expect(originalId).toBe(expectedOriginalId);
			seedClaim(storage, context.client_id, idempotencyKey, originalId);
			const originalAdmission = admissionRows(storage);
			const originalClaim = claimRows(storage);
			expect(originalAdmission).toEqual([
				{
					id: originalId,
					client_id: context.client_id,
					grant_id: context.grant_id,
					epoch,
					fingerprint: preparedDescriptor.descriptorFingerprint,
					admitted_at: 10_000,
					expires_at: 70_000,
					state: "reserved",
				},
			]);
			expect(originalClaim).toEqual([
				{
					client_id: context.client_id,
					key: idempotencyKey,
					admission_id: originalId,
				},
			]);

			now = 70_000;
			const replacement = await captureOutcome(() =>
				coordinator.beginMutation(context, descriptor, idempotencyKey),
			);
			expect.soft(replacement).toHaveProperty("value", {
				ok: true,
				lease: { admission_id: expectedReplacementId, expires_at: 130_000 },
			});
			const replacementValue = replacement.value;
			const replacementId =
				replacementValue?.ok === true
					? replacementValue.lease.admission_id
					: undefined;
			expect.soft(replacementId).toBe(expectedReplacementId);
			const replacementAdmission = {
				id: expectedReplacementId,
				client_id: context.client_id,
				grant_id: context.grant_id,
				epoch,
				fingerprint: preparedDescriptor.descriptorFingerprint,
				admitted_at: 70_000,
				expires_at: 130_000,
				state: "reserved",
			};
			const replacementClaim = {
				client_id: context.client_id,
				key: idempotencyKey,
				admission_id: expectedReplacementId,
			};
			expect.soft(admissionRows(storage)).toContainEqual(replacementAdmission);
			expect.soft(claimRows(storage)).toContainEqual(replacementClaim);
			replacementAdmissionSnapshot = admissionRows(storage);
			replacementClaimSnapshot = claimRows(storage);
			const oldCompletion = admissions.finish(context, originalId, "settled");
			expect.soft(oldCompletion).toMatchObject({ ok: true });
			expect.soft(admissionRows(storage)).toEqual(replacementAdmissionSnapshot);
			expect.soft(claimRows(storage)).toEqual(replacementClaimSnapshot);
		});
		await evictDurableObject(stub);
		await runInDurableObject(stub, (_instance, state) => {
			expect
				.soft(admissionRows(state.storage))
				.toEqual(replacementAdmissionSnapshot);
			expect.soft(claimRows(state.storage)).toEqual(replacementClaimSnapshot);
		});
	});

	it("keeps each client within its 16-admission bound through three refill cycles", async () => {
		await withMutationStore(async ({ storage, coordinator, setNow }) => {
			for (let cycle = 0; cycle < 3; cycle += 1) {
				setNow(10_000 + cycle * 60_000);
				for (let index = 0; index < 16; index += 1) {
					const result = await captureOutcome(() =>
						coordinator.beginMutation(
							context,
							{ ...descriptor, paths: [`cycle-${cycle}-${index}.md`] },
							IdempotencyKeySchema.parse(`cycle-${cycle}-key-${index}`),
						),
					);
					expect.soft(result).toHaveProperty("value.ok", true);
				}
				const saturated = await captureOutcome(() =>
					coordinator.beginMutation(
						context,
						{ ...descriptor, paths: [`cycle-${cycle}-overflow.md`] },
						IdempotencyKeySchema.parse(`cycle-${cycle}-overflow`),
					),
				);
				expect
					.soft(saturated)
					.toHaveProperty("value.failure.kind", "admission_limited");
				expect.soft(admissionRows(storage)).toHaveLength(16);
				expect.soft(admissionRows(storage).length).toBeLessThanOrEqual(1_024);
				expect.soft(claimRows(storage)).toHaveLength(16);
				expect.soft(claimRows(storage).length).toBeLessThanOrEqual(1_024);
			}
		});
	});

	it("refuses global saturation and cleans expired claim ledgers across three refill cycles", async () => {
		await withMutationStore(
			async ({ storage, admissions, coordinator, setNow }) => {
				let now = 10_000;
				for (let cycle = 0; cycle < 3; cycle += 1) {
					const existing = admissionRows(storage).length;
					seedGlobalClaims(storage, cycle, 1_024 - existing, now, now + 60_000);
					expect.soft(admissionRows(storage)).toHaveLength(1_024);
					expect.soft(claimRows(storage)).toHaveLength(1_024);
					const beforeSaturation = {
						admissions: admissionRows(storage),
						claims: claimRows(storage),
					};
					const overflowContext = {
						...context,
						client_id: `overflow-${cycle}`,
					};
					const saturated = await captureOutcome(() =>
						coordinator.beginMutation(
							overflowContext,
							descriptor,
							IdempotencyKeySchema.parse(`global-overflow-${cycle}`),
						),
					);
					expect
						.soft(saturated)
						.toHaveProperty("value.failure.kind", "admission_limited");
					expect
						.soft(admissionRows(storage))
						.toEqual(beforeSaturation.admissions);
					expect.soft(claimRows(storage)).toEqual(beforeSaturation.claims);

					now += 60_000;
					setNow(now);
					const cleanupContext = {
						...context,
						client_id: `cleanup-${cycle}`,
					};
					let keeperId = "";
					let keeperKey = "";
					let keeperAdmission:
						| ReturnType<typeof admissionRows>[number]
						| undefined;
					let keeperClaim: ReturnType<typeof claimRows>[number] | undefined;
					for (let refill = 0; refill < 16; refill += 1) {
						const beforeAdmissions = admissionRows(storage);
						const beforeClaims = claimRows(storage);
						const result = await admissions.reserve(cleanupContext, {
							...descriptor,
							paths: [`cleanup-${cycle}-${refill}.md`],
						});
						expect(result.ok).toBe(true);
						if (!result.ok) return;
						const newAdmissionId = result.lease.admission_id;
						const newKey = IdempotencyKeySchema.parse(
							`refill-${cycle}-key-${refill}`,
						);
						seedClaim(
							storage,
							cleanupContext.client_id,
							newKey,
							newAdmissionId,
						);
						const afterAdmissions = admissionRows(storage);
						const afterClaims = claimRows(storage);
						expect
							.soft(beforeAdmissions.length - afterAdmissions.length + 1)
							.toBe(64);
						expect.soft(beforeClaims.length - afterClaims.length + 1).toBe(64);
						expect.soft(afterAdmissions.length).toBeLessThanOrEqual(1_024);
						expect.soft(afterClaims.length).toBeLessThanOrEqual(1_024);

						if (refill === 0) {
							keeperId = newAdmissionId;
							keeperKey = newKey;
							keeperAdmission = afterAdmissions.find(
								({ id }) => id === keeperId,
							);
							keeperClaim = afterClaims.find(({ key }) => key === keeperKey);
							expect(keeperAdmission).toBeDefined();
							expect(keeperClaim).toBeDefined();
							continue;
						}

						expect
							.soft(afterAdmissions.find(({ id }) => id === keeperId))
							.toEqual(keeperAdmission);
						expect
							.soft(afterClaims.find(({ key }) => key === keeperKey))
							.toEqual(keeperClaim);
						const settled = admissions.finish(
							cleanupContext,
							newAdmissionId,
							"settled",
						);
						expect(settled).toMatchObject({ ok: true });
						expect
							.soft(admissionRows(storage))
							.toHaveLength(afterAdmissions.length - 1);
						expect
							.soft(claimRows(storage))
							.toHaveLength(afterClaims.length - 1);
						expect
							.soft(admissionRows(storage).find(({ id }) => id === keeperId))
							.toEqual(keeperAdmission);
						expect
							.soft(claimRows(storage).find(({ key }) => key === keeperKey))
							.toEqual(keeperClaim);
					}
					expect.soft(admissionRows(storage)).toEqual([keeperAdmission]);
					expect.soft(claimRows(storage)).toEqual([keeperClaim]);
				}
			},
		);
	});
});

describe("native mutation coordinator", () => {
	it("publishes once, stores one receipt, and replays without a second callback", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const { prepared, authorized } = await activeOperation(admissions);
			expectTicket(authorized);
			seedClaim(
				storage,
				context.client_id,
				idempotencyKey,
				authorized.ticket.id,
			);
			let callbacks = 0;
			const first = await captureOutcome(() =>
				coordinator.commit(
					context,
					prepared,
					authorized.ticket.id,
					idempotencyKey,
					(tx) => {
						callbacks += 1;
						return publishMetadata(tx);
					},
				),
			);
			const replay = await captureOutcome(() =>
				coordinator.commit(
					context,
					prepared,
					authorized.ticket.id,
					idempotencyKey,
					(tx) => {
						callbacks += 1;
						return publishMetadata(tx);
					},
				),
			);
			expect.soft(first).toHaveProperty("value.ok", true);
			expect.soft(first).toHaveProperty("value", {
				ok: true,
				response: receipt,
			});
			expect.soft(replay).toHaveProperty("value.response", receipt);
			expect.soft(replay).toHaveProperty("value", {
				ok: true,
				response: receipt,
			});
			expect.soft(callbacks).toBe(1);
			expect.soft(receiptRows(storage)).toEqual([
				{
					client_id: context.client_id,
					key: idempotencyKey,
					fingerprint: prepared.fingerprint,
					status: receipt.status,
					body: JSON.stringify(receipt.body),
					at: 10_000,
				},
			]);
			expect
				.soft(
					storage.sql
						.exec<{ value: string }>(
							"SELECT value FROM meta WHERE key = 'head_seq'",
						)
						.toArray(),
				)
				.toEqual([{ value: "1" }]);
			expect.soft(claimRows(storage)).toEqual([]);
			expect.soft(admissionRows(storage)).toEqual([]);
		});
	});

	it("distinguishes exact-path precondition failures from canonical path collisions", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			let callbacks = 0;
			/** Authorize one path request and capture its result without publishing on refusal. */
			const attempt = async (operationIntent: OperationIntent) => {
				const prepared = await prepareOperation(context, operationIntent);
				const authorized = await admissions.authorize(context, operationIntent);
				expectTicket(authorized);
				return captureOutcome(() =>
					coordinator.commit(
						context,
						prepared,
						authorized.ticket.id,
						undefined,
						() => {
							callbacks += 1;
							return receipt;
						},
					),
				);
			};
			seedFile(storage, "same.md", "same.md", 0);
			const exact = await attempt({ ...intent, paths: ["same.md"] });
			seedFile(storage, "Alias.md", "alias.md", 0);
			const alias = await attempt({ ...intent, paths: ["alias.md"] });
			seedFile(storage, "restore.md", "restore.md", 1);
			seedFile(storage, "RESTORE.md", "restore.md", 0);
			const tombstoneAlias = await attempt({
				...intent,
				paths: ["restore.md"],
				precondition: { kind: "match", etag: formatETag(epoch, 1) },
			});
			expect
				.soft(exact)
				.toHaveProperty("value.failure.kind", "precondition_failed");
			expect.soft(alias).toHaveProperty("value.failure", {
				kind: "path_collision",
				existing_path: "Alias.md",
			});
			expect.soft(tombstoneAlias).toHaveProperty("value.failure", {
				kind: "path_collision",
				existing_path: "RESTORE.md",
			});
			expect.soft(callbacks).toBe(0);
		});
	});

	it("projects current conflict content only for a read-authorized caller", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const updatedPayload = await prepareTextPayload(
				new TextEncoder().encode("updated body"),
			);
			let callbacks = 0;
			/** Authorize one stale write and capture its read-authorized conflict result. */
			const attempt = async (
				operationContext: AuthorizationContext,
				path: string,
			) => {
				seedFile(storage, path, pathKey(path), 0);
				storage.sql.exec(
					"UPDATE files SET rev = 2, seq = 2, content = ?, hash = ?, size = ?, updated_at = 2 WHERE path = ?",
					updatedPayload.content,
					updatedPayload.payload_hash,
					updatedPayload.size,
					path,
				);
				const staleIntent: OperationIntent = {
					...intent,
					paths: [path],
					precondition: { kind: "match", etag: formatETag(epoch, 1) },
				};
				const prepared = await prepareOperation(operationContext, staleIntent);
				const authorized = await admissions.authorize(
					operationContext,
					staleIntent,
				);
				expectTicket(authorized);
				return captureOutcome(() =>
					coordinator.commit(
						operationContext,
						prepared,
						authorized.ticket.id,
						undefined,
						() => {
							callbacks += 1;
							return receipt;
						},
					),
				);
			};
			const readable = await attempt(
				{ ...context, scopes: ["vault:write", "vault:read"] },
				"conflict.md",
			);
			const writeOnly = await attempt(context, "private.md");
			expect.soft(readable).toHaveProperty("value.failure", {
				kind: "precondition_failed",
				etag: formatETag(epoch, 2),
				hash: updatedPayload.payload_hash,
				deleted: false,
				content: "updated body",
			});
			expect
				.soft(writeOnly)
				.toHaveProperty("value.failure.kind", "precondition_failed");
			expect.soft(writeOnly).not.toHaveProperty("value.failure.content");
			expect.soft(callbacks).toBe(0);
		});
	});

	it("rejects a mismatched fingerprint without publishing or settling ownership", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const { authorized } = await activeOperation(admissions);
			expectTicket(authorized);
			seedClaim(
				storage,
				context.client_id,
				idempotencyKey,
				authorized.ticket.id,
			);
			const different = await prepareOperation(context, {
				...intent,
				payload_hash: "a".repeat(64),
			});
			const admissionsBefore = admissionRows(storage);
			const claimsBefore = claimRows(storage);
			let callbacks = 0;
			const outcome = await captureOutcome(() =>
				coordinator.commit(
					context,
					different,
					authorized.ticket.id,
					idempotencyKey,
					() => {
						callbacks += 1;
						return receipt;
					},
				),
			);
			expect
				.soft(outcome)
				.toHaveProperty("value.failure.kind", "idempotency_mismatch");
			expect.soft(callbacks).toBe(0);
			expect.soft(admissionRows(storage)).toHaveLength(1);
			expect.soft(claimRows(storage)).toHaveLength(1);
			expect.soft(admissionRows(storage)).toEqual(admissionsBefore);
			expect.soft(claimRows(storage)).toEqual(claimsBefore);
		});
	});

	it("keeps a claim mismatch result stable when another admission matches the operation", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const first = await activeOperation(admissions);
			const firstTicket = first.authorized;
			expectTicket(firstTicket);
			const differentIntent: OperationIntent = {
				...intent,
				payload_hash: bodyPayload.payload_hash,
				size: bodyPayload.size,
			};
			const different = await prepareOperation(context, differentIntent);
			const second = await admissions.authorize(context, differentIntent);
			expectTicket(second);
			seedClaim(
				storage,
				context.client_id,
				idempotencyKey,
				firstTicket.ticket.id,
			);
			const admissionsBefore = admissionRows(storage);
			const claimsBefore = claimRows(storage);
			const receiptsBefore = receiptRows(storage);
			let callbacks = 0;
			const outcome = await captureOutcome(() =>
				coordinator.commit(
					context,
					different,
					firstTicket.ticket.id,
					idempotencyKey,
					() => {
						callbacks += 1;
						return receipt;
					},
				),
			);
			expect
				.soft(outcome)
				.toHaveProperty("value.failure.kind", "idempotency_mismatch");
			expect.soft(callbacks).toBe(0);
			expect.soft(admissionRows(storage)).toEqual(admissionsBefore);
			expect.soft(claimRows(storage)).toEqual(claimsBefore);
			expect.soft(receiptRows(storage)).toEqual(receiptsBefore);
		});
	});

	it("rejects a different fingerprint from a final receipt without changing ownership", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const original = await prepareOperation(context, intent);
			const differentIntent: OperationIntent = {
				...intent,
				payload_hash: bodyPayload.payload_hash,
				size: bodyPayload.size,
			};
			const different = await prepareOperation(context, differentIntent);
			const authorized = await admissions.authorize(context, differentIntent);
			expectTicket(authorized);
			seedClaim(
				storage,
				context.client_id,
				idempotencyKey,
				authorized.ticket.id,
			);
			storage.sql.exec(
				"INSERT INTO receipts(client_id,key,fingerprint,status,body,at) VALUES (?, ?, ?, ?, ?, ?)",
				context.client_id,
				idempotencyKey,
				original.fingerprint,
				receipt.status,
				JSON.stringify(receipt.body),
				10_000,
			);
			const receiptsBefore = receiptRows(storage);
			const admissionsBefore = admissionRows(storage);
			const claimsBefore = claimRows(storage);
			let callbacks = 0;
			const outcome = await captureOutcome(() =>
				coordinator.commit(
					context,
					different,
					authorized.ticket.id,
					idempotencyKey,
					() => {
						callbacks += 1;
						return receipt;
					},
				),
			);
			expect
				.soft(outcome)
				.toHaveProperty("value.failure.kind", "idempotency_mismatch");
			expect.soft(callbacks).toBe(0);
			expect.soft(receiptRows(storage)).toEqual(receiptsBefore);
			expect.soft(admissionRows(storage)).toEqual(admissionsBefore);
			expect.soft(claimRows(storage)).toEqual(claimsBefore);
		});
	});

	it("replays an old receipt after current authorization without checking stale file conditions", async () => {
		await withMutationStore(
			async ({ storage, admissions, coordinator, setNow }) => {
				const staleIntent: OperationIntent = {
					...intent,
					precondition: { kind: "match", etag: formatETag(epoch, 1) },
				};
				const prepared = await prepareOperation(context, staleIntent);
				const authorized = await admissions.authorize(context, staleIntent);
				expectTicket(authorized);
				const newerPayload = await prepareTextPayload(
					new TextEncoder().encode("newer"),
				);
				storage.sql.exec(
					"INSERT INTO files(path,path_key,rev,seq,hash,size,kind,content,deleted,updated_at,origin) VALUES (?, ?, 2, 1, ?, ?, 'text', ?, 0, 2, 'test')",
					"claim.md",
					pathKey("claim.md"),
					newerPayload.payload_hash,
					newerPayload.size,
					newerPayload.content,
				);
				const oldKey = IdempotencyKeySchema.parse(
					"00000000-0000-7000-8000-000000000000",
				);
				seedClaim(storage, context.client_id, oldKey, authorized.ticket.id);
				storage.sql.exec(
					"INSERT INTO receipts(client_id,key,fingerprint,status,body,at) VALUES (?, ?, ?, 201, ?, 1)",
					context.client_id,
					oldKey,
					prepared.fingerprint,
					JSON.stringify(receipt.body),
				);
				setNow(2_246_400_000);
				let callbacks = 0;
				const replay = await captureOutcome(() =>
					coordinator.commit(
						context,
						prepared,
						authorized.ticket.id,
						oldKey,
						() => {
							callbacks += 1;
							return receipt;
						},
					),
				);
				expect.soft(replay).toHaveProperty("value.response", receipt);
				expect.soft(callbacks).toBe(0);
				expect.soft(receiptRows(storage)).toHaveLength(1);
			},
		);
	});

	it("rejects corrupt receipts without repairing or deleting them", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const { prepared, authorized } = await activeOperation(admissions);
			expectTicket(authorized);
			seedClaim(
				storage,
				context.client_id,
				idempotencyKey,
				authorized.ticket.id,
			);
			storage.sql.exec(
				"INSERT INTO receipts(client_id,key,fingerprint,status,body,at) VALUES (?, ?, ?, 201, '{', 1)",
				context.client_id,
				idempotencyKey,
				prepared.fingerprint,
			);
			const beforeReceipts = receiptRows(storage);
			const beforeClaims = claimRows(storage);
			let callbacks = 0;
			const outcome = await captureOutcome(() =>
				coordinator.commit(
					context,
					prepared,
					authorized.ticket.id,
					idempotencyKey,
					() => {
						callbacks += 1;
						return receipt;
					},
				),
			);
			expect.soft(outcome).toHaveProperty("error");
			expect.soft(receiptRows(storage)).toEqual(beforeReceipts);
			expect.soft(claimRows(storage)).toEqual(beforeClaims);
			expect.soft(callbacks).toBe(0);
		});
	});

	it("rejects a claim bound to another admission without changing either owner", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const first = await activeOperation(admissions);
			const second = await admissions.authorize(context, {
				...intent,
				paths: ["second.md"],
			});
			const firstTicket = first.authorized;
			expectTicket(firstTicket);
			expectTicket(second);
			seedClaim(storage, context.client_id, idempotencyKey, second.ticket.id);
			const beforeClaims = claimRows(storage);
			const beforeAdmissions = admissionRows(storage);
			const outcome = await captureOutcome(() =>
				coordinator.commit(
					context,
					first.prepared,
					firstTicket.ticket.id,
					idempotencyKey,
					() => receipt,
				),
			);
			expect
				.soft(outcome)
				.toHaveProperty("value.failure.kind", "invalid_ticket");
			expect.soft(claimRows(storage)).toEqual(beforeClaims);
			expect.soft(admissionRows(storage)).toEqual(beforeAdmissions);
		});
	});

	it("checks revocation and scope before reading a seeded receipt", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const { prepared, authorized } = await activeOperation(admissions);
			expectTicket(authorized);
			storage.sql.exec(
				"INSERT INTO receipts(client_id,key,fingerprint,status,body,at) VALUES (?, ?, ?, 201, ?, 1)",
				context.client_id,
				idempotencyKey,
				prepared.fingerprint,
				JSON.stringify(receipt.body),
			);
			const canonicalReceipts = receiptRows(storage);
			const admissionsBefore = admissionRows(storage);
			const claimsBefore = claimRows(storage);
			admissions.recordRevocation(context.grant_id);
			let callbacks = 0;
			const canonicalRevoked = await captureOutcome(() =>
				coordinator.commit(
					context,
					prepared,
					authorized.ticket.id,
					idempotencyKey,
					() => {
						callbacks += 1;
						return receipt;
					},
				),
			);
			expect
				.soft(canonicalRevoked)
				.toHaveProperty("value.failure.kind", "revoked");
			expect.soft(receiptRows(storage)).toEqual(canonicalReceipts);
			expect.soft(admissionRows(storage)).toEqual(admissionsBefore);
			expect.soft(claimRows(storage)).toEqual(claimsBefore);
			const canonicalMissingScope = await captureOutcome(() =>
				coordinator.commit(
					{ ...context, grant_id: "other-grant", scopes: [] },
					prepared,
					authorized.ticket.id,
					idempotencyKey,
					() => {
						callbacks += 1;
						return receipt;
					},
				),
			);
			expect
				.soft(canonicalMissingScope)
				.toHaveProperty("value.failure.kind", "forbidden_scope");
			expect.soft(receiptRows(storage)).toEqual(canonicalReceipts);
			expect.soft(admissionRows(storage)).toEqual(admissionsBefore);
			expect.soft(claimRows(storage)).toEqual(claimsBefore);
			expect.soft(callbacks).toBe(0);

			storage.sql.exec(
				"UPDATE receipts SET body = '{' WHERE client_id = ? AND key = ?",
				context.client_id,
				idempotencyKey,
			);
			const corruptReceipts = receiptRows(storage);
			const corruptRevoked = await captureOutcome(() =>
				coordinator.commit(
					context,
					prepared,
					authorized.ticket.id,
					idempotencyKey,
					() => {
						callbacks += 1;
						return receipt;
					},
				),
			);
			expect
				.soft(corruptRevoked)
				.toHaveProperty("value.failure.kind", "revoked");
			expect.soft(receiptRows(storage)).toEqual(corruptReceipts);
			expect.soft(admissionRows(storage)).toEqual(admissionsBefore);
			expect.soft(claimRows(storage)).toEqual(claimsBefore);
			const corruptMissingScope = await captureOutcome(() =>
				coordinator.commit(
					{ ...context, grant_id: "other-grant", scopes: [] },
					prepared,
					authorized.ticket.id,
					idempotencyKey,
					() => {
						callbacks += 1;
						return receipt;
					},
				),
			);
			expect
				.soft(corruptMissingScope)
				.toHaveProperty("value.failure.kind", "forbidden_scope");
			expect.soft(receiptRows(storage)).toEqual(corruptReceipts);
			expect.soft(admissionRows(storage)).toEqual(admissionsBefore);
			expect.soft(claimRows(storage)).toEqual(claimsBefore);
			expect.soft(callbacks).toBe(0);
		});
	});

	it("does not settle a different operation when a retry ticket is unrelated", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const first = await activeOperation(admissions);
			const second = await admissions.authorize(context, {
				...intent,
				paths: ["other.md"],
			});
			expectTicket(first.authorized);
			expectTicket(second);
			seedClaim(
				storage,
				context.client_id,
				IdempotencyKeySchema.parse("other-key-0001"),
				second.ticket.id,
			);
			const beforeAdmissions = admissionRows(storage);
			const beforeClaims = claimRows(storage);
			let callbacks = 0;
			const outcome = await captureOutcome(() =>
				coordinator.commit(
					context,
					first.prepared,
					second.ticket.id,
					IdempotencyKeySchema.parse("other-key-0001"),
					() => {
						callbacks += 1;
						return receipt;
					},
				),
			);
			expect
				.soft(outcome)
				.toHaveProperty("value.failure.kind", "idempotency_mismatch");
			expect.soft(admissionRows(storage)).toHaveLength(2);
			expect.soft(claimRows(storage)).toHaveLength(1);
			expect.soft(callbacks).toBe(0);
			expect.soft(admissionRows(storage)).toEqual(beforeAdmissions);
			expect.soft(claimRows(storage)).toEqual(beforeClaims);
		});
	});

	it("rolls back publisher and receipt failures and typed publisher denial", async () => {
		await withMutationStore(async ({ storage, admissions, coordinator }) => {
			const { prepared, authorized } = await activeOperation(admissions);
			expectTicket(authorized);
			seedClaim(
				storage,
				context.client_id,
				idempotencyKey,
				authorized.ticket.id,
			);
			const before = {
				meta: storage.sql.exec("SELECT * FROM meta ORDER BY key").toArray(),
				files: storage.sql.exec("SELECT * FROM files ORDER BY path").toArray(),
				receipts: receiptRows(storage),
				admissions: admissionRows(storage),
				claims: claimRows(storage),
			};
			let publisherCallbacks = 0;
			const publisherError = new Error("publisher failed");
			const publisherFailure = await captureOutcome(() =>
				coordinator.commit(
					context,
					prepared,
					authorized.ticket.id,
					idempotencyKey,
					(tx) => {
						publisherCallbacks += 1;
						publishTestFile(tx, "claim.md");
						tx.run(
							sql.raw("UPDATE meta SET value = '1' WHERE key = 'head_seq'"),
						);
						throw publisherError;
					},
				),
			);
			expect
				.soft(
					"error" in publisherFailure &&
						publisherFailure.error === publisherError,
				)
				.toBe(true);
			expect.soft(publisherCallbacks).toBe(1);
			const afterPublisherFailure = {
				meta: storage.sql.exec("SELECT * FROM meta ORDER BY key").toArray(),
				files: storage.sql.exec("SELECT * FROM files ORDER BY path").toArray(),
				receipts: receiptRows(storage),
				admissions: admissionRows(storage),
				claims: claimRows(storage),
			};
			expect.soft(afterPublisherFailure).toEqual(before);

			const typedPublisherError = new FileOperationDenied({
				kind: "precondition_failed",
			});
			let typedDenialCallbacks = 0;
			const typedDenial = await captureOutcome(() =>
				coordinator.commit(
					context,
					prepared,
					authorized.ticket.id,
					idempotencyKey,
					(tx) => {
						typedDenialCallbacks += 1;
						publishTestFile(tx, "claim.md");
						tx.run(
							sql.raw("UPDATE meta SET value = '2' WHERE key = 'head_seq'"),
						);
						throw typedPublisherError;
					},
				),
			);
			expect
				.soft(
					"error" in typedDenial && typedDenial.error === typedPublisherError,
				)
				.toBe(true);
			expect
				.soft(
					"error" in typedDenial &&
						typedDenial.error instanceof FileOperationDenied,
				)
				.toBe(true);
			expect.soft(typedDenialCallbacks).toBe(1);
			expect
				.soft(storage.sql.exec("SELECT * FROM meta ORDER BY key").toArray())
				.toEqual(before.meta);
			expect
				.soft(storage.sql.exec("SELECT * FROM files ORDER BY path").toArray())
				.toEqual(before.files);
			expect.soft(receiptRows(storage)).toEqual(before.receipts);
			expect.soft(admissionRows(storage)).toEqual(before.admissions);
			expect.soft(claimRows(storage)).toEqual(before.claims);

			const receiptKey = IdempotencyKeySchema.parse("new-key-123456");
			const receiptIntent: OperationIntent = {
				...intent,
				paths: ["receipt-error.md"],
			};
			const receiptPrepared = await prepareOperation(context, receiptIntent);
			const receiptAuthorized = await admissions.authorize(
				context,
				receiptIntent,
			);
			expectTicket(receiptAuthorized);
			seedClaim(
				storage,
				context.client_id,
				receiptKey,
				receiptAuthorized.ticket.id,
			);
			const beforeReceiptFailure = {
				meta: storage.sql.exec("SELECT * FROM meta ORDER BY key").toArray(),
				files: storage.sql.exec("SELECT * FROM files ORDER BY path").toArray(),
				receipts: receiptRows(storage),
				admissions: admissionRows(storage),
				claims: claimRows(storage),
			};
			storage.sql.exec(
				"CREATE TRIGGER reject_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
			);
			let receiptCallbacks = 0;
			const receiptFailure = await captureOutcome(() =>
				coordinator.commit(
					context,
					receiptPrepared,
					receiptAuthorized.ticket.id,
					receiptKey,
					(tx) => {
						receiptCallbacks += 1;
						publishTestFile(tx, "receipt-error.md");
						tx.run(
							sql.raw("UPDATE meta SET value = '3' WHERE key = 'head_seq'"),
						);
						return {
							...receipt,
							body: { ...receipt.body, path: "receipt-error.md" },
						};
					},
				),
			);
			const receiptError =
				"error" in receiptFailure ? receiptFailure.error : undefined;
			const visitedErrors = new Set<Error>();
			let currentError: unknown = receiptError;
			let hasReceiptFailureMessage = false;
			while (
				currentError instanceof Error &&
				!visitedErrors.has(currentError)
			) {
				visitedErrors.add(currentError);
				if (currentError.message.includes("receipt failure")) {
					hasReceiptFailureMessage = true;
					break;
				}
				currentError = currentError.cause;
			}
			expect.soft(hasReceiptFailureMessage).toBe(true);
			expect.soft(receiptCallbacks).toBe(1);
			expect
				.soft(storage.sql.exec("SELECT * FROM meta ORDER BY key").toArray())
				.toEqual(beforeReceiptFailure.meta);
			expect
				.soft(storage.sql.exec("SELECT * FROM files ORDER BY path").toArray())
				.toEqual(beforeReceiptFailure.files);
			expect.soft(receiptRows(storage)).toEqual(beforeReceiptFailure.receipts);
			expect
				.soft(admissionRows(storage))
				.toEqual(beforeReceiptFailure.admissions);
			expect.soft(claimRows(storage)).toEqual(beforeReceiptFailure.claims);
		});
	});
});

/** Generate valid, distinct ticket identifiers for independent native admission rows. */
function nextTicketId(): string {
	const id =
		ticketSequence === 0
			? ticketId
			: ticketSequence.toString(16).padStart(32, "0");
	ticketSequence += 1;
	return id;
}
