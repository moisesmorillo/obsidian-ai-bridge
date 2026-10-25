import {
	type AdmissionCompletion,
	type AuthorizationContext,
	type FileCommand,
	type FileFailure,
	type McpAppendToNoteInput,
	type McpCreateNoteInput,
	type McpDeleteNoteInput,
	type McpRestoreNoteInput,
	type McpUpdateNoteInput,
	OperationDescriptorSchema,
	parseETag,
	TextMutationDescriptorSchema,
} from "@obsidian-ai-bridge/protocol";
import type { HistoryVaultGateway } from "@worker/application/history";
import { executeFileCommand } from "@worker/application/history";
import type { McpReadOwner } from "@worker/application/mcp-notes";
import type { TextVaultGateway } from "@worker/application/text-files";
import { executeTextMutation } from "@worker/application/text-files";
import { prepareTextPayload } from "@worker/application/text-payload";

/** Mutation gateway limited to the existing text and history authorities. */
export type McpMutationGateway = TextVaultGateway & HistoryVaultGateway;

/** Result of one MCP write with its operation-specific epoch and response owner. */
export type McpMutationOutcome =
	| { ok: true; epoch: string; etag: string; owner: McpReadOwner }
	| {
			ok: false;
			failure: FileFailure | { kind: "internal_error" };
			epoch?: string;
			owner: McpReadOwner;
	  };

/** Create the response owner after the authoritative operation has settled. */
function settledMutationOwner(): McpReadOwner {
	return {
		completion: "settled",
		/** The underlying operation settled before the tool result was built. */
		async cancel() {},
		/** Keep one successful finish result for the transferred response owner. */
		async finish() {
			return { ok: true };
		},
	};
}

/** Run one mutation only after its own scope, epoch, and revocation checks pass. */
async function runMutation(
	gateway: McpMutationGateway,
	identity: AuthorizationContext,
	scope: "vault:write" | "vault:delete",
	op: "put" | "delete" | "append" | "restore",
	expectedEpoch: string,
	_operationProduction: Promise<void>,
	operation: (
		ownedGateway: McpMutationGateway,
	) => Promise<Awaited<ReturnType<typeof executeTextMutation>>>,
): Promise<McpMutationOutcome> {
	const settlements = new Map<string, AdmissionCompletion>();
	const owner: McpReadOwner = {
		completion: "settled",
		/** All mutation work settles before the response transfers ownership. */
		async cancel() {},
		/** Keep known durable admissions until response EOF or cancellation cleanup. */
		async finish(completion) {
			for (const [ticket, known] of settlements) {
				const result = await gateway.finishAdmission(
					identity,
					ticket,
					completion === "uncertain" ? completion : known,
				);
				if (!result.ok) return result;
				settlements.delete(ticket);
			}
			return { ok: true };
		},
	};
	const ownedGateway: McpMutationGateway = {
		...gateway,
		/** Retain known cleanup for the response owner. Unknown work keeps its original durable deadline. */
		async finishAdmission(context, ticket, completion) {
			if (completion === "uncertain")
				return gateway.finishAdmission(context, ticket, completion);
			settlements.set(ticket, completion);
			return { ok: true };
		},
	};
	if (!identity.scopes.includes(scope))
		return { ok: false, failure: { kind: "forbidden_scope" }, owner };
	const current = await gateway.getCurrentEpoch(identity, op);
	if (!current.ok) return { ok: false, failure: current.failure, owner };
	if (current.current_epoch !== expectedEpoch)
		return {
			ok: false,
			failure: { kind: "epoch_mismatch", current_epoch: current.current_epoch },
			epoch: current.current_epoch,
			owner,
		};
	const result = await operation(ownedGateway).catch(() => ({
		ok: false as const,
		failure: { kind: "internal_error" as const },
	}));
	if (result.ok)
		return {
			ok: true,
			epoch: current.current_epoch,
			etag: result.response.body.etag,
			owner,
		};
	const refreshed = await gateway.getCurrentEpoch(identity, op);
	if (!refreshed.ok) return { ok: false, failure: refreshed.failure, owner };
	return {
		ok: false,
		failure: result.failure,
		epoch: refreshed.current_epoch,
		owner,
	};
}

/** Create a note only when its path is absent in the supplied vault epoch. */
export function createMcpNote(
	gateway: McpMutationGateway,
	identity: AuthorizationContext,
	input: McpCreateNoteInput,
	responseProduction: Promise<void>,
) {
	const descriptor = TextMutationDescriptorSchema.parse({
		op: "put",
		paths: [input.path],
		precondition: { kind: "absent" },
		epoch: input.epoch,
	});
	return runMutation(
		gateway,
		identity,
		"vault:write",
		"put",
		input.epoch,
		responseProduction,
		(ownedGateway) =>
			executeTextMutation(
				ownedGateway,
				identity,
				descriptor,
				input.idempotency_key,
				async () => prepareTextPayload(new TextEncoder().encode(input.content)),
				undefined,
				responseProduction,
			),
	);
}

