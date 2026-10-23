import type {
	AdmissionCompletion,
	AdmissionFailure,
	AdmissionFinishResult,
	AdmissionResult,
	AuthorizationContext,
	CurrentEpochOperation,
	CurrentEpochResult,
	OperationDescriptor,
	OperationIntent,
	RequestAdmissionResult,
} from "@obsidian-ai-bridge/protocol";
import {
	AuthorizationContextSchema,
	CurrentEpochRequestSchema,
	CurrentEpochResultSchema,
	EpochSchema,
	formatETag,
	IdempotencyKeySchema,
	OperationTicketSchema,
	parseETag,
	pathKey,
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
	requiredScope,
} from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";
import {
	type PreparedRenameSourceReservation,
	prepareRenameSourceReservation,
} from "@worker/application/history";
import {
	files,
	meta,
	mutationClaims,
	operationAdmissions,
	revokedGrants,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import type { Logger } from "drizzle-orm";
import { and, asc, count, eq, gt, inArray, lte } from "drizzle-orm";
import {
	type DrizzleSqliteDODatabase,
	drizzle,
} from "drizzle-orm/durable-sqlite";

/** Official inferred Drizzle callback type for synchronous SQLite work inside infrastructure. */
export type VaultTransaction = Parameters<
	Parameters<DrizzleSqliteDODatabase<typeof vaultSchema>["transaction"]>[0]
>[0];

/** Limit physical admission rows across all clients, grants, states, and expiry times. */
const MAX_VAULT_ADMISSIONS = 1_024;

/** SQLite admission entry points for one Durable Object's native storage. */
export class SqliteAdmissionAuthority {
	private readonly db;

	/** Create a Drizzle session over native storage and retain the authority's clock and ticket-ID ports. Schema bootstrap stays separate. */
	constructor(
		storage: DurableObjectStorage,
		private readonly ports: {
			now: () => number;
			newTicketId: () => string;
			logger?: Logger;
		},
	) {
		this.db = drizzle(storage, { schema: vaultSchema, logger: ports.logger });
	}

	/** Return the current epoch after revocation and operation-scope checks, without reserving a ticket. */
	async getCurrentEpoch(
		context: AuthorizationContext,
		operation: CurrentEpochOperation,
	): Promise<CurrentEpochResult> {
		const request = CurrentEpochRequestSchema.safeParse({ operation });
		const identity = AuthorizationContextSchema.safeParse(context);
		if (!request.success || !identity.success)
			return { ok: false, failure: { kind: "invalid_request" } };
		try {
			return this.db.transaction((tx) => {
				const revoked = tx
					.select({ grantId: revokedGrants.grantId })
					.from(revokedGrants)
					.where(eq(revokedGrants.grantId, identity.data.grant_id))
					.all();
				if (revoked.length > 0)
					return { ok: false, failure: { kind: "revoked" } };
				if (!identity.data.scopes.includes(requiredScope(operation)))
					return { ok: false, failure: { kind: "forbidden_scope" } };
				const row = tx
					.select({ value: meta.value })
					.from(meta)
					.where(eq(meta.key, "epoch"))
					.all()[0];
				if (!row) throw new Error("Missing vault epoch metadata");
				return CurrentEpochResultSchema.parse({
					ok: true,
					current_epoch: EpochSchema.parse(row.value),
				});
			});
		} catch (error) {
			if (error instanceof AdmissionDenied)
				return { ok: false, failure: error.failure };
			throw error;
		}
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
			return this.db.transaction((tx) =>
				this.reserveInTransaction(tx, context, prepared),
			);
		} catch (error) {
			if (error instanceof AdmissionDenied) return denied(error.failure);
			throw error;
		}
	}

	/** Reserve a validated source-only rename lease through the shared native limits. */
	reserveRenameSource(
		context: AuthorizationContext,
		prepared: PreparedRenameSourceReservation,
	): RequestAdmissionResult {
		return this.db.transaction((tx) =>
			this.reserveRenameSourceInTransaction(tx, context, prepared),
		);
	}

	/** Validate client, grant, scope, revocation, and observed epoch for a source lease. */
	assertRenameSourcePolicyInTransaction(
		tx: VaultTransaction,
		context: AuthorizationContext,
		prepared: PreparedRenameSourceReservation,
	): AuthorizationContext {
		const identity = AuthorizationContextSchema.safeParse(context);
		if (
			!identity.success ||
			identity.data.client_id !== prepared.context.client_id ||
			identity.data.grant_id !== prepared.context.grant_id
		)
			throw new AdmissionDenied({ kind: "invalid_request" });
		const revoked = tx
			.select({ grantId: revokedGrants.grantId })
			.from(revokedGrants)
			.where(eq(revokedGrants.grantId, identity.data.grant_id))
			.all();
		if (revoked.length > 0) throw new AdmissionDenied({ kind: "revoked" });
		if (!identity.data.scopes.includes("vault:write"))
			throw new AdmissionDenied({ kind: "forbidden_scope" });
		const epochRow = tx
			.select({ value: meta.value })
			.from(meta)
			.where(eq(meta.key, "epoch"))
			.all()[0];
		if (!epochRow) throw new Error("Missing vault epoch metadata");
		const currentEpoch = EpochSchema.parse(epochRow.value);
		if (currentEpoch !== prepared.epoch)
			throw new AdmissionDenied({
				kind: "epoch_mismatch",
				current_epoch: currentEpoch,
			});
		return identity.data;
	}

	/** Reserve a source lease in the caller transaction without treating it as a complete descriptor. */
	reserveRenameSourceInTransaction(
		tx: VaultTransaction,
		context: AuthorizationContext,
		prepared: PreparedRenameSourceReservation,
		allowStaleSource = false,
	): RequestAdmissionResult {
		let identity: AuthorizationContext;
		let currentEpoch: string;
		try {
			identity = this.assertRenameSourcePolicyInTransaction(
				tx,
				context,
				prepared,
			);
			currentEpoch = prepared.epoch;
		} catch (error) {
			if (error instanceof AdmissionDenied) return denied(error.failure);
			throw error;
		}
		const source = tx
			.select()
			.from(files)
			.where(eq(files.path, prepared.reservation.path))
			.all()[0];
		const expected = parseETag(prepared.reservation.if_match);
		if (
			expected.epoch !== currentEpoch ||
			(!allowStaleSource &&
				(!source || source.deleted === 1 || expected.rev !== source.rev))
		)
			return denied({ kind: "precondition_failed" });
		const now = this.ports.now();
		const expiresAt = now + 60_000;
		if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt))
			return denied({ kind: "invalid_request" });
		cleanupExpiredAdmissions(tx, identity.client_id, now);
		const clientLimit = checkClientLimit(tx, identity.client_id, now);
		if (clientLimit) return denied(clientLimit);
		const vaultLimit = checkVaultLimit(tx, now);
		if (vaultLimit) return denied(vaultLimit);
		const id = nextAdmissionId(tx, () => this.ports.newTicketId());
		if (!id) return denied({ kind: "invalid_request" });
		tx.insert(operationAdmissions)
			.values({
				id,
				clientId: identity.client_id,
				grantId: identity.grant_id,
				epoch: currentEpoch,
				fingerprint: prepared.fingerprint,
				admittedAt: now,
				expiresAt,
				state: "reserved",
			})
			.run();
		return { ok: true, lease: { admission_id: id, expires_at: expiresAt } };
	}

	/** Reserve one prepared descriptor inside the caller's transaction using the existing policy and limits. */
	reserveInTransaction(
		tx: VaultTransaction,
		context: AuthorizationContext,
		prepared: PreparedDescriptor,
	): RequestAdmissionResult {
		const currentEpoch = assertPolicyInTransaction(tx, context, prepared);
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
	}

	/** Delete only an observed admission that matches its client, grant, epoch, full fingerprint, and ID. */
	settleMatchingInTransaction(
		tx: VaultTransaction,
		context: AuthorizationContext,
		operation: PreparedOperation,
		ticketId: string,
	): void {
		const currentEpoch = assertPolicyInTransaction(tx, context, operation);
		const observed = tx
			.select()
			.from(operationAdmissions)
			.where(eq(operationAdmissions.id, ticketId))
			.all()[0];
		if (
			!observed ||
			operation.client_id !== context.client_id ||
			observed.id !== ticketId ||
			observed.clientId !== context.client_id ||
			observed.grantId !== context.grant_id ||
			observed.epoch !== currentEpoch ||
			observed.fingerprint !== operation.fingerprint
		)
			return;
		tx.delete(operationAdmissions).where(admissionRowPredicate(observed)).run();
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

	/** Bind a complete rename to its source lease and retain the original deadline. */
	async authorizeRenameSource(
		context: AuthorizationContext,
		intent: OperationIntent,
		admissionId: string,
		key?: string,
	): Promise<AdmissionResult> {
		let prepared: PreparedOperation;
		try {
			prepared = await prepareOperation(context, intent);
		} catch (error) {
			if (error instanceof AdmissionDenied) return denied(error.failure);
			throw error;
		}
		const sourcePath = prepared.intent.paths[0];
		if (
			prepared.intent.op !== "rename" ||
			!sourcePath ||
			prepared.intent.precondition.kind !== "match"
		)
			return denied({ kind: "invalid_request" });
		const sourceLease = await prepareRenameSourceReservation(context, {
			path: sourcePath,
			if_match: prepared.intent.precondition.etag,
			...(prepared.intent.epoch === undefined
				? {}
				: { epoch: prepared.intent.epoch }),
		});
		return this.db.transaction((tx) => {
			let currentEpoch: string;
			try {
				currentEpoch = assertPolicyInTransaction(tx, context, prepared);
			} catch (error) {
				if (error instanceof AdmissionDenied) return denied(error.failure);
				throw error;
			}
			const now = this.ports.now();
			if (key !== undefined && !IdempotencyKeySchema.safeParse(key).success)
				return denied({ kind: "invalid_request" });
			const claim = tx
				.select()
				.from(mutationClaims)
				.where(eq(mutationClaims.admissionId, admissionId))
				.all()[0];
			if (
				key === undefined
					? claim !== undefined
					: claim?.clientId !== context.client_id || claim.key !== key
			)
				return denied({ kind: "invalid_ticket" });
			const reserved = tx
				.select()
				.from(operationAdmissions)
				.where(eq(operationAdmissions.id, admissionId))
				.all()[0];
			if (
				!Number.isSafeInteger(now) ||
				!reserved ||
				reserved.clientId !== context.client_id ||
				reserved.grantId !== context.grant_id ||
				reserved.epoch !== currentEpoch ||
				reserved.fingerprint !== sourceLease.fingerprint ||
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
				const currentEpoch = assertPolicyInTransaction(tx, context, prepared);
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

	/** Check native policy, ticket identity, deadline, and key ownership without consuming the ticket. */
	assertActiveTicketInTransaction(
		tx: VaultTransaction,
		context: AuthorizationContext,
		operation: PreparedOperation,
		ticketId: string,
		key?: string,
	): void {
		const currentEpoch = assertPolicyInTransaction(tx, context, operation);
		const now = this.ports.now();
		const observed = tx
			.select()
			.from(operationAdmissions)
			.where(eq(operationAdmissions.id, ticketId))
			.all()[0];
		if (
			!Number.isSafeInteger(now) ||
			!observed ||
			observed.state !== "active" ||
			observed.clientId !== context.client_id ||
			observed.grantId !== context.grant_id ||
			observed.epoch !== currentEpoch ||
			observed.fingerprint !== operation.fingerprint ||
			observed.expiresAt <= now
		)
			throw new AdmissionDenied({ kind: "invalid_ticket" });
		if (key !== undefined && !IdempotencyKeySchema.safeParse(key).success)
			throw new AdmissionDenied({ kind: "invalid_request" });
		const claim = tx
			.select()
			.from(mutationClaims)
			.where(eq(mutationClaims.admissionId, ticketId))
			.all()[0];
		if (
			key === undefined
				? claim !== undefined
				: claim?.clientId !== context.client_id || claim.key !== key
		)
			throw new AdmissionDenied({ kind: "invalid_ticket" });
	}

	/** Check the authoritative file precondition without consuming its ticket. */
	assertPreconditionsInTransaction(
		tx: VaultTransaction,
		context: AuthorizationContext,
		operation: PreparedOperation,
	): void {
		const currentEpoch = assertPolicyInTransaction(tx, context, operation);
		const precondition = operation.intent.precondition;
		if (precondition.kind === "match") {
			const path = operation.intent.paths[0];
			if (path === undefined)
				throw new AdmissionDenied({ kind: "invalid_ticket" });
			const current = tx
				.select({
					rev: files.rev,
					hash: files.hash,
					deleted: files.deleted,
					content: files.content,
				})
				.from(files)
				.where(eq(files.path, path))
				.limit(1)
				.all()[0];
			if (!current) throw new AdmissionDenied({ kind: "precondition_failed" });
			const expectedTag = parseETag(precondition.etag);
			if (
				expectedTag.epoch !== currentEpoch ||
				expectedTag.rev !== current.rev
			) {
				throw new AdmissionDenied({
					kind: "precondition_failed",
					etag: formatETag(currentEpoch, current.rev),
					hash: current.hash,
					deleted: current.deleted === 1,
					...(context.scopes.includes("vault:read") &&
					current.deleted === 0 &&
					current.content !== null
						? { content: current.content }
						: {}),
				});
			}
			if (operation.intent.op === "put" && current.deleted === 1) {
				const alias = tx
					.select({ path: files.path })
					.from(files)
					.where(and(eq(files.pathKey, pathKey(path)), eq(files.deleted, 0)))
					.all()
					.find(({ path: existingPath }) => existingPath !== path);
				if (alias) {
					if (alias.path === null)
						throw new AdmissionDenied({ kind: "invalid_ticket" });
					throw new FileOperationDenied({
						kind: "path_collision",
						existing_path: alias.path,
					});
				}
			}
		} else if (precondition.kind === "absent") {
			const path = operation.intent.paths[0];
			if (path === undefined)
				throw new AdmissionDenied({ kind: "invalid_ticket" });
			const current = tx
				.select({
					path: files.path,
					rev: files.rev,
					hash: files.hash,
					deleted: files.deleted,
					content: files.content,
				})
				.from(files)
				.where(and(eq(files.pathKey, pathKey(path)), eq(files.deleted, 0)))
				.limit(1)
				.all()[0];
			if (current) {
				if (current.path === null)
					throw new AdmissionDenied({ kind: "invalid_ticket" });
				if (current.path !== path)
					throw new FileOperationDenied({
						kind: "path_collision",
						existing_path: current.path,
					});
				throw new AdmissionDenied({
					kind: "precondition_failed",
					etag: formatETag(currentEpoch, current.rev),
					hash: current.hash,
					deleted: current.deleted === 1,
					...(context.scopes.includes("vault:read") &&
					current.deleted === 0 &&
					current.content !== null
						? { content: current.content }
						: {}),
				});
			}
		}
	}

	/** Check policy, ticket ownership, expiry, fingerprint, and file preconditions in the caller transaction. */
	consumeInTransaction(
		tx: VaultTransaction,
		context: AuthorizationContext,
		operation: PreparedOperation,
		ticketId: string,
	): void {
		const currentEpoch = assertPolicyInTransaction(tx, context, operation);
		if (operation.intent.op === "read")
			throw new AdmissionDenied({ kind: "invalid_ticket" });
		const now = this.ports.now();
		if (!Number.isSafeInteger(now))
			throw new AdmissionDenied({ kind: "invalid_request" });

		const observed = tx
			.select()
			.from(operationAdmissions)
			.where(eq(operationAdmissions.id, ticketId))
			.all()[0];
		if (
			observed?.state !== "active" ||
			observed.clientId !== context.client_id ||
			observed.grantId !== context.grant_id ||
			observed.epoch !== currentEpoch ||
			observed.fingerprint !== operation.fingerprint ||
			observed.expiresAt <= now
		)
			throw new AdmissionDenied({ kind: "invalid_ticket" });

		this.assertPreconditionsInTransaction(tx, context, operation);

		const consumed = tx
			.delete(operationAdmissions)
			.where(admissionRowPredicate(observed))
			.returning({ id: operationAdmissions.id })
			.all();
		if (consumed.length !== 1)
			throw new AdmissionDenied({ kind: "invalid_ticket" });
	}

	/** Persist one grant revocation without changing its first timestamp. */
	recordRevocation(grantId: string): void {
		if (!AuthorizationContextSchema.shape.grant_id.safeParse(grantId).success)
			throw new AdmissionDenied({ kind: "invalid_request" });
		const at = this.ports.now();
		if (!Number.isSafeInteger(at))
			throw new AdmissionDenied({ kind: "invalid_request" });
		this.db.transaction((tx) => {
			tx.insert(revokedGrants)
				.values({ grantId, at })
				.onConflictDoNothing({ target: revokedGrants.grantId })
				.run();
		});
	}
}

/** Drizzle-inferred persisted row used to condition changes on observed ledger values. */
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
export function assertPolicyInTransaction(
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

/** Build a typed refusal from a known failure. Callers propagate other exceptions. */
function denied(
	failure: AdmissionFailure,
): RequestAdmissionResult & AdmissionResult {
	return { ok: false, failure };
}
