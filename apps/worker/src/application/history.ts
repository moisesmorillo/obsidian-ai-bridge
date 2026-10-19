import {
	type AdmissionCompletion,
	type AdmissionFinishResult,
	type AdmissionResult,
	type AuthorizationContext,
	AuthorizationContextSchema,
	type FileCommand,
	FileCommandSchema,
	type HistoryRequest,
	type HistoryResult,
	type OperationDescriptor,
	OperationDescriptorSchema,
	type OperationIntent,
	OperationIntentSchema,
	parseETag,
	type RenameReservation,
	RenameReservationSchema,
	type TextMutationBeginResult,
	type TextMutationResult,
} from "@obsidian-ai-bridge/protocol";
import {
	AdmissionDenied,
	type PreparedOperation,
	prepareOperation,
} from "@worker/application/admission";
import { FileOperationDenied } from "@worker/application/files";

/** Native operations required to authorize and publish one file command. */
export interface HistoryVaultGateway {
	/** Reserve capacity before the caller reads command bytes. */
	beginMutation(
		context: AuthorizationContext,
		descriptor: OperationDescriptor,
		key?: string,
	): Promise<TextMutationBeginResult>;
	/** Reserve capacity from source identity while the rename destination remains unread. */
	beginRenameSource(
		context: AuthorizationContext,
		reservation: RenameReservation,
		key?: string,
	): Promise<TextMutationBeginResult>;
	/** Authorize a complete command against a standard reservation. */
	authorize(
		context: AuthorizationContext,
		intent: OperationIntent,
		admissionId?: string,
	): Promise<AdmissionResult>;
	/** Bind a complete rename to its source-only capacity lease. */
	authorizeRenameSource(
		context: AuthorizationContext,
		intent: OperationIntent,
		admissionId: string,
		key?: string,
	): Promise<AdmissionResult>;
	/** Publish a complete native command through the shared receipt coordinator. */
	commitFileCommand(
		context: AuthorizationContext,
		intent: OperationIntent,
		ticketId: string,
		command: ImmutableFileCommand,
		key?: string,
	): Promise<TextMutationResult>;
	/** Close known work or retain uncertain work to its original deadline. */
	finishAdmission(
		context: AuthorizationContext,
		ticketId: string,
		completion: AdmissionCompletion,
	): AdmissionFinishResult | Promise<AdmissionFinishResult>;
	/** Read retained metadata under native read policy. */
	readHistory(
		context: AuthorizationContext,
		request: HistoryRequest,
	): Promise<
		| { ok: true; entries: HistoryResult }
		| { ok: false; failure: { kind: string } }
	>;
}

/** Maps every nested object and array to a readonly TypeScript contract. */
type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly unknown[]
		? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T;

/** Immutable command snapshot validated by the canonical file-command schema. */
export type ImmutableFileCommand = DeepReadonly<FileCommand>;

/** Immutable validated command and its canonical admission fingerprint. */
export type PreparedHistoryCommand = Readonly<{
	command: ImmutableFileCommand;
	operation: PreparedOperation;
}>;

/** Reserve before body reads, then authorize and publish one immutable command. */
export async function executeFileCommand(
	gateway: HistoryVaultGateway,
	context: AuthorizationContext,
	descriptor: OperationDescriptor | RenameReservation,
	key: string | undefined,
	readCommand: () => Promise<FileCommand>,
): Promise<TextMutationResult> {
	const parsedRename = RenameReservationSchema.safeParse(descriptor);
	const renameReservation = parsedRename.success
		? parsedRename.data
		: undefined;
	const parsedDescriptor = renameReservation
		? undefined
		: OperationDescriptorSchema.safeParse(descriptor);
	const normalDescriptor = parsedDescriptor?.success
		? parsedDescriptor.data
		: undefined;
	if (!renameReservation && !normalDescriptor)
		return { ok: false, failure: { kind: "invalid_request" } };
	if (
		normalDescriptor &&
		normalDescriptor.op !== "append" &&
		normalDescriptor.op !== "restore"
	)
		return { ok: false, failure: { kind: "invalid_request" } };
	if (normalDescriptor?.op === "append" && key === undefined)
		return { ok: false, failure: { kind: "idempotency_key_required" } };
	if (normalDescriptor?.op === "append" && normalDescriptor.epoch === undefined)
		return { ok: false, failure: { kind: "invalid_request" } };
	const reservation = renameReservation
		? await gateway.beginRenameSource(context, renameReservation, key)
		: normalDescriptor
			? await gateway.beginMutation(context, normalDescriptor, key)
			: { ok: false as const, failure: { kind: "invalid_request" as const } };
	if (!reservation.ok) return { ok: false, failure: reservation.failure };
	let preserveAdmission = false;
	try {
		const parsedCommand = FileCommandSchema.safeParse(await readCommand());
		if (!parsedCommand.success)
			throw new AdmissionDenied({ kind: "invalid_request" });
		const parsedSnapshot = parsedCommand.data;
		const prepared = await prepareHistoryCommand(context, parsedSnapshot);
		const command = prepared.command;
		if (renameReservation) {
			if (
				command.op !== "rename" ||
				command.intent.paths[0] !== renameReservation.path ||
				command.intent.precondition.kind !== "match" ||
				command.intent.precondition.etag !== renameReservation.if_match ||
				(renameReservation.epoch !== undefined &&
					command.intent.epoch !== renameReservation.epoch) ||
				command.key !== key
			)
				throw new AdmissionDenied({ kind: "invalid_request" });
		} else if (
			!normalDescriptor ||
			command.op === "rename" ||
			JSON.stringify({
				op: command.intent.op,
				epoch: command.intent.epoch,
				paths: command.intent.paths,
				precondition: command.intent.precondition,
			}) !==
				JSON.stringify({
					op: normalDescriptor.op,
					epoch: normalDescriptor.epoch,
					paths: normalDescriptor.paths,
					precondition: normalDescriptor.precondition,
				})
		)
			throw new AdmissionDenied({ kind: "invalid_request" });
		const intent = OperationIntentSchema.parse(prepared.command.intent);
		if ((command.key ?? undefined) !== key)
			throw new AdmissionDenied({ kind: "invalid_request" });
		let authorized: AdmissionResult;
		try {
			authorized = renameReservation
				? await gateway.authorizeRenameSource(
						context,
						intent,
						reservation.lease.admission_id,
						key,
					)
				: await gateway.authorize(
						context,
						intent,
						reservation.lease.admission_id,
					);
		} catch (error) {
			preserveAdmission = true;
			await gateway.finishAdmission(
				context,
				reservation.lease.admission_id,
				"uncertain",
			);
			throw error;
		}
		if (!authorized.ok) {
			await gateway.finishAdmission(
				context,
				reservation.lease.admission_id,
				"settled",
			);
			return { ok: false, failure: authorized.failure };
		}
		try {
			const result = await gateway.commitFileCommand(
				context,
				intent,
				authorized.ticket.id,
				command,
				key,
			);
			try {
				await gateway.finishAdmission(context, authorized.ticket.id, "settled");
			} catch {
				/* The commit result is authoritative. */
			}
			return result;
		} catch (error) {
			preserveAdmission = true;
			await gateway.finishAdmission(context, authorized.ticket.id, "uncertain");
			throw error;
		}
	} catch (error) {
		try {
			if (!preserveAdmission)
				await gateway.finishAdmission(
					context,
					reservation.lease.admission_id,
					"settled",
				);
		} catch {
			/* Keep the original failure. */
		}
		if (
			error instanceof AdmissionDenied ||
			error instanceof FileOperationDenied
		)
			return { ok: false, failure: error.failure };
		throw error;
	}
}

