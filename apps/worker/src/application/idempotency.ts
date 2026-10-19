import {
	type IdempotencyKey,
	IdempotencyKeySchema,
} from "@obsidian-ai-bridge/protocol";
import { FileOperationDenied } from "@worker/application/files";

/** Rejects invalid keys or UUIDv7 timestamps outside the inclusive policy window. */
export function assertIdempotencyWindow(
	key: IdempotencyKey,
	now: number,
): void {
	if (
		!IdempotencyKeySchema.safeParse(key).success ||
		!Number.isSafeInteger(now)
	) {
		throw new FileOperationDenied({ kind: "invalid_request" });
	}

	const match =
		/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(
			key,
		);
	if (!match) return;

	const timestamp = Number.parseInt(key.replaceAll("-", "").slice(0, 12), 16);
	if (timestamp < now - 25 * 86_400_000 || timestamp > now + 5 * 60_000) {
		throw new FileOperationDenied({ kind: "operation_expired" });
	}
}
