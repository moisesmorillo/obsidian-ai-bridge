import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
	AdmissionCompletion,
	AdmissionResult,
	AuthorizationContext,
	OperationDescriptor,
	OperationIntent,
	RequestAdmissionResult,
} from "@obsidian-ai-bridge/protocol";
import {
	prepareDescriptor,
	prepareOperation,
} from "@worker/application/admission";
import { SqliteAdmissionAuthority } from "@worker/infrastructure/sqlite/admission";
import {
	initializeVaultStorage,
	SCHEMA_VERSION,
} from "@worker/infrastructure/sqlite/schema";
import {
	captureVaultState,
	clearTestVault,
	seedCanonicalV1,
} from "@worker/test-fixtures/admission";
import { describe, expect, it } from "vitest";

const epoch = "0123456789abcdef0123456789abcdef";
const authorized: AuthorizationContext = {
	client_id: "client",
	grant_id: "grant",
	scopes: ["vault:write"],
};
const writeDescriptor: OperationDescriptor = {
	op: "put",
	epoch,
	paths: ["note.md"],
	precondition: { kind: "absent" },
};
const writeIntent: OperationIntent = {
	...writeDescriptor,
	payload_hash:
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	size: 0,
};
const now = 10_000;

/** Create a test authority with controllable time and deterministic ticket-ID generation. */
function createAuthority(
	storage: DurableObjectStorage,
	clock: number | (() => number) = now,
	newTicketId: string | (() => string) = "0123456789abcdef0123456789abcdef",
) {
	return new SqliteAdmissionAuthority(storage, {
		now: typeof clock === "function" ? clock : () => clock,
		newTicketId:
			typeof newTicketId === "function" ? newTicketId : () => newTicketId,
	});
}

/** Dispatch one admission kind through its public authority method using live metadata. */
function runAuthorityOperation(
	authority: SqliteAdmissionAuthority,
	kind: "reserve" | "authorize",
	context: AuthorizationContext,
	storage: DurableObjectStorage,
): Promise<RequestAdmissionResult | AdmissionResult> {
	return kind === "reserve"
		? authority.reserve(context, liveWriteDescriptor(storage))
		: authority.authorize(context, liveWriteIntent(storage));
}

/** Rebuild the canonical test descriptor with the current stored vault epoch. */
function liveWriteDescriptor(
	storage: DurableObjectStorage,
): OperationDescriptor {
	return { ...writeDescriptor, epoch: currentEpoch(storage) };
}

/** Rebuild the canonical test intent with the current stored vault epoch. */
function liveWriteIntent(storage: DurableObjectStorage): OperationIntent {
	return { ...writeIntent, epoch: currentEpoch(storage) };
}

/** Read the stored epoch and use an empty sentinel when its metadata row is absent. */
function currentEpoch(storage: DurableObjectStorage): string {
	return (
		storage.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'epoch'")
			.toArray()[0]?.value ?? ""
	);
}

/** Seed one explicit ledger row for a lifecycle test without calling an authority transition. */
function seedAdmission(
	storage: DurableObjectStorage,
	row: {
		id: string;
		context: AuthorizationContext;
		epoch: string;
		fingerprint: string;
		admittedAt: number;
		expiresAt: number;
		state: "reserved" | "active" | "uncertain";
	},
): void {
	storage.sql.exec(
		"INSERT INTO operation_admissions(id, client_id, grant_id, epoch, fingerprint, admitted_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		row.id,
		row.context.client_id,
		row.context.grant_id,
		row.epoch,
		row.fingerprint,
		row.admittedAt,
		row.expiresAt,
		row.state,
	);
}

/** Capture an asynchronous value or its thrown error without changing either result. */
async function captureResult<T>(run: () => Promise<T>) {
	try {
		return { value: await run() } as const;
	} catch (error) {
		return { error } as const;
	}
}

/** Raw admission ledger projection used to assert persisted ownership and lifecycle state. */
type AdmissionTestRow = {
	id: string;
	client_id: string;
	grant_id: string;
	epoch: string;
	fingerprint: string;
	admitted_at: number;
	expires_at: number;
	state: string;
};

/** Read physical admission rows for lifecycle assertions. */
function admissionRows(storage: DurableObjectStorage): AdmissionTestRow[] {
	return storage.sql
		.exec<AdmissionTestRow>("SELECT * FROM operation_admissions")
		.toArray();
}

/** Snapshot file, revision, and feed rows to prove admission checks do not change content. */
function contentState(storage: DurableObjectStorage) {
	return {
		files: storage.sql.exec("SELECT * FROM files ORDER BY path").toArray(),
		revisions: storage.sql
			.exec("SELECT * FROM revisions ORDER BY path, rev")
			.toArray(),
		changes: storage.sql.exec("SELECT * FROM changes ORDER BY seq").toArray(),
	};
}