/** Hashes bytes with SHA-256 and returns lowercase hexadecimal output. */
async function sha256(bytes: Uint8Array): Promise<string> {
	const input = new Uint8Array(bytes.byteLength);
	input.set(bytes);
	const digest = await crypto.subtle.digest("SHA-256", input);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Freezes parsed command data recursively so caller changes cannot alter async work. */
function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value as DeepReadonly<T>;
}

/** Returns exact canonical command bytes or exact UTF-8 append input bytes. */
function commandBytes(command: DeepReadonly<FileCommand>): Uint8Array {
	if (command.op === "append") return new TextEncoder().encode(command.content);
	const body =
		command.op === "rename"
			? { to: command.body.to }
			: {
					source_rev: command.body.source_rev,
					as_conflict_copy: command.body.as_conflict_copy ?? false,
				};
	return new TextEncoder().encode(JSON.stringify(body));
}

/** Validated capacity-only source reservation, distinct from a complete operation. */
export type PreparedRenameSourceReservation = Readonly<{
	context: DeepReadonly<AuthorizationContext>;
	reservation: RenameReservation;
	epoch: string;
	fingerprint: string;
}>;

/** Prepare a namespaced source lease without constructing a complete operation descriptor. */
export async function prepareRenameSourceReservation(
	context: AuthorizationContext,
	reservation: RenameReservation,
): Promise<PreparedRenameSourceReservation> {
	const identity = AuthorizationContextSchema.safeParse(context);
	const parsed = RenameReservationSchema.safeParse(reservation);
	if (!identity.success || !parsed.success)
		throw new AdmissionDenied({ kind: "invalid_request" });
	const etagEpoch = parseETag(parsed.data.if_match).epoch;
	if (parsed.data.epoch !== undefined && parsed.data.epoch !== etagEpoch)
		throw new AdmissionDenied({ kind: "invalid_request" });
	const normalized = Object.freeze({ ...parsed.data, epoch: etagEpoch });
	const tuple = JSON.stringify([
		1,
		"rename-source-capacity-lease",
		etagEpoch,
		identity.data.client_id,
		identity.data.grant_id,
		"rename",
		normalized.path,
		{ kind: "match", etag: normalized.if_match },
	]);
	return Object.freeze({
		context: Object.freeze({
			...identity.data,
			scopes: Object.freeze([...identity.data.scopes]),
		}),
		reservation: normalized,
		epoch: etagEpoch,
		fingerprint: await sha256(new TextEncoder().encode(tuple)),
	});
}

/** Parses an immutable command, verifies its exact input binding, then prepares admission. */
export async function prepareHistoryCommand(
	context: AuthorizationContext,
	command: FileCommand | ImmutableFileCommand,
): Promise<PreparedHistoryCommand> {
	const parsed = FileCommandSchema.safeParse(command);
	if (!parsed.success) throw new AdmissionDenied({ kind: "invalid_request" });
	const snapshot = deepFreeze(parsed.data);
	const contextSnapshot = deepFreeze(AuthorizationContextSchema.parse(context));
	const bytes = commandBytes(snapshot);
	const payloadHash = await sha256(bytes);
	if (
		payloadHash !== snapshot.intent.payload_hash ||
		bytes.byteLength !== snapshot.intent.size
	) {
		throw new AdmissionDenied({ kind: "invalid_request" });
	}
	const operation = await prepareOperation(
		AuthorizationContextSchema.parse(contextSnapshot),
		OperationIntentSchema.parse(snapshot.intent),
	);
	return Object.freeze({ command: snapshot, operation });
}
