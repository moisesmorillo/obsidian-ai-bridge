import type {
	AdmissionCompletion,
	AdmissionFailure,
	AdmissionFinishResult,
	AdmissionResult,
	AuthorizationContext,
	OperationDescriptor,
	OperationIntent,
	RequestAdmissionResult,
} from "@obsidian-ai-bridge/protocol";
import {
	AuthorizationContextSchema,
	OperationTicketSchema,
} from "@obsidian-ai-bridge/protocol";
import type {
	PreparedDescriptor,
	PreparedOperation,
} from "@worker/application/admission";
import {
	AdmissionDenied,
	assertAdmissionAllowed,
	prepareDescriptor,
	prepareOperation,
} from "@worker/application/admission";
import {
	meta,
	operationAdmissions,
	revokedGrants,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import { and, asc, count, eq, gt, inArray, lte } from "drizzle-orm";
import {
	type DrizzleSqliteDODatabase,
	drizzle,
} from "drizzle-orm/durable-sqlite";

type VaultTransaction = Parameters<
	Parameters<DrizzleSqliteDODatabase<typeof vaultSchema>["transaction"]>[0]
>[0];

/** Limit physical admission rows across all clients, grants, states, and expiry times. */
const MAX_VAULT_ADMISSIONS = 1_024;

/** SQLite admission entry points for one Durable Object's native storage. */
export class SqliteAdmissionAuthority {
	private readonly db;

	constructor(
		storage: DurableObjectStorage,
		private readonly ports: { now: () => number; newTicketId: () => string },
	) {
		this.db = drizzle(storage, { schema: vaultSchema });
	}

	/** Validate policy and reserve one durable client slot before body processing. */
	async reserve(
		context: AuthorizationContext,
		descriptor: OperationDescriptor,
	): Promise<RequestAdmissionResult> {
		let prepared: PreparedDescriptor;
		try {
			prepared = await prepareDescriptor(context, descriptor);
		} catch (error) {
			if (error instanceof AdmissionDenied) return denied(error.failure);
			throw error;
		}
		try {
			return this.db.transaction((tx) => {
				const currentEpoch = assertPolicy(tx, context, prepared);
				const now = this.ports.now();
				const expiresAt = now + 60_000;
				if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt))
					return denied({ kind: "invalid_request" });
				cleanupExpiredAdmissions(tx, context.client_id, now);
				const limitFailure = checkClientLimit(tx, context.client_id, now);
				if (limitFailure) return denied(limitFailure);
				const vaultLimitFailure = checkVaultLimit(tx, now);
				if (vaultLimitFailure) return denied(vaultLimitFailure);
				const id = nextAdmissionId(tx, () => this.ports.newTicketId());
				if (!id) return denied({ kind: "invalid_request" });
				tx.insert(operationAdmissions)
					.values({
						id,
						clientId: context.client_id,
						grantId: context.grant_id,
						epoch: currentEpoch,
						fingerprint: prepared.descriptorFingerprint,
						admittedAt: now,
						expiresAt,
						state: "reserved",
					})
					.run();
				return { ok: true, lease: { admission_id: id, expires_at: expiresAt } };
			});
		} catch (error) {
			if (error instanceof AdmissionDenied) return denied(error.failure);
			throw error;
		}
	}

	/** Settle or retain only an admission owned by the verified client and grant. */
	finish(
		context: AuthorizationContext,
		ticketId: string,
		completion: AdmissionCompletion,
	): AdmissionFinishResult {
		const parsed = AuthorizationContextSchema.safeParse(context);
		if (
			!parsed.success ||
			(completion !== "settled" && completion !== "uncertain")
		)
			return { ok: false, failure: { kind: "invalid_request" } };
		return this.db.transaction((tx) => {
			const revoked = tx
				.select({ grantId: revokedGrants.grantId })
				.from(revokedGrants)
				.where(eq(revokedGrants.grantId, parsed.data.grant_id))
				.all();
			if (revoked.length > 0)
				return { ok: false, failure: { kind: "revoked" } };
			const observed = tx
				.select()
				.from(operationAdmissions)
				.where(eq(operationAdmissions.id, ticketId))
				.all()[0];
			if (!observed) {
				return completion === "settled"
					? { ok: true }
					: { ok: false, failure: { kind: "invalid_ticket" } };
			}
			if (
				observed.clientId !== parsed.data.client_id ||
				observed.grantId !== parsed.data.grant_id
			)
				return { ok: false, failure: { kind: "invalid_ticket" } };
			if (completion === "settled") {
				tx.delete(operationAdmissions)
					.where(admissionRowPredicate(observed))
					.run();
				const remaining = tx
					.select({ id: operationAdmissions.id })
					.from(operationAdmissions)
					.where(eq(operationAdmissions.id, observed.id))
					.all();
				return remaining.length === 0
					? { ok: true }
					: { ok: false, failure: { kind: "invalid_ticket" } };
			}
			if (observed.state === "uncertain") return { ok: true };
			tx.update(operationAdmissions)
				.set({ state: "uncertain" })
				.where(admissionRowPredicate(observed))
				.run();
			const retained = tx
				.select()
				.from(operationAdmissions)
				.where(eq(operationAdmissions.id, observed.id))
				.all()[0];
			return retained && sameAdmissionRow(retained, observed, "uncertain")
				? { ok: true }
				: { ok: false, failure: { kind: "invalid_ticket" } };
		});
	}

	/** Authorize full intent, binding its reservation or charging one active slot. */
	async authorize(
		context: AuthorizationContext,
		intent: OperationIntent,
		admissionId?: string,
	): Promise<AdmissionResult> {
		let prepared: PreparedOperation;
		try {
			prepared = await prepareOperation(context, intent);
		} catch (error) {
			if (error instanceof AdmissionDenied) return denied(error.failure);
			throw error;
		}
		try {
			return this.db.transaction((tx) => {
				const currentEpoch = assertPolicy(tx, context, prepared);
				const now = this.ports.now();
				if (!Number.isSafeInteger(now))
					return denied({ kind: "invalid_request" });
				if (admissionId !== undefined) {
					const reserved = tx
						.select()
						.from(operationAdmissions)
						.where(eq(operationAdmissions.id, admissionId))
						.all()[0];
					if (
						!reserved ||
						reserved.clientId !== context.client_id ||
						reserved.grantId !== context.grant_id ||
						reserved.epoch !== currentEpoch ||
						reserved.fingerprint !== prepared.descriptorFingerprint ||
						reserved.state !== "reserved" ||
						reserved.expiresAt <= now
					)
						return denied({ kind: "invalid_ticket" });
					tx.update(operationAdmissions)
						.set({ state: "active", fingerprint: prepared.fingerprint })
						.where(
							and(
								eq(operationAdmissions.id, reserved.id),
								eq(operationAdmissions.clientId, reserved.clientId),
								eq(operationAdmissions.grantId, reserved.grantId),
								eq(operationAdmissions.epoch, reserved.epoch),
								eq(operationAdmissions.fingerprint, reserved.fingerprint),
								eq(operationAdmissions.admittedAt, reserved.admittedAt),
								eq(operationAdmissions.expiresAt, reserved.expiresAt),
								eq(operationAdmissions.state, "reserved"),
								gt(operationAdmissions.expiresAt, now),
							),
						)
						.run();
					const active = tx
						.select()
						.from(operationAdmissions)
						.where(eq(operationAdmissions.id, reserved.id))
						.all()[0];
					if (
						active?.state !== "active" ||
						active.fingerprint !== prepared.fingerprint ||
						active.admittedAt !== reserved.admittedAt ||
						active.expiresAt !== reserved.expiresAt
					)
						return denied({ kind: "invalid_ticket" });
					return {
						ok: true,
						ticket: { id: active.id, expires_at: active.expiresAt },
					};
				}
				const expiresAt = now + 60_000;
				if (!Number.isSafeInteger(expiresAt))
					return denied({ kind: "invalid_request" });
				cleanupExpiredAdmissions(tx, context.client_id, now);
				const limitFailure = checkClientLimit(tx, context.client_id, now);
				if (limitFailure) return denied(limitFailure);
				const vaultLimitFailure = checkVaultLimit(tx, now);
				if (vaultLimitFailure) return denied(vaultLimitFailure);
				const id = nextAdmissionId(tx, () => this.ports.newTicketId());
				if (!id) return denied({ kind: "invalid_request" });
				tx.insert(operationAdmissions)
					.values({
						id,
						clientId: context.client_id,
						grantId: context.grant_id,
						epoch: currentEpoch,
						fingerprint: prepared.fingerprint,
						admittedAt: now,
						expiresAt,
						state: "active",
					})
					.run();
				return { ok: true, ticket: { id, expires_at: expiresAt } };
			});
		} catch (error) {
			if (error instanceof AdmissionDenied) return denied(error.failure);
			throw error;
		}
	}
}

