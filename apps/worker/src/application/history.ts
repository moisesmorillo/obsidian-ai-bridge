import {
	type AuthorizationContext,
	AuthorizationContextSchema,
	type FileCommand,
	FileCommandSchema,
} from "@obsidian-ai-bridge/protocol";
import {
	AdmissionDenied,
	type PreparedOperation,
	prepareOperation,
} from "@worker/application/admission";

/** Immutable validated command and its canonical admission fingerprint. */
export type PreparedHistoryCommand = Readonly<{
	command: FileCommand;
	operation: PreparedOperation;
}>;

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
function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Returns exact canonical command bytes or exact UTF-8 append input bytes. */
function commandBytes(command: FileCommand): Uint8Array {
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

/** Parses an immutable command, verifies its exact input binding, then prepares admission. */
export async function prepareHistoryCommand(
	context: AuthorizationContext,
	command: FileCommand,
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
	const operation = await prepareOperation(contextSnapshot, snapshot.intent);
	return Object.freeze({ command: snapshot, operation });
}
