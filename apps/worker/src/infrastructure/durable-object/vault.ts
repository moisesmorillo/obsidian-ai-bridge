import { DurableObject } from "cloudflare:workers";
import type {
	AdmissionCompletion,
	AdmissionFinishResult,
	AdmissionResult,
	AuthorizationContext,
	OperationDescriptor,
	OperationIntent,
	RequestAdmissionResult,
} from "@obsidian-ai-bridge/protocol";
import type { Env } from "@worker/env";
import { SqliteAdmissionAuthority } from "@worker/infrastructure/sqlite/admission";
import {
	generateEpoch,
	initializeVaultStorage,
} from "@worker/infrastructure/sqlite/schema";

/** SQLite-backed authority for one isolated vault id. */
export class Vault extends DurableObject<Env> {
	private readonly admissionAuthority: SqliteAdmissionAuthority;

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
	}

	/** Reserve request capacity before the Worker reads or buffers a body. */
	reserveAdmission(
		context: AuthorizationContext,
		descriptor: OperationDescriptor,
	): Promise<RequestAdmissionResult> {
		return this.admissionAuthority.reserve(context, descriptor);
	}

	/** Close an owned admission after a known or uncertain operation outcome. */
	finishAdmission(
		context: AuthorizationContext,
		ticketId: string,
		completion: AdmissionCompletion,
	): AdmissionFinishResult {
		return this.admissionAuthority.finish(context, ticketId, completion);
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
