import { DurableObject } from "cloudflare:workers";
import type {
	AdmissionCompletion,
	AdmissionFinishResult,
	AdmissionResult,
	AuthorizationContext,
	CurrentEpochOperation,
	CurrentEpochResult,
	HistoryRequest,
	IdempotencyKey,
	OperationDescriptor,
	OperationIntent,
	RenameReservation,
	RequestAdmissionResult,
	TextMutationBeginResult,
	TextMutationIntent,
	TextMutationResult,
	TextReadRequest,
	TextReadResult,
} from "@obsidian-ai-bridge/protocol";
import type { ImmutableFileCommand } from "@worker/application/history";
import type { Env } from "@worker/env";
import { SqliteAdmissionAuthority } from "@worker/infrastructure/sqlite/admission";
import { SqliteMutationCoordinator } from "@worker/infrastructure/sqlite/mutations";
import {
	generateEpoch,
	initializeVaultStorage,
} from "@worker/infrastructure/sqlite/schema";
import { SqliteTextStore } from "@worker/infrastructure/sqlite/text-files";

/** SQLite-backed authority for one isolated vault id. */
export class Vault extends DurableObject<Env> {
	private readonly admissionAuthority: SqliteAdmissionAuthority;
	private readonly mutationCoordinator: SqliteMutationCoordinator;
	private readonly textStore: SqliteTextStore;

	/**
	 * The constructor creates fresh storage or validates existing storage synchronously in one transaction.
	 * It throws on incompatible state without repair or identity replacement.
	 *
	 * It then wires shared admission, mutation coordination, and inline text operations.
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		initializeVaultStorage(
			ctx.storage,
			() =>
				generateEpoch((bytes) => {
					bytes.set(crypto.getRandomValues(new Uint8Array(16)));
					return bytes;
				}),
			Date.now,
		);
		this.admissionAuthority = new SqliteAdmissionAuthority(ctx.storage, {
			now: Date.now,
			newTicketId: () =>
				Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join(""),
		});
		this.mutationCoordinator = new SqliteMutationCoordinator(
			ctx.storage,
			this.admissionAuthority,
			{ now: Date.now },
		);
		this.textStore = new SqliteTextStore(
			ctx.storage,
			this.mutationCoordinator,
			{
				now: Date.now,
			},
		);
	}

	/** Read current epoch metadata after current revocation and operation scope checks. */
	getCurrentEpoch(
		context: AuthorizationContext,
		operation: CurrentEpochOperation,
	): Promise<CurrentEpochResult> {
		return this.admissionAuthority.getCurrentEpoch(context, operation);
	}

	/** Reserve request capacity before the Worker reads or buffers a body. */
	reserveAdmission(
		context: AuthorizationContext,
		descriptor: OperationDescriptor,
	): Promise<RequestAdmissionResult> {
		return this.admissionAuthority.reserve(context, descriptor);
	}

	/** Start a keyed or unkeyed text mutation admission. */
	beginMutation(
		context: AuthorizationContext,
		descriptor: OperationDescriptor,
		key?: IdempotencyKey,
	): Promise<TextMutationBeginResult> {
		return this.textStore.beginMutation(context, descriptor, key);
	}

	/** Reserve source capacity before a rename body reveals its destination. */
	beginRenameSource(
		context: AuthorizationContext,
		reservation: RenameReservation,
		key?: IdempotencyKey,
	): Promise<TextMutationBeginResult> {
		return this.textStore.beginRenameSource(context, reservation, key);
	}

	/** Publish validated inline text through the atomic SQLite coordinator. */
	commitText(
		context: AuthorizationContext,
		intent: TextMutationIntent,
		ticketId: string,
		content: string | undefined,
		key?: IdempotencyKey,
	): Promise<TextMutationResult> {
		return this.textStore.commitText(context, intent, ticketId, content, key);
	}

	/** Commit a native rename, append, or restore command through the SQLite history owner. */
	commitFileCommand(
		context: AuthorizationContext,
		intent: OperationIntent,
		ticketId: string,
		command: ImmutableFileCommand,
		key?: IdempotencyKey,
	): Promise<TextMutationResult> {
		return this.textStore.commitFileCommand(
			context,
			intent,
			ticketId,
			command,
			key,
		);
	}

	/** Read retained content-free revision metadata after native policy checks. */
	readHistory(context: AuthorizationContext, request: HistoryRequest) {
		return this.textStore.readHistory(context, request);
	}

	/** Read current or selected historical inline text. */
	readText(
		context: AuthorizationContext,
		request: TextReadRequest,
	): Promise<TextReadResult> {
		return this.textStore.readText(context, request);
	}

	/** Close an owned admission after a known or uncertain operation outcome. */
	finishAdmission(
		context: AuthorizationContext,
		ticketId: string,
		completion: AdmissionCompletion,
	): AdmissionFinishResult {
		return this.admissionAuthority.finish(context, ticketId, completion);
	}

	/** Bind a complete rename command to its source-only capacity lease. */
	authorizeRenameSource(
		context: AuthorizationContext,
		intent: OperationIntent,
		admissionId: string,
		key?: string,
	): Promise<AdmissionResult> {
		return this.admissionAuthority.authorizeRenameSource(
			context,
			intent,
			admissionId,
			key,
		);
	}

	/** Authorize a complete bounded intent, optionally binding a prior reservation. */
	authorize(
		context: AuthorizationContext,
		intent: OperationIntent,
		admissionId?: string,
	): Promise<AdmissionResult> {
		return this.admissionAuthority.authorize(context, intent, admissionId);
	}
}
