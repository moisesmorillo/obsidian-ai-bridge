import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
	AdmissionResult,
	AuthorizationContext,
	OperationDescriptor,
	OperationIntent,
	RequestAdmissionResult,
	TextMutationBeginResult,
} from "@obsidian-ai-bridge/protocol";
import {
	prepareDescriptor,
	prepareOperation,
} from "@worker/application/admission";
import { SqliteAdmissionAuthority } from "@worker/infrastructure/sqlite/admission";
import { describe, expect, it } from "vitest";

const emptyPayloadHash =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const states = ["reserved", "active", "uncertain"] as const;
const operationKinds = ["reserve", "authorize"] as const;
const vaultOperationKinds = ["beginMutation", "authorize"] as const;
/** Admission insertion path exercised by reservation and full authorization tests. */
type OperationKind = (typeof operationKinds)[number];
/** Persisted lifecycle states seeded and checked by native tests. */
type AdmissionTestState = (typeof states)[number];
/** Result union returned by either request reservation or operation authorization. */
type AdmissionResultForKind =
	| RequestAdmissionResult
	| AdmissionResult
	| TextMutationBeginResult;

/** Raw SQL projection of the persisted admission ledger, including expired rows. */
type AdmissionTestRow = {
	id: string;
	client_id: string;
	grant_id: string;
	epoch: string;
	fingerprint: string;
	admitted_at: number;
	expires_at: number;
	state: AdmissionTestState;
};

/** Camel-case seed record used to create and later identify one native ledger row. */
type SeedRow = {
	id: string;
	clientId: string;
	grantId: string;
	epoch: string;
	fingerprint: string;
	admittedAt: number;
	expiresAt: number;
	state: AdmissionTestState;
};

/** Configure physical row groups, identities, and optional batch sampling after commit. Counts partition fixture rows. Timestamps use Unix milliseconds. */
type SeedOptions = {
	liveCount: number;
	expiredCount: number;
	now: number;
	idOffset?: number;
	clientIdForRow?: (index: number, clientIndex: number) => string;
	grantIdForRow?: (index: number, clientIndex: number) => string;
	expiresAtForRow?: (index: number, isExpired: boolean) => number;
	afterBatchCommit?: (insertedRows: number) => void;
};

/** Build deterministic write-scope claims for one reservation or authorization test. */
function contextFor(clientId: string, grantId: string): AuthorizationContext {
	return { client_id: clientId, grant_id: grantId, scopes: ["vault:write"] };
}

/** Build a canonical absent-path put descriptor for the supplied vault epoch. */
function descriptorFor(epoch: string): OperationDescriptor {
	return {
		op: "put",
		epoch,
		paths: ["Notes/global-admission.md"],
		precondition: { kind: "absent" },
	};
}

/** Add the empty payload hash and zero-byte size to the canonical put descriptor. */
function intentFor(epoch: string): OperationIntent {
	return { ...descriptorFor(epoch), payload_hash: emptyPayloadHash, size: 0 };
}

/** Read the stored vault epoch and return an empty sentinel when metadata is absent. */
function currentEpoch(storage: DurableObjectStorage): string {
	return (
		storage.sql
			.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'epoch'")
			.toArray()[0]?.value ?? ""
	);
}

/** Create a native authority with test-controlled milliseconds and ticket identifiers. */
function createAuthority(
	storage: DurableObjectStorage,
	now: number | (() => number),
	newTicketId: () => string,
): SqliteAdmissionAuthority {
	return new SqliteAdmissionAuthority(storage, {
		now: typeof now === "function" ? now : () => now,
		newTicketId,
	});
}

/** Capture content, history, receipts, blob references, and metadata without admission rows. */
function contentSnapshot(storage: DurableObjectStorage) {
	return {
		files: storage.sql.exec("SELECT * FROM files ORDER BY path").toArray(),
		revisions: storage.sql
			.exec("SELECT * FROM revisions ORDER BY path, rev")
			.toArray(),
		changes: storage.sql.exec("SELECT * FROM changes ORDER BY seq").toArray(),
		filesFts: storage.sql
			.exec("SELECT rowid, path, content FROM files_fts ORDER BY rowid")
			.toArray(),
		blobRefs: storage.sql
			.exec("SELECT * FROM blob_refs ORDER BY hash")
			.toArray(),
		receipts: storage.sql
			.exec("SELECT * FROM receipts ORDER BY client_id, key")
			.toArray(),
		meta: storage.sql.exec("SELECT * FROM meta ORDER BY key").toArray(),
	};
}

/** Read every physical admission row, including expired rows that await cleanup. */
function admissionSnapshot(storage: DurableObjectStorage): AdmissionTestRow[] {
	return storage.sql
		.exec<AdmissionTestRow>("SELECT * FROM operation_admissions ORDER BY id")
		.toArray();
}

/** Count physical admission rows, including rows that expired without cleanup. */
function admissionRowCount(storage: DurableObjectStorage): number {
	return (
		storage.sql
			.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM operation_admissions",
			)
			.toArray()[0]?.count ?? 0
	);
}

/** Count expired rows without deleting them. */
function expiredAdmissionRowCount(
	storage: DurableObjectStorage,
	now: number,
): number {
	return (
		storage.sql
			.exec<{ count: number }>(
				"SELECT COUNT(*) AS count FROM operation_admissions WHERE expires_at <= ?",
				now,
			)
			.toArray()[0]?.count ?? 0
	);
}

/** Find the largest physical admission count for one client. */
function maximumClientAdmissionCount(storage: DurableObjectStorage): number {
	return (
		storage.sql
			.exec<{ maximum: number }>(
				"SELECT COALESCE(MAX(client_count), 0) AS maximum FROM (SELECT COUNT(*) AS client_count FROM operation_admissions GROUP BY client_id)",
			)
			.toArray()[0]?.maximum ?? 0
	);
}

