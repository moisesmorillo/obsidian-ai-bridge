import {
	type AuthorizationContext,
	EMPTY_PAYLOAD_HASH,
	type TextReadRequest,
} from "@obsidian-ai-bridge/protocol";
import { AdmissionDenied } from "@worker/application/admission";
import type { BlobContentStore } from "@worker/application/blobs";
import { FileOperationDenied } from "@worker/application/files";
import { tryAcquireReadSlot } from "@worker/application/read-budget";
import { assertReadDemand, ReadAborted } from "@worker/application/read-demand";
import type { TextVaultGateway } from "@worker/application/text-files";
import { readBlobResponse } from "@worker/transport/blobs";
import { fileFailureResponse } from "@worker/transport/mutation-response";
import {
	blobReadSource,
	encodeJsonChunks,
	jsonReadSource,
	ownedReadResponse,
} from "@worker/transport/read-response";

/** Select current or exact content under one durable ticket and one shared response slot. */
export async function readContentResponse(
	gateway: Pick<
		TextVaultGateway,
		"authorize" | "finishAdmission" | "readText" | "readBlobMetadata"
	>,
	store: () => BlobContentStore,
	identity: AuthorizationContext,
	selection: TextReadRequest,
	request: Request,
): Promise<Response> {
	const release = tryAcquireReadSlot();
	if (!release)
		return fileFailureResponse({
			kind: "admission_limited",
			retry_after_seconds: 1,
		});
	let ticket: string | undefined;
	let cleanup: ReturnType<TextVaultGateway["finishAdmission"]> | undefined;
	/** Settle once after response production, without extending the admission deadline. */
	const finish = (completion: "settled" | "uncertain") => {
		if (ticket === undefined)
			throw new Error("Content response has no admission");
		const admissionId = ticket;
		cleanup ??= Promise.resolve().then(() =>
			gateway.finishAdmission(identity, admissionId, completion),
		);
		return cleanup;
	};
	try {
		assertReadDemand(request.signal);
		const begun = await gateway.authorize(identity, {
			op: "read",
			paths: [selection.path],
			precondition: { kind: "none" },
			payload_hash: EMPTY_PAYLOAD_HASH,
			size: 0,
		});
		if (!begun.ok) {
			release();
			return fileFailureResponse(begun.failure);
		}
		ticket = begun.ticket.id;
		assertReadDemand(request.signal);
		const selected = await gateway.readText(identity, selection, ticket);
		if (!selected.ok) {
			if (selected.failure.kind !== "not_implemented") {
				await finish("settled");
				release();
				return fileFailureResponse(selected.failure);
			}
			assertReadDemand(request.signal);
			const response = await readBlobResponse(
				gateway,
				store(),
				identity,
				selection,
				request.headers.get("Range"),
				ticket,
				request.signal,
			);
			if (!response.ok || response.body === null) {
				await finish("settled");
				release();
				return response;
			}
			return ownedReadResponse(
				blobReadSource(response.body),
				{ finish },
				release,
				response,
				request.signal,
			);
		}
		assertReadDemand(request.signal);
		return ownedReadResponse(
			jsonReadSource(encodeJsonChunks(selected.body)),
			{ finish },
			release,
			{
				headers: {
					ETag: selected.body.etag,
					"Content-Type": "application/json; charset=UTF-8",
				},
			},
			request.signal,
		);
	} catch (error) {
		const known =
			error instanceof FileOperationDenied || error instanceof AdmissionDenied;
		try {
			if (ticket !== undefined)
				await finish(
					known || error instanceof ReadAborted ? "settled" : "uncertain",
				);
		} catch {
			/* Unknown cleanup keeps the durable ticket at its original deadline. */
		} finally {
			release();
		}
		return fileFailureResponse(
			known ? error.failure : { kind: "internal_error" },
		);
	}
}
