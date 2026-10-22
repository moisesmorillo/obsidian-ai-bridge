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
	RequestAdmissionResult,
	SearchRequest,
	SearchResponse,
	TextMutationBeginResult,
	TextMutationIntent,
	TextMutationResult,
	TextReadRequest,
	TextReadResult,
	VaultReadResponse,
} from "@obsidian-ai-bridge/protocol";
import { AdmissionDenied } from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";
import type { ImmutableFileCommand } from "@worker/application/history";
import type { Env } from "@worker/env";
import { R2BlobStore } from "@worker/infrastructure/r2/blobs";
import { SqliteAdmissionAuthority } from "@worker/infrastructure/sqlite/admission";
import { SqliteMutationCoordinator } from "@worker/infrastructure/sqlite/mutations";
import { SqliteReadStore } from "@worker/infrastructure/sqlite/reads";
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

/** SQLite-backed authority for one isolated vault id. */
export class Vault extends DurableObject<Env> {
	private readonly admissionAuthority: SqliteAdmissionAuthority;
	private readonly mutationCoordinator: SqliteMutationCoordinator;
	private readonly textStore: SqliteTextStore;
	private readonly readStore: SqliteReadStore;
	private readonly searchStore: SqliteSearchStore;

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
		this.readStore = new SqliteReadStore(ctx.storage, this.admissionAuthority, {
			now: Date.now,
		});
		this.searchStore = new SqliteSearchStore(
			ctx.storage,
			this.admissionAuthority,
		);
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
