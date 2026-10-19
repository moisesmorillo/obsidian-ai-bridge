import type {
	AuthorizationContext,
	IdempotencyKey,
	MutationReceipt,
	OperationDescriptor,
	RenameReservation,
	TextMutationBeginResult,
	TextMutationResult,
} from "@obsidian-ai-bridge/protocol";
import {
	IdempotencyKeySchema,
	MutationReceiptSchema,
} from "@obsidian-ai-bridge/protocol";
import {
	AdmissionDenied,
	type PreparedDescriptor,
	type PreparedOperation,
	prepareDescriptor,
} from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";
import {
	type PreparedRenameSourceReservation,
	prepareRenameSourceReservation,
} from "@worker/application/history";
import { assertIdempotencyWindow } from "@worker/application/idempotency";
import {
	assertPolicyInTransaction,
	type SqliteAdmissionAuthority,
	type VaultTransaction,
} from "@worker/infrastructure/sqlite/admission";
import {
	mutationClaims,
	operationAdmissions,
	receipts,
	vaultSchema,
} from "@worker/infrastructure/sqlite/schema-model";
import type { Logger } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

/** Stores the native dependencies for atomic mutation coordination. */
export class SqliteMutationCoordinator {
	/** Create a synchronous Drizzle session for durable mutation claims, receipts, and publication. */
	constructor(
		storage: DurableObjectStorage,
		private readonly admissions: SqliteAdmissionAuthority,
		private readonly ports: { now: () => number; logger?: Logger },
	) {
		this.db = drizzle(storage, { schema: vaultSchema, logger: ports.logger });
	}

	private readonly db;

	/** Validate a descriptor and reserve its admission with an optional durable key claim. */
	async beginMutation(
		context: AuthorizationContext,
		descriptor: OperationDescriptor,
		key?: IdempotencyKey,
	): Promise<TextMutationBeginResult> {
		if (key === undefined) return this.admissions.reserve(context, descriptor);
		if (!IdempotencyKeySchema.safeParse(key).success)
			return { ok: false, failure: { kind: "invalid_request" } };

		let prepared: PreparedDescriptor;
		try {
			prepared = await prepareDescriptor(context, descriptor);
		} catch (error) {
			if (error instanceof AdmissionDenied)
				return { ok: false, failure: error.failure };
			throw error;
		}

		try {
			return this.db.transaction((tx) => {
				try {
					assertPolicyInTransaction(tx, context, prepared);
				} catch (error) {
					if (error instanceof AdmissionDenied)
						return { ok: false, failure: error.failure };
					throw error;
				}

				const now = this.ports.now();
				if (!Number.isSafeInteger(now))
					return { ok: false, failure: { kind: "invalid_request" } };
				const priorReceipt = tx
					.select({ key: receipts.key })
					.from(receipts)
					.where(
						and(
							eq(receipts.clientId, context.client_id),
							eq(receipts.key, key),
						),
					)
					.all()[0];
				if (!priorReceipt) {
					try {
						assertIdempotencyWindow(key, now);
					} catch (error) {
						if (error instanceof FileOperationDenied)
							return { ok: false, failure: error.failure };
						throw error;
					}
				}

				const priorClaim = tx
					.select()
					.from(mutationClaims)
					.where(
						and(
							eq(mutationClaims.clientId, context.client_id),
							eq(mutationClaims.key, key),
						),
					)
					.all()[0];
				if (priorClaim) {
					const owner = tx
						.select()
						.from(operationAdmissions)
						.where(eq(operationAdmissions.id, priorClaim.admissionId))
						.all()[0];
					if (
						!owner ||
						owner.clientId !== context.client_id ||
						owner.grantId !== context.grant_id
					)
						return {
							ok: false,
							failure: { kind: "invalid_ticket" },
						};
					if (owner.expiresAt > now)
						return {
							ok: false,
							failure: { kind: "idempotency_in_progress" },
						};
				}

				const reservation = this.admissions.reserveInTransaction(
					tx,
					context,
					prepared,
				);
				if (!reservation.ok) return reservation;
				tx.insert(mutationClaims)
					.values({
						clientId: context.client_id,
						key,
						admissionId: reservation.lease.admission_id,
					})
					.run();
				return reservation;
			});
		} catch (error) {
			if (error instanceof AdmissionDenied)
				return { ok: false, failure: error.failure };
			throw error;
		}
	}