describe("Vault durable admission", () => {
	it("uses canonical schema version 6", () => {
		expect(SCHEMA_VERSION).toBe(6);
	});

	it("creates an admission table in native storage", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			const tables = state.storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table'",
				)
				.toArray()
				.map(({ name }) => name);
			expect(tables).toContain("operation_admissions");
		});
	});

	it("reserves a native lease before any body preparation", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		let liveEpoch = "";
		await runInDurableObject(stub, (_instance, state) => {
			liveEpoch = currentEpoch(state.storage);
		});
		const result = await stub.reserveAdmission(authorized, {
			...writeDescriptor,
			epoch: liveEpoch,
		});
		expect(result).toMatchObject({
			ok: true,
			lease: { expires_at: expect.any(Number) },
		});
		const rows = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		expect(rows).toHaveLength(1);
	});

	it("limits 17 reservations across two stubs and grants, but isolates another client", async () => {
		const id = env.VAULTS.newUniqueId();
		const firstStub = env.VAULTS.get(id);
		const secondStub = env.VAULTS.get(id);
		let liveEpoch = "";
		await runInDurableObject(firstStub, (_instance, state) => {
			liveEpoch = currentEpoch(state.storage);
		});
		const descriptor = { ...writeDescriptor, epoch: liveEpoch };
		const results = await Promise.all(
			Array.from({ length: 17 }, (_, index) =>
				(index % 2 === 0 ? firstStub : secondStub).reserveAdmission(
					{ ...authorized, grant_id: `grant-${index}` },
					descriptor,
				),
			),
		);
		const admitted = results.filter((result) => result.ok);
		const denied = results.filter((result) => !result.ok);
		const secondClientResults = await Promise.all(
			Array.from({ length: 17 }, () =>
				firstStub.reserveAdmission(
					{ ...authorized, client_id: "client-two" },
					descriptor,
				),
			),
		);
		const rows = await runInDurableObject(firstStub, (_instance, state) =>
			state.storage.sql
				.exec<{ client_id: string }>(
					"SELECT client_id FROM operation_admissions ORDER BY client_id",
				)
				.toArray(),
		);
		expect.soft(admitted).toHaveLength(16);
		expect.soft(denied).toHaveLength(1);
		expect.soft(denied[0]).toMatchObject({
			ok: false,
			failure: {
				kind: "admission_limited",
				retry_after_seconds: expect.any(Number),
			},
		});
		expect.soft(denied[0]).not.toHaveProperty("lease");
		if (!denied[0]?.ok && denied[0]?.failure.kind === "admission_limited")
			expect.soft(denied[0].failure.retry_after_seconds).toBeGreaterThan(0);
		expect
			.soft(rows.filter(({ client_id }) => client_id === "client"))
			.toHaveLength(16);
		expect
			.soft(secondClientResults.filter((result) => result.ok))
			.toHaveLength(16);
		expect
			.soft(secondClientResults.filter((result) => !result.ok))
			.toHaveLength(1);
		expect
			.soft(rows.filter(({ client_id }) => client_id === "client-two"))
			.toHaveLength(16);
	});

	it("rejects canonical-v1 storage without writes or identity factory calls", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, (_instance, state) => {
			clearTestVault(state.storage);
			seedCanonicalV1(state.storage);
			const before = captureVaultState(state.storage);
			expect(before.metadata).toContainEqual({
				key: "schema_version",
				value: "1",
			});
			expect(before.files).toHaveLength(1);
			let epochCalls = 0;
			let timeCalls = 0;
			expect(() =>
				initializeVaultStorage(
					state.storage,
					() => {
						epochCalls += 1;
						return epoch;
					},
					() => {
						timeCalls += 1;
						return 2;
					},
				),
			).toThrow();
			expect(epochCalls).toBe(0);
			expect(timeCalls).toBe(0);
			expect(captureVaultState(state.storage)).toEqual(before);
		});
	});

	it("denies a revoked grant before admission or content changes", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO revoked_grants(grant_id, at) VALUES ('grant', 1)",
			);
			const before = contentState(state.storage);
			const result = await createAuthority(state.storage).authorize(
				authorized,
				writeIntent,
			);
			expect(result).toEqual({ ok: false, failure: { kind: "revoked" } });
			expect(admissionRows(state.storage)).toHaveLength(0);
			expect(contentState(state.storage)).toEqual(before);
		});
	});

	it("denies missing scope before cleanup, admission, or content changes", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const expiredContext = { ...authorized, grant_id: "expired-grant" };
			const expiredDescriptor = await prepareDescriptor(
				expiredContext,
				liveWriteDescriptor(state.storage),
			);
			seedAdmission(state.storage, {
				id: "b".repeat(32),
				context: expiredContext,
				epoch: currentEpoch(state.storage),
				fingerprint: expiredDescriptor.descriptorFingerprint,
				admittedAt: now - 60_000,
				expiresAt: now - 1,
				state: "reserved",
			});
			const beforeRows = admissionRows(state.storage);
			const read: OperationDescriptor = {
				op: "read",
				paths: ["note.md"],
				precondition: { kind: "none" },
			};
			const before = contentState(state.storage);
			const result = await createAuthority(state.storage).reserve(
				authorized,
				read,
			);
			expect(result).toEqual({
				ok: false,
				failure: { kind: "forbidden_scope" },
			});
			expect(admissionRows(state.storage)).toEqual(beforeRows);
			expect(contentState(state.storage)).toEqual(before);
		});
	});

	it("denies a stale epoch before admission or content changes", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const stale = {
				...writeDescriptor,
				epoch: "fedcba9876543210fedcba9876543210",
			};
			const before = contentState(state.storage);
			const result = await createAuthority(state.storage).reserve(
				authorized,
				stale,
			);
			expect(result).toEqual({
				ok: false,
				failure: {
					kind: "epoch_mismatch",
					current_epoch: currentEpoch(state.storage),
				},
			});
			expect(admissionRows(state.storage)).toHaveLength(0);
			expect(contentState(state.storage)).toEqual(before);
		});
	});

	it("denies invalid paths before admission or content changes", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const invalid = { ...writeDescriptor, paths: ["../outside.md"] };
			const before = contentState(state.storage);
			const result = await createAuthority(state.storage).reserve(
				authorized,
				invalid,
			);
			expect(result).toEqual({
				ok: false,
				failure: { kind: "invalid_request" },
			});
			expect(admissionRows(state.storage)).toHaveLength(0);
			expect(contentState(state.storage)).toEqual(before);
		});
	});

	it("authorizes a complete intent without a reservation", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const intent = liveWriteIntent(state.storage);
			const before = contentState(state.storage);
			const result = await createAuthority(state.storage).authorize(
				authorized,
				intent,
			);
			const rows = admissionRows(state.storage);
			expect.soft(result).toMatchObject({
				ok: true,
				ticket: { id: expect.stringMatching(/^[0-9a-f]{32}$/) },
			});
			expect.soft(rows).toHaveLength(1);
			expect.soft(rows[0]).toMatchObject({ state: "active" });
			expect.soft(contentState(state.storage)).toEqual(before);
		});
	});

	it("binds a reservation without changing its identifier, deadline, or charged slot", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const descriptor = liveWriteDescriptor(state.storage);
			const intent = liveWriteIntent(state.storage);
			let clock = now;
			const authority = createAuthority(state.storage, () => clock);
			const lease = await authority.reserve(authorized, descriptor);
			const beforeContent = contentState(state.storage);
			if (!lease.ok) {
				expect.soft(lease.ok).toBe(true);
				return;
			}
			const reservation = admissionRows(state.storage)[0];
			expect.soft(reservation).toMatchObject({
				id: lease.lease.admission_id,
				state: "reserved",
				admitted_at: now,
				expires_at: lease.lease.expires_at,
			});
			clock += 5_000;
			const result = await authority.authorize(
				authorized,
				intent,
				lease.lease.admission_id,
			);
			const rows = admissionRows(state.storage);
			const prepared = await prepareOperation(authorized, intent);
			expect.soft(result).toEqual({
				ok: true,
				ticket: {
					id: lease.lease.admission_id,
					expires_at: lease.lease.expires_at,
				},
			});
			expect.soft(rows).toHaveLength(1);
			expect.soft(rows[0]).toMatchObject({
				id: lease.lease.admission_id,
				client_id: authorized.client_id,
				grant_id: authorized.grant_id,
				admitted_at: reservation?.admitted_at,
				expires_at: reservation?.expires_at,
				state: "active",
				fingerprint: prepared.fingerprint,
			});
			expect.soft(contentState(state.storage)).toEqual(beforeContent);
		});
	});

	it("binds a held reservation when all 16 client slots are charged", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const descriptor = liveWriteDescriptor(state.storage);
			const intent = liveWriteIntent(state.storage);
			let clock = now;
			let serial = 0;
			const authority = createAuthority(
				state.storage,
				() => clock,
				() => {
					serial += 1;
					return serial.toString(16).padStart(32, "0");
				},
			);
			const leases = await Promise.all(
				Array.from({ length: 16 }, () =>
					authority.reserve(authorized, descriptor),
				),
			);
			const before = admissionRows(state.storage);
			const held = leases[0];
			expect.soft(leases.filter((result) => result.ok)).toHaveLength(16);
			expect.soft(before).toHaveLength(16);
			if (!held?.ok) {
				expect.soft(held?.ok).toBe(true);
				return;
			}
			clock += 5_000;
			const result = await authority.authorize(
				authorized,
				intent,
				held.lease.admission_id,
			);
			const after = admissionRows(state.storage);
			expect.soft(result).toMatchObject({
				ok: true,
				ticket: {
					id: held.lease.admission_id,
					expires_at: held.lease.expires_at,
				},
			});
			expect.soft(after).toHaveLength(16);
			expect.soft(after).toContainEqual(
				expect.objectContaining({
					id: held.lease.admission_id,
					state: "active",
					expires_at: held.lease.expires_at,
				}),
			);
		});
	});

	it("rejects second binding without releasing the active slot", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const intent = liveWriteIntent(state.storage);
			const prepared = await prepareOperation(authorized, intent);
			const id = "a".repeat(32);
			state.storage.sql.exec(
				"INSERT INTO operation_admissions(id, client_id, grant_id, epoch, fingerprint, admitted_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')",
				id,
				authorized.client_id,
				authorized.grant_id,
				currentEpoch(state.storage),
				prepared.fingerprint,
				now,
				now + 60_000,
			);
			const before = admissionRows(state.storage);
			expect.soft(before).toHaveLength(1);
			expect.soft(before[0]).toMatchObject({
				id,
				state: "active",
				fingerprint: prepared.fingerprint,
			});
			const repeated = await createAuthority(state.storage).authorize(
				authorized,
				intent,
				id,
			);
			expect.soft(repeated).toEqual({
				ok: false,
				failure: { kind: "invalid_ticket" },
			});
			expect.soft(admissionRows(state.storage)).toEqual(before);
		});
	});

	it("rejects altered descriptors and foreign client or grant ownership", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const descriptor = liveWriteDescriptor(state.storage);
			const intent = liveWriteIntent(state.storage);
			const authority = createAuthority(state.storage);
			const lease = await authority.reserve(authorized, descriptor);
			if (!lease.ok) {
				expect.soft(lease.ok).toBe(true);
				return;
			}
			const before = admissionRows(state.storage);
			const altered = await authority.authorize(
				authorized,
				{ ...intent, paths: ["other.md"] },
				lease.lease.admission_id,
			);
			const foreignClient = await authority.authorize(
				{ ...authorized, client_id: "foreign-client" },
				intent,
				lease.lease.admission_id,
			);
			const foreignGrant = await authority.authorize(
				{ ...authorized, grant_id: "foreign-grant" },
				intent,
				lease.lease.admission_id,
			);
			expect.soft(altered).toEqual({
				ok: false,
				failure: { kind: "invalid_ticket" },
			});
			expect.soft(foreignClient).toEqual({
				ok: false,
				failure: { kind: "invalid_ticket" },
			});
			expect.soft(foreignGrant).toEqual({
				ok: false,
				failure: { kind: "invalid_ticket" },
			});
			expect.soft(admissionRows(state.storage)).toEqual(before);
		});
	});

	it("rejects expired and uncertain fixture reservations without changing ownership", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const intent = liveWriteIntent(state.storage);
			const descriptor = await prepareDescriptor(authorized, intent);
			const operation = await prepareOperation(authorized, intent);
			const expiredId = "0".repeat(32);
			const uncertainId = "1".repeat(32);
			state.storage.sql.exec(
				"INSERT INTO operation_admissions(id, client_id, grant_id, epoch, fingerprint, admitted_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)",
				expiredId,
				authorized.client_id,
				authorized.grant_id,
				currentEpoch(state.storage),
				descriptor.descriptorFingerprint,
				0,
				60_000,
				"reserved",
				uncertainId,
				authorized.client_id,
				authorized.grant_id,
				currentEpoch(state.storage),
				operation.fingerprint,
				0,
				60_001,
				"uncertain",
			);
			const before = admissionRows(state.storage);
			expect.soft(before).toHaveLength(2);
			expect.soft(before).toContainEqual(
				expect.objectContaining({
					id: expiredId,
					client_id: authorized.client_id,
					grant_id: authorized.grant_id,
					fingerprint: descriptor.descriptorFingerprint,
					expires_at: 60_000,
					state: "reserved",
				}),
			);
			expect.soft(before).toContainEqual(
				expect.objectContaining({
					id: uncertainId,
					client_id: authorized.client_id,
					grant_id: authorized.grant_id,
					fingerprint: operation.fingerprint,
					expires_at: 60_001,
					state: "uncertain",
				}),
			);
			const authority = createAuthority(state.storage, 60_000);
			const expired = await authority.authorize(authorized, intent, expiredId);
			const uncertain = await authority.authorize(
				authorized,
				intent,
				uncertainId,
			);
			expect.soft(expired).toEqual({
				ok: false,
				failure: { kind: "invalid_ticket" },
			});
			expect.soft(uncertain).toEqual({
				ok: false,
				failure: { kind: "invalid_ticket" },
			});
			expect.soft(admissionRows(state.storage)).toEqual(before);
		});
	});

	it("settles an owned ticket once and treats repeated completion as success", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		let ticketId = "";
		let deadline = 0;
		await runInDurableObject(stub, async (_instance, state) => {
			const intent = liveWriteIntent(state.storage);
			const prepared = await prepareOperation(authorized, intent);
			ticketId = "2".repeat(32);
			const admittedAt = Date.now();
			deadline = admittedAt + 60_000;
			seedAdmission(state.storage, {
				id: ticketId,
				context: authorized,
				epoch: currentEpoch(state.storage),
				fingerprint: prepared.fingerprint,
				admittedAt,
				expiresAt: deadline,
				state: "active",
			});
		});
		const beforeContent = await runInDurableObject(stub, (_instance, state) =>
			contentState(state.storage),
		);
		const completion: AdmissionCompletion = "settled";
		const first = await stub.finishAdmission(authorized, ticketId, completion);
		const firstRows = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		const repeated = await stub.finishAdmission(
			authorized,
			ticketId,
			completion,
		);
		const finalRows = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		expect.soft(first).toEqual({ ok: true });
		expect.soft(firstRows).toHaveLength(0);
		expect.soft(repeated).toEqual({ ok: true });
		expect.soft(finalRows).toHaveLength(0);
		expect
			.soft(
				await runInDurableObject(stub, (_instance, state) =>
					contentState(state.storage),
				),
			)
			.toEqual(beforeContent);
	});

	it("retains an uncertain reservation and its deadline, then rejects binding", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		let leaseId = "";
		let intent = writeIntent;
		let admittedAt = 0;
		let deadline = 0;
		let descriptorFingerprint = "";
		await runInDurableObject(stub, async (_instance, state) => {
			intent = liveWriteIntent(state.storage);
			const descriptor = await prepareDescriptor(authorized, intent);
			descriptorFingerprint = descriptor.descriptorFingerprint;
			leaseId = "3".repeat(32);
			admittedAt = Date.now();
			deadline = admittedAt + 60_000;
			seedAdmission(state.storage, {
				id: leaseId,
				context: authorized,
				epoch: currentEpoch(state.storage),
				fingerprint: descriptorFingerprint,
				admittedAt,
				expiresAt: deadline,
				state: "reserved",
			});
		});
		const before = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		expect.soft(before[0]).toMatchObject({
			id: leaseId,
			fingerprint: descriptorFingerprint,
			admitted_at: admittedAt,
			expires_at: deadline,
			state: "reserved",
		});
		expect.soft(deadline).toBeGreaterThan(Date.now());
		const uncertain = await stub.finishAdmission(
			authorized,
			leaseId,
			"uncertain",
		);
		const retained = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		const bind = await stub.authorize(authorized, intent, leaseId);
		expect.soft(uncertain).toEqual({ ok: true });
		expect.soft(retained).toHaveLength(1);
		expect.soft(retained[0]).toMatchObject({
			id: leaseId,
			client_id: authorized.client_id,
			grant_id: authorized.grant_id,
			fingerprint: descriptorFingerprint,
			admitted_at: admittedAt,
			expires_at: deadline,
			state: "uncertain",
		});
		expect.soft(bind).toEqual({
			ok: false,
			failure: { kind: "invalid_ticket" },
		});
		expect
			.soft(
				await runInDurableObject(stub, (_instance, state) =>
					admissionRows(state.storage),
				),
			)
			.toEqual(retained);
	});

	it("refuses foreign-client and foreign-grant completion without changing rows", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const firstId = "4".repeat(32);
		const secondId = "5".repeat(32);
		const otherGrant = { ...authorized, grant_id: "grant-two" };
		await runInDurableObject(stub, async (_instance, state) => {
			const firstIntent = liveWriteIntent(state.storage);
			const firstOperation = await prepareOperation(authorized, firstIntent);
			const secondOperation = await prepareOperation(otherGrant, firstIntent);
			const admittedAt = Date.now();
			const deadline = admittedAt + 60_000;
			seedAdmission(state.storage, {
				id: firstId,
				context: authorized,
				epoch: currentEpoch(state.storage),
				fingerprint: firstOperation.fingerprint,
				admittedAt,
				expiresAt: deadline,
				state: "active",
			});
			seedAdmission(state.storage, {
				id: secondId,
				context: otherGrant,
				epoch: currentEpoch(state.storage),
				fingerprint: secondOperation.fingerprint,
				admittedAt,
				expiresAt: deadline,
				state: "active",
			});
		});
		const before = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		const foreignClient = await stub.finishAdmission(
			{ ...authorized, client_id: "foreign-client" },
			firstId,
			"settled",
		);
		const foreignGrant = await stub.finishAdmission(
			{ ...authorized, grant_id: "foreign-grant" },
			secondId,
			"settled",
		);
		const after = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		expect.soft(foreignClient).toEqual({
			ok: false,
			failure: { kind: "invalid_ticket" },
		});
		expect.soft(foreignGrant).toEqual({
			ok: false,
			failure: { kind: "invalid_ticket" },
		});
		expect.soft(after).toEqual(before);
	});

	it("preserves uncertain admission state across Durable Object eviction", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const ticketId = "6".repeat(32);
		let deadline = 0;
		await runInDurableObject(stub, async (_instance, state) => {
			const intent = liveWriteIntent(state.storage);
			const operation = await prepareOperation(authorized, intent);
			const admittedAt = Date.now();
			deadline = admittedAt + 60_000;
			seedAdmission(state.storage, {
				id: ticketId,
				context: authorized,
				epoch: currentEpoch(state.storage),
				fingerprint: operation.fingerprint,
				admittedAt,
				expiresAt: deadline,
				state: "uncertain",
			});
		});
		await evictDurableObject(stub);
		const afterEviction = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		const result = await stub.finishAdmission(authorized, ticketId, "settled");
		const afterFinish = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		expect.soft(afterEviction).toHaveLength(1);
		expect.soft(afterEviction[0]).toMatchObject({
			id: ticketId,
			state: "uncertain",
			expires_at: deadline,
		});
		expect.soft(result).toEqual({ ok: true });
		expect.soft(afterFinish).toHaveLength(0);
	});

	it("checks revocation before invalid vault metadata during completion", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const ticketId = "9".repeat(32);
		await runInDurableObject(stub, async (_instance, state) => {
			const intent = liveWriteIntent(state.storage);
			const operation = await prepareOperation(authorized, intent);
			const admittedAt = Date.now();
			seedAdmission(state.storage, {
				id: ticketId,
				context: authorized,
				epoch: currentEpoch(state.storage),
				fingerprint: operation.fingerprint,
				admittedAt,
				expiresAt: admittedAt + 60_000,
				state: "active",
			});
			state.storage.sql.exec(
				"INSERT INTO revoked_grants(grant_id, at) VALUES ('grant', ?)",
				admittedAt,
			);
			state.storage.sql.exec(
				"UPDATE meta SET value = 'invalid' WHERE key = 'epoch'",
			);
		});
		const before = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		const result = await stub.finishAdmission(authorized, ticketId, "settled");
		const after = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		expect.soft(result).toEqual({
			ok: false,
			failure: { kind: "revoked" },
		});
		expect.soft(after).toEqual(before);
	});

	it("treats repeated uncertain completion as idempotent", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const ticketId = "a".repeat(32);
		await runInDurableObject(stub, async (_instance, state) => {
			const intent = liveWriteIntent(state.storage);
			const operation = await prepareOperation(authorized, intent);
			const admittedAt = Date.now();
			seedAdmission(state.storage, {
				id: ticketId,
				context: authorized,
				epoch: currentEpoch(state.storage),
				fingerprint: operation.fingerprint,
				admittedAt,
				expiresAt: admittedAt + 60_000,
				state: "uncertain",
			});
		});
		const before = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		const first = await stub.finishAdmission(authorized, ticketId, "uncertain");
		const second = await stub.finishAdmission(
			authorized,
			ticketId,
			"uncertain",
		);
		const after = await runInDurableObject(stub, (_instance, state) =>
			admissionRows(state.storage),
		);
		expect.soft(first).toEqual({ ok: true });
		expect.soft(second).toEqual({ ok: true });
		expect.soft(after).toEqual(before);
	});

	it("accepts binding at 59,999 ms and rejects it at 60,000 ms", async () => {
		const acceptedStub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const expiredStub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const acceptedId = "7".repeat(32);
		const expiredId = "8".repeat(32);
		for (const [stub, id, expiresAt] of [
			[acceptedStub, acceptedId, 61_000],
			[expiredStub, expiredId, 61_000],
		] as const) {
			await runInDurableObject(stub, async (_instance, state) => {
				const intent = liveWriteIntent(state.storage);
				const descriptor = await prepareDescriptor(authorized, intent);
				seedAdmission(state.storage, {
					id,
					context: authorized,
					epoch: currentEpoch(state.storage),
					fingerprint: descriptor.descriptorFingerprint,
					admittedAt: 1_000,
					expiresAt,
					state: "reserved",
				});
			});
		}
		const accepted = await runInDurableObject(
			acceptedStub,
			async (_instance, state) =>
				createAuthority(state.storage, 60_999).authorize(
					authorized,
					liveWriteIntent(state.storage),
					acceptedId,
				),
		);
		const expired = await runInDurableObject(
			expiredStub,
			async (_instance, state) =>
				createAuthority(state.storage, 61_000).authorize(
					authorized,
					liveWriteIntent(state.storage),
					expiredId,
				),
		);
		expect.soft(accepted).toMatchObject({ ok: true });
		expect.soft(expired).toEqual({
			ok: false,
			failure: { kind: "invalid_ticket" },
		});
	});

	it("shares reserved, active, and uncertain capacity across grants and authorities", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const intent = liveWriteIntent(state.storage);
			const descriptor = await prepareDescriptor(authorized, intent);
			const operation = await prepareOperation(authorized, intent);
			for (let index = 0; index < 16; index += 1) {
				const context = { ...authorized, grant_id: `grant-${index}` };
				const stateName =
					index < 6 ? "reserved" : index < 11 ? "active" : "uncertain";
				const fingerprint =
					stateName === "reserved"
						? descriptor.descriptorFingerprint
						: operation.fingerprint;
				seedAdmission(state.storage, {
					id: index.toString(16).padStart(32, "0"),
					context,
					epoch: currentEpoch(state.storage),
					fingerprint,
					admittedAt: now,
					expiresAt: now + 60_000,
					state: stateName,
				});
			}
			const before = admissionRows(state.storage);
			const reserveResult = await createAuthority(state.storage).reserve(
				{ ...authorized, grant_id: "new-reserve-grant" },
				liveWriteDescriptor(state.storage),
			);
			const authorizeResult = await createAuthority(state.storage).authorize(
				{ ...authorized, grant_id: "new-authorize-grant" },
				intent,
			);
			expect.soft(reserveResult).toEqual({
				ok: false,
				failure: {
					kind: "admission_limited",
					retry_after_seconds: expect.any(Number),
				},
			});
			expect.soft(authorizeResult).toEqual({
				ok: false,
				failure: {
					kind: "admission_limited",
					retry_after_seconds: expect.any(Number),
				},
			});
			expect.soft(admissionRows(state.storage)).toEqual(before);
		});
	});

	it.each(["reserve", "authorize"] as const)(
		"cleans the caller's expired rows and no more than 64 global expired rows through %s",
		async (operationKind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const cleanupTime = 30_000;
			await runInDurableObject(stub, async (_instance, state) => {
				const liveContext = { ...authorized, client_id: "client" };
				const ownExpired = ["a".repeat(32), "b".repeat(32)];
				const ownDescriptor = await prepareDescriptor(
					liveContext,
					liveWriteDescriptor(state.storage),
				);
				const ownOperation = await prepareOperation(
					liveContext,
					liveWriteIntent(state.storage),
				);
				for (const [index, id] of ownExpired.entries())
					seedAdmission(state.storage, {
						id,
						context: liveContext,
						epoch: currentEpoch(state.storage),
						fingerprint:
							index === 0
								? ownDescriptor.descriptorFingerprint
								: ownOperation.fingerprint,
						admittedAt: cleanupTime - 60_000,
						expiresAt: index === 0 ? cleanupTime - 1 : cleanupTime,
						state: index === 0 ? "reserved" : "uncertain",
					});
				const globalExpired = Array.from({ length: 70 }, (_, index) =>
					(index + 1).toString(16).padStart(32, "0"),
				);
				for (const [index, id] of globalExpired.entries()) {
					const context = {
						...authorized,
						client_id: `other-${index}`,
						grant_id: `other-grant-${index}`,
					};
					const descriptor = await prepareDescriptor(
						context,
						liveWriteDescriptor(state.storage),
					);
					const operation = await prepareOperation(
						context,
						liveWriteIntent(state.storage),
					);
					const stateName =
						index % 3 === 0
							? "reserved"
							: index % 3 === 1
								? "active"
								: "uncertain";
					seedAdmission(state.storage, {
						id,
						context,
						epoch: currentEpoch(state.storage),
						fingerprint:
							stateName === "reserved"
								? descriptor.descriptorFingerprint
								: operation.fingerprint,
						admittedAt: cleanupTime - 60_000,
						expiresAt: index % 2 === 0 ? cleanupTime - 1 : cleanupTime,
						state: stateName,
					});
				}
				const liveIds = Array.from({ length: 6 }, (_, index) =>
					(100 + index).toString(16).padStart(32, "0"),
				);
				for (const [index, id] of liveIds.entries()) {
					const context = {
						...authorized,
						client_id: `live-client-${index}`,
					};
					const descriptor = await prepareDescriptor(
						context,
						liveWriteDescriptor(state.storage),
					);
					const operation = await prepareOperation(
						context,
						liveWriteIntent(state.storage),
					);
					const stateName =
						index % 3 === 0
							? "reserved"
							: index % 3 === 1
								? "active"
								: "uncertain";
					seedAdmission(state.storage, {
						id,
						context,
						epoch: currentEpoch(state.storage),
						fingerprint:
							stateName === "reserved"
								? descriptor.descriptorFingerprint
								: operation.fingerprint,
						admittedAt: cleanupTime - 1,
						expiresAt: cleanupTime + 1,
						state: stateName,
					});
				}
				const beforeContent = contentState(state.storage);
				const beforeRows = admissionRows(state.storage);
				const liveRowsBefore = beforeRows.filter(({ id }) =>
					liveIds.includes(id),
				);
				const result = await runAuthorityOperation(
					createAuthority(state.storage, cleanupTime, "f".repeat(32)),
					operationKind,
					liveContext,
					state.storage,
				);
				const afterRows = admissionRows(state.storage);
				const remainingGlobal = afterRows.filter(({ id }) =>
					globalExpired.includes(id),
				);
				expect.soft(beforeRows).toHaveLength(78);
				expect.soft(result).toMatchObject({ ok: true });
				expect
					.soft(afterRows.filter(({ id }) => ownExpired.includes(id)))
					.toHaveLength(0);
				expect.soft(remainingGlobal).toHaveLength(6);
				expect
					.soft(
						globalExpired.filter((id) =>
							remainingGlobal.some((row) => row.id === id),
						),
					)
					.toHaveLength(6);
				expect
					.soft(afterRows.filter(({ id }) => liveIds.includes(id)))
					.toEqual(expect.arrayContaining(liveRowsBefore));
				expect.soft(afterRows).toHaveLength(13);
				expect.soft(contentState(state.storage)).toEqual(beforeContent);
			});
		},
	);

	it.each(["reserve", "authorize"] as const)(
		"recovers a client's expired slots through %s at the expiry boundary",
		async (operationKind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const cleanupTime = 30_000;
			await runInDurableObject(stub, async (_instance, state) => {
				for (let index = 0; index < 16; index += 1) {
					const context = { ...authorized, grant_id: `expired-${index}` };
					const descriptor = await prepareDescriptor(
						context,
						liveWriteDescriptor(state.storage),
					);
					const operation = await prepareOperation(
						context,
						liveWriteIntent(state.storage),
					);
					const stateName =
						index % 3 === 0
							? "reserved"
							: index % 3 === 1
								? "active"
								: "uncertain";
					seedAdmission(state.storage, {
						id: (index + 200).toString(16).padStart(32, "0"),
						context,
						epoch: currentEpoch(state.storage),
						fingerprint:
							stateName === "reserved"
								? descriptor.descriptorFingerprint
								: operation.fingerprint,
						admittedAt: cleanupTime - 60_000,
						expiresAt: cleanupTime,
						state: stateName,
					});
				}
				const beforeContent = contentState(state.storage);
				const beforeRows = admissionRows(state.storage);
				const authority = createAuthority(
					state.storage,
					cleanupTime,
					"c".repeat(32),
				);
				const result = await runAuthorityOperation(
					authority,
					operationKind,
					authorized,
					state.storage,
				);
				expect.soft(beforeRows).toHaveLength(16);
				expect.soft(result).toMatchObject({ ok: true });
				expect.soft(admissionRows(state.storage)).toHaveLength(1);
				expect.soft(contentState(state.storage)).toEqual(beforeContent);
			});
		},
	);

	it.each(["reserve", "authorize"] as const)(
		"rolls back client cleanup when %s insertion fails",
		async (operationKind) => {
			const successStub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const failureStub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const cleanupTime = 30_000;
			for (const stub of [successStub, failureStub])
				await runInDurableObject(stub, async (_instance, state) => {
					const descriptor = await prepareDescriptor(
						authorized,
						liveWriteDescriptor(state.storage),
					);
					const globalContext = {
						...authorized,
						client_id: "global-expired-client",
					};
					const globalOperation = await prepareOperation(
						globalContext,
						liveWriteIntent(state.storage),
					);
					seedAdmission(state.storage, {
						id: "d".repeat(32),
						context: authorized,
						epoch: currentEpoch(state.storage),
						fingerprint: descriptor.descriptorFingerprint,
						admittedAt: cleanupTime - 60_000,
						expiresAt: cleanupTime,
						state: "reserved",
					});
					seedAdmission(state.storage, {
						id: "c".repeat(32),
						context: globalContext,
						epoch: currentEpoch(state.storage),
						fingerprint: globalOperation.fingerprint,
						admittedAt: cleanupTime - 60_000,
						expiresAt: cleanupTime,
						state: "uncertain",
					});
				});
			const success = await runInDurableObject(
				successStub,
				async (_instance, state) => {
					const beforeRows = admissionRows(state.storage);
					const beforeContent = contentState(state.storage);
					const result = await runAuthorityOperation(
						createAuthority(state.storage, cleanupTime, "e".repeat(32)),
						operationKind,
						authorized,
						state.storage,
					);
					return {
						result,
						beforeRows,
						rows: admissionRows(state.storage),
						content: contentState(state.storage),
						beforeContent,
					};
				},
			);
			expect.soft(success.result).toMatchObject({ ok: true });
			expect.soft(success.beforeRows).toHaveLength(2);
			expect.soft(success.rows).toHaveLength(1);
			expect
				.soft(success.rows.map(({ id }) => id))
				.not.toContain("c".repeat(32));
			expect
				.soft(success.rows.map(({ id }) => id))
				.not.toContain("d".repeat(32));
			expect.soft(success.content).toEqual(success.beforeContent);
			await runInDurableObject(failureStub, async (_instance, state) => {
				state.storage.sql.exec(
					"CREATE TRIGGER cleanup_insert_failure BEFORE INSERT ON operation_admissions BEGIN SELECT RAISE(ABORT, 'injected cleanup insertion failure'); END",
				);
				try {
					const beforeRows = admissionRows(state.storage);
					const beforeContent = contentState(state.storage);
					expect
						.soft(beforeRows.map(({ id }) => id))
						.toEqual(expect.arrayContaining(["c".repeat(32), "d".repeat(32)]));
					const outcome = await captureResult(() =>
						runAuthorityOperation(
							createAuthority(state.storage, cleanupTime, "e".repeat(32)),
							operationKind,
							authorized,
							state.storage,
						),
					);
					expect.soft(outcome).toHaveProperty("error");
					if ("error" in outcome)
						expect
							.soft(String(outcome.error))
							.toContain("injected cleanup insertion failure");
					expect.soft(admissionRows(state.storage)).toEqual(beforeRows);
					expect.soft(contentState(state.storage)).toEqual(beforeContent);
				} finally {
					state.storage.sql.exec("DROP TRIGGER cleanup_insert_failure");
				}
			});
		},
	);

	it.each(["reserve", "authorize"] as const)(
		"rolls back caller and global cleanup when entropy fails for %s",
		async (operationKind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const cleanupTime = 30_000;
			await runInDurableObject(stub, async (_instance, state) => {
				const globalContext = {
					...authorized,
					client_id: "global-expired-client",
				};
				const descriptor = await prepareDescriptor(
					authorized,
					liveWriteDescriptor(state.storage),
				);
				const operation = await prepareOperation(
					globalContext,
					liveWriteIntent(state.storage),
				);
				seedAdmission(state.storage, {
					id: "a".repeat(32),
					context: authorized,
					epoch: currentEpoch(state.storage),
					fingerprint: descriptor.descriptorFingerprint,
					admittedAt: cleanupTime - 60_000,
					expiresAt: cleanupTime,
					state: "reserved",
				});
				seedAdmission(state.storage, {
					id: "b".repeat(32),
					context: globalContext,
					epoch: currentEpoch(state.storage),
					fingerprint: operation.fingerprint,
					admittedAt: cleanupTime - 60_000,
					expiresAt: cleanupTime,
					state: "active",
				});
				const beforeRows = admissionRows(state.storage);
				const beforeContent = contentState(state.storage);
				expect
					.soft(beforeRows.map(({ id }) => id))
					.toEqual(expect.arrayContaining(["a".repeat(32), "b".repeat(32)]));
				const authority = new SqliteAdmissionAuthority(state.storage, {
					now: () => cleanupTime,
					newTicketId: () => {
						throw new Error("injected cleanup entropy failure");
					},
				});
				const outcome = await captureResult(() =>
					runAuthorityOperation(
						authority,
						operationKind,
						authorized,
						state.storage,
					),
				);
				expect.soft(beforeRows).toHaveLength(2);
				expect.soft(outcome).toHaveProperty("error");
				expect.soft("value" in outcome).toBe(false);
				if ("error" in outcome)
					expect
						.soft(String(outcome.error))
						.toBe("Error: injected cleanup entropy failure");
				expect.soft(admissionRows(state.storage)).toEqual(beforeRows);
				expect.soft(contentState(state.storage)).toEqual(beforeContent);
			});
		},
	);

	it.each(["reserve", "authorize"] as const)(
		"denies revoked, out-of-scope, and stale-epoch operations before cleanup and ports for %s",
		async (operationKind) => {
			for (const policy of ["revoked", "scope", "epoch"] as const) {
				const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
				await runInDurableObject(stub, async (_instance, state) => {
					const cleanupTime = 30_000;
					const current = currentEpoch(state.storage);
					let context = authorized;
					let descriptor = liveWriteDescriptor(state.storage);
					let intent = liveWriteIntent(state.storage);
					if (policy === "scope") {
						const readDescriptor: OperationDescriptor = {
							op: "read",
							paths: ["note.md"],
							precondition: { kind: "none" },
						};
						context = { ...authorized, scopes: ["vault:write"] };
						descriptor = readDescriptor;
						intent = {
							...readDescriptor,
							payload_hash:
								"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
							size: 0,
						};
					} else if (policy === "epoch") {
						descriptor = {
							...descriptor,
							epoch: "fedcba9876543210fedcba9876543210",
						};
						intent = { ...intent, epoch: descriptor.epoch };
					} else {
						state.storage.sql.exec(
							"INSERT INTO revoked_grants(grant_id, at) VALUES (?, ?)",
							context.grant_id,
							cleanupTime,
						);
					}
					const expiredContext = {
						...context,
						grant_id: "expired-client-grant",
					};
					const expiredDescriptor = await prepareDescriptor(
						expiredContext,
						liveWriteDescriptor(state.storage),
					);
					const globalContext = {
						...context,
						client_id: "expired-global-client",
						grant_id: "expired-global-grant",
					};
					const globalOperation = await prepareOperation(
						globalContext,
						liveWriteIntent(state.storage),
					);
					seedAdmission(state.storage, {
						id: "a".repeat(32),
						context: expiredContext,
						epoch: current,
						fingerprint: expiredDescriptor.descriptorFingerprint,
						admittedAt: cleanupTime - 60_000,
						expiresAt: cleanupTime - 1,
						state: "reserved",
					});
					seedAdmission(state.storage, {
						id: "b".repeat(32),
						context: globalContext,
						epoch: current,
						fingerprint: globalOperation.fingerprint,
						admittedAt: cleanupTime - 60_000,
						expiresAt: cleanupTime,
						state: "uncertain",
					});
					let clockCalls = 0;
					let idCalls = 0;
					const beforeRows = admissionRows(state.storage);
					const beforeContent = contentState(state.storage);
					const authority = new SqliteAdmissionAuthority(state.storage, {
						now: () => {
							clockCalls += 1;
							return cleanupTime;
						},
						newTicketId: () => {
							idCalls += 1;
							return "f".repeat(32);
						},
					});
					const result =
						operationKind === "reserve"
							? await authority.reserve(context, descriptor)
							: await authority.authorize(context, intent);
					const expectedFailure =
						policy === "revoked"
							? { kind: "revoked" }
							: policy === "scope"
								? { kind: "forbidden_scope" }
								: { kind: "epoch_mismatch", current_epoch: current };
					expect.soft(result).toEqual({ ok: false, failure: expectedFailure });
					expect.soft(clockCalls).toBe(0);
					expect.soft(idCalls).toBe(0);
					expect.soft(admissionRows(state.storage)).toEqual(beforeRows);
					expect.soft(contentState(state.storage)).toEqual(beforeContent);
				});
			}
		},
	);

	it.each(["reserve", "authorize"] as const)(
		"retries seven existing identifiers and succeeds on candidate eight for %s",
		async (operationKind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, async (_instance, state) => {
				const owner = { ...authorized, client_id: "existing-client" };
				const fixtureOperation = await prepareOperation(
					owner,
					liveWriteIntent(state.storage),
				);
				const collisions = Array.from({ length: 7 }, (_, index) =>
					(index + 1).toString(16).padStart(32, "0"),
				);
				for (const id of collisions)
					seedAdmission(state.storage, {
						id,
						context: owner,
						epoch: currentEpoch(state.storage),
						fingerprint: fixtureOperation.fingerprint,
						admittedAt: now,
						expiresAt: now + 60_000,
						state: "active",
					});
				const before = admissionRows(state.storage);
				let calls = 0;
				const finalId = "8".repeat(32);
				const authority = createAuthority(state.storage, now, () => {
					calls += 1;
					return collisions[calls - 1] ?? finalId;
				});
				const outcome = await captureResult(() =>
					runAuthorityOperation(
						authority,
						operationKind,
						authorized,
						state.storage,
					),
				);
				const rows = admissionRows(state.storage);
				expect.soft(calls).toBe(8);
				if (operationKind === "reserve")
					expect.soft(outcome).toMatchObject({
						value: {
							ok: true,
							lease: { admission_id: finalId },
						},
					});
				else
					expect.soft(outcome).toMatchObject({
						value: { ok: true, ticket: { id: finalId } },
					});
				expect.soft(rows).toHaveLength(8);
				expect.soft(rows).toEqual(expect.arrayContaining(before));
				expect.soft(rows.map(({ id }) => id)).toContain(finalId);
			});
		},
	);

	it.each(["reserve", "authorize"] as const)(
		"stops after eight collisions for %s without changing existing rows",
		async (operationKind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, async (_instance, state) => {
				const owner = { ...authorized, client_id: "existing-client" };
				const fixtureOperation = await prepareOperation(
					owner,
					liveWriteIntent(state.storage),
				);
				const collisions = Array.from({ length: 8 }, (_, index) =>
					(index + 1).toString(16).padStart(32, "0"),
				);
				for (const id of collisions)
					seedAdmission(state.storage, {
						id,
						context: owner,
						epoch: currentEpoch(state.storage),
						fingerprint: fixtureOperation.fingerprint,
						admittedAt: now,
						expiresAt: now + 60_000,
						state: "active",
					});
				const before = admissionRows(state.storage);
				let calls = 0;
				const authority = createAuthority(state.storage, now, () => {
					calls += 1;
					return collisions[calls - 1] ?? "9".repeat(32);
				});
				const outcome = await captureResult(() =>
					runAuthorityOperation(
						authority,
						operationKind,
						authorized,
						state.storage,
					),
				);
				expect.soft(calls).toBe(8);
				expect.soft(outcome).toEqual({
					value: {
						ok: false,
						failure: { kind: "invalid_request" },
					},
				});
				expect.soft(admissionRows(state.storage)).toEqual(before);
			});
		},
	);

	it.each(["reserve", "authorize"] as const)(
		"rejects a malformed generated identifier before insertion for %s",
		async (operationKind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, async (_instance, state) => {
				let calls = 0;
				const authority = createAuthority(state.storage, now, () => {
					calls += 1;
					return "not-a-ticket-id";
				});
				const before = admissionRows(state.storage);
				const outcome = await captureResult(() =>
					runAuthorityOperation(
						authority,
						operationKind,
						authorized,
						state.storage,
					),
				);
				expect.soft(calls).toBe(1);
				expect.soft(outcome).toEqual({
					value: {
						ok: false,
						failure: { kind: "invalid_request" },
					},
				});
				expect.soft(admissionRows(state.storage)).toEqual(before);
			});
		},
	);

	it.each(["reserve", "authorize"] as const)(
		"rejects unsafe clocks and deadline overflow before identifier generation for %s",
		async (operationKind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, async (_instance, state) => {
				for (const clock of [Number.NaN, Number.MAX_SAFE_INTEGER]) {
					let idCalls = 0;
					const authority = createAuthority(state.storage, clock, () => {
						idCalls += 1;
						return "a".repeat(32);
					});
					const before = admissionRows(state.storage);
					const outcome = await captureResult(() =>
						runAuthorityOperation(
							authority,
							operationKind,
							authorized,
							state.storage,
						),
					);
					expect.soft(idCalls).toBe(0);
					expect.soft(outcome).toEqual({
						value: {
							ok: false,
							failure: { kind: "invalid_request" },
						},
					});
					expect.soft(admissionRows(state.storage)).toEqual(before);
				}
			});
		},
	);

	it.each(["reserve", "authorize"] as const)(
		"propagates clock and entropy exceptions without a slot for %s",
		async (operationKind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, async (_instance, state) => {
				const before = admissionRows(state.storage);
				const clockAuthority = new SqliteAdmissionAuthority(state.storage, {
					now: () => {
						throw new Error("injected clock failure");
					},
					newTicketId: () => "a".repeat(32),
				});
				const clockOutcome = await captureResult(() =>
					runAuthorityOperation(
						clockAuthority,
						operationKind,
						authorized,
						state.storage,
					),
				);
				const idAuthority = new SqliteAdmissionAuthority(state.storage, {
					now: () => now,
					newTicketId: () => {
						throw new Error("injected entropy failure");
					},
				});
				const idOutcome = await captureResult(() =>
					runAuthorityOperation(
						idAuthority,
						operationKind,
						authorized,
						state.storage,
					),
				);
				expect.soft(clockOutcome).toMatchObject({
					error: new Error("injected clock failure"),
				});
				expect.soft(idOutcome).toMatchObject({
					error: new Error("injected entropy failure"),
				});
				expect.soft(admissionRows(state.storage)).toEqual(before);
			});
		},
	);

	it.each(["reserve", "authorize"] as const)(
		"propagates native insert failures without creating admission rows for %s",
		async (operationKind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			await runInDurableObject(stub, async (_instance, state) => {
				state.storage.sql.exec(
					"CREATE TRIGGER admission_insert_failure BEFORE INSERT ON operation_admissions BEGIN SELECT RAISE(ABORT, 'injected admission insert failure'); END",
				);
				try {
					const beforeRows = admissionRows(state.storage);
					const beforeContent = contentState(state.storage);
					const authority = createAuthority(state.storage);
					const outcome = await captureResult(() =>
						runAuthorityOperation(
							authority,
							operationKind,
							authorized,
							state.storage,
						),
					);
					expect.soft(outcome).toHaveProperty("error");
					if ("error" in outcome)
						expect
							.soft(String(outcome.error))
							.toContain("injected admission insert failure");
					expect.soft(admissionRows(state.storage)).toEqual(beforeRows);
					expect.soft(contentState(state.storage)).toEqual(beforeContent);
				} finally {
					state.storage.sql.exec("DROP TRIGGER admission_insert_failure");
				}
			});
		},
	);

	it("denies oversized declarations before admission or content changes", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const oversized = { ...writeIntent, size: 25_000_001 };
			const before = contentState(state.storage);
			const result = await createAuthority(state.storage).authorize(
				authorized,
				oversized,
			);
			expect(result).toEqual({
				ok: false,
				failure: { kind: "blob_too_large" },
			});
			expect(admissionRows(state.storage)).toHaveLength(0);
			expect(contentState(state.storage)).toEqual(before);
		});
	});
});