/** Replace a note only at the exact ETag supplied by the caller. */
export function updateMcpNote(
	gateway: McpMutationGateway,
	identity: AuthorizationContext,
	input: McpUpdateNoteInput,
	responseProduction: Promise<void>,
) {
	const epoch = parseETag(input.etag).epoch;
	const descriptor = TextMutationDescriptorSchema.parse({
		op: "put",
		paths: [input.path],
		precondition: { kind: "match", etag: input.etag },
		epoch,
	});
	return runMutation(
		gateway,
		identity,
		"vault:write",
		"put",
		epoch,
		responseProduction,
		(ownedGateway) =>
			executeTextMutation(
				ownedGateway,
				identity,
				descriptor,
				input.idempotency_key,
				async () => prepareTextPayload(new TextEncoder().encode(input.content)),
				undefined,
				responseProduction,
			),
	);
}

/** Append one immutable payload under its required client-scoped receipt key. */
export function appendMcpNote(
	gateway: McpMutationGateway,
	identity: AuthorizationContext,
	input: McpAppendToNoteInput,
	responseProduction: Promise<void>,
) {
	const intent = {
		op: "append" as const,
		paths: [input.path],
		precondition: { kind: "none" as const },
		epoch: input.epoch,
		payload_hash: "0".repeat(64),
		size: new TextEncoder().encode(input.text).byteLength,
	};
	const descriptor = OperationDescriptorSchema.parse({
		op: "append",
		paths: [input.path],
		precondition: { kind: "none" },
		epoch: input.epoch,
	});
	const command: FileCommand = {
		op: "append",
		intent,
		content: input.text,
		key: input.idempotency_key,
	};
	return runMutation(
		gateway,
		identity,
		"vault:write",
		"append",
		input.epoch,
		responseProduction,
		async (ownedGateway) => {
			const prepared = await prepareTextPayload(
				new TextEncoder().encode(input.text),
			);
			command.intent.payload_hash = prepared.payload_hash;
			return executeFileCommand(
				ownedGateway,
				identity,
				descriptor,
				input.idempotency_key,
				async () => ({ ...command, content: prepared.content }),
				responseProduction,
			);
		},
	);
}

/** Delete a note only at the exact ETag supplied by the caller. */
export function deleteMcpNote(
	gateway: McpMutationGateway,
	identity: AuthorizationContext,
	input: McpDeleteNoteInput,
	responseProduction: Promise<void>,
) {
	const epoch = parseETag(input.etag).epoch;
	const descriptor = TextMutationDescriptorSchema.parse({
		op: "delete",
		paths: [input.path],
		precondition: { kind: "match", etag: input.etag },
		epoch,
	});
	return runMutation(
		gateway,
		identity,
		"vault:delete",
		"delete",
		epoch,
		responseProduction,
		(ownedGateway) =>
			executeTextMutation(
				ownedGateway,
				identity,
				descriptor,
				undefined,
				async () => prepareTextPayload(new Uint8Array()),
				undefined,
				responseProduction,
			),
	);
}

/** Restore a retained revision in place while preserving the displaced current revision. */
export async function restoreMcpNote(
	gateway: McpMutationGateway,
	identity: AuthorizationContext,
	input: McpRestoreNoteInput,
	responseProduction: Promise<void>,
): Promise<McpMutationOutcome> {
	const current = parseETag(input.current_etag);
	const source = parseETag(input.source_etag);
	if (current.epoch !== source.epoch) {
		const owner = settledMutationOwner();
		if (!identity.scopes.includes("vault:write"))
			return { ok: false, failure: { kind: "forbidden_scope" }, owner };
		const epoch = await gateway.getCurrentEpoch(identity, "restore");
		return epoch.ok
			? {
					ok: false,
					failure: {
						kind: "epoch_mismatch",
						current_epoch: epoch.current_epoch,
					},
					epoch: epoch.current_epoch,
					owner,
				}
			: { ok: false, failure: epoch.failure, owner };
	}
	const descriptor = OperationDescriptorSchema.parse({
		op: "restore",
		paths: [input.path],
		precondition: { kind: "match", etag: input.current_etag },
		epoch: current.epoch,
	});
	const command: FileCommand = {
		op: "restore",
		intent: {
			...descriptor,
			op: "restore",
			payload_hash: "0".repeat(64),
			size: 0,
		},
		body: {
			source_rev: source.rev,
			as_conflict_copy: input.as_conflict_copy ?? false,
		},
	};
	return runMutation(
		gateway,
		identity,
		"vault:write",
		"restore",
		current.epoch,
		responseProduction,
		(ownedGateway) =>
			executeFileCommand(
				ownedGateway,
				identity,
				descriptor,
				undefined,
				async () => {
					const payload = await prepareTextPayload(
						new TextEncoder().encode(JSON.stringify(command.body)),
					);
					return {
						...command,
						intent: {
							...command.intent,
							payload_hash: payload.payload_hash,
							size: payload.size,
						},
					};
				},
				responseProduction,
			),
	);
}