type AdmissionRow = typeof operationAdmissions.$inferSelect;

/** Match every observed admission field so completion changes only the row that it read. */
function admissionRowPredicate(row: AdmissionRow) {
	return and(
		eq(operationAdmissions.id, row.id),
		eq(operationAdmissions.clientId, row.clientId),
		eq(operationAdmissions.grantId, row.grantId),
		eq(operationAdmissions.epoch, row.epoch),
		eq(operationAdmissions.fingerprint, row.fingerprint),
		eq(operationAdmissions.admittedAt, row.admittedAt),
		eq(operationAdmissions.expiresAt, row.expiresAt),
		eq(operationAdmissions.state, row.state),
	);
}

/** Check retained admission identity and deadline after a conditional uncertainty update. */
function sameAdmissionRow(
	actual: AdmissionRow,
	observed: AdmissionRow,
	state: AdmissionRow["state"],
): boolean {
	return (
		actual.id === observed.id &&
		actual.clientId === observed.clientId &&
		actual.grantId === observed.grantId &&
		actual.epoch === observed.epoch &&
		actual.fingerprint === observed.fingerprint &&
		actual.admittedAt === observed.admittedAt &&
		actual.expiresAt === observed.expiresAt &&
		actual.state === state
	);
}

/** Check revocation before epoch within the caller's transaction, then return the current epoch. */
function assertPolicy(
	tx: VaultTransaction,
	context: AuthorizationContext,
	operation: PreparedDescriptor | PreparedOperation,
): string {
	const revoked = tx
		.select({ grantId: revokedGrants.grantId })
		.from(revokedGrants)
		.where(eq(revokedGrants.grantId, context.grant_id))
		.all();
	if (revoked.length > 0) throw new AdmissionDenied({ kind: "revoked" });
	const epochRow = tx
		.select({ value: meta.value })
		.from(meta)
		.where(eq(meta.key, "epoch"))
		.all()[0];
	if (!epochRow) throw new Error("Missing vault epoch metadata");
	assertAdmissionAllowed(context, operation, epochRow.value);
	return epochRow.value;
}

