import { DurableObject } from "cloudflare:workers";
import type {
	AdmissionCompletion,
	AdmissionFinishResult,
	AdmissionResult,
	AuthorizationContext,
	CurrentEpochOperation,
	CurrentEpochResult,
	FileFailure,
	HistoryRequest,
	HistoryUpperResponse,
	IdempotencyKey,
	MetadataBatchRequest,
	MetadataBatchResponse,
	OperationDescriptor,
	OperationIntent,
	RenameReservation,
	SearchRequest,
	SearchResponse,
	TextMutationBeginResult,
	TextMutationIntent,
	TextMutationResult,
	TextReadRequest,
	TextReadResult,
	VaultReadResponse,
} from "@obsidian-ai-bridge/protocol";
import {
	BeginClientConsentRequestSchema,
	ListClientGrantsRequestSchema,
	ListClientGrantsResultSchema,
	ListClientsRequestSchema,
	ListClientsResultSchema,
	OwnerCsrfConsumeRequestSchema,
	RegisterClientGrantRequestSchema,
	RenameClientRequestSchema,
	RevokeClientRequestSchema,
} from "@obsidian-ai-bridge/protocol";
import { AdmissionDenied } from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";
import type { ImmutableFileCommand } from "@worker/application/history";
import type { Env } from "@worker/env";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { SqliteAdmissionAuthority } from "@worker/infrastructure/sqlite/admission";
import { SqliteClientRegistry } from "@worker/infrastructure/sqlite/clients";
import { SqliteMutationCoordinator } from "@worker/infrastructure/sqlite/mutations";
import { SqliteReadStore } from "@worker/infrastructure/sqlite/reads";
import { SqliteRetentionStore } from "@worker/infrastructure/sqlite/retention";
import {
	generateEpoch,
	initializeVaultStorage,
} from "@worker/infrastructure/sqlite/schema";
import { SqliteSearchStore } from "@worker/infrastructure/sqlite/search";
import { SqliteTextStore } from "@worker/infrastructure/sqlite/text-files";

/** Return structured native policy failures and propagate uncertain storage faults. */
function nativeReadFailure(error: unknown): {
	ok: false;
	failure: FileFailure;
} {
	if (error instanceof AdmissionDenied || error instanceof FileOperationDenied)
		return { ok: false, failure: error.failure };
	throw error;
}

/** Delay between bounded maintenance batches after an alarm finds more work. */
const RETENTION_CONTINUATION_MS = 60_000;
/** UTC hour for the next full retention cycle after a batch completes. */
const RETENTION_NIGHTLY_HOUR_UTC = 3;

/** Return the next 03:00 UTC maintenance deadline, never the current instant. */
function nextRetentionNightly(now: number): number {
	const next = new Date(now);
	next.setUTCHours(RETENTION_NIGHTLY_HOUR_UTC, 0, 0, 0);
	if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
	return next.getTime();
}