/** Seed valid rows and sample after each committed batch when the optional callback runs. */
async function seedAdmissions(
	storage: DurableObjectStorage,
	options: SeedOptions,
): Promise<SeedRow[]> {
	const epoch = currentEpoch(storage);
	const total = options.liveCount + options.expiredCount;
	const preparedByClient = new Map<
		string,
		{ descriptorFingerprint: string; fingerprint: string }
	>();
	const rows: SeedRow[] = [];

	for (let index = 0; index < total; index += 1) {
		const clientIndex = Math.floor(index / 16);
		const clientId =
			options.clientIdForRow?.(index, clientIndex) ??
			`global-budget-client-${clientIndex}`;
		const grantId =
			options.grantIdForRow?.(index, clientIndex) ??
			`global-budget-grant-${clientIndex}`;
		const fingerprintKey = `${clientId}\u0000${grantId}`;

		let prepared = preparedByClient.get(fingerprintKey);
		if (!prepared) {
			const context = contextFor(clientId, grantId);
			const descriptor = await prepareDescriptor(context, descriptorFor(epoch));
			const intent = await prepareOperation(context, intentFor(epoch));
			prepared = {
				descriptorFingerprint: descriptor.descriptorFingerprint,
				fingerprint: intent.fingerprint,
			};
			preparedByClient.set(fingerprintKey, prepared);
		}

		const isExpired = index >= options.liveCount;
		const expiresAt =
			options.expiresAtForRow?.(index, isExpired) ??
			(isExpired ? options.now - 1 : options.now + 60_000);
		const state = states[index % states.length] as AdmissionTestState;
		rows.push({
			id: ((options.idOffset ?? 0) + index + 1).toString(16).padStart(32, "0"),
			clientId,
			grantId,
			epoch,
			fingerprint:
				state === "reserved"
					? prepared.descriptorFingerprint
					: prepared.fingerprint,
			admittedAt: expiresAt - 60_000,
			expiresAt,
			state,
		});
	}

	const insertPrefix =
		"INSERT INTO operation_admissions(id, client_id, grant_id, epoch, fingerprint, admitted_at, expires_at, state) VALUES ";
	for (let offset = 0; offset < rows.length; offset += 12) {
		const batch = rows.slice(offset, offset + 12);
		const values = batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
		const parameters = batch.flatMap((row) => [
			row.id,
			row.clientId,
			row.grantId,
			row.epoch,
			row.fingerprint,
			row.admittedAt,
			row.expiresAt,
			row.state,
		]);
		if (options.afterBatchCommit) {
			storage.transactionSync(() =>
				storage.sql.exec(`${insertPrefix}${values}`, ...parameters),
			);
			options.afterBatchCommit(batch.length);
		} else {
			storage.sql.exec(`${insertPrefix}${values}`, ...parameters);
		}
	}
	return rows;
}

/** Run the selected reserve or authorize path with the current vault epoch. */
async function runInsertion(
	kind: OperationKind,
	authority: SqliteAdmissionAuthority,
	context: AuthorizationContext,
	storage: DurableObjectStorage,
): Promise<AdmissionResultForKind> {
	const epoch = currentEpoch(storage);
	return kind === "reserve"
		? authority.reserve(context, descriptorFor(epoch))
		: authority.authorize(context, intentFor(epoch));
}

/** Normalize successful lease and ticket results for shared row assertions. */
type AdmissionIdentity = {
	id: string;
	expiresAt: number;
	state: "reserved" | "active";
};

/** Extract persisted identity and state, or return undefined for a denial. */
function admissionIdentity(
	result: AdmissionResultForKind,
): AdmissionIdentity | undefined {
	if (!result.ok) return undefined;
	if ("lease" in result)
		return {
			id: result.lease.admission_id,
			expiresAt: result.lease.expires_at,
			state: "reserved",
		};
	return {
		id: result.ticket.id,
		expiresAt: result.ticket.expires_at,
		state: "active",
	};
}

/** Check retained rows and one new slot with canonical ownership and an unchanged 60-second deadline. */
function expectSuccessfulInsertion(
	result: AdmissionResultForKind,
	context: AuthorizationContext,
	epoch: string,
	beforeRows: AdmissionTestRow[],
	afterRows: AdmissionTestRow[],
	now: number,
	expectedCount: number,
): void {
	const identity = admissionIdentity(result);
	expect(identity).toBeDefined();
	if (!identity) return;

	const originalLiveRows = beforeRows.filter((row) => row.expires_at > now);
	const originalLiveIds = new Set(originalLiveRows.map((row) => row.id));
	const addedRows = afterRows.filter((row) => !originalLiveIds.has(row.id));
	expect(afterRows).toHaveLength(expectedCount);
	expect(afterRows.filter((row) => originalLiveIds.has(row.id))).toEqual(
		originalLiveRows,
	);
	expect(afterRows.filter((row) => row.expires_at <= now)).toHaveLength(0);
	expect(addedRows).toHaveLength(1);
	expect(addedRows[0]).toMatchObject({
		id: identity.id,
		client_id: context.client_id,
		grant_id: context.grant_id,
		epoch,
		admitted_at: now,
		expires_at: identity.expiresAt,
		state: identity.state,
	});
	expect(identity.expiresAt).toBe(now + 60_000);
}

/** Seed 1,022 live rows plus caller-owned and global expired cleanup markers. */
async function seedCleanupMarkers(
	storage: DurableObjectStorage,
	now: number,
	caller: AuthorizationContext,
) {
	const liveRows = await seedAdmissions(storage, {
		liveCount: 1_022,
		expiredCount: 0,
		now,
	});
	const callerMarker = (
		await seedAdmissions(storage, {
			liveCount: 0,
			expiredCount: 1,
			now,
			idOffset: 1_022,
			clientIdForRow: () => caller.client_id,
			grantIdForRow: () => `${caller.grant_id}-expired`,
			expiresAtForRow: () => now - 1,
		})
	)[0];
	const globalMarker = (
		await seedAdmissions(storage, {
			liveCount: 0,
			expiredCount: 1,
			now,
			idOffset: 1_023,
			clientIdForRow: () => "global-expired-marker-client",
			grantIdForRow: () => "global-expired-marker-grant",
			expiresAtForRow: () => now - 1,
		})
	)[0];
	return { liveRows, callerMarker, globalMarker };
}

