import type {
	AdmissionResult,
	AuthorizationContext,
	SearchRequest,
	SearchResponse,
	SearchResult,
} from "@obsidian-ai-bridge/protocol";
import {
	EMPTY_PAYLOAD_HASH,
	SearchRequestSchema,
} from "@obsidian-ai-bridge/protocol";
import { AdmissionDenied } from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";
import { assertReadDemand, ReadAborted } from "@worker/application/read-demand";
import type { ReadOutcome, ReadVaultGateway } from "@worker/application/reads";
import { createReadSession } from "@worker/application/reads";

/** Native search gateway operations that extend the shared read authority. */
export interface SearchVaultGateway extends ReadVaultGateway {
	/** Select bounded literal search results under the active read ticket. */
	search(
		context: AuthorizationContext,
		request: SearchRequest,
		admissionId: string,
	): Promise<SearchResponse>;
}

/** Authorize search with a body-free read ticket and return response ownership. */
export async function readSearch(
	gateway: SearchVaultGateway,
	context: AuthorizationContext,
	request: SearchRequest,
	signal?: AbortSignal,
): Promise<ReadOutcome<SearchResult>> {
	const parsed = SearchRequestSchema.parse(request);
	assertReadDemand(signal);
	const intent = {
		op: "read" as const,
		paths: [],
		precondition: { kind: "none" as const },
		payload_hash: EMPTY_PAYLOAD_HASH,
		size: 0,
	};
	let authorized: AdmissionResult;
	try {
		authorized = await gateway.authorize(context, intent);
	} catch (error) {
		if (error instanceof AdmissionDenied)
			return { ok: false, failure: error.failure };
		throw error;
	}
	if (!authorized.ok) return authorized;
	const ticketId = authorized.ticket.id;
	try {
		assertReadDemand(signal);
		const response = await gateway.search(context, parsed, ticketId);
		if (!response.ok) {
			await gateway.finishAdmission(context, ticketId, "settled");
			return { ok: false, failure: response.failure };
		}
		assertReadDemand(signal);
		return createReadSession(gateway, context, ticketId, response.body);
	} catch (error) {
		if (
			error instanceof ReadAborted ||
			error instanceof AdmissionDenied ||
			error instanceof FileOperationDenied
		) {
			await gateway.finishAdmission(context, ticketId, "settled");
			if (error instanceof ReadAborted) throw error;
			return { ok: false, failure: error.failure };
		}
		throw error;
	}
}