	/** Reserve a source-only rename lease and optional key claim before reading the destination body. */
	async beginRenameSource(
		context: AuthorizationContext,
		reservation: RenameReservation,
		key?: IdempotencyKey,
	): Promise<TextMutationBeginResult> {
		let prepared: PreparedRenameSourceReservation;
		try {
			prepared = await prepareRenameSourceReservation(context, reservation);
		} catch (error) {
			if (error instanceof AdmissionDenied)
				return { ok: false, failure: error.failure };
			throw error;
		}
		if (key === undefined)
			return this.admissions.reserveRenameSource(context, prepared);
		if (!IdempotencyKeySchema.safeParse(key).success)
			return { ok: false, failure: { kind: "invalid_request" } };
		return this.db.transaction((tx) => {
			try {
				this.admissions.assertRenameSourcePolicyInTransaction(
					tx,
					context,
					prepared,
				);
			} catch (error) {
				if (error instanceof AdmissionDenied)
					return { ok: false, failure: error.failure };
				throw error;
			}
			const now = this.ports.now();
			if (!Number.isSafeInteger(now))
				return { ok: false, failure: { kind: "invalid_request" } };
			const priorReceipt = tx
				.select({ key: receipts.key })
				.from(receipts)
				.where(
					and(eq(receipts.clientId, context.client_id), eq(receipts.key, key)),
				)
				.all()[0];
			if (!priorReceipt) {
				try {
					assertIdempotencyWindow(key, now);
				} catch (error) {
					if (error instanceof FileOperationDenied)
						return { ok: false, failure: error.failure };
					throw error;
				}
			}
			const priorClaim = tx
				.select()
				.from(mutationClaims)
				.where(
					and(
						eq(mutationClaims.clientId, context.client_id),
						eq(mutationClaims.key, key),
					),
				)
				.all()[0];
			if (priorClaim) {
				const owner = tx
					.select()
					.from(operationAdmissions)
					.where(eq(operationAdmissions.id, priorClaim.admissionId))
					.all()[0];
				if (
					!owner ||
					owner.clientId !== context.client_id ||
					owner.grantId !== context.grant_id
				)
					return { ok: false, failure: { kind: "invalid_ticket" } };
				if (owner.expiresAt > now)
					return { ok: false, failure: { kind: "idempotency_in_progress" } };
			}
			const result = this.admissions.reserveRenameSourceInTransaction(
				tx,
				context,
				prepared,
				priorReceipt !== undefined,
			);
			if (!result.ok) return result;
			tx.insert(mutationClaims)
				.values({
					clientId: context.client_id,
					key,
					admissionId: result.lease.admission_id,
				})
				.run();
			return result;
		});
	}

	/** Return an existing same-key receipt before append reads current file state. */
	replayIfPresent(
		context: AuthorizationContext,
		operation: PreparedOperation,
		ticketId: string,
		key: IdempotencyKey,
	): TextMutationResult | undefined {
		return this.db.transaction((tx) => {
			try {
				assertPolicyInTransaction(tx, context, operation);
			} catch (error) {
				if (error instanceof AdmissionDenied)
					return { ok: false, failure: error.failure };
				throw error;
			}
			return this.replayReceiptInTransaction(
				tx,
				context,
				operation,
				ticketId,
				key,
			);
		});
	}

	/** Replay one canonical receipt and settle only its matching current ticket claim. */
	private replayReceiptInTransaction(
		tx: VaultTransaction,
		context: AuthorizationContext,
		operation: PreparedOperation,
		ticketId: string,
		key: IdempotencyKey,
	): TextMutationResult | undefined {
		const stored = tx
			.select()
			.from(receipts)
			.where(
				and(eq(receipts.clientId, context.client_id), eq(receipts.key, key)),
			)
			.all()[0];
		if (!stored) return undefined;
		const response = MutationReceiptSchema.parse({
			status: stored.status,
			body: JSON.parse(stored.body),
		});
		if (stored.fingerprint !== operation.fingerprint)
			return { ok: false, failure: { kind: "idempotency_mismatch" } };
		const claim = tx
			.select()
			.from(mutationClaims)
			.where(
				and(
					eq(mutationClaims.clientId, context.client_id),
					eq(mutationClaims.key, key),
				),
			)
			.all()[0];
		if (claim?.admissionId === ticketId)
			this.admissions.settleMatchingInTransaction(
				tx,
				context,
				operation,
				ticketId,
			);
		return { ok: true, response };
	}