/** Verify both expired markers retain their identities, fingerprints, and original deadlines. */
function expectCleanupMarkersPresent(
	storage: DurableObjectStorage,
	now: number,
	caller: AuthorizationContext,
	callerMarker: SeedRow,
	globalMarker: SeedRow,
): void {
	const rows = admissionSnapshot(storage);
	for (const marker of [callerMarker, globalMarker]) {
		expect(rows.find((row) => row.id === marker.id)).toMatchObject({
			id: marker.id,
			client_id: marker.clientId,
			grant_id: marker.grantId,
			fingerprint: marker.fingerprint,
			admitted_at: marker.admittedAt,
			expires_at: marker.expiresAt,
			state: marker.state,
		});
		expect(marker.expiresAt).toBeLessThanOrEqual(now);
		expect(marker.expiresAt).toBe(marker.admittedAt + 60_000);
	}
	expect(callerMarker.clientId).toBe(caller.client_id);
	expect(callerMarker.grantId).toBe(`${caller.grant_id}-expired`);
	expect(globalMarker.clientId).not.toBe(caller.client_id);
	expect(callerMarker.clientId).not.toBe(globalMarker.clientId);
}

/** Verify cleanup removes both expired markers, admits one row, and leaves content tables unchanged. */
async function expectCleanupSuccess(
	kind: OperationKind,
	storage: DurableObjectStorage,
	context: AuthorizationContext,
	epoch: string,
	now: number,
	callerMarker: SeedRow,
	globalMarker: SeedRow,
): Promise<void> {
	const beforeRows = admissionSnapshot(storage);
	const beforeContent = contentSnapshot(storage);
	let idCalls = 0;
	const result = await runInsertion(
		kind,
		createAuthority(storage, now, () => {
			idCalls += 1;
			return "e".repeat(32);
		}),
		context,
		storage,
	);
	expect(idCalls).toBe(1);
	const afterRows = admissionSnapshot(storage);
	expectSuccessfulInsertion(
		result,
		context,
		epoch,
		beforeRows,
		afterRows,
		now,
		1_023,
	);
	expect(afterRows.some((row) => row.id === callerMarker.id)).toBe(false);
	expect(afterRows.some((row) => row.id === globalMarker.id)).toBe(false);
	expect(contentSnapshot(storage)).toEqual(beforeContent);
}