/** SQLite-backed authority and alarm owner for one isolated vault id. */
export class Vault extends DurableObject<Env> {
	/** Blocks request dispatch until fresh native alarm scheduling completes. */
	private readonly initialization: Promise<void>;
	private readonly admissionAuthority: SqliteAdmissionAuthority;
	private readonly clientRegistry: SqliteClientRegistry;
	private readonly mutationCoordinator: SqliteMutationCoordinator;
	private readonly textStore: SqliteTextStore;
	private readonly readStore: SqliteReadStore;
	private readonly searchStore: SqliteSearchStore;
	/** Applies one bounded SQLite retention batch for each native alarm. */
	private readonly retentionStore: SqliteRetentionStore;

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
		this.clientRegistry = new SqliteClientRegistry(ctx.storage, Date.now);
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
		this.readStore = new SqliteReadStore(ctx.storage, this.admissionAuthority, {
			now: Date.now,
		});
		this.searchStore = new SqliteSearchStore(
			ctx.storage,
			this.admissionAuthority,
		);
		this.retentionStore = new SqliteRetentionStore(ctx.storage);
		this.initialization = ctx.blockConcurrencyWhile(async () => {
			if ((await ctx.storage.getAlarm()) === null)
				await ctx.storage.setAlarm(nextRetentionNightly(Date.now()));
		});
		this.textStore = new SqliteTextStore(
			ctx.storage,
			this.mutationCoordinator,
			{
				now: Date.now,
				blobStore: new R2BlobStore(env.R2_BUCKET),
				admissions: this.admissionAuthority,
			},
		);
	}

	/** Run one retention transaction and schedule continuation or the next nightly cycle.
	 * A future export owner must join this native alarm dispatch and choose its next deadline.
	 */
	async alarm(): Promise<void> {
		await this.initialization;
		const now = Date.now();
		const result = this.retentionStore.runBatch(now);
		await this.ctx.storage.setAlarm(
			result.more ? now + RETENTION_CONTINUATION_MS : nextRetentionNightly(now),
		);
	}

	/** Persist a pending owner consent fence for the supplied client. */
	beginClientConsent(ownerSubject: string, clientId: string, name: string) {
		const request = BeginClientConsentRequestSchema.parse({
			owner_subject: ownerSubject,
			client_id: clientId,
		});
		return this.clientRegistry.beginClientConsent(
			request.owner_subject,
			request.client_id,
			name,
		);
	}

	/** Register a provider grant only while its consent generation remains current. */
	registerClientGrant(input: unknown): boolean {
		const request = RegisterClientGrantRequestSchema.parse(input);
		return this.clientRegistry.registerClientGrant(request);
	}

	/** Return a bounded page of clients for the configured owner. */
	listClients(ownerSubject: string, cursor?: string) {
		const request = ListClientsRequestSchema.parse({
			owner_subject: ownerSubject,
			cursor,
		});
		return ListClientsResultSchema.parse(
			this.clientRegistry.listClients(request.owner_subject, request.cursor),
		);
	}

	/** List one bounded grant page for an owner-selected client. */
	listClientGrants(ownerSubject: string, clientId: string, cursor?: string) {
		const request = ListClientGrantsRequestSchema.parse({
			owner_subject: ownerSubject,
			client_id: clientId,
			cursor,
		});
		return ListClientGrantsResultSchema.parse(
			this.clientRegistry.listClientGrants(
				request.owner_subject,
				request.client_id,
				request.cursor,
			),
		);
	}

	/** Rename one client owned by the verified subject. */
	renameClient(ownerSubject: string, clientId: string, name: string): boolean {
		const request = RenameClientRequestSchema.parse({
			owner_subject: ownerSubject,
			client_id: clientId,
			name,
		});
		return this.clientRegistry.renameClient(
			request.owner_subject,
			request.client_id,
			request.name,
		);
	}

	/** Close the current generation and insert all grant denials in one transaction. */
	revokeClient(ownerSubject: string, clientId: string) {
		const request = RevokeClientRequestSchema.parse({
			owner_subject: ownerSubject,
			client_id: clientId,
		});
		return this.clientRegistry.revokeClient(
			request.owner_subject,
			request.client_id,
		);
	}

	/** Confirm one grant cleanup after the provider removes it. */
	markGrantCleanupComplete(clientId: string, grantId: string): void {
		this.clientRegistry.markGrantCleanupComplete(clientId, grantId);
	}

	/** Persist a short-lived browser-bound owner form state. */
	storeOwnerCsrf(input: unknown): void {
		this.clientRegistry.storeOwnerCsrf(input);
	}

	/** Consume one owner form state once for its bound browser and subject. */
	consumeOwnerCsrf(input: unknown): boolean {
		return this.clientRegistry.consumeOwnerCsrf(
			OwnerCsrfConsumeRequestSchema.parse(input),
		);
	}

	/** Read current epoch metadata after current revocation and operation scope checks. */
	getCurrentEpoch(
		context: AuthorizationContext,
		operation: CurrentEpochOperation,
	): Promise<CurrentEpochResult> {
		return this.admissionAuthority.getCurrentEpoch(context, operation);
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

	/** Return aggregate metadata or a canonical known policy failure across Durable Object RPC. */
	async readVault(
		context: AuthorizationContext,
		admissionId: string,
	): Promise<VaultReadResponse> {
		try {
			return {
				ok: true,
				body: await this.readStore.readVault(context, admissionId),
			};
		} catch (error) {
			return nativeReadFailure(error);
		}
	}

	/** Capture a path's history ceiling or return a canonical known policy failure. */
	async readHistoryUpper(
		context: AuthorizationContext,
		admissionId: string,
		path: string,
	): Promise<HistoryUpperResponse> {
		try {
			return {
				ok: true,
				body: await this.readStore.readHistoryUpper(context, admissionId, path),
			};
		} catch (error) {
			return nativeReadFailure(error);
		}
	}

	/** Read one bounded metadata batch or return its canonical known policy failure. */
	async readBatch(
		context: AuthorizationContext,
		request: MetadataBatchRequest,
		admissionId: string,
	): Promise<MetadataBatchResponse> {
		try {
			return {
				ok: true,
				body: await this.readStore.readBatch(context, request, admissionId),
			};
		} catch (error) {
			return nativeReadFailure(error);
		}
	}

	/** Run literal Markdown search and return canonical policy failures across RPC. */
	async search(
		context: AuthorizationContext,
		request: SearchRequest,
		admissionId: string,
	): Promise<SearchResponse> {
		try {
			return {
				ok: true,
				body: await this.searchStore.search(context, request, admissionId),
			};
		} catch (error) {
			return nativeReadFailure(error);
		}
	}

	/** Read retained content-free revision metadata after native policy checks. */
	readHistory(context: AuthorizationContext, request: HistoryRequest) {
		return this.textStore.readHistory(context, request);
	}

	/** Authorize declared bytes or replay a matching current-policy receipt in one authority call. */
	authorizeBlob(
		context: AuthorizationContext,
		intent: TextMutationIntent,
		admissionId: string,
		key?: IdempotencyKey,
	) {
		return this.mutationCoordinator.authorizeBlob(
			context,
			intent,
			admissionId,
			key,
		);
	}

	/** Verify storage evidence and atomically publish a blob reference. */
	commitBlob(
		context: AuthorizationContext,
		intent: TextMutationIntent,
		ticketId: string,
		key?: IdempotencyKey,
	): Promise<TextMutationResult> {
		return this.textStore.commitBlob(context, intent, ticketId, key);
	}

	/** Select blob metadata under current policy and the optional response ticket. Public HTTP reads always supply that ticket. */
	readBlobMetadata(
		context: AuthorizationContext,
		request: TextReadRequest,
		admissionId?: string,
	) {
		return this.textStore.readBlobMetadata(context, request, admissionId);
	}

	/** Select inline text under current policy and the optional response ticket. Public HTTP reads always supply that ticket. */
	readText(
		context: AuthorizationContext,
		request: TextReadRequest,
		admissionId?: string,
	): Promise<TextReadResult> {
		return this.textStore.readText(context, request, admissionId);
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