	/** Recheck active ticket and key ownership before a bounded append reads current text. */
	assertActiveTicketInTransaction(
		tx: VaultTransaction,
		context: AuthorizationContext,
		operation: PreparedOperation,
		ticketId: string,
		key?: IdempotencyKey,
	): void {
		this.admissions.assertActiveTicketInTransaction(
			tx,
			context,
			operation,
			ticketId,
			key,
		);
	}

	/** Recheck current policy and active ticket before a blob adapter performs asynchronous metadata I/O. */
	preflight(
		context: AuthorizationContext,
		operation: PreparedOperation,
		ticketId: string,
		key?: IdempotencyKey,
	): TextMutationResult | undefined {
		return this.db.transaction((tx) => {
			try {
				assertPolicyInTransaction(tx, context, operation);
			} catch (error) {
				if (error instanceof AdmissionDenied)
					return { ok: false, failure: error.failure };
				throw error;
			}
			if (key !== undefined) {
				const replay = this.replayReceiptInTransaction(
					tx,
					context,
					operation,
					ticketId,
					key,
				);
				if (replay) return replay;
			}
			try {
				this.admissions.assertActiveTicketInTransaction(
					tx,
					context,
					operation,
					ticketId,
					key,
				);
			} catch (error) {
				if (
					error instanceof AdmissionDenied ||
					error instanceof FileOperationDenied
				)
					return { ok: false, failure: error.failure };
				throw error;
			}
			return undefined;
		});
	}

	/** Check policy, replay receipts, and atomically consume, publish, and store successful results. */
	commit(
		context: AuthorizationContext,
		operation: PreparedOperation,
		ticketId: string,
		key: IdempotencyKey | undefined,
		publish: (tx: VaultTransaction) => MutationReceipt,
	): TextMutationResult {
		return this.db.transaction((tx) => {
			let currentEpoch: string;
			try {
				currentEpoch = assertPolicyInTransaction(tx, context, operation);
			} catch (error) {
				if (error instanceof AdmissionDenied)
					return { ok: false, failure: error.failure };
				throw error;
			}

			if (key !== undefined && !IdempotencyKeySchema.safeParse(key).success)
				return { ok: false, failure: { kind: "invalid_request" } };
			const now = this.ports.now();
			if (key !== undefined) {
				const replay = this.replayReceiptInTransaction(
					tx,
					context,
					operation,
					ticketId,
					key,
				);
				if (replay) return replay;
				try {
					assertIdempotencyWindow(key, now);
				} catch (error) {
					if (error instanceof FileOperationDenied)
						return { ok: false, failure: error.failure };
					throw error;
				}
				const claim = tx
					.select()
					.from(mutationClaims)
					.where(
						and(
							eq(mutationClaims.clientId, context.client_id),
							eq(mutationClaims.key, key),
						),
					)
					.all()[0];
				if (!claim || claim.admissionId !== ticketId)
					return { ok: false, failure: { kind: "invalid_ticket" } };
				const owner = tx
					.select()
					.from(operationAdmissions)
					.where(eq(operationAdmissions.id, ticketId))
					.all()[0];
				if (
					!owner ||
					owner.clientId !== context.client_id ||
					owner.grantId !== context.grant_id ||
					owner.epoch !== currentEpoch ||
					owner.state !== "active"
				)
					return { ok: false, failure: { kind: "invalid_ticket" } };
				if (owner.fingerprint !== operation.fingerprint)
					return { ok: false, failure: { kind: "idempotency_mismatch" } };
			}

			try {
				this.admissions.assertActiveTicketInTransaction(
					tx,
					context,
					operation,
					ticketId,
					key,
				);
				this.admissions.consumeInTransaction(tx, context, operation, ticketId);
			} catch (error) {
				if (
					error instanceof AdmissionDenied ||
					error instanceof FileOperationDenied
				)
					return { ok: false, failure: error.failure };
				throw error;
			}

			const response = MutationReceiptSchema.parse(publish(tx));
			if (key !== undefined) {
				tx.insert(receipts)
					.values({
						clientId: context.client_id,
						key,
						fingerprint: operation.fingerprint,
						status: response.status,
						body: JSON.stringify(response.body),
						at: now,
					})
					.run();
			}
			return { ok: true, response };
		});
	}
}