describe("vault aggregate admission limit", () => {
	it.each(vaultOperationKinds)(
		"limits concurrent %s insertions across two stubs and clients",
		async (kind) => {
			const id = env.VAULTS.newUniqueId();
			const firstStub = env.VAULTS.get(id);
			const secondStub = env.VAULTS.get(id);
			let epoch = "";
			let initialContent: ReturnType<typeof contentSnapshot> | undefined;
			await runInDurableObject(firstStub, async (_instance, state) => {
				epoch = currentEpoch(state.storage);
				await seedAdmissions(state.storage, {
					liveCount: 1_023,
					expiredCount: 0,
					now: Date.now(),
				});
				initialContent = contentSnapshot(state.storage);
			});

			const left = contextFor("race-client-left", "race-grant-left");
			const right = contextFor("race-client-right", "race-grant-right");
			const results = await Promise.all(
				kind === "beginMutation"
					? [
							firstStub.beginMutation(left, descriptorFor(epoch)),
							secondStub.beginMutation(right, descriptorFor(epoch)),
						]
					: [
							firstStub.authorize(left, intentFor(epoch)),
							secondStub.authorize(right, intentFor(epoch)),
						],
			);
			const successes = results.filter((result) => result.ok);
			const failures = results.filter((result) => !result.ok);
			expect.soft(successes).toHaveLength(1);
			expect.soft(failures).toHaveLength(1);
			expect.soft(failures[0]).toMatchObject({
				ok: false,
				failure: {
					kind: "admission_limited",
					retry_after_seconds: expect.any(Number),
				},
			});
			if (
				failures[0] &&
				!failures[0].ok &&
				failures[0].failure.kind === "admission_limited"
			)
				expect.soft(failures[0].failure.retry_after_seconds).toBeGreaterThan(0);

			const afterRace = await runInDurableObject(
				firstStub,
				(_instance, state) => ({
					rows: admissionSnapshot(state.storage),
					content: contentSnapshot(state.storage),
				}),
			);
			expect.soft(afterRace.rows).toHaveLength(1_024);
			expect.soft(afterRace.content).toEqual(initialContent);
			const successfulIndex = results.findIndex((result) => result.ok);
			const successfulResult = results[successfulIndex];
			const identity = successfulResult
				? admissionIdentity(successfulResult)
				: undefined;
			const owner = successfulIndex === 0 ? left : right;
			expect.soft(identity).toBeDefined();
			if (identity)
				expect
					.soft(afterRace.rows.find((row) => row.id === identity.id))
					.toMatchObject({
						id: identity.id,
						client_id: owner.client_id,
						grant_id: owner.grant_id,
						expires_at: identity.expiresAt,
						state: identity.state,
					});

			const fresh = contextFor("fresh-global-client", "fresh-global-grant");
			const freshResult =
				kind === "beginMutation"
					? await firstStub.beginMutation(fresh, descriptorFor(epoch))
					: await firstStub.authorize(fresh, intentFor(epoch));
			expect.soft(freshResult).toMatchObject({
				ok: false,
				failure: {
					kind: "admission_limited",
					retry_after_seconds: expect.any(Number),
				},
			});
			if (!freshResult.ok && freshResult.failure.kind === "admission_limited")
				expect.soft(freshResult.failure.retry_after_seconds).toBeGreaterThan(0);
			const finalState = await runInDurableObject(
				firstStub,
				(_instance, state) => ({
					rows: admissionSnapshot(state.storage),
					content: contentSnapshot(state.storage),
				}),
			);
			expect.soft(finalState.rows).toHaveLength(1_024);
			expect.soft(finalState.rows).toEqual(afterRace.rows);
			expect.soft(finalState.content).toEqual(initialContent);
		},
	);

	it.each(operationKinds)(
		"uses the earliest retained vault expiry and skips IDs for global %s denial",
		async (kind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const now = 200_000;
			const probe = contextFor(
				"empty-global-probe",
				"empty-global-probe-grant",
			);
			await runInDurableObject(stub, async (_instance, state) => {
				await seedAdmissions(state.storage, {
					liveCount: 1_024,
					expiredCount: 0,
					now,
					expiresAtForRow: (index) =>
						index === 17 ? now + 1_250 : now + 15_000,
				});
				const beforeRows = admissionSnapshot(state.storage);
				const beforeContent = contentSnapshot(state.storage);
				let idCalls = 0;
				const authority = createAuthority(state.storage, now, () => {
					idCalls += 1;
					return "f".repeat(32);
				});
				const result = await runInsertion(
					kind,
					authority,
					probe,
					state.storage,
				);
				expect.soft(result).toEqual({
					ok: false,
					failure: { kind: "admission_limited", retry_after_seconds: 2 },
				});
				expect.soft(idCalls).toBe(0);
				expect.soft(admissionSnapshot(state.storage)).toEqual(beforeRows);
				expect.soft(contentSnapshot(state.storage)).toEqual(beforeContent);
			});
		},
	);

	it.each(operationKinds)(
		"keeps client denial first when both %s limits are full",
		async (kind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const now = 300_000;
			const caller = contextFor(
				"global-budget-client-0",
				"global-budget-grant-0",
			);
			await runInDurableObject(stub, async (_instance, state) => {
				await seedAdmissions(state.storage, {
					liveCount: 1_024,
					expiredCount: 0,
					now,
					expiresAtForRow: (index) => (index < 16 ? now + 41_999 : now + 1_000),
				});
				const expired = await seedAdmissions(state.storage, {
					liveCount: 0,
					expiredCount: 1,
					now,
					idOffset: 1_024,
					clientIdForRow: () => caller.client_id,
				});
				const beforeRows = admissionSnapshot(state.storage);
				const beforeContent = contentSnapshot(state.storage);
				let idCalls = 0;
				const authority = createAuthority(state.storage, now, () => {
					idCalls += 1;
					return "f".repeat(32);
				});
				const result = await runInsertion(
					kind,
					authority,
					caller,
					state.storage,
				);
				expect.soft(result).toEqual({
					ok: false,
					failure: { kind: "admission_limited", retry_after_seconds: 42 },
				});
				expect.soft(idCalls).toBe(0);
				expect
					.soft(admissionSnapshot(state.storage))
					.toEqual(beforeRows.filter((row) => row.id !== expired[0]?.id));
				expect.soft(contentSnapshot(state.storage)).toEqual(beforeContent);
			});
		},
	);

	it("binds an owned reservation at full vault capacity without changing its row identity or deadline", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const caller = contextFor("binding-client", "binding-grant");
		const now = Date.now();
		await runInDurableObject(stub, async (_instance, state) => {
			const epoch = currentEpoch(state.storage);
			let nextId = 0;
			const authority = createAuthority(state.storage, now, () => {
				const id = `f${nextId.toString(16).padStart(31, "0")}`;
				nextId += 1;
				return id;
			});
			const lease = await authority.reserve(caller, descriptorFor(epoch));
			expect(lease.ok).toBe(true);
			if (!lease.ok) return;
			await seedAdmissions(state.storage, {
				liveCount: 1_023,
				expiredCount: 0,
				now,
			});
			const beforeRows = admissionSnapshot(state.storage);
			const beforeContent = contentSnapshot(state.storage);
			const ownedBefore = beforeRows.find(
				(row) => row.id === lease.lease.admission_id,
			);
			const prepared = await prepareOperation(caller, intentFor(epoch));
			const result = await authority.authorize(
				caller,
				intentFor(epoch),
				lease.lease.admission_id,
			);
			expect(result).toMatchObject({
				ok: true,
				ticket: {
					id: lease.lease.admission_id,
					expires_at: lease.lease.expires_at,
				},
			});
			const afterRows = admissionSnapshot(state.storage);
			const ownedAfter = afterRows.find(
				(row) => row.id === lease.lease.admission_id,
			);
			expect(afterRows).toHaveLength(1_024);
			expect(ownedBefore).toMatchObject({
				client_id: caller.client_id,
				grant_id: caller.grant_id,
				state: "reserved",
			});
			expect(ownedAfter).toMatchObject({
				id: ownedBefore?.id,
				client_id: ownedBefore?.client_id,
				grant_id: ownedBefore?.grant_id,
				epoch: ownedBefore?.epoch,
				fingerprint: prepared.fingerprint,
				admitted_at: ownedBefore?.admitted_at,
				expires_at: ownedBefore?.expires_at,
				state: "active",
			});
			expect(ownedAfter?.fingerprint).not.toBe(ownedBefore?.fingerprint);
			expect(
				afterRows.filter((row) => row.id !== lease.lease.admission_id),
			).toEqual(
				beforeRows.filter((row) => row.id !== lease.lease.admission_id),
			);
			expect(contentSnapshot(state.storage)).toEqual(beforeContent);
		});
	});

	it("keeps uncertain work charged at full capacity and refuses its binding", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const caller = contextFor("uncertain-client", "uncertain-grant");
		const now = Date.now();
		await runInDurableObject(stub, async (_instance, state) => {
			const epoch = currentEpoch(state.storage);
			const authority = createAuthority(state.storage, now, () =>
				"f".repeat(32),
			);
			const lease = await authority.reserve(caller, descriptorFor(epoch));
			expect(lease.ok).toBe(true);
			if (!lease.ok) return;
			await seedAdmissions(state.storage, {
				liveCount: 1_023,
				expiredCount: 0,
				now,
			});
			const beforeFinish = admissionSnapshot(state.storage);
			const settled = await authority.finish(
				caller,
				lease.lease.admission_id,
				"uncertain",
			);
			expect(settled).toEqual({ ok: true });
			const afterFinish = admissionSnapshot(state.storage);
			expect(afterFinish).toHaveLength(1_024);
			expect(afterFinish).toEqual(
				beforeFinish.map((row) =>
					row.id === lease.lease.admission_id
						? { ...row, state: "uncertain" }
						: row,
				),
			);
			const binding = await authority.authorize(
				caller,
				intentFor(epoch),
				lease.lease.admission_id,
			);
			expect(binding).toEqual({
				ok: false,
				failure: { kind: "invalid_ticket" },
			});
			expect(admissionSnapshot(state.storage)).toEqual(afterFinish);
		});
	});

	it("releases one settled row and admits one replacement at full capacity", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		const owner = contextFor("settled-owner", "settled-owner-grant");
		const now = Date.now();
		await runInDurableObject(stub, async (_instance, state) => {
			const epoch = currentEpoch(state.storage);
			let nextId = 0;
			const authority = createAuthority(state.storage, now, () => {
				const id = `f${nextId.toString(16).padStart(31, "0")}`;
				nextId += 1;
				return id;
			});
			const ticket = await authority.authorize(owner, intentFor(epoch));
			expect(ticket.ok).toBe(true);
			if (!ticket.ok) return;
			await seedAdmissions(state.storage, {
				liveCount: 1_023,
				expiredCount: 0,
				now,
			});
			expect(admissionSnapshot(state.storage)).toHaveLength(1_024);
			const beforeFinish = admissionSnapshot(state.storage);
			const finish = await authority.finish(owner, ticket.ticket.id, "settled");
			expect(finish).toEqual({ ok: true });
			const afterFinish = admissionSnapshot(state.storage);
			expect(afterFinish).toHaveLength(1_023);
			expect(afterFinish).toEqual(
				beforeFinish.filter((row) => row.id !== ticket.ticket.id),
			);
			const replacement = contextFor(
				"settled-replacement",
				"replacement-grant",
			);
			const admitted = await authority.reserve(
				replacement,
				descriptorFor(epoch),
			);
			expect(admitted.ok).toBe(true);
			expect(admissionSnapshot(state.storage)).toHaveLength(1_024);
		});
	});

	it.each(operationKinds)(
		"denies %s at 59,999 ms while every ledger row remains live",
		async (kind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const boundary = 60_000;
			const caller = contextFor("boundary-probe", "boundary-probe-grant");
			await runInDurableObject(stub, async (_instance, state) => {
				await seedAdmissions(state.storage, {
					liveCount: 1_023,
					expiredCount: 1,
					now: boundary,
					expiresAtForRow: (index) =>
						index === 1_023 ? boundary : boundary + 60_000,
				});
				const beforeRows = admissionSnapshot(state.storage);
				let idCalls = 0;
				const result = await runInsertion(
					kind,
					createAuthority(state.storage, boundary - 1, () => {
						idCalls += 1;
						return "f".repeat(32);
					}),
					caller,
					state.storage,
				);
				expect.soft(result).toEqual({
					ok: false,
					failure: { kind: "admission_limited", retry_after_seconds: 1 },
				});
				expect.soft(idCalls).toBe(0);
				expect.soft(admissionSnapshot(state.storage)).toEqual(beforeRows);
			});
		},
	);

	it.each(operationKinds)(
		"recovers %s capacity at the exact 60,000 ms expiry boundary",
		async (kind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const now = 60_000;
			const caller = contextFor(
				"boundary-recovery-client",
				"boundary-recovery-grant",
			);
			await runInDurableObject(stub, async (_instance, state) => {
				const epoch = currentEpoch(state.storage);
				await seedAdmissions(state.storage, {
					liveCount: 1_023,
					expiredCount: 1,
					now,
					expiresAtForRow: (index) => (index === 1_023 ? now : now + 60_000),
				});
				const beforeRows = admissionSnapshot(state.storage);
				const beforeContent = contentSnapshot(state.storage);
				const expired = beforeRows.find((row) => row.expires_at === now);
				expect(expired).toBeDefined();
				const result = await runInsertion(
					kind,
					createAuthority(state.storage, now, () => "f".repeat(32)),
					caller,
					state.storage,
				);
				const afterRows = admissionSnapshot(state.storage);
				expectSuccessfulInsertion(
					result,
					caller,
					epoch,
					beforeRows,
					afterRows,
					now,
					1_024,
				);
				expect(afterRows.some((row) => row.id === expired?.id)).toBe(false);
				expect(contentSnapshot(state.storage)).toEqual(beforeContent);
			});
		},
	);

	it.each(operationKinds)(
		"denies %s when bounded cleanup leaves an over-budget expired backlog",
		async (kind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const now = 500_000;
			const caller = contextFor("backlog-probe", "backlog-probe-grant");
			await runInDurableObject(stub, async (_instance, state) => {
				await seedAdmissions(state.storage, {
					liveCount: 1_024,
					expiredCount: 65,
					now,
				});
				const beforeRows = admissionSnapshot(state.storage);
				const liveBefore = beforeRows.filter((row) => row.expires_at > now);
				let idCalls = 0;
				const authority = createAuthority(state.storage, now, () => {
					idCalls += 1;
					return "f".repeat(32);
				});
				const result = await runInsertion(
					kind,
					authority,
					caller,
					state.storage,
				);
				expect.soft(result).toEqual({
					ok: false,
					failure: { kind: "admission_limited", retry_after_seconds: 1 },
				});
				expect.soft(idCalls).toBe(0);
				const afterRows = admissionSnapshot(state.storage);
				expect.soft(afterRows).toHaveLength(1_025);
				expect
					.soft(afterRows.filter((row) => row.expires_at > now))
					.toEqual(liveBefore);
				expect
					.soft(afterRows.filter((row) => row.expires_at <= now))
					.toHaveLength(1);
			});
		},
	);

	it.each(operationKinds)(
		"admits %s when cleanup leaves 1,023 original live rows",
		async (kind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const now = 600_000;
			const caller = contextFor(
				"cleanup-recovery-probe",
				"cleanup-recovery-grant",
			);
			await runInDurableObject(stub, async (_instance, state) => {
				const epoch = currentEpoch(state.storage);
				await seedAdmissions(state.storage, {
					liveCount: 1_023,
					expiredCount: 64,
					now,
				});
				const beforeRows = admissionSnapshot(state.storage);
				const beforeContent = contentSnapshot(state.storage);
				const originalLiveIds = new Set(
					beforeRows.filter((row) => row.expires_at > now).map((row) => row.id),
				);
				expect(originalLiveIds.size).toBe(1_023);
				const result = await runInsertion(
					kind,
					createAuthority(state.storage, now, () => "f".repeat(32)),
					caller,
					state.storage,
				);
				const afterRows = admissionSnapshot(state.storage);
				expectSuccessfulInsertion(
					result,
					caller,
					epoch,
					beforeRows,
					afterRows,
					now,
					1_024,
				);
				expect(afterRows.filter((row) => originalLiveIds.has(row.id))).toEqual(
					beforeRows.filter((row) => originalLiveIds.has(row.id)),
				);
				expect(contentSnapshot(state.storage)).toEqual(beforeContent);
			});
		},
	);

	it.each([
		{ kind: "reserve" as const, candidateKind: "malformed" as const },
		{ kind: "reserve" as const, candidateKind: "collisions" as const },
		{ kind: "authorize" as const, candidateKind: "malformed" as const },
		{ kind: "authorize" as const, candidateKind: "collisions" as const },
	])(
		"commits eligible cleanup after returned ID denial for $kind $candidateKind",
		async ({ kind, candidateKind }) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const now = 650_000;
			const caller = contextFor(
				"returned-denial-client",
				"returned-denial-grant",
			);
			await runInDurableObject(stub, async (_instance, state) => {
				const markers = await seedCleanupMarkers(state.storage, now, caller);
				const beforeRows = admissionSnapshot(state.storage);
				const beforeContent = contentSnapshot(state.storage);
				expect(beforeRows).toHaveLength(1_024);
				expect(markers.liveRows).toHaveLength(1_022);
				expectCleanupMarkersPresent(
					state.storage,
					now,
					caller,
					markers.callerMarker,
					markers.globalMarker,
				);

				const collisionRows = markers.liveRows.slice(0, 8);
				expect(collisionRows).toHaveLength(8);
				for (const collision of collisionRows) {
					expect(
						beforeRows.find((row) => row.id === collision.id),
					).toMatchObject({
						id: collision.id,
						client_id: collision.clientId,
						grant_id: collision.grantId,
						epoch: collision.epoch,
						fingerprint: collision.fingerprint,
						admitted_at: collision.admittedAt,
						expires_at: collision.expiresAt,
						state: collision.state,
					});
				}

				let idCalls = 0;
				const authority = createAuthority(state.storage, now, () => {
					const candidateIndex = idCalls;
					idCalls += 1;
					return candidateKind === "malformed"
						? "malformed-ticket-id"
						: (collisionRows[candidateIndex]?.id ?? "f".repeat(32));
				});
				const result = await runInsertion(
					kind,
					authority,
					caller,
					state.storage,
				);
				expect(result).toEqual({
					ok: false,
					failure: { kind: "invalid_request" },
				});
				expect(idCalls).toBe(candidateKind === "malformed" ? 1 : 8);
				const afterRows = admissionSnapshot(state.storage);
				const originalLiveRows = beforeRows.filter(
					(row) => row.expires_at > now,
				);
				expect(afterRows).toEqual(originalLiveRows);
				expect(afterRows).toHaveLength(1_022);
				expect(
					afterRows.some((row) => row.id === markers.callerMarker.id),
				).toBe(false);
				expect(
					afterRows.some((row) => row.id === markers.globalMarker.id),
				).toBe(false);
				expect(contentSnapshot(state.storage)).toEqual(beforeContent);
			});
		},
	);

	it.each(operationKinds)(
		"rolls back caller and global cleanup when %s insertion throws",
		async (kind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const now = 700_000;
			const caller = contextFor("insert-failure-probe", "insert-failure-grant");
			await runInDurableObject(stub, async (_instance, state) => {
				const epoch = currentEpoch(state.storage);
				const markers = await seedCleanupMarkers(state.storage, now, caller);
				const beforeRows = admissionSnapshot(state.storage);
				const beforeContent = contentSnapshot(state.storage);
				expect(beforeRows).toHaveLength(1_024);
				expect(markers.liveRows).toHaveLength(1_022);
				expectCleanupMarkersPresent(
					state.storage,
					now,
					caller,
					markers.callerMarker,
					markers.globalMarker,
				);
				state.storage.sql.exec(
					"CREATE TRIGGER fail_global_admission_insert BEFORE INSERT ON operation_admissions BEGIN SELECT RAISE(ABORT, 'forced admission insert failure'); END",
				);
				let idCalls = 0;
				const authority = createAuthority(state.storage, now, () => {
					idCalls += 1;
					return "f".repeat(32);
				});
				let failure: unknown;
				try {
					await runInsertion(kind, authority, caller, state.storage);
				} catch (error) {
					failure = error;
				} finally {
					state.storage.sql.exec("DROP TRIGGER fail_global_admission_insert");
				}
				expect.soft(failure).toBeInstanceOf(Error);
				expect
					.soft(String(failure))
					.toContain("forced admission insert failure");
				expect.soft(idCalls).toBe(1);
				expect.soft(admissionSnapshot(state.storage)).toEqual(beforeRows);
				expect.soft(contentSnapshot(state.storage)).toEqual(beforeContent);
				expectCleanupMarkersPresent(
					state.storage,
					now,
					caller,
					markers.callerMarker,
					markers.globalMarker,
				);
				await expectCleanupSuccess(
					kind,
					state.storage,
					caller,
					epoch,
					now,
					markers.callerMarker,
					markers.globalMarker,
				);
			});
		},
	);

	it.each(operationKinds)(
		"rolls back caller and global cleanup when %s entropy throws",
		async (kind) => {
			const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
			const now = 800_000;
			const caller = contextFor(
				"entropy-failure-probe",
				"entropy-failure-grant",
			);
			await runInDurableObject(stub, async (_instance, state) => {
				const epoch = currentEpoch(state.storage);
				const markers = await seedCleanupMarkers(state.storage, now, caller);
				const beforeRows = admissionSnapshot(state.storage);
				const beforeContent = contentSnapshot(state.storage);
				expect(beforeRows).toHaveLength(1_024);
				expect(markers.liveRows).toHaveLength(1_022);
				expectCleanupMarkersPresent(
					state.storage,
					now,
					caller,
					markers.callerMarker,
					markers.globalMarker,
				);
				let idCalls = 0;
				const authority = createAuthority(state.storage, now, () => {
					idCalls += 1;
					throw new Error("forced admission entropy failure");
				});
				let failure: unknown;
				try {
					await runInsertion(kind, authority, caller, state.storage);
				} catch (error) {
					failure = error;
				}
				expect.soft(failure).toBeInstanceOf(Error);
				expect.soft(idCalls).toBe(1);
				expect.soft(admissionSnapshot(state.storage)).toEqual(beforeRows);
				expect.soft(contentSnapshot(state.storage)).toEqual(beforeContent);
				expectCleanupMarkersPresent(
					state.storage,
					now,
					caller,
					markers.callerMarker,
					markers.globalMarker,
				);
				await expectCleanupSuccess(
					kind,
					state.storage,
					caller,
					epoch,
					now,
					markers.callerMarker,
					markers.globalMarker,
				);
			});
		},
	);

	it("measures native storage across three saturation, cleanup, and refill cycles", async () => {
		const stub = env.VAULTS.get(env.VAULTS.newUniqueId());
		await runInDurableObject(stub, async (_instance, state) => {
			const rowLimit = 1_024;
			const maxIdentityBytes = 2_048;
			const maxGrowthBytes = 32 * 1_024 * 1_024;
			const encoder = new TextEncoder();
			let now = 1_000_000;
			let nextTicketId = 700_000;
			const baselineBytes = state.storage.sql.databaseSize;
			expect(admissionRowCount(state.storage)).toBe(0);
			expect(Number.isSafeInteger(baselineBytes)).toBe(true);

			const cycles: {
				number: number;
				startBytes: number;
				peakBytes: number;
				transactionSamples: number;
				finalBytes?: number;
				finalRows?: number;
			}[] = [];
			let activeCycle: (typeof cycles)[number] | undefined;
			let absolutePeakBytes = baselineBytes;
			let finalRetainedBytes = baselineBytes;
			let transactionSamples = 0;
			let setupTransactionSamples = 0;
			/** Return native byte and transaction samples. Peak delta measures growth from the initialized empty database. */
			const metrics = () => ({
				baselineBytes,
				absolutePeakBytes,
				peakDeltaBytes: absolutePeakBytes - baselineBytes,
				finalRetainedBytes,
				transactionSamples,
				setupTransactionSamples,
				cycles,
			});
			/** Sample native bytes after the storage transaction returns. */
			const sampleAfterTransaction = (expectedRows: number): void => {
				const databaseBytes = state.storage.sql.databaseSize;
				const rowCount = admissionRowCount(state.storage);
				transactionSamples += 1;
				finalRetainedBytes = databaseBytes;
				absolutePeakBytes = Math.max(absolutePeakBytes, databaseBytes);
				if (activeCycle) {
					activeCycle.transactionSamples += 1;
					activeCycle.peakBytes = Math.max(
						activeCycle.peakBytes,
						databaseBytes,
					);
				} else {
					setupTransactionSamples += 1;
				}
				expect(rowCount).toBeLessThanOrEqual(rowLimit);
				expect(rowCount).toBe(expectedRows);
				expect(maximumClientAdmissionCount(state.storage)).toBeLessThanOrEqual(
					16,
				);
				const peakDeltaBytes = absolutePeakBytes - baselineBytes;
				if (peakDeltaBytes > maxGrowthBytes)
					console.info(
						"OAB native admission storage budget exceeded",
						JSON.stringify(metrics()),
					);
				expect(peakDeltaBytes).toBeLessThanOrEqual(maxGrowthBytes);
			};
			/** Create an ASCII identity at the protocol's 2,048-byte UTF-8 boundary. */
			const maxLengthIdentity = (prefix: string): string => {
				const prefixBytes = encoder.encode(prefix).byteLength;
				if (prefixBytes >= maxIdentityBytes)
					throw new Error("Resource identity prefix exceeds its byte limit");
				return `${prefix}${"x".repeat(maxIdentityBytes - prefixBytes)}`;
			};
			/** Check the 1,024-row vault cap, 2,048-byte identities, canonical hashes, states, deadlines, and 16-row client cap. */
			const expectResourceRows = (rows: AdmissionTestRow[]): void => {
				const clientCounts = new Map<string, number>();
				const validRows = rows.every((row) => {
					clientCounts.set(
						row.client_id,
						(clientCounts.get(row.client_id) ?? 0) + 1,
					);
					return (
						/^[0-9a-f]{32}$/.test(row.id) &&
						/^[0-9a-f]{64}$/.test(row.fingerprint) &&
						encoder.encode(row.client_id).byteLength === maxIdentityBytes &&
						encoder.encode(row.grant_id).byteLength === maxIdentityBytes &&
						states.includes(row.state) &&
						Number.isSafeInteger(row.admitted_at) &&
						Number.isSafeInteger(row.expires_at) &&
						row.expires_at === now + 60_000
					);
				});
				expect(rows).toHaveLength(rowLimit);
				expect(validRows).toBe(true);
				expect(Math.max(...clientCounts.values())).toBeLessThanOrEqual(16);
				for (const admissionState of states)
					expect(rows.some((row) => row.state === admissionState)).toBe(true);
			};

			const initialClientIds = Array.from({ length: 64 }, (_, index) =>
				maxLengthIdentity(`resource-initial-client-${index}-`),
			);
			const initialGrantIds = Array.from({ length: 64 }, (_, index) =>
				maxLengthIdentity(`resource-initial-grant-${index}-`),
			);
			let initialRowsInserted = 0;
			const initialRows = await seedAdmissions(state.storage, {
				liveCount: rowLimit,
				expiredCount: 0,
				now,
				idOffset: 100_000,
				clientIdForRow: (_index, clientIndex) => initialClientIds[clientIndex],
				grantIdForRow: (_index, clientIndex) => initialGrantIds[clientIndex],
				afterBatchCommit: (insertedRows) => {
					initialRowsInserted += insertedRows;
					sampleAfterTransaction(initialRowsInserted);
				},
			});
			expect(initialRows).toHaveLength(rowLimit);
			expectResourceRows(admissionSnapshot(state.storage));

			for (let cycleNumber = 1; cycleNumber <= 3; cycleNumber += 1) {
				activeCycle = {
					number: cycleNumber,
					startBytes: state.storage.sql.databaseSize,
					peakBytes: state.storage.sql.databaseSize,
					transactionSamples: 0,
				};
				cycles.push(activeCycle);
				const startRows = admissionRowCount(state.storage);
				expect(startRows).toBe(rowLimit);
				expect(expiredAdmissionRowCount(state.storage, now)).toBe(0);

				const saturationContext = contextFor(
					maxLengthIdentity(`resource-saturation-${cycleNumber}-client-`),
					maxLengthIdentity(`resource-saturation-${cycleNumber}-grant-`),
				);
				let saturationIdCalls = 0;
				const saturationAuthority = createAuthority(
					state.storage,
					() => now,
					() => {
						saturationIdCalls += 1;
						return "f".repeat(32);
					},
				);
				const beforeDenialBytes = state.storage.sql.databaseSize;
				const saturated = await runInsertion(
					"reserve",
					saturationAuthority,
					saturationContext,
					state.storage,
				);
				expect(saturated.ok).toBe(false);
				if (saturated.ok || saturated.failure.kind !== "admission_limited")
					throw new Error(
						"Full-vault reserve did not return admission_limited",
					);
				expect(saturated.failure.retry_after_seconds).toBeGreaterThan(0);
				expect(saturationIdCalls).toBe(0);
				expect(admissionRowCount(state.storage)).toBe(rowLimit);
				expect(state.storage.sql.databaseSize).toBe(beforeDenialBytes);

				now += 60_000;
				expect(admissionRowCount(state.storage)).toBe(rowLimit);
				expect(expiredAdmissionRowCount(state.storage, now)).toBe(rowLimit);
				let cleanedRows = 0;
				const cleanupAuthority = createAuthority(
					state.storage,
					() => now,
					() => {
						const id = (nextTicketId++).toString(16).padStart(32, "0");
						return id;
					},
				);
				for (let cleanupStep = 0; cleanupStep < 16; cleanupStep += 1) {
					const clientId = maxLengthIdentity(
						`resource-cycle-${cycleNumber}-writer-client-${cleanupStep}-`,
					);
					const grantId = maxLengthIdentity(
						`resource-cycle-${cycleNumber}-writer-grant-${cleanupStep}-`,
					);
					const result = await runInsertion(
						"reserve",
						cleanupAuthority,
						contextFor(clientId, grantId),
						state.storage,
					);
					expect(result.ok).toBe(true);
					cleanedRows += 64;
					const expectedRows = rowLimit - cleanedRows + cleanupStep + 1;
					sampleAfterTransaction(expectedRows);
					expect(expiredAdmissionRowCount(state.storage, now)).toBe(
						rowLimit - cleanedRows,
					);
				}
				expect(admissionRowCount(state.storage)).toBe(16);
				expect(expiredAdmissionRowCount(state.storage, now)).toBe(0);

				const refillClientIds = Array.from({ length: 63 }, (_, index) =>
					maxLengthIdentity(`resource-refill-${cycleNumber}-client-${index}-`),
				);
				const refillGrantIds = Array.from({ length: 63 }, (_, index) =>
					maxLengthIdentity(`resource-refill-${cycleNumber}-grant-${index}-`),
				);
				let refillRowsInserted = 16;
				const refillRows = await seedAdmissions(state.storage, {
					liveCount: rowLimit - 16,
					expiredCount: 0,
					now,
					idOffset: 200_000 + cycleNumber * 10_000,
					clientIdForRow: (_index, clientIndex) => refillClientIds[clientIndex],
					grantIdForRow: (_index, clientIndex) => refillGrantIds[clientIndex],
					afterBatchCommit: (insertedRows) => {
						refillRowsInserted += insertedRows;
						sampleAfterTransaction(refillRowsInserted);
					},
				});
				expect(refillRows).toHaveLength(rowLimit - 16);
				expect(admissionRowCount(state.storage)).toBe(rowLimit);
				expect(expiredAdmissionRowCount(state.storage, now)).toBe(0);
				expectResourceRows(admissionSnapshot(state.storage));
				activeCycle.finalBytes = state.storage.sql.databaseSize;
				activeCycle.finalRows = admissionRowCount(state.storage);
				expect(activeCycle.finalRows).toBe(rowLimit);
				activeCycle = undefined;
			}

			const finalRows = admissionSnapshot(state.storage);
			expectResourceRows(finalRows);
			finalRetainedBytes = state.storage.sql.databaseSize;
			const finalMetrics = metrics();
			console.info(
				"OAB native admission storage measurement",
				JSON.stringify(finalMetrics),
			);
			expect(finalMetrics.peakDeltaBytes).toBeLessThanOrEqual(maxGrowthBytes);
			expect(finalMetrics.setupTransactionSamples).toBe(86);
			expect(finalMetrics.transactionSamples).toBe(386);
			expect(finalMetrics.transactionSamples).toBe(
				finalMetrics.setupTransactionSamples +
					finalMetrics.cycles.reduce(
						(total, cycle) => total + cycle.transactionSamples,
						0,
					),
			);
			expect(finalMetrics.cycles).toHaveLength(3);
			for (const cycle of finalMetrics.cycles) {
				expect(cycle.transactionSamples).toBe(100);
				expect(cycle.finalRows).toBe(rowLimit);
				expect(cycle.finalBytes).toBeDefined();
				expect(cycle.peakBytes).toBeGreaterThanOrEqual(cycle.startBytes);
			}
		});
	});
});