/** Try at most eight canonical IDs and return the first value not in the ledger. */
function nextAdmissionId(
	tx: VaultTransaction,
	newTicketId: () => string,
): string | undefined {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const candidate = newTicketId();
		if (!OperationTicketSchema.shape.id.safeParse(candidate).success)
			return undefined;
		const existing = tx
			.select({ id: operationAdmissions.id })
			.from(operationAdmissions)
			.where(eq(operationAdmissions.id, candidate))
			.all();
		if (existing.length === 0) return candidate;
	}
	return undefined;
}

/** Delete all expired rows for this client, then at most 64 global expired rows. */
function cleanupExpiredAdmissions(
	tx: VaultTransaction,
	clientId: string,
	now: number,
): void {
	tx.delete(operationAdmissions)
		.where(
			and(
				eq(operationAdmissions.clientId, clientId),
				lte(operationAdmissions.expiresAt, now),
			),
		)
		.run();
	const globalIds = tx
		.select({ id: operationAdmissions.id })
		.from(operationAdmissions)
		.where(lte(operationAdmissions.expiresAt, now))
		.limit(64)
		.all()
		.map(({ id }) => id);
	if (globalIds.length > 0)
		tx.delete(operationAdmissions)
			.where(inArray(operationAdmissions.id, globalIds))
			.run();
}

/** Count this client's unexpired slots and return the bounded retry delay at capacity. */
function checkClientLimit(
	tx: VaultTransaction,
	clientId: string,
	now: number,
): AdmissionFailure | undefined {
	const live = tx
		.select({ value: count() })
		.from(operationAdmissions)
		.where(
			and(
				eq(operationAdmissions.clientId, clientId),
				gt(operationAdmissions.expiresAt, now),
			),
		)
		.all()[0]?.value;
	if (live === undefined)
		throw new Error("Admission count query returned no row");
	if (live < 16) return undefined;
	const earliest = tx
		.select({ expiresAt: operationAdmissions.expiresAt })
		.from(operationAdmissions)
		.where(
			and(
				eq(operationAdmissions.clientId, clientId),
				gt(operationAdmissions.expiresAt, now),
			),
		)
		.orderBy(asc(operationAdmissions.expiresAt))
		.limit(1)
		.all()[0]?.expiresAt;
	if (earliest === undefined)
		throw new Error("Admission expiry query returned no row");
	return {
		kind: "admission_limited",
		retry_after_seconds: Math.max(1, Math.ceil((earliest - now) / 1000)),
	};
}

/** Check the retained row limit before insertion and use the earliest expiry for a full vault. */
function checkVaultLimit(
	tx: VaultTransaction,
	now: number,
): AdmissionFailure | undefined {
	const cappedAdmissions = tx
		.select({ id: operationAdmissions.id })
		.from(operationAdmissions)
		.limit(MAX_VAULT_ADMISSIONS)
		.as("capped_admissions");
	const retainedCount = tx
		.select({ value: count() })
		.from(cappedAdmissions)
		.all()[0]?.value;
	if (retainedCount === undefined)
		throw new Error("Vault admission count query returned no row");
	if (retainedCount < MAX_VAULT_ADMISSIONS) return undefined;

	const earliestExpiry = tx
		.select({ expiresAt: operationAdmissions.expiresAt })
		.from(operationAdmissions)
		.orderBy(asc(operationAdmissions.expiresAt))
		.limit(1)
		.all()[0]?.expiresAt;
	if (earliestExpiry === undefined)
		throw new Error("Vault admission expiry query returned no row");
	return {
		kind: "admission_limited",
		retry_after_seconds: Math.max(1, Math.ceil((earliestExpiry - now) / 1_000)),
	};
}

function denied(
	failure: AdmissionFailure,
): RequestAdmissionResult & AdmissionResult {
	return { ok: false, failure };
}
