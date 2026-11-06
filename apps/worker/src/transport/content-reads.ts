import {
	type AuthorizationContext,
	EMPTY_PAYLOAD_HASH,
	type TextReadRequest,
} from "@obsidian-ai-bridge/protocol";
import { AdmissionDenied } from "@worker/application/admission";
import type { BlobContentStore } from "@worker/application/blobs";
import { FileOperationDenied } from "@worker/application/files";
import {
	tryAcquireReadSlot,
	waitForReadSlotWork,
} from "@worker/application/read-budget";
import { assertReadDemand, ReadAborted } from "@worker/application/read-demand";
import { settleReadAdmission } from "@worker/application/reads";
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
		const begunResult = await waitForReadSlotWork(
			release,
			gateway.authorize(identity, {
				op: "read",
				paths: [selection.path],
				precondition: { kind: "none" },
				payload_hash: EMPTY_PAYLOAD_HASH,
				size: 0,
			}),
		);
		if (begunResult.kind === "expired")
			return fileFailureResponse({ kind: "internal_error" });
		const begun = begunResult.value;
		if (!begun.ok) {
			release();
			release.complete();
			return fileFailureResponse(begun.failure);
		}
		ticket = begun.ticket.id;
		assertReadDemand(request.signal);
		const selectedResult = await waitForReadSlotWork(
			release,
			gateway.readText(identity, selection, ticket),
		);
		if (selectedResult.kind === "expired")
			return fileFailureResponse({ kind: "internal_error" });
		const selected = selectedResult.value;
		if (!selected.ok) {
			if (selected.failure.kind !== "not_implemented") {
				release();
				release.complete();
				try {
					await settleReadAdmission(() => finish("settled"));
				} catch {
					return fileFailureResponse({ kind: "internal_error" });
				}
				return fileFailureResponse(selected.failure);
			}
			assertReadDemand(request.signal);
			const responseResult = await waitForReadSlotWork(
				release,
				readBlobResponse(
					gateway,
					store(),
					identity,
					selection,
					request.headers.get("Range"),
					ticket,
					request.signal,
				),
			);
			if (responseResult.kind === "expired")
				return fileFailureResponse({ kind: "internal_error" });
			const response = responseResult.value;
			if (!response.ok || response.body === null) {
				release();
				release.complete();
				try {
					await settleReadAdmission(() => finish("settled"));
				} catch {
					return fileFailureResponse({ kind: "internal_error" });
				}
				return response;
			}
			const contentLength = response.headers.get("Content-Length");
			if (contentLength === null)
				throw new Error("Blob response has no declared byte length");
			const knownByteLength = Number(contentLength);
			return ownedReadResponse(
				blobReadSource(response.body),
				{ finish },
				release,
				response,
				request.signal,
				knownByteLength,
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
					"Cache-Control": "no-transform",
					"Content-Type": "application/json; charset=UTF-8",
				},
			},
			request.signal,
		);
	} catch (error) {
		const known =
			error instanceof FileOperationDenied || error instanceof AdmissionDenied;
		release();
		release.complete();
		if (ticket !== undefined) {
			try {
				await settleReadAdmission(() =>
					finish(
						known || error instanceof ReadAborted ? "settled" : "uncertain",
					),
				);
			} catch {
				return fileFailureResponse({ kind: "internal_error" });
			}
		}
		return fileFailureResponse(
			known ? error.failure : { kind: "internal_error" },
		);
	}
}
