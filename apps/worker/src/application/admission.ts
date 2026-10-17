import type {
	AdmissionFailure,
	AuthorizationContext,
	OperationDescriptor,
	OperationIntent,
	VaultScope,
} from "@obsidian-ai-bridge/protocol";
import {
	AuthorizationContextSchema,
	DescriptorPreparationSchema,
	OperationPreparationSchema,
	parseETag,
} from "@obsidian-ai-bridge/protocol";

export type PreparedDescriptor = Readonly<{
	client_id: string;
	descriptor: OperationDescriptor;
	descriptorFingerprint: string;
}>;

export type PreparedOperation = PreparedDescriptor &
	Readonly<{
		intent: OperationIntent;
		fingerprint: string;
	}>;

/** Holds one admission failure without exposing file content. */
export class AdmissionDenied extends Error {
	constructor(readonly failure: AdmissionFailure) {
		super(failure.kind);
	}
}

/** Returns the minimum vault scope for an operation. */
export function requiredScope(op: OperationIntent["op"]): VaultScope {
	if (op === "read") return "vault:read";
	if (op === "delete") return "vault:delete";
	return "vault:write";
}

/** Derives the tuple epoch from a match ETag when the descriptor omits it. */
function tupleEpoch(descriptor: OperationDescriptor): string | null {
	if (descriptor.epoch !== undefined) return descriptor.epoch;
	if (descriptor.precondition.kind === "match")
		return parseETag(descriptor.precondition.etag).epoch;
	return null;
}

/** Encodes only reservation metadata in fixed field order. */
function descriptorTuple(
	context: AuthorizationContext,
	descriptor: OperationDescriptor,
): string {
	return JSON.stringify([
		1,
		tupleEpoch(descriptor),
		context.client_id,
		descriptor.op,
		descriptor.paths,
		descriptor.precondition,
	]);
}

/** Encodes the complete operation binding in fixed field order. */
function operationTuple(
	context: AuthorizationContext,
	intent: OperationIntent,
): string {
	return JSON.stringify([
		1,
		tupleEpoch(intent),
		context.client_id,
		intent.op,
		intent.paths,
		intent.precondition,
		intent.payload_hash,
		intent.size,
	]);
}

/** Hashes canonical tuple JSON as UTF-8 with Web Crypto SHA-256. */
async function sha256Json(tupleJson: string): Promise<string> {
	const bytes = new TextEncoder().encode(tupleJson);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Copies and freezes identity scopes before any asynchronous hash. */
function freezeContext(context: AuthorizationContext): AuthorizationContext {
	return Object.freeze({
		...context,
		scopes: Object.freeze([...context.scopes]),
	}) as AuthorizationContext;
}

/** Copies and freezes normalized paths and preconditions. */
function freezeDescriptor(
	descriptor: OperationDescriptor,
): OperationDescriptor {
	return Object.freeze({
		...descriptor,
		paths: Object.freeze([...descriptor.paths]),
		precondition: Object.freeze({ ...descriptor.precondition }),
	}) as OperationDescriptor;
}

/** Copies and freezes normalized intent paths and preconditions. */
function freezeIntent(intent: OperationIntent): OperationIntent {
	return Object.freeze({
		...intent,
		paths: Object.freeze([...intent.paths]),
		precondition: Object.freeze({ ...intent.precondition }),
	}) as OperationIntent;
}

/** Parses and snapshots descriptor data before hashing it. */
export async function prepareDescriptor(
	context: AuthorizationContext,
	descriptor: OperationDescriptor,
): Promise<PreparedDescriptor> {
	const result = DescriptorPreparationSchema.safeParse({ context, descriptor });
	if (!result.success) throw new AdmissionDenied({ kind: "invalid_request" });
	const parsed = result.data;
	const frozenContext = freezeContext(parsed.context);
	const frozen = freezeDescriptor(parsed.descriptor);
	const descriptorFingerprint = await sha256Json(
		descriptorTuple(frozenContext, frozen),
	);
	return Object.freeze({
		client_id: frozenContext.client_id,
		descriptor: frozen,
		descriptorFingerprint,
	});
}

/** Hashes a validated operation with the canonical versioned fingerprint tuple. */
export async function fingerprintOperation(
	context: AuthorizationContext,
	intent: OperationIntent,
): Promise<string> {
	const parsed = OperationPreparationSchema.parse({ context, intent });
	const frozenContext = freezeContext(parsed.context);
	const frozen = freezeIntent(parsed.intent);
	return sha256Json(operationTuple(frozenContext, frozen));
}

/** Parses and snapshots an operation before either asynchronous hash. */
export async function prepareOperation(
	context: AuthorizationContext,
	intent: OperationIntent,
): Promise<PreparedOperation> {
	const result = OperationPreparationSchema.safeParse({ context, intent });
	if (!result.success) throw new AdmissionDenied({ kind: "invalid_request" });
	const parsed = result.data;
	const frozenContext = freezeContext(parsed.context);
	const frozen = freezeIntent(parsed.intent);
	const descriptor: OperationDescriptor = Object.freeze({
		op: frozen.op,
		epoch: frozen.epoch,
		paths: frozen.paths,
		precondition: frozen.precondition,
	});
	const descriptorFingerprint = await sha256Json(
		descriptorTuple(frozenContext, descriptor),
	);
	const fingerprint = await sha256Json(operationTuple(frozenContext, frozen));
	return Object.freeze({
		client_id: frozenContext.client_id,
		descriptor,
		descriptorFingerprint,
		intent: frozen,
		fingerprint,
	});
}

/** Checks the operation scope and observed vault epoch before content effects. */
export function assertAdmissionAllowed(
	context: AuthorizationContext,
	operation: PreparedDescriptor | PreparedOperation,
	currentEpoch: string,
): void {
	const parsedContext = AuthorizationContextSchema.parse(context);
	const op =
		"intent" in operation ? operation.intent.op : operation.descriptor.op;
	if (!parsedContext.scopes.includes(requiredScope(op))) {
		throw new AdmissionDenied({ kind: "forbidden_scope" });
	}
	const observedEpoch = tupleEpoch(operation.descriptor);
	if (observedEpoch !== null && observedEpoch !== currentEpoch) {
		throw new AdmissionDenied({
			kind: "epoch_mismatch",
			current_epoch: currentEpoch,
		});
	}
}
